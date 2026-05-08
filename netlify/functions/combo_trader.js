// Combo bot — paper-only meta-strategy. Pulls candidate bets from BOTH weatherbot
// (temperature) and rainbot (rain) and fills the highest-conviction picks across
// both pools into a single Đ100 paper bankroll. Every cycle:
//   1. Settle any open positions whose underlying Kalshi market has resolved.
//   2. Fetch weatherbot signals from /api/kalshi (internal auth).
//   3. Fetch rainbot signals from rainbot-mf.netlify.app/api/markets (env-var basic auth).
//   4. Sell any open position whose hold-EV has fallen meaningfully below current bid.
//   5. Rank the union by halfKelly desc, gate on ev≥0.10 + halfKelly≥0.05.
//   6. Place new bets up to 20 concurrent, dedup on (ticker,side), Đ1–Đ5 stake band.
//
// Paper-only. State lives in Netlify Blobs (combo_state, combo_open_bets, combo_settled_bets).
// Future port to real money would mirror jackson_trader.js — same entry/sell logic but
// against the live Kalshi account.

import { getStore } from "@netlify/blobs";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const RAINBOT_BASE = process.env.RAINBOT_BASE_URL || "https://rainbot-mf.netlify.app";
const KALSHI_PUBLIC = "https://api.elections.kalshi.com/trade-api/v2";

const STARTING_BANKROLL = 100;        // Đ100 dollar-bucks
const MAX_CONCURRENT = 20;
const MIN_EDGE = 0.10;                // net EV per Đ1 staked
const MIN_HALF_KELLY = 0.05;
const STAKE_FLOOR = 1.0;
const STAKE_CEIL = 5.0;               // Đ5 hard cap = same as rainbot's MAX_STAKE
// Sell hysteresis: only sell when model expected payout has fallen this much below
// the current market bid. 0.15 = sell when holdEV < 0.85 × sellProceeds. Tighter than
// jackson_trader's 0.20 because paper bot pays no fees, but loose enough to ignore
// per-cycle model wiggle.
const SELL_HYSTERESIS = 0.15;

async function fetchInternalKalshi() {
  const auth = "Basic " + btoa("internal:hydro");
  const r = await fetch(`${SITE_BASE}/api/kalshi`, {
    headers: { authorization: auth }, signal: AbortSignal.timeout(20_000)
  });
  if (!r.ok) throw new Error(`weatherbot kalshi ${r.status}`);
  return await r.json();
}

