// Production residual logger + paper-trading bookkeeper. Runs hourly.
//
// Three responsibilities:
//
// (A) Predictions: at each city's local 15:00, capture the prediction →
//     predictions/<cli>/<localDate>.json. At local 07:00 next day, fetch CLI,
//     compute residual → residuals/<cli>/<localDate>.json.
//
// (B) Paper-trading bet placement: every hour, check spare bet capacity. Up to 20
//     CONCURRENT (in-flight, not-yet-settled) bets at any time. Per-bet stake =
//     max($1, bankroll/20). Cumulative stakes cannot exceed bankroll. Pulls the
//     top Kelly-ranked +EV bets from /api/kalshi (already filtered for edge,
//     freshness, etc.), places new bets up to remaining capacity, deduping on
//     (city, targetDate, ticker, side).
//
// (C) Settlement: at each city's local 07:00, settle any open bets targeting
//     yesterday's local date for that city. Updates bankroll in paper_state.

import { getStore } from "@netlify/blobs";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const UA = "weatherbot-logger";

const STARTING_BANKROLL = 20;
const MAX_CONCURRENT = 20;
const MIN_EDGE = 0.05;
const MIN_HALF_KELLY = 0.02;

function localDateParts(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const hourStr = p.hour === "24" ? "0" : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: parseInt(hourStr, 10),
    minute: parseInt(p.minute, 10)
  };
}
function priorLocalDate(tz, date = new Date()) {
  const yesterday = new Date(date.getTime() - 24 * 3600 * 1000);
  return localDateParts(tz, yesterday).date;
}

async function fetchInternal(path) {
  const auth = "Basic " + btoa("internal:hydro");
  const r = await fetch(`${SITE_BASE}${path}`, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return await r.json();
}

async function fetchCLIYesterday(cli) {
  const url = `https://forecast.weather.gov/product.php?site=NWS&product=CLI&issuedby=${cli}&format=txt&version=1&glossary=0`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const html = await r.text();
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!pre) return null;
  const text = pre[1];
  const m = text.match(/^\s*MAXIMUM\s+(-?\d+)/im);
  const maxF = m ? parseInt(m[1], 10) : null;
  const forMatch = text.match(/CLIMATE\s+SUMMARY\s+FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})/i);
  const isPartial = /VALID\s+(AS\s+OF|TODAY|THROUGH)/i.test(text);
  return { maxF, isPartial, dateLabel: forMatch ? `${forMatch[1]} ${forMatch[2]} ${forMatch[3]}` : null };
}

function settleBet(bet, actualHigh) {
  const lo = (bet.loInt == null) ? -Infinity : bet.loInt;
  const hi = (bet.hiInt == null) ? Infinity : bet.hiInt;
  const inBucket = actualHigh >= lo && actualHigh <= hi;
  const won = bet.side === "YES" ? inBucket : !inBucket;
  const stake = bet.stake_dollars;
  const pnl = won ? stake * (1 - bet.price) / bet.price : -stake;
  return {
    ...bet,
    actualHigh, outcome: won ? "WIN" : "LOSS",
    pnl_dollars: Math.round(pnl * 100) / 100,
    settledAtUTC: new Date().toISOString()
  };
}

