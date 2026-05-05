// "Andrew Jackson" trader — places REAL Kalshi orders matching the paper-trade rules.
// Runs every 5 min. Dormant if Kalshi env vars not set.
//
// Logic mirror of the paper trader (logger.js):
//   - Read live balance + open positions from Kalshi
//   - Sell positions whose model has flipped negative (would-be losers)
//   - Place new buys for top Kelly-ranked +EV bets, deduped against already-open positions
//   - Bankroll = real Kalshi balance; max 20 concurrent; stake = max($1, balance/20)
//
// Same SAFETY guards as jackson.js: allowlist + denylist on Kalshi endpoints.
// No deposits, withdrawals, or transfers under any circumstance.

import { kalshiAuthedFetch, getBalance, getPositions } from "./jackson.js";
import { getStore } from "@netlify/blobs";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
// Up to 20 concurrent positions, each on a DIFFERENT market. Threshold-gated so
// the bot fires fewer if signals don't qualify — never 20 at once unless all great.
const MAX_CONCURRENT = 20;
// High-conviction floor: net-of-fee edge ≥ 10¢ AND halfKelly ≥ 5%. Model RMSE is
// ~1.7°F so anything below this is likely noise.
// Audit on 2026-05-04 of bot's first 28 settled positions: 3 wins (10.7%), all on
// high-conviction NO bets at 45-85¢. Cheap-tail YES (≤10¢) hit rate was 0/8.
// Tightened from 0.10/0.05 to 0.20/0.10 to filter out the cold-mean-tail-YES pattern
// that lost ~$50 over May 2-3 by pricing left-tail outcomes the model couldn't actually
// hit (model was running 1.5-2.3°F cold across cities).
const MIN_EDGE = 0.20;
const MIN_HALF_KELLY = 0.10;
const PER_CITY_FRESHNESS_MAX_MIN = 180;
// Don't re-enter a ticker+side within this window after selling it.
const COOLDOWN_MIN = 60;
// Sell-loser hysteresis. Require expected hold value to be at least this fraction
// below the sell-now proceeds before paying round-trip fees on a flip.
const SELL_HYSTERESIS = 0.10;
// Stake = halfKelly × bankroll, floored at $1 and capped at 10% of bankroll.
// At $20 bankroll: stake range $1–$2. At $200: $1–$20. Conviction-weighted.
const STAKE_FLOOR = 1.0;
const STAKE_CEIL_FRAC = 0.10;

// Parse a B-bucket ticker code into integer outcome range. Only B-prefix is
// safely parseable from the code alone — T-prefix is direction-ambiguous (Kalshi
// uses it for both left tails "≤ N-1" and right tails "≥ N+1"), so for T-buckets
// callers MUST provide explicit loInt/hiInt rather than relying on this function.
// B<N>.5 = "[N, N+1]" (middle bucket, integer span). Subtitle "59° to 60°" for B59.5.
function bucketToRange(bucket) {
  if (!bucket || typeof bucket !== "string") return null;
  if (bucket.startsWith("B")) {
    const v = parseFloat(bucket.slice(1));
    if (!Number.isFinite(v)) return null;
    const lo = Math.floor(v);
    return { lo, hi: lo + 1 };
  }
  return null;
}

// Does bet win at integer outcome x? Prefers explicit numeric bounds (loInt/hiInt)
// when carried on the bet — these are always correct for both T-less and T-greater
// buckets. Falls back to bucketToRange for B-buckets when explicit bounds aren't
// available. Returns false for T-buckets without explicit bounds (caller bug).
// Bounds use ±Infinity (kalshi.js) or null (JSON-roundtripped) for unbounded ends.
// Previous bug: passed b.bucket (human label like "48–49°F") which silently failed parse
// and made every bet appear to "lose at every x", over-firing tile-conflict skips.
function betWinsAt(bet, x) {
  let lo, hi;
  if (bet.loInt !== undefined || bet.hiInt !== undefined) {
    lo = (bet.loInt == null || bet.loInt === -Infinity) ? null : bet.loInt;
    hi = (bet.hiInt == null || bet.hiInt === Infinity)  ? null : bet.hiInt;
  } else {
    const r = bucketToRange(bet.ticker);
    if (!r) return false;
    lo = r.lo; hi = r.hi;
  }
  const inRange = (lo == null || x >= lo) && (hi == null || x <= hi);
  // Case-insensitive: kalshi.js emits "YES"/"NO" uppercase, seed loop emits lowercase.
  return bet.side?.toLowerCase() === "yes" ? inRange : !inRange;
}

