// /api/preflight — live-trading readiness report (2026-07-22). READ-ONLY: places
// no orders, flips no flags. Answers "if we armed the trader right now, what would
// break?" so going live is a two-env-var flip on a green board instead of a leap.
//
// Checks:
//   env       — creds present, arm-switch state (KALSHI_TRADING_LIVE +
//               KALSHI_TRADING_RESUME double key per TRADING_POSTMORTEM.md)
//   quotes    — /api/kalshi returns cities with live two-sided books (the 2026-07
//               dollar-string schema migration parsed correctly)
//   tickers   — every CITY high-series ticker still returns open markets on Kalshi
//               (they go stale silently — quarterly audit memory, HOU rename)
//   calibration — calibration_state age vs the trader's cal-stale gate (45 min)
//
// ready=true means: flip KALSHI_TRADING_RESUME=true + KALSHI_TRADING_LIVE=true in
// Netlify env (or ="dryrun" first for an instrumentation-only rehearsal cycle) and
// the next jackson_trader cron fires armed. This endpoint NEVER does that itself.

const SITE = "https://weatherbot-mf.netlify.app";
const AUTH = "Basic " + Buffer.from("preflight:hydro").toString("base64");
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

// Keep in sync with kalshi.js CITY_TO_KALSHI (high side — the traded series).
const HIGH_SERIES = {
  "New York": "KXHIGHNY", "Los Angeles": "KXHIGHLAX", "Chicago": "KXHIGHCHI",
  "Houston": "KXHIGHTHOU", "Phoenix": "KXHIGHTPHX", "Philadelphia": "KXHIGHPHIL",
  "San Antonio": "KXHIGHTSATX", "Dallas-Fort Worth": "KXHIGHTDAL",
  "Austin": "KXHIGHAUS", "Seattle": "KXHIGHTSEA", "Denver": "KXHIGHDEN",
  "Washington DC": "KXHIGHTDC", "Boston": "KXHIGHTBOS",
};

async function getJSON(url, headers = {}, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(9000) }).catch((e) => {
      if (attempt >= retries) throw e;
      return null;
    });
    if (r && r.ok) return r.json();
    // Kalshi 429s under the ticker sweep are routine (shared egress + tight limits) —
    // verified 2026-07-22: the "dead series" list churned between runs until retried.
    if (attempt >= retries) throw new Error(`${url.replace(/^https?:\/\/[^/]+/, "")} HTTP ${r ? r.status : "ERR"}`);
    await new Promise((res) => setTimeout(res, 700 * (attempt + 1)));
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