export default async () => {
  const now = new Date();
  const predStore = getStore("predictions");
  const residStore = getStore("residuals");
  const openStore = getStore("open_bets");
  const settledStore = getStore("settled_bets");
  const stateStore = getStore("paper_state");

  let weatherData;
  try { weatherData = await fetchInternal("/api/weather"); }
  catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  const captures = [];
  const reconciliations = [];
  const placements = [];
  const settlements = [];

  // ===== (A) Per-city prediction capture / reconciliation =====
  for (const city of weatherData.cities || []) {
    if (city.error) continue;
    const tz = city.tz;
    const { date: localDate, hour: localHr } = localDateParts(tz, now);

    if (localHr === 15) {
      const key = `${city.cli}/${localDate}.json`;
      const existing = await predStore.get(key, { type: "json" }).catch(() => null);
      if (!existing) {
        await predStore.setJSON(key, {
          cli: city.cli, station: city.station, name: city.name,
          localDate, capturedAtUTC: now.toISOString(),
          mean: city.mean, std: city.std, ci68: city.ci68, ci95: city.ci95,
          maxSoFar: city.maxSoFar, currentTemp: city.currentTemp,
          forecastHighF: city.forecastHighF, biasF: city.biasF, method: city.method,
          ensembleSources: city.ensembleSources
        });
        captures.push(`${city.cli}:${localDate}`);
      }
    }

    if (localHr === 7) {
      const yDate = priorLocalDate(tz, now);
      const yKey = `${city.cli}/${yDate}.json`;
      const existing = await residStore.get(yKey, { type: "json" }).catch(() => null);
      if (!existing) {
        const stored = await predStore.get(yKey, { type: "json" }).catch(() => null);
        if (stored) {
          const cli = await fetchCLIYesterday(city.cli);
          if (cli && cli.maxF != null && !cli.isPartial) {
            const residual = stored.mean - cli.maxF;
            await residStore.setJSON(yKey, {
              cli: city.cli, name: city.name, localDate: yDate,
              predicted: stored.mean, actual: cli.maxF, residual,
              std: stored.std, withinCI68: Math.abs(residual) <= stored.std,
              withinCI95: Math.abs(residual) <= 1.96 * stored.std,
              cliDateLabel: cli.dateLabel,
              capturedAtUTC: stored.capturedAtUTC,
              reconciledAtUTC: now.toISOString()
            });
            reconciliations.push(`${city.cli}:${yDate} pred=${stored.mean} actual=${cli.maxF} resid=${residual.toFixed(2)}`);
          }
        }
      }
    }
  }

  // ===== Load state, list open bets =====
  let state = await stateStore.get("global", { type: "json" }).catch(() => null);
  if (!state) {
    state = {
      startedAtUTC: now.toISOString(),
      bankroll: STARTING_BANKROLL,
      n_bets_total: 0, n_wins_total: 0,
      total_staked: 0, total_pnl: 0,
      lastUpdatedUTC: now.toISOString()
    };
  }
  const { blobs: openBlobs } = await openStore.list().catch(() => ({ blobs: [] }));
  const openBets = (await Promise.all(
    openBlobs.map(b => openStore.get(b.key, { type: "json" }).catch(() => null))
  )).filter(Boolean);
  const openCount = openBets.length;
  const openIds = new Set(openBets.map(b => b.betId));

  // ===== (C) Settlement at city's local 07:00 =====
  // Process before placement so freed-up capacity can immediately be used.
  for (const city of weatherData.cities || []) {
    if (city.error) continue;
    const tz = city.tz;
    const { hour: localHr } = localDateParts(tz, now);
    if (localHr !== 7) continue;
    const yDate = priorLocalDate(tz, now);
    const candidates = openBets.filter(b => b.targetCli === city.cli && b.targetLocalDate === yDate);
    if (!candidates.length) continue;
    const cliResult = await fetchCLIYesterday(city.cli);
    if (!cliResult || cliResult.maxF == null || cliResult.isPartial) continue;
    const actualHigh = cliResult.maxF;

    for (const bet of candidates) {
      const result = settleBet(bet, actualHigh);
      await settledStore.setJSON(`${bet.betId}.json`, result);
      await openStore.delete(`${bet.betId}.json`).catch(() => {});
      openIds.delete(bet.betId);
      state.bankroll = Math.round((state.bankroll + result.pnl_dollars) * 100) / 100;
      state.n_bets_total += 1;
      if (result.outcome === "WIN") state.n_wins_total += 1;
      state.total_staked = Math.round((state.total_staked + result.stake_dollars) * 100) / 100;
      state.total_pnl = Math.round((state.total_pnl + result.pnl_dollars) * 100) / 100;
      settlements.push(`${bet.city} ${bet.ticker} ${bet.side}: ${result.outcome} $${result.pnl_dollars.toFixed(2)} (bankroll → $${state.bankroll.toFixed(2)})`);
    }
  }

  // ===== (B) Paper-trading bet placement =====
  // Compute spare capacity at current bankroll.
  const bankroll = state.bankroll;
  const bet_size = Math.max(1, bankroll / 20);
  const currentOpenStake = openBets.reduce((a, b) => a + (b.stake_dollars || 0), 0);
  const cashAvailable = bankroll - currentOpenStake;
  const remainingByCount = MAX_CONCURRENT - (openCount - settlements.length);
  const remainingByCash = Math.floor(cashAvailable / bet_size);
  const spareCapacity = Math.max(0, Math.min(remainingByCount, remainingByCash));

  let kalshiData = null;
  if (spareCapacity > 0) {
    try { kalshiData = await fetchInternal("/api/kalshi"); } catch (e) { kalshiData = null; }
  }
  const fr = kalshiData?.freshness || {};
  const skipFresh = !!(fr.cacheStale || fr.forecastStale);

  if (spareCapacity > 0 && kalshiData && !skipFresh) {
    const qualifying = (kalshiData.topBets || []).filter(b =>
      b.ev >= MIN_EDGE && b.halfKelly >= MIN_HALF_KELLY
    );
    const cityByName = Object.fromEntries((weatherData.cities || []).map(c => [c.name, c]));
    const placedThisRun = [];
    for (const b of qualifying) {
      if (placedThisRun.length >= spareCapacity) break;
      const c = cityByName[b.city];
      if (!c) continue;
      const targetLocalDate = localDateParts(c.tz, now).date;
      const betId = `${c.cli}-${targetLocalDate}-${b.ticker}-${b.side}`;
      if (openIds.has(betId)) continue;  // already in flight
      // Also skip if a settled bet exists with this ID (already played for that target date).
      const wasSettled = await settledStore.get(`${betId}.json`, { type: "json" }).catch(() => null);
      if (wasSettled) continue;
      const record = {
        betId, city: b.city, targetCli: c.cli, targetLocalDate,
        ticker: b.ticker, bucket: b.bucket, side: b.side, price: b.price,
        p_model: b.p_model, ev: b.ev, kelly: b.kelly, halfKelly: b.halfKelly,
        stake_dollars: Math.round(bet_size * 100) / 100,
        loInt: (b.loInt === -Infinity || b.loInt == null) ? null : b.loInt,
        hiInt: (b.hiInt === Infinity || b.hiInt == null) ? null : b.hiInt,
        modelMean: b.modelMean, modelStd: b.modelStd,
        placedAtUTC: now.toISOString(),
        bankroll_at_placement: bankroll
      };
      await openStore.setJSON(`${betId}.json`, record);
      openIds.add(betId);
      placedThisRun.push(record);
      placements.push(`${b.city} ${b.bucket} ${b.side} @ $${b.price.toFixed(2)} stake=$${record.stake_dollars}`);
    }
  }

  state.win_rate = state.n_bets_total ? state.n_wins_total / state.n_bets_total : 0;
  state.roi = state.total_staked ? state.total_pnl / state.total_staked : 0;
  state.lastUpdatedUTC = now.toISOString();
  await stateStore.setJSON("global", state);

  return new Response(JSON.stringify({
    ok: true, ranAtUTC: now.toISOString(),
    bankroll: state.bankroll, openCount: openIds.size,
    bet_size_dollars: Math.round(bet_size * 100) / 100,
    spareCapacity, freshnessSkip: skipFresh,
    captures, reconciliations, placements, settlements
  }), { headers: { "content-type": "application/json" } });
};

// Every 5 min: fast enough to catch SPECIs and NWS forecast updates promptly,
// while ≥ /api/weather server cache TTL (3 min) so most firings see fresh data.
// Dedup by betId keeps us from re-stacking the same (city, ticker, side, date).
export const config = {
  schedule: "*/5 * * * *"
};