// Bucket-rounding-boundary margin for NO bets that lean on already-observed extremes.
// CLI rounds to integer °F; B-bucket "[N, N+1]" catches any continuous CLI in [N-0.5, N+1.5).
// For LOW NO: daily low ≤ minSoFar. To win, CLI must be < N-0.5 (rounds below bucket) OR
//   > N+1.5 (rounds above bucket). Since low ≤ minSoFar, the achievable side is below.
//   Margin = (N - 0.5) - minSoFar. Negative or thin margin = high upset risk.
// For HIGH NO: symmetric on the upper side. Margin = maxSoFar - (N + 1.5).
// Returns null only when truly inapplicable (no observation yet, wrong bucket type).
// 2026-05-04: previous version bailed out when observation was inside/above the bucket;
// that missed the CHI low B48.5 NO failure mode where minSoFar landed inside the bucket.
const BUCKET_MARGIN_MIN_F = 0.6;
function bucketBoundaryMargin(b, weatherCity) {
  if (b.side?.toLowerCase() !== "no") return null;  // kalshi.js emits uppercase "NO"
  const code = b.ticker;
  if (!code || !code.startsWith("B")) return null;
  const v = parseFloat(code.slice(1));
  if (!Number.isFinite(v)) return null;
  const N = Math.floor(v);  // continuous bucket = [N - 0.5, N + 1.5) after rounding
  // The filter targets the "near-arb" failure mode where the already-observed extremum
  // sits in or right below the bucket's rounding boundary, making the bet structurally
  // dangerous regardless of model probability. For observations far away, the model
  // drives — return null and don't filter.
  if (b.variable === "low") {
    const m = weatherCity?.minSoFar;
    if (m == null) return null;
    if (m >= N + 1.5) return null;  // minSoFar far above bucket — not the near-arb shape
    if (m >= N - 0.5) return -Math.abs(N - 0.5 - m) - 0.01;  // minSoFar in/at bucket → neg margin (reject)
    return (N - 0.5) - m;  // minSoFar safely below bucket → return margin (must exceed threshold)
  }
  if (b.variable === "high" || !b.variable) {
    const m = weatherCity?.maxSoFar;
    if (m == null) return null;
    if (m <= N - 0.5) return null;  // maxSoFar far below bucket — not the near-arb shape
    if (m <= N + 1.5) return -Math.abs(m - (N + 1.5)) - 0.01;  // maxSoFar in/at bucket → neg margin (reject)
    return m - (N + 1.5);  // maxSoFar safely above bucket → return margin
  }
  return null;
}

// Tile-coverage check: would adding `candidate` to `committed` create a dual-loss zone
// inside the model's high-density region? Returns {ok: true} or {ok: false, reason}.
// High-density = within ±1.5σ of model mean. Catches the CHI-lows-on-2026-05-03 trap
// (T45 YES + B44.5 NO both lose at 45) and the AUS-2026-05-03 trap (T76 YES + B76.5 YES
// both lose at 80, where model mean was 78).
function tileConflict(candidate, committed) {
  if (!committed || committed.length === 0) return { ok: true };
  const mean = candidate.modelMean;
  const std = Math.max(0.4, candidate.modelStd || 1.0);
  if (!Number.isFinite(mean)) return { ok: true };
  const lo = Math.round(mean - 1.5 * std);
  const hi = Math.round(mean + 1.5 * std);
  for (let x = lo; x <= hi; x++) {
    const candWins = betWinsAt(candidate, x);
    if (candWins) continue;  // candidate would win here — fine
    const allCommittedLose = committed.every(b => !betWinsAt(b, x));
    if (allCommittedLose) {
      return { ok: false, reason: `dual-loss-at-${x}F (model ${mean.toFixed(1)}±${std.toFixed(1)})` };
    }
  }
  return { ok: true };
}