async function fetchRainbotMarkets() {
  const auth = process.env.RAINBOT_BASIC_AUTH;
  if (!auth) return { error: "RAINBOT_BASIC_AUTH env var not set — rain signals unavailable" };
  const headers = auth.startsWith("Basic ") ? { authorization: auth }
                                             : { authorization: `Basic ${auth}` };
  try {
    const r = await fetch(`${RAINBOT_BASE}/api/markets`, {
      headers, signal: AbortSignal.timeout(28_000)
    });
    if (!r.ok) return { error: `rainbot markets ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: `rainbot fetch failed: ${String(e)}` };
  }
}

// Public Kalshi market lookup — no auth needed for read-only market state.
// Returns "yes" / "no" if resolved, null otherwise.
async function getMarketResultPublic(ticker) {
  try {
    const r = await fetch(`${KALSHI_PUBLIC}/markets/${ticker}`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000)
    });
    if (!r.ok) return null;
    const j = await r.json();
    const result = j?.market?.result;
    return (result === "yes" || result === "no") ? result : null;
  } catch (e) { return null; }
}

// Normalize weatherbot topBets entries into the common candidate shape.
// weatherbot ticker is a short bucket code; compose full ticker with eventTicker.
//
// Carries through every field the protective gates need: bucket-suffix `ticker`
// (e.g., "B62.5" or "T60") for parsing, `eventTicker` for tile-conflict grouping,
// and `loInt`/`hiInt` for the tail gate's bucket-bound detection.
function normalizeWeatherbot(kalshiData) {
  if (!kalshiData?.topBets || !kalshiData?.cities) return [];
  const eventByCity = {};
  for (const c of kalshiData.cities) {
    eventByCity[`${c.name}-high`] = c.highEvent;
    eventByCity[`${c.name}-low`]  = c.lowEvent;
  }
  return kalshiData.topBets.map(b => {
    const ev = eventByCity[`${b.city}-${b.variable || "high"}`];
    if (!ev || ev === "not found") return null;
    const fullTicker = `${ev}-${b.ticker}`;
    return {
      source: "weather",
      city: b.city,
      variable: b.variable || "high",
      bucket: b.bucket || b.ticker,
      label: `${b.city} ${b.variable || "high"} ${b.bucket || b.ticker}`,
      ticker: b.ticker,           // bucket suffix only ("B62.5", "T60") — gate functions parse this
      eventTicker: ev,            // for tile/cooldown grouping
      fullTicker,
      side: b.side,
      price: b.price,
      pModel: b.p_model,
      ev: b.ev,
      halfKelly: b.halfKelly,
      // Bucket bounds + model context — needed by tail-obs-floor + tile-conflict gates.
      loInt: b.loInt, hiInt: b.hiInt,
      modelMean: b.modelMean, modelStd: b.modelStd
    };
  }).filter(Boolean);
}

// Build a fullTicker → { yes_bid, no_bid, p_yes_model } lookup from both source feeds.
// Used by the sell loop to mark-to-market every open position regardless of source.
// Tolerant of missing data — partial lookup is better than none.
function buildMarketSnapshot(kalshiData, rainMarkets) {
  const lookup = {};
  if (kalshiData?.cities) {
    for (const c of kalshiData.cities) {
      for (const arr of [c.highBuckets, c.lowBuckets]) {
        if (!arr) continue;
        for (const b of arr) {
          if (!b.ticker) continue;
          lookup[b.ticker] = { yes_bid: b.yes_bid, no_bid: b.no_bid, p_yes_model: b.p_model };
        }
      }
    }
  }
  if (rainMarkets?.cities) {
    for (const c of rainMarkets.cities) {
      for (const sec of [c.daily, c.monthly]) {
        if (!sec?.bets) continue;
        // rainbot emits one record per (ticker, side); group them so we have both bids
        // and the YES-side p_model on a single entry.
        for (const b of sec.bets) {
          if (!b.ticker) continue;
          const e = lookup[b.ticker] ??= {};
          e.yes_bid = b.yes_bid; e.no_bid = b.no_bid;
          if (b.side === "YES") e.p_yes_model = b.p_model;
          else if (b.side === "NO" && e.p_yes_model == null) e.p_yes_model = 1 - b.p_model;
        }
      }
    }
  }
  return lookup;
}

function normalizeRainbot(markets) {
  if (!markets?.topBets) return [];
  return markets.topBets.map(b => ({
    source: "rain",
    city: b.city,
    variable: b.kind === "monthly-tier" ? "monthly-rain" : "daily-rain",
    bucket: b.bucket,
    label: `${b.city} ${b.kind === "monthly-tier" ? "monthly" : "daily"} ${b.bucket}`,
    fullTicker: b.ticker,
    side: b.side,
    price: b.price,
    pModel: b.p_model,
    ev: b.ev_net,
    halfKelly: b.halfKelly,
    threshold: b.threshold,
    kind: b.kind
  }));
}

// State store now holds only started_at (a once-written timestamp for display). All other
// "state" — bankroll, totals, per-source aggregates — is derived from open + settled blobs
// at read time. See combo.js for the same shift. The denormalized counter approach was
// drift-prone: scheduled-function timeouts would settle bets (write to settledStore) but
// time out before persisting the global state counter, leaving aggregates stuck at the
// initial values. Deriving from blobs makes partial cycles self-healing.
async function loadStartedAt(store) {
  const v = await store.get("global", { type: "json" }).catch(() => null);
  return v?.started_at ?? null;
}
async function ensureStartedAt(store) {
  const cur = await loadStartedAt(store);
  if (cur) return cur;
  const startedAt = new Date().toISOString();
  await store.setJSON("global", { started_at: startedAt }).catch(() => {});
  return startedAt;
}

// ---- Protective gates ported from jackson_trader.js (2026-05-08) ----
// Combo bot was running a naive ranker over the same weather signal pool that
// jackson_trader uses; with no defenses, it caught all the failure modes
// jackson_trader filters (CLI rounding boundaries, frontal-drop tail YES,
// diurnal-passed B-bucket YES, model-thrash on consecutive runs). 2-day result:
// combo went 2/8 (25%) on weather signals while jackson's paper was 3/4 (75%)
// over a comparable period. These gates mirror jackson_trader's calibrated
// thresholds. Apply ONLY to weather-source candidates — rain has separate
// resolution mechanics and goes through rainbot's own ranking.

const BUCKET_MARGIN_MIN_F = 0.6;       // B-NO bucket-margin threshold
const BUCKET_YES_MARGIN_MIN_F = 1.5;   // B-YES in-bucket headroom threshold
const BUCKET_TAIL_OBS_GAP_MAX_F = 1.5; // T-tail YES drop/rise-needed threshold
const BUCKET_ABOVE_OBS_GAP_MAX_F = 0.4; // B-YES above-obs drop-needed threshold
const BUY_CITYVAR_COOLDOWN_MIN = 60;   // city+variable lockout after a buy

const cityVarKey = (city, variable) => `cv:${city}:${variable}`;

// B-bucket margin: catches bets where the already-observed extremum sits in a
// structurally dangerous zone of the bucket. NO requires ≥0.6°F headroom (CLI rounding);
// YES requires ≥1.5°F headroom (frontal drops past minSoFar can move further).
function bucketBoundaryMargin(b, weatherCity) {
  const side = b.side?.toLowerCase();
  if (side !== "yes" && side !== "no") return null;
  const code = b.ticker;
  if (!code || !code.startsWith("B")) return null;
  const v = parseFloat(code.slice(1));
  if (!Number.isFinite(v)) return null;
  const N = Math.floor(v);

  if (b.variable === "low") {
    const m = weatherCity?.minSoFar;
    if (m == null) return null;
    if (side === "no") {
      if (m >= N + 1.5) return null;
      if (m >= N - 0.5) return -Math.abs(N - 0.5 - m) - 0.01;
      return (N - 0.5) - m;
    }
    if (m >= N + 1.5) return null;
    if (m < N - 0.5) return -Math.abs(N - 0.5 - m) - 0.01;
    return m - (N - 0.5);
  }
  if (b.variable === "high") {
    const m = weatherCity?.maxSoFar;
    if (m == null) return null;
    if (side === "no") {
      if (m <= N - 0.5) return null;
      if (m <= N + 1.5) return -Math.abs(m - (N + 1.5)) - 0.01;
      return m - (N + 1.5);
    }
    if (m <= N - 0.5) return null;
    if (m > N + 1.5) return -Math.abs(m - (N + 1.5)) - 0.01;
    return (N + 1.5) - m;
  }
  return null;
}

// T-tail obs-vs-boundary gate. YES → gapF (residual drop/rise needed to reach the tail).
// NO → safetyMargin (room above/below tail before bet flips to auto-loss). Tail bounds
// in JSON are null after JSON.stringify of ±Infinity. NO branch added 2026-05-08 after
// PHX T69 NO at 30¢ lost on already-past minSoFar.
function tailBucketObsGap(b, weatherCity) {
  const side = b.side?.toLowerCase();
  if (side !== "yes" && side !== "no") return null;
  const code = b.ticker;
  if (!code || !code.startsWith("T")) return null;
  const lo = b.loInt, hi = b.hiInt;

  if (b.variable === "low") {
    const m = weatherCity?.minSoFar;
    if (m == null) return null;
    if (lo == null && Number.isFinite(hi)) {
      const boundary = hi + 0.5;
      if (side === "yes") {
        const gapF = Math.max(0, m - boundary);
        return { variable: "low", side: "yes", obs: m, boundary, gapF, kind: "drop-needed" };
      }
      const safetyMargin = m - boundary;
      return { variable: "low", side: "no", obs: m, boundary, safetyMargin, kind: "no-margin-above-tail" };
    }
    return null;
  }
  if (b.variable === "high") {
    const m = weatherCity?.maxSoFar;
    if (m == null) return null;
    if (hi == null && Number.isFinite(lo)) {
      const boundary = lo - 0.5;
      if (side === "yes") {
        const gapF = Math.max(0, boundary - m);
        return { variable: "high", side: "yes", obs: m, boundary, gapF, kind: "rise-needed" };
      }
      const safetyMargin = boundary - m;
      return { variable: "high", side: "no", obs: m, boundary, safetyMargin, kind: "no-margin-below-tail" };
    }
    return null;
  }
  return null;
}

// B-bucket "obs already past bucket" gate for LOW YES. minSoFar above the bucket's upper
// edge means a residual drop is needed AND must land in a 1°F window — strictly harder
// than a tail bet, hence the tighter 0.4°F threshold. LOW only (HIGH version would need
// post-peak detection — at sunrise, maxSoFar << forecast high is normal, not a signal).
function bucketAboveObsGap(b, weatherCity) {
  const side = b.side?.toLowerCase();
  if (side !== "yes") return null;
  if (b.variable !== "low") return null;
  const code = b.ticker;
  if (!code || !code.startsWith("B")) return null;
  const v = parseFloat(code.slice(1));
  if (!Number.isFinite(v)) return null;
  const N = Math.floor(v);

  const m = weatherCity?.minSoFar;
  if (m == null) return null;
  if (m < N + 1.5) return null;
  const boundary = N + 1.5;
  const gapF = m - boundary;
  return { variable: "low", side: "yes", obs: m, boundary, gapF, kind: "drop-needed-to-enter" };
}

// Compute live bankroll as: starting bankroll + realized P&L on settled bets − stake
// currently locked in open bets. Mirrors combo.js's derivation so trader and reader agree.
function deriveBankroll(openBets, settledBets) {
  const settledPnl = settledBets.reduce((a, s) => a + (s.pnl_dollars || 0), 0);
  const openStake = openBets.reduce((a, b) => a + (b.stake_dollars || 0), 0);
  return Math.round((STARTING_BANKROLL + settledPnl - openStake) * 100) / 100;
}

export default async () => {
  const stateStore    = getStore("combo_state");
  const openStore     = getStore("combo_open_bets");
  const settledStore  = getStore("combo_settled_bets");
  const cooldownStore = getStore("combo_cooldown");
  const logStore      = getStore("combo_logs");

  const errors = [];
  const settledThisCycle = [];
  const placements = [];
  const skipped = [];

  // ---- Settle resolved positions first ----
  // Load opens AND settleds together — both are needed to derive bankroll for stake-sizing
  // later in this cycle. (settledBets is read-only here; we only append to it.)
  const [{ blobs: openBlobs }, { blobs: settledBlobs }, startedAt, cooldownRaw] = await Promise.all([
    openStore.list().catch(() => ({ blobs: [] })),
    settledStore.list().catch(() => ({ blobs: [] })),
    ensureStartedAt(stateStore),
    cooldownStore.get("global", { type: "json" }).catch(() => null)
  ]);
  // Prune expired cv-cooldown entries (older than BUY_CITYVAR_COOLDOWN_MIN minutes).
  const cooldownMap = {};
  const cooldownCutoff = Date.now() - BUY_CITYVAR_COOLDOWN_MIN * 60 * 1000;
  for (const [k, ts] of Object.entries(cooldownRaw || {})) {
    if (new Date(ts).getTime() >= cooldownCutoff) cooldownMap[k] = ts;
  }
  const [openBets, settledBets] = await Promise.all([
    Promise.all(openBlobs.map(b => openStore.get(b.key, { type: "json" }).catch(() => null)))
      .then(arr => arr.filter(Boolean)),
    Promise.all(settledBlobs.map(b => settledStore.get(b.key, { type: "json" }).catch(() => null)))
      .then(arr => arr.filter(Boolean))
  ]);

  // Query Kalshi result in parallel for each open position.
  const results = await Promise.all(openBets.map(b => getMarketResultPublic(b.fullTicker)));
  for (let i = 0; i < openBets.length; i++) {
    const bet = openBets[i];
    const result = results[i];
    if (result !== "yes" && result !== "no") continue;
    const sideLower = (bet.side || "").toLowerCase();
    const won = (sideLower === result);
    // Contract pays $1 if won, $0 if lost. Stake_dollars / price = contracts held.
    const contracts = bet.contracts || (bet.price > 0 ? bet.stake_dollars / bet.price : 0);
    const realized = won ? (contracts * 1.0) - bet.stake_dollars : -bet.stake_dollars;
    const settledRecord = {
      ...bet,
      settledAtUTC: new Date().toISOString(),
      outcome: won ? "WIN" : "LOSS",
      marketResult: result,
      pnl_dollars: Math.round(realized * 100) / 100
    };
    await settledStore.setJSON(`${bet.betId}.json`, settledRecord)
      .catch(err => errors.push({ where: "settled-write", betId: bet.betId, err: String(err) }));
    await openStore.delete(`${bet.betId}.json`).catch(() => {});
    settledThisCycle.push(settledRecord);
    settledBets.push(settledRecord);
  }

  // ---- Refresh open list after settling, then fetch fresh signals ----
  let remainingOpen = openBets.filter(b =>
    !settledThisCycle.find(s => s.betId === b.betId)
  );

  let weatherCands = [], rainCands = [];
  let rainErr = null, weatherErr = null;
  let weatherData = null, rainData = null;
  try {
    weatherData = await fetchInternalKalshi();
    weatherCands = normalizeWeatherbot(weatherData);
  } catch (e) { weatherErr = String(e); errors.push({ where: "weatherbot-fetch", err: weatherErr }); }
  const rb = await fetchRainbotMarkets();
  if (rb.error) { rainErr = rb.error; errors.push({ where: "rainbot-fetch", err: rainErr }); }
  else { rainData = rb; rainCands = normalizeRainbot(rb); }

  // ---- Sell open positions whose hold-EV has fallen below current bid ----
  // Mark-to-market via the freshly-fetched snapshots. Tolerant of one-side fetch
  // failure: snapshot built from whatever feed succeeded. Sells return cash to bankroll
  // immediately so freed capacity is available for new placements this cycle.
  const sells = [];
  const snapshot = buildMarketSnapshot(weatherData, rainData);
  for (const bet of remainingOpen) {
    const m = snapshot[bet.fullTicker];
    if (!m) continue;
    const isYes = bet.side === "YES";
    const sellPrice = isYes ? m.yes_bid : m.no_bid;
    if (sellPrice == null || sellPrice <= 0) continue;
    if (m.p_yes_model == null) continue;
    const pNow = isYes ? m.p_yes_model : (1 - m.p_yes_model);
    const contracts = bet.contracts || (bet.price > 0 ? bet.stake_dollars / bet.price : 0);
    if (contracts <= 0) continue;
    const sellProceeds = contracts * sellPrice;
    const holdEV = contracts * pNow;
    // Forward-only criterion. Stake is sunk cost; compare model EV to what market pays now.
    if (holdEV >= sellProceeds * (1 - SELL_HYSTERESIS)) continue;
    const realized = sellProceeds - bet.stake_dollars;
    const settledRecord = {
      ...bet,
      settledAtUTC: new Date().toISOString(),
      outcome: "SOLD",
      sell_price: Math.round(sellPrice * 1000) / 1000,
      sell_proceeds: Math.round(sellProceeds * 100) / 100,
      pnl_dollars: Math.round(realized * 100) / 100,
      p_model_at_sell: Math.round(pNow * 1000) / 1000
    };
    await settledStore.setJSON(`${bet.betId}.json`, settledRecord)
      .catch(err => errors.push({ where: "sold-write", betId: bet.betId, err: String(err) }));
    await openStore.delete(`${bet.betId}.json`).catch(() => {});
    sells.push(settledRecord);
    settledBets.push(settledRecord);
  }
  if (sells.length > 0) {
    const soldIds = new Set(sells.map(s => s.betId));
    remainingOpen = remainingOpen.filter(b => !soldIds.has(b.betId));
  }

  const heldKeys = new Set(remainingOpen.map(b => `${b.fullTicker}|${b.side}`));
  const spareCapacity = Math.max(0, MAX_CONCURRENT - remainingOpen.length);

  // ---- Combine & rank candidate pool ----
  const allCands = [...weatherCands, ...rainCands]
    .filter(c => Number.isFinite(c.ev) && Number.isFinite(c.halfKelly))
    .sort((a, b) => b.halfKelly - a.halfKelly);

  // Bankroll for stake-sizing: derived from settled P&L minus stake locked in (post-settle,
  // post-sell) opens. As placements happen below, we deduct each new stake from a local
  // running counter — no persisted state mutation involved.
  const baselineBankroll = deriveBankroll(remainingOpen, settledBets);
  let placed = 0;
  let stakeAddedThisCycle = 0;
  const cashFree = () => Math.round((baselineBankroll - stakeAddedThisCycle) * 100) / 100;

  for (const c of allCands) {
    if (placed >= spareCapacity) { skipped.push({ ...c, reason: "no-spare-capacity" }); continue; }
    if (c.ev < MIN_EDGE) { skipped.push({ ...c, reason: "edge-below-gate" }); continue; }
    if (c.halfKelly < MIN_HALF_KELLY) { skipped.push({ ...c, reason: "halfKelly-below-gate" }); continue; }
    const dedupKey = `${c.fullTicker}|${c.side}`;
    if (heldKeys.has(dedupKey)) { skipped.push({ ...c, reason: "already-held" }); continue; }

    // City+variable cooldown: catches model-thrash patterns (different strike, different
    // side, but same city/variable bought within the last hour). Mirrors jackson_trader's
    // BUY_CITYVAR_COOLDOWN_MIN guard.
    const cvLockKey = cityVarKey(c.city, c.variable);
    if (cooldownMap[cvLockKey]) {
      skipped.push({ ...c, reason: "city-var-cooldown",
                     lockedSince: cooldownMap[cvLockKey], lockKey: cvLockKey });
      continue;
    }

    // Weather-source protective gates. Skip these for rain candidates (rain has different
    // resolution mechanics — daily binary or monthly accumulation, no diurnal min/max).
    if (c.source === "weather") {
      const cityWeather = (weatherData?.cities || []).find(x => x.name === c.city);

      // B-bucket margin: NO 0.6°F threshold, YES 1.5°F.
      const margin = bucketBoundaryMargin(c, cityWeather);
      const marginThreshold = c.side?.toLowerCase() === "yes" ? BUCKET_YES_MARGIN_MIN_F : BUCKET_MARGIN_MIN_F;
      if (margin != null && margin < marginThreshold) {
        skipped.push({ ...c, reason: "bucket-margin-thin",
                       marginF: margin.toFixed(2), thresholdF: marginThreshold });
        continue;
      }

      // T-tail obs-floor / obs-ceiling gate. YES: skip when drop/rise required exceeds
      // BUCKET_TAIL_OBS_GAP_MAX_F. NO: skip when safety margin from boundary is below
      // the same threshold.
      const tailGap = tailBucketObsGap(c, cityWeather);
      if (tailGap && tailGap.side === "yes" && tailGap.gapF > BUCKET_TAIL_OBS_GAP_MAX_F) {
        skipped.push({ ...c, reason: "tail-obs-floor",
                       gapF: tailGap.gapF.toFixed(2), thresholdF: BUCKET_TAIL_OBS_GAP_MAX_F });
        continue;
      }
      if (tailGap && tailGap.side === "no" && tailGap.safetyMargin < BUCKET_TAIL_OBS_GAP_MAX_F) {
        skipped.push({ ...c, reason: "tail-obs-ceiling",
                       safetyMarginF: tailGap.safetyMargin.toFixed(2),
                       thresholdF: BUCKET_TAIL_OBS_GAP_MAX_F });
        continue;
      }

      // B-bucket above-obs YES gate (LOW only): drop required to enter a bucket already
      // below minSoFar. Catches the diurnal-min-passed failure mode.
      const bucketGap = bucketAboveObsGap(c, cityWeather);
      if (bucketGap && bucketGap.gapF > BUCKET_ABOVE_OBS_GAP_MAX_F) {
        skipped.push({ ...c, reason: "bucket-above-obs",
                       gapF: bucketGap.gapF.toFixed(2), thresholdF: BUCKET_ABOVE_OBS_GAP_MAX_F });
        continue;
      }
    }

    if (cashFree() < STAKE_FLOOR) { skipped.push({ ...c, reason: "out-of-cash" }); continue; }

    const stake = Math.max(STAKE_FLOOR, Math.min(STAKE_CEIL,
      c.halfKelly * baselineBankroll, cashFree()));
    if (stake < STAKE_FLOOR) continue;
    const contracts = c.price > 0 ? stake / c.price : 0;
    const betId = `${c.fullTicker}-${c.side}-${Date.now()}`;
    const record = {
      betId,
      source: c.source,
      city: c.city,
      variable: c.variable,
      bucket: c.bucket,
      label: c.label,
      fullTicker: c.fullTicker,
      side: c.side,
      price: c.price,
      pModel: c.pModel,
      ev: c.ev,
      halfKelly: c.halfKelly,
      stake_dollars: Math.round(stake * 100) / 100,
      contracts: Math.round(contracts * 100) / 100,
      placedAtUTC: new Date().toISOString(),
      modelMean: c.modelMean ?? null, modelStd: c.modelStd ?? null,
      threshold: c.threshold ?? null, kind: c.kind ?? null
    };
    await openStore.setJSON(`${betId}.json`, record)
      .catch(err => errors.push({ where: "open-write", betId, err: String(err) }));
    placements.push(record);
    heldKeys.add(dedupKey);
    // Stamp city+variable cooldown so subsequent runs don't compound model-thrash on the
    // same (city, variable) pair within the lockout window. Stamped on FIRST placement per
    // (city, var) in this cycle; multiple complementary tail bets in one cycle still go
    // through (the cooldownMap reflects only what was loaded at cycle start).
    cooldownMap[cityVarKey(c.city, c.variable)] = new Date().toISOString();
    stakeAddedThisCycle += stake;
    placed++;
  }

  // No global state write — counters/bankroll/totals are all derived from open+settled
  // blobs at read time (see combo.js). Eliminates the timeout-induced drift bug.
  await cooldownStore.setJSON("global", cooldownMap)
    .catch(err => errors.push({ where: "cooldown-write", err: String(err) }));

  const ranAtUTC = new Date().toISOString();
  const finalBankroll = Math.round((baselineBankroll - stakeAddedThisCycle) * 100) / 100;
  // Per-cycle log (capped fields).
  try {
    await logStore.setJSON(`${ranAtUTC}.json`, {
      ranAtUTC,
      bankroll: finalBankroll,
      cands: { weather: weatherCands.length, rain: rainCands.length, total: allCands.length },
      errors: { weather: weatherErr, rain: rainErr },
      settled: settledThisCycle.map(s => ({ betId: s.betId, source: s.source, label: s.label,
                                            outcome: s.outcome, pnl: s.pnl_dollars })),
      sells: sells.map(s => ({ betId: s.betId, source: s.source, label: s.label,
                                sell_price: s.sell_price, pnl: s.pnl_dollars,
                                p_model_at_sell: s.p_model_at_sell })),
      placements: placements.map(p => ({ betId: p.betId, source: p.source, label: p.label,
                                          side: p.side, stake: p.stake_dollars,
                                          ev: p.ev, halfKelly: p.halfKelly })),
      skipped: skipped.slice(0, 20).map(s => ({ source: s.source, label: s.label, side: s.side,
                                                 ev: s.ev, halfKelly: s.halfKelly, reason: s.reason }))
    });
  } catch (e) { /* don't fail the cycle on log write */ }

  return new Response(JSON.stringify({
    ok: true, ranAtUTC,
    bankroll: finalBankroll,
    startedAt,
    spareCapacity,
    settledCount: settledThisCycle.length,
    soldCount: sells.length,
    placedCount: placements.length,
    skippedCount: skipped.length,
    candCounts: { weather: weatherCands.length, rain: rainCands.length },
    sourceErrors: { weather: weatherErr, rain: rainErr },
    settled: settledThisCycle,
    sells,
    placements,
    skippedTop: skipped.slice(0, 10),
    errors
  }, null, 2), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};

// Run every 30 min — matches rainbot's signal cadence (rain QPF only refreshes every
// ~30 min upstream). Weatherbot signals refresh more often but the bottleneck is rain.
export const config = { schedule: "*/30 * * * *" };
