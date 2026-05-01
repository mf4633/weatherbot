// Production residual logger + paper-trading bookkeeper.
// Runs hourly via Netlify scheduled function.
//
// At each city's local 15:00 (peak heating):
//   - Captures the prediction for the city → predictions/<cli>/<localDate>.json
//   - Pulls qualifying Kalshi bets for that city, half-Kelly sized against $1000
//     virtual bankroll → paper_bets/<cli>/<localDate>.json. NO REAL MONEY.
//
// At each city's local 07:00 (after morning CLI is typically issued):
//   - Fetches CLI<station>, parses yesterday's MAXIMUM
//   - Reconciles prediction → residuals/<cli>/<localDate>.json
//   - Settles each paper bet (WIN if outcome matches bucket+side) →
//     paper_settlements/<cli>/<localDate>.json, accumulates running stats in
//     paper_state.json
//
// All idempotent on date keys.

import { getStore } from "@netlify/blobs";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const UA = "weatherbot-logger";

// Paper-trade params (no real money).
const PAPER_BANKROLL = 1000;          // virtual $1000 per bet for sizing
const MIN_EDGE = 0.05;                // skip bets with edge under 5¢
const MAX_STAKE_FRAC = 0.20;          // cap any single bet at 20% of bankroll
const MIN_KELLY_FRAC = 0.02;          // skip half-Kelly bets under 2%

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