async function fetchInternal(path) {
  const auth = "Basic " + btoa("internal:hydro");
  const r = await fetch(`${SITE_BASE}${path}`, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return await r.json();
}

// Place a buy order via Kalshi. Returns the order response.
// Kalshi prices are integer cents 1-99. Stake comes through `count` (number of contracts).
async function placeBuyOrder(ticker, side, count, priceCents) {
  const body = {
    action: "buy",
    side: side.toLowerCase(),       // "yes" or "no"
    ticker,
    count: Math.max(1, Math.round(count)),
    type: "limit",
    [side.toLowerCase() === "yes" ? "yes_price" : "no_price"]: priceCents,
    expiration_ts: Math.floor(Date.now() / 1000) + 60 * 5,  // 5-minute IOC-ish
    client_order_id: `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
  const r = await kalshiAuthedFetch("POST", "/trade-api/v2/portfolio/orders", body);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

// Place a sell order to close an existing position.
async function placeSellOrder(ticker, side, count, priceCents) {
  const body = {
    action: "sell",
    side: side.toLowerCase(),
    ticker,
    count: Math.max(1, Math.round(count)),
    type: "limit",
    [side.toLowerCase() === "yes" ? "yes_price" : "no_price"]: priceCents,
    expiration_ts: Math.floor(Date.now() / 1000) + 60 * 5,
    client_order_id: `wb-sell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
  const r = await kalshiAuthedFetch("POST", "/trade-api/v2/portfolio/orders", body);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

export default async () => {
  if (!process.env.KALSHI_ACCESS_KEY_ID || !process.env.KALSHI_PRIVATE_KEY) {
    return new Response(JSON.stringify({ ok: true, dormant: true,
      message: "Real-trader dormant: KALSHI_ACCESS_KEY_ID/KALSHI_PRIVATE_KEY not set" }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
  // Hard arm-switch: real trading only fires when KALSHI_TRADING_LIVE === "true".
  // Without this, the trader is paused even if creds are present. Lets us land
  // safety changes without immediately firing real orders.
  const liveFlag = (process.env.KALSHI_TRADING_LIVE || "").trim().toLowerCase();
  // Distinguish "paused" (kill switch off) from "dry-run" mode. In dry-run we still execute
  // the placement loop (computing all skip/place decisions) but don't call Kalshi to actually
  // submit orders. This lets us instrument the bucket-margin filter etc. without trading.
  const isLive = ["true", "1", "yes", "on", "live"].includes(liveFlag);
  const isDryRun = !isLive && ["dryrun", "dry-run", "shadow"].includes(liveFlag);
  if (!isLive && !isDryRun) {
    return new Response(JSON.stringify({ ok: true, paused: true,
      flagValueSeen: liveFlag ? "(non-empty but not truthy)" : "(empty/unset)",
      message: "Real-trader paused: KALSHI_TRADING_LIVE must be 'true' (or 1/yes/on/live). Set to 'dryrun' for instrumentation-only mode." }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }

  const placements = [], sales = [], errors = [], skipped = [];
  const ledgerStore = getStore("jackson_open_bets");
  const cooldownStore = getStore("jackson_cooldown");
  try {
    // 1. Read live state from Kalshi + bot ledger + cooldown map.
    const [balance, positionsResp, kalshiData, weatherData, { blobs: ledgerBlobs }, cooldownRaw] = await Promise.all([
      getBalance(),
      getPositions(),
      fetchInternal("/api/kalshi"),
      fetchInternal("/api/weather"),
      ledgerStore.list().catch(() => ({ blobs: [] })),
      cooldownStore.get("map.json", { type: "json" }).catch(() => ({}))
    ]);
    // Prune expired cooldown entries.
    const cooldownMap = cooldownRaw || {};
    const nowMs = Date.now();
    const cooldownMs = COOLDOWN_MIN * 60 * 1000;
    for (const k of Object.keys(cooldownMap)) {
      if (nowMs - new Date(cooldownMap[k]).getTime() > cooldownMs) delete cooldownMap[k];
    }

    const cashCents = balance.balance ?? 0;          // Kalshi returns balance in cents
    const cashDollars = cashCents / 100;
    // Normalize Kalshi position fields. Real fields: position_fp (string of float;
    // sign = direction), market_exposure_dollars (string), realized_pnl_dollars (string).
    const positions = (positionsResp.market_positions || []).map(p => ({
      ...p,
      qty: parseFloat(p.position_fp || "0"),
      exposure: parseFloat(p.market_exposure_dollars || "0"),
      realizedPnl: parseFloat(p.realized_pnl_dollars || "0")
    }));
    const allOpenCount = positions.filter(p => p.qty !== 0).length;

    // Bot ledger: entries we placed. Sell-loser logic ONLY iterates these.
    // User's pre-existing positions are off-limits.
    const ledger = (await Promise.all(
      ledgerBlobs.map(b => ledgerStore.get(b.key, { type: "json" }).catch(() => null))
    )).filter(Boolean);
    const botKey = (ticker, side) => `${ticker}-${side}`;

    // Reconcile: remove ledger entries for positions Kalshi no longer has (settled/sold).
    const heldByKalshi = new Set();
    for (const p of positions) {
      if (p.qty > 0) heldByKalshi.add(botKey(p.ticker, "YES"));
      if (p.qty < 0) heldByKalshi.add(botKey(p.ticker, "NO"));
    }
    const liveLedger = [];
    for (const entry of ledger) {
      const key = botKey(entry.ticker, entry.side);
      if (heldByKalshi.has(key)) liveLedger.push(entry);
      else await ledgerStore.delete(`${entry.betId}.json`).catch(() => {});
    }
    const botPlacedKeys = new Set(liveLedger.map(e => botKey(e.ticker, e.side)));
    const botOpenCount = liveLedger.length;

    const spareCapacity = Math.max(0, MAX_CONCURRENT - botOpenCount);

    // Buy dedup: union of bot's blob ledger AND Kalshi's authoritative position list.
    // Kalshi positions are eventually-consistent within seconds; the blob ledger lags by
    // up to several minutes due to Netlify Blobs eventual consistency, which previously
    // allowed "double-buy" patterns where the bot bought the same (ticker, side) twice
    // across adjacent cycles before the ledger entry from cycle N was visible in cycle
    // N+1. Including Kalshi-side held positions in the dedup set fixes this.
    // SELL safety: only botPlacedKeys is consulted in the sell loop, so user-placed
    // positions remain off-limits to the sell logic.
    const heldKey = new Set(botPlacedKeys);
    for (const p of positions) {
      if (p.qty > 0) heldKey.add(botKey(p.ticker, "YES"));
      if (p.qty < 0) heldKey.add(botKey(p.ticker, "NO"));
    }

    // 2. Sell would-be losers — ONLY among bot-placed positions.
    if (kalshiData?.cities) {
      const cityIndex = Object.fromEntries(kalshiData.cities.map(c => [c.name, c]));
      for (const p of positions) {
        if (p.qty === 0) continue;
        const ticker = p.ticker;
        const side = p.qty > 0 ? "YES" : "NO";
        if (!botPlacedKeys.has(botKey(ticker, side))) continue;  // SAFETY: skip user-placed
        // Find this market in our Kalshi snapshot to get current bid + model probability.
        let bucket = null, citySide = null;
        for (const c of kalshiData.cities) {
          for (const variant of [c.highBuckets, c.lowBuckets]) {
            if (!variant) continue;
            const found = variant.find(b => ticker.endsWith("-" + b.ticker));
            if (found) { bucket = found; citySide = c; break; }
          }
          if (bucket) break;
        }
        if (!bucket) continue;
        const isYes = p.qty > 0;
        const sellPrice = isYes ? bucket.kalshi_yes_bid : bucket.kalshi_no_bid;
        if (sellPrice == null || sellPrice <= 0) continue;
        const pNow = isYes ? bucket.p_model : (1 - bucket.p_model);
        const contracts = Math.abs(p.qty);
        if (contracts <= 0) continue;
        // Avg entry = total exposure (dollars at risk) / contracts.
        const avgEntry = p.exposure / contracts;
        if (avgEntry <= 0) continue;
        const sellProceeds = contracts * sellPrice;     // dollars (1 contract = $1 max payout)
        const stakePaid = p.exposure;
        const holdEV = contracts * pNow;
        if (sellProceeds >= stakePaid) continue;        // winning vs entry, hold
        if (holdEV >= stakePaid) continue;              // model expects breakeven, hold
        // Hysteresis: only sell if hold value is meaningfully below sell-now value.
        // Avoids paying round-trip Kalshi fees on tiny noise-level model flips.
        if (holdEV >= sellProceeds * (1 - SELL_HYSTERESIS)) continue;
        // SELL. In dry-run, fake the order response.
        const sellPriceCents = Math.max(1, Math.round(sellPrice * 100));
        const res = isDryRun ? { ok: true, body: { dryRun: true } }
                             : await placeSellOrder(ticker, isYes ? "YES" : "NO", contracts, sellPriceCents);
        sales.push({ ticker, side: isYes ? "YES" : "NO", count: contracts, sellPriceCents, dryRun: isDryRun, ok: res.ok });
        if (!res.ok) errors.push({ where: "sell", ticker, response: res.body });
        else if (!isDryRun) cooldownMap[botKey(ticker, isYes ? "YES" : "NO")] = new Date().toISOString();
      }
    }

    // 3. Place new bets.
    if (kalshiData?.topBets && spareCapacity > 0) {
      const fr = kalshiData.freshness || {};
      const cityForecastAge = {};
      for (const c of (weatherData.cities || [])) {
        if (c.forecastUpdateTime) cityForecastAge[c.name] = (Date.now() - new Date(c.forecastUpdateTime).getTime()) / 60000;
      }
      // Threshold gate: high-conviction floor on net edge AND halfKelly. Sorted by
      // halfKelly desc upstream, so iterating fills highest-conviction first.
      const qualifying = (kalshiData.topBets || []).filter(b => b.ev >= MIN_EDGE && b.halfKelly >= MIN_HALF_KELLY);
      // Skip-reason log so we can see exactly how high vs low were weighed each run.
      // Listed in priority order matching the iteration below.
      const briefBet = b => ({ city: b.city, variable: b.variable || "high", bucket: b.bucket,
                               ticker: b.ticker, side: b.side,
                               ev: Math.round(b.ev*1000)/1000,
                               halfKelly: Math.round(b.halfKelly*1000)/1000,
                               pWin: b.p_model != null ? Math.round(b.p_model*1000)/1000 : null,
                               price: b.price });
      let placed = 0;
      let committed = 0;
      // Track committed bets per event-ticker for tile-coverage checks across the run.
      const committedByEvent = {};
      // Index every kalshi.js bucket by its bucket code (e.g. "T52" → {loInt:53,hiInt:null}),
      // grouped by event ticker. Used by the seed loop below to recover numeric bounds for
      // already-held positions whose botKey only carries the ticker code, not bucket bounds.
      // Without this, betWinsAt() falls back to bucketToRange() which can't disambiguate
      // T-less from T-greater buckets.
      const boundsByEvent = {};
      for (const c of (kalshiData?.cities || [])) {
        for (const variant of [["highEvent", "highBuckets"], ["lowEvent", "lowBuckets"]]) {
          const ev = c[variant[0]];
          const buckets = c[variant[1]];
          if (!ev || ev === "not found" || !Array.isArray(buckets)) continue;
          const idx = boundsByEvent[ev] ??= {};
          for (const bk of buckets) {
            const code = (bk.ticker || "").split("-").pop();
            if (code) idx[code] = { loInt: bk.loInt, hiInt: bk.hiInt };
          }
        }
      }
      // Seed from already-held positions so we don't add a tile-conflicting bet on top
      // of a position we already own from a prior run. botKey format is
      // "<eventTicker>-<bucketCode>-<SIDE>" where SIDE is "YES" or "NO" (suffix).
      // 2026-05-04 bug fix: previous version split on ":" but botKey uses "-".
      for (const heldKey_ of heldKey) {
        const m = heldKey_.match(/^(.+)-(YES|NO)$/);
        if (!m) continue;
        const held_full = m[1];     // e.g. "KXLOWTCHI-26MAY04-B48.5"
        const held_side = m[2];     // "YES" or "NO"
        const lastDash = held_full.lastIndexOf("-");
        if (lastDash < 0) continue;
        const ev = held_full.slice(0, lastDash);
        const bucketCode = held_full.slice(lastDash + 1);
        const bounds = boundsByEvent[ev]?.[bucketCode] || {};
        (committedByEvent[ev] ??= []).push({
          ticker: bucketCode, side: held_side.toLowerCase(),
          loInt: bounds.loInt, hiInt: bounds.hiInt,
          modelMean: NaN, modelStd: 1.0
        });
      }
      for (const b of qualifying) {
        if (placed >= spareCapacity) { skipped.push({ ...briefBet(b), reason: "no-spare-capacity" }); continue; }
        if (cashDollars - committed < STAKE_FLOOR) { skipped.push({ ...briefBet(b), reason: "out-of-cash" }); continue; }
        const ageMin = cityForecastAge[b.city];
        if (ageMin != null && ageMin > PER_CITY_FRESHNESS_MAX_MIN) { skipped.push({ ...briefBet(b), reason: "forecast-stale", ageMin: Math.round(ageMin) }); continue; }
        // Resolve event ticker → full market ticker like KXHIGHNY-26MAY02-B65.5.
        const cityKalshi = (kalshiData.cities || []).find(c => c.name === b.city);
        if (!cityKalshi) { skipped.push({ ...briefBet(b), reason: "city-not-in-kalshi-data" }); continue; }
        const eventTicker = b.variable === "low" ? cityKalshi.lowEvent : cityKalshi.highEvent;
        if (!eventTicker || eventTicker === "not found") { skipped.push({ ...briefBet(b), reason: "event-not-listed-on-kalshi" }); continue; }
        const fullTicker = `${eventTicker}-${b.ticker}`;
        const dedupKey = botKey(fullTicker, b.side);
        if (heldKey.has(dedupKey)) { skipped.push({ ...briefBet(b), reason: "already-held" }); continue; }
        if (cooldownMap[dedupKey]) { skipped.push({ ...briefBet(b), reason: "in-cooldown" }); continue; }
        // Tile-coverage check: skip if buying this on top of already-committed bets in the
        // same event would create a dual-loss zone inside ±1.5σ of model mean.
        const tile = tileConflict(b, committedByEvent[eventTicker]);
        if (!tile.ok) { skipped.push({ ...briefBet(b), reason: "tile-conflict", detail: tile.reason }); continue; }
        // Bucket-rounding-boundary margin: for cheap-tail NO bets that look like near-arbs
        // (observed already rules out the bucket), require ≥0.6°F margin to the CLI rounding
        // boundary. Prevents METAR-vs-CLI integer-rounding upsets where METAR shows e.g.
        // 58.5°F observed and CLI ends up rounding to 59°F → bucket [59,60] triggers → NO loses.
        const cityWeather = (weatherData.cities || []).find(c => c.name === b.city);
        const margin = bucketBoundaryMargin(b, cityWeather);
        // Debug instrumentation: tag every NO-on-B-bucket decision with the margin computation
        // so we can see post-hoc whether the filter saw the right inputs. Removable once verified.
        const marginDebug = (b.side?.toLowerCase() === "no" && b.ticker?.startsWith("B")) ? {
          ticker: b.ticker, variable: b.variable,
          minSoFar: cityWeather?.minSoFar, maxSoFar: cityWeather?.maxSoFar,
          cityName: b.city, weatherCityFound: !!cityWeather,
          computedMargin: margin
        } : null;
        if (margin != null && margin < BUCKET_MARGIN_MIN_F) {
          skipped.push({ ...briefBet(b), reason: "bucket-margin-thin", marginF: margin.toFixed(2), marginDebug });
          continue;
        }
        if (marginDebug) {
          // Attach debug to placement record so we can trace why the filter passed.
          b._marginDebug = marginDebug;
        }
        // Conviction-weighted stake: halfKelly × bankroll, floored & capped, and
        // bounded by the cash actually still available after prior placements in this run.
        const remaining = cashDollars - committed;
        const stake_dollars = Math.max(STAKE_FLOOR,
          Math.min(cashDollars * STAKE_CEIL_FRAC, b.halfKelly * cashDollars, remaining));
        if (stake_dollars < STAKE_FLOOR) break;
        const contracts = Math.max(1, Math.floor(stake_dollars / b.price));
        const priceCents = Math.max(1, Math.min(99, Math.round(b.price * 100)));
        // Dry-run mode: skip Kalshi order submission, fake an "ok" response so the
        // placement is logged for instrumentation purposes.
        const res = isDryRun ? { ok: true, body: { order: { client_order_id: `dryrun-${Date.now()}` }, dryRun: true } }
                             : await placeBuyOrder(fullTicker, b.side, contracts, priceCents);
        // Expected payout = contracts × $1 × p_winning (assuming win pays $1/contract).
        const pWin = b.p_model;  // p_model is set to pNo for NO side, p_yes for YES side
        const expectedPayout = contracts * (Number.isFinite(pWin) ? pWin : 0);
        placements.push({ ticker: fullTicker, side: b.side, count: contracts, priceCents,
                          stake_dollars: Math.round(stake_dollars * 100) / 100,
                          ev: b.ev, halfKelly: b.halfKelly,
                          pWin: pWin != null ? Math.round(pWin * 1000) / 1000 : null,
                          expectedPayout: Math.round(expectedPayout * 100) / 100,
                          marginDebug: b._marginDebug,  // debug instrumentation
                          dryRun: isDryRun,
                          ok: res.ok });
        if (!res.ok) {
          errors.push({ where: "buy", ticker: fullTicker, response: res.body });
          skipped.push({ ...briefBet(b), reason: "kalshi-rejected", detail: res.body?.error?.code || res.body?.error?.message || "unknown" });
        } else {
          placed++;
          committed += stake_dollars;
          // Track for tile-coverage checks against subsequent candidates this run.
          // Use ticker code (e.g., "B48.5"), not human label. Carry numeric bounds so
          // betWinsAt() can resolve T-less vs T-greater without re-parsing the code.
          (committedByEvent[eventTicker] ??= []).push({
            ticker: b.ticker, side: b.side,
            loInt: b.loInt, hiInt: b.hiInt,
            modelMean: b.modelMean, modelStd: b.modelStd
          });
          // Save to bot ledger so future runs know we own this position. Skip in dry-run.
          if (isDryRun) continue;
          const betId = res.body?.order?.client_order_id || `${fullTicker}-${b.side}-${Date.now()}`;
          await ledgerStore.setJSON(`${betId}.json`, {
            betId, ticker: fullTicker, side: b.side, contracts,
            price: b.price, stake_dollars,
            city: b.city, variable: b.variable || "high",
            bucket: b.bucket, ev: b.ev, halfKelly: b.halfKelly,
            modelMean: b.modelMean, modelStd: b.modelStd,
            placedAtUTC: new Date().toISOString(),
            kalshiOrderId: res.body?.order?.order_id || null
          }).catch(err => errors.push({ where: "ledger-write", err: String(err) }));
        }
      }
    }
    // Persist updated cooldown map (sells written above; expired pruned at top).
    await cooldownStore.setJSON("map.json", cooldownMap)
      .catch(err => errors.push({ where: "cooldown-write", err: String(err) }));

    const ranAtUTC = new Date().toISOString();
    const stakeCeil = Math.round(cashDollars * STAKE_CEIL_FRAC * 100) / 100;
    const responseBody = {
      ok: true,
      ranAtUTC,
      cashDollars,
      botOpenCount, allOpenCount,
      spareCapacity,
      stake_floor: STAKE_FLOOR,
      stake_ceil_dollars: stakeCeil,
      sales, placements, skipped, errors
    };

    // Write per-cycle structured log to trader_logs blob. Filename = ISO timestamp.
    // Tail (most recent ~200 entries) read via /api/trader_log.
    try {
      const logStore = getStore("trader_logs");
      await logStore.setJSON(`${ranAtUTC}.json`, {
        ranAtUTC, cashDollars, spareCapacity, stake_ceil: stakeCeil,
        placements: placements.map(p => ({
          ticker: p.ticker, side: p.side, count: p.count, priceCents: p.priceCents,
          stake_dollars: p.stake_dollars, ev: p.ev, halfKelly: p.halfKelly,
          pWin: p.pWin, expectedPayout: p.expectedPayout, ok: p.ok
        })),
        sales: sales.map(s => ({ ticker: s.ticker, side: s.side, count: s.count,
                                   priceCents: s.priceCents, ok: s.ok })),
        skipped: skipped.slice(0, 30),  // cap to avoid huge blobs
        errors: errors.slice(0, 10)
      });
    } catch (logErr) {
      // Don't fail the cycle if logging fails. Log error in errors array on next cycle if persistent.
    }

    return new Response(JSON.stringify(responseBody, null, 2), {
      status: 200, headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false, error: String(e), placements, sales, skipped, errors
    }), { status: 500, headers: { "content-type": "application/json" } });
  }
};

// Same 5-min schedule as paper trader. Will short-circuit if env vars missing.
export const config = { schedule: "*/5 * * * *" };