export default async () => {
  const blockers = [], warnings = [];

  // --- env / arm-switch state (report presence, never values) --------------------
  const creds = !!(process.env.KALSHI_ACCESS_KEY_ID && process.env.KALSHI_PRIVATE_KEY);
  const liveFlag = (process.env.KALSHI_TRADING_LIVE || "").trim().toLowerCase();
  const resumeFlag = process.env.KALSHI_TRADING_RESUME === "true";
  const armed = resumeFlag && ["true", "1", "yes", "on", "live"].includes(liveFlag);
  if (!creds) blockers.push("KALSHI_ACCESS_KEY_ID / KALSHI_PRIVATE_KEY not set in env");

  // --- quotes: normalized book health (schema-migration canary) ------------------
  let quotes = null;
  try {
    const ks = await getJSON(`${SITE}/api/kalshi`, { authorization: AUTH });
    const cities = ks.cities || [];
    let withBooks = 0, buckets = 0, pricedBuckets = 0;
    for (const c of cities) {
      const bs = [...(c.highBuckets || []), ...(c.lowBuckets || [])];
      buckets += bs.length;
      const priced = bs.filter(b => b.yes_ask != null || b.no_ask != null).length;
      pricedBuckets += priced;
      if (priced > 0) withBooks++;
    }
    quotes = { cities: cities.length, cities_with_live_books: withBooks, buckets, priced_buckets: pricedBuckets };
    if (!cities.length) blockers.push("/api/kalshi returned no cities");
    else if (withBooks === 0) blockers.push("no city has a priced book — quote parsing broken (schema drift?)");
    else if (withBooks < cities.length / 2) warnings.push(`only ${withBooks}/${cities.length} cities have priced books (off-hours is normal overnight)`);
  } catch (e) { blockers.push(`quotes check failed: ${String(e?.message || e)}`); }

  // --- tickers: every traded high series still alive on Kalshi -------------------
  let tickers = null;
  try {
    const entries = Object.entries(HIGH_SERIES);
    const results = await mapLimit(entries, 2, async ([city, series]) => {
      try {
        const j = await getJSON(`${KALSHI}/markets?series_ticker=${series}&status=open&limit=1`,
                                { Accept: "application/json" });
        return { city, series, open_markets: (j.markets || []).length };
      } catch (e) { return { city, series, error: String(e?.message || e) }; }
    });
    const dead = results.filter(r => r.error || r.open_markets === 0);
    tickers = { checked: results.length, dead: dead.map(d => `${d.city}:${d.series}`), detail: results };
    // Empty series overnight can be legitimate (between contract days) — warn, don't block,
    // unless it errored outright.
    const errored = dead.filter(d => d.error);
    if (errored.length) blockers.push(`series fetch errors: ${errored.map(d => d.series).join(", ")}`);
    else if (dead.length) warnings.push(`series with zero open markets right now: ${dead.map(d => d.series).join(", ")} (stale rename? or between contract days)`);
  } catch (e) { blockers.push(`ticker audit failed: ${String(e?.message || e)}`); }

  // --- calibration freshness (trader self-halts on cal_age >= 45 min) ------------
  let calibration = null;
  try {
    const cal = await getJSON(`${SITE}/api/calibration_state`, { authorization: AUTH });
    const asof = cal.asof || cal.updated_at || cal.ts || null;
    const ageMin = asof ? Math.round((Date.now() - new Date(asof).getTime()) / 60000) : null;
    calibration = { asof, age_min: ageMin };
    if (ageMin == null) warnings.push("calibration_state has no timestamp — cal-stale gate state unknown");
    else if (ageMin >= 45) warnings.push(`calibration_state is ${ageMin} min old (>= 45 min trips the trader's cal-stale gate; it will self-kick, but first cycle may skip)`);
  } catch (e) { warnings.push(`calibration check failed: ${String(e?.message || e)}`); }

  const ready = blockers.length === 0;
  // `ready` has only ever meant INFRASTRUCTURE readiness (creds, quotes, tickers, cal age).
  // Reported alone next to arming instructions it reads as a green light to trade, which
  // is the opposite of the standing decision: TRADING_POSTMORTEM.md halted this strategy
  // because it is a measured net loser. State that here so the two can't be confused.
  const strategy_halt = {
    in_force: true,
    source: "TRADING_POSTMORTEM.md",
    finding: "344 temperature bets May-Jul 2026, staked $1,606.91, lost $716.63 (-44.6% ROI, 18.3% win rate); zero deployable +EV strategies found across eight hypotheses; the market prices the bot's own bets better than the model does (Brier 0.1925 vs 0.4481).",
    means: "Infrastructure readiness is not permission to trade. Clearing the go/no-go bar in STRATEGY.md is."
  };
  return new Response(JSON.stringify({
    ok: true, ready, armed,
    ready_meaning: "infrastructure only — creds, quote parsing, live tickers, calibration age. NOT a judgement that trading is +EV.",
    strategy_halt,
    arm_state: { creds_present: creds, KALSHI_TRADING_LIVE: liveFlag || "(unset)", KALSHI_TRADING_RESUME: resumeFlag },
    to_go_live: ready
      ? "BLOCKED BY STRATEGY HALT (see strategy_halt). Infrastructure is otherwise ready: arming would be KALSHI_TRADING_RESUME=true + KALSHI_TRADING_LIVE=dryrun for an instrumentation-only rehearsal, review /api/trader_log, then LIVE=true — but do not do that until a strategy clears STRATEGY.md's go/no-go bar."
      : "Resolve blockers first.",
    blockers, warnings, quotes, tickers, calibration,
    asof: new Date().toISOString(),
  }, null, 2), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
};

export const config = { path: "/api/preflight" };