async function fetchKalshiData() {
  const auth = "Basic " + btoa("internal:hydro");
  const r = await fetch(`${SITE_BASE}/api/kalshi`, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`kalshi API ${r.status}`);
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

// Settle a single paper bet given the actual high temp.
function settleBet(bet, actualHigh) {
  const { side, loInt, hiInt } = bet;
  // For tail buckets, loInt may be -Infinity / hiInt Infinity, but JSON serialization
  // converts those to null. Treat null as ±Infinity.
  const lo = (loInt == null || loInt === -Infinity) ? -Infinity : loInt;
  const hi = (hiInt == null || hiInt === Infinity) ? Infinity : hiInt;
  const inBucket = actualHigh >= lo && actualHigh <= hi;
  const wonYes = side === "YES" ? inBucket : !inBucket;
  const stake = bet.stake_dollars;
  const pnl = wonYes ? stake * (1 - bet.price) / bet.price : -stake;
  return {
    ticker: bet.ticker, bucket: bet.bucket, side: bet.side,
    price: bet.price, stake_dollars: stake,
    actualHigh, outcome: wonYes ? "WIN" : "LOSS",
    pnl_dollars: Math.round(pnl * 100) / 100
  };
}

export default async () => {
  const now = new Date();
  const predStore = getStore("predictions");
  const residStore = getStore("residuals");
  const paperBetsStore = getStore("paper_bets");
  const paperSettleStore = getStore("paper_settlements");
  const stateStore = getStore("paper_state");

  let kalshiData;
  try {
    kalshiData = await fetchKalshiData();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  const allBets = kalshiData.topBets || [];
  const freshness = kalshiData.freshness || {};

  const captures = [];
  const reconciliations = [];
  const paperCaptures = [];
  const paperSettlements = [];

  // /api/weather is the source of truth for per-city tz, prediction fields, etc.
  const predListData = await (async () => {
    const auth = "Basic " + btoa("internal:hydro");
    const r = await fetch(`${SITE_BASE}/api/weather`, { headers: { authorization: auth } });
    if (!r.ok) return { cities: [] };
    return await r.json();
  })();

  for (const city of predListData.cities || []) {
    if (city.error) continue;
    const tz = city.tz;
    const { date: localDate, hour: localHr } = localDateParts(tz, now);

    // ===== Capture window: peak hour =====
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

        // ===== Paper-trade capture =====
        // Only place paper bets if data is fresh and bets meet minimum edge/Kelly.
        const cityBets = allBets.filter(b =>
          b.city === city.name && b.ev >= MIN_EDGE && b.halfKelly >= MIN_KELLY_FRAC
        );
        const skip = freshness.cacheStale || freshness.forecastStale;
        if (cityBets.length && !skip) {
          const paperRecord = {
            cli: city.cli, name: city.name, localDate, capturedAtUTC: now.toISOString(),
            modelMean: city.mean, modelStd: city.std,
            freshness,
            bankroll: PAPER_BANKROLL,
            bets: cityBets.map(b => {
              const stakeFrac = Math.min(b.halfKelly, MAX_STAKE_FRAC);
              const stake = Math.round(stakeFrac * PAPER_BANKROLL * 100) / 100;
              return {
                ticker: b.ticker, bucket: b.bucket, side: b.side, price: b.price,
                p_model: b.p_model, ev: b.ev, halfKelly: b.halfKelly,
                stake_frac: Math.round(stakeFrac * 1000) / 1000,
                stake_dollars: stake,
                max_payout: Math.round((stake / b.price) * 100) / 100,
                loInt: b.loInt === -Infinity ? null : b.loInt,
                hiInt: b.hiInt === Infinity ? null : b.hiInt
              };
            })
          };
          await paperBetsStore.setJSON(key, paperRecord);
          paperCaptures.push(`${city.cli}:${localDate} (${paperRecord.bets.length} bets)`);
        } else if (cityBets.length && skip) {
          paperCaptures.push(`${city.cli}:${localDate} SKIPPED (stale data)`);
        }
      }
    }

    // ===== Reconciliation window: morning =====
    if (localHr === 7) {
      const yDate = priorLocalDate(tz, now);
      const yKey = `${city.cli}/${yDate}.json`;
      const alreadyDoneResid = await residStore.get(yKey, { type: "json" }).catch(() => null);
      const alreadyDoneSettle = await paperSettleStore.get(yKey, { type: "json" }).catch(() => null);
      if (alreadyDoneResid && alreadyDoneSettle) continue;
      const stored = await predStore.get(yKey, { type: "json" }).catch(() => null);
      if (!stored) continue;
      const cli = await fetchCLIYesterday(city.cli);
      if (!cli || cli.maxF == null || cli.isPartial) continue;

      // Residual reconciliation.
      if (!alreadyDoneResid) {
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

      // Paper bet settlement.
      if (!alreadyDoneSettle) {
        const paperRec = await paperBetsStore.get(yKey, { type: "json" }).catch(() => null);
        if (paperRec && paperRec.bets?.length) {
          const settlements = paperRec.bets.map(b => settleBet(b, cli.maxF));
          const totalStake = settlements.reduce((a, s) => a + s.stake_dollars, 0);
          const totalPnl = settlements.reduce((a, s) => a + s.pnl_dollars, 0);
          await paperSettleStore.setJSON(yKey, {
            cli: city.cli, name: city.name, localDate: yDate,
            actualHigh: cli.maxF, capturedAtUTC: paperRec.capturedAtUTC,
            settledAtUTC: now.toISOString(),
            n_bets: settlements.length,
            totalStake_dollars: Math.round(totalStake * 100) / 100,
            totalPnl_dollars: Math.round(totalPnl * 100) / 100,
            settlements
          });
          paperSettlements.push(`${city.cli}:${yDate} ${settlements.length} bets staked=$${totalStake.toFixed(2)} pnl=$${totalPnl.toFixed(2)}`);

          // Update running paper-state.
          const state = (await stateStore.get("global", { type: "json" }).catch(() => null)) || {
            startedAtUTC: now.toISOString(),
            n_bets: 0, n_wins: 0,
            total_staked: 0, total_pnl: 0,
            cities_seen: []
          };
          state.n_bets += settlements.length;
          state.n_wins += settlements.filter(s => s.outcome === "WIN").length;
          state.total_staked += totalStake;
          state.total_pnl += totalPnl;
          if (!state.cities_seen.includes(city.cli)) state.cities_seen.push(city.cli);
          state.lastUpdatedUTC = now.toISOString();
          state.win_rate = state.n_bets ? state.n_wins / state.n_bets : 0;
          state.roi = state.total_staked ? state.total_pnl / state.total_staked : 0;
          await stateStore.setJSON("global", state);
        }
      }
    }
  }

  return new Response(JSON.stringify({
    ok: true, ranAtUTC: now.toISOString(),
    captures, reconciliations, paperCaptures, paperSettlements
  }), { headers: { "content-type": "application/json" } });
};

export const config = {
  schedule: "5 * * * *"
};
