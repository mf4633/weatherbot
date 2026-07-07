// Cross-references our weatherbot predictions with Kalshi daily-high markets.
// For each market bucket, computes P(actual high in bucket) under our normal model and
// compares to the market's mid-price. Returns a sorted "best bets" list by expected value.
//
// EV per dollar (YES contract): p_model - yes_ask  (positive = +EV)
// EV per dollar (NO contract):  (1 - p_model) - no_ask
//
// All Kalshi prices are in dollars (0.01–0.99 for active markets).

import { normCdf } from "./lib/stats.js";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

// Map our city display name → Kalshi series ticker for HIGH and LOW.
// 7 of 20 cities don't have Kalshi markets and are skipped: SAN, JAX, TPA, SJC, CMH, CLT, IND.
const CITY_TO_KALSHI = {
  "New York":          { high: "KXHIGHNY",   low: "KXLOWNY"     },
  "Los Angeles":       { high: "KXHIGHLAX",  low: "KXLOWLAX"    },
  "Chicago":           { high: "KXHIGHCHI",  low: "KXLOWTCHI"   },
  "Houston":           { high: "KXHIGHTHOU", low: "KXLOWTHOU"   },
  "Phoenix":           { high: "KXHIGHTPHX", low: "KXLOWTPHX"   },
  "Philadelphia":      { high: "KXHIGHPHIL", low: "KXLOWPHIL"   },
  "San Antonio":       { high: "KXHIGHTSATX", low: "KXLOWTSATX" },
  "Dallas-Fort Worth": { high: "KXHIGHTDAL", low: "KXLOWTDAL"   },
  "Austin":            { high: "KXHIGHAUS",  low: "KXLOWAUS"    },
  "Seattle":           { high: "KXHIGHTSEA", low: "KXLOWTSEA"   },
  "Denver":            { high: "KXHIGHDEN",  low: "KXLOWDEN"    },
  "Washington DC":     { high: "KXHIGHTDC",  low: null          },  // no DCA low yet
  "Boston":            { high: "KXHIGHTBOS", low: "KXLOWTBOS"   }
};

// Standard normal CDF (Abramowitz & Stegun 26.2.17) — see lib/stats.js.

// --- Student-t CDF, for the Bayesian posterior-predictive bucket probabilities.
// The calibration loop (calibration_update.js) emits (ν, scale); the outcome's
// posterior predictive is Student-t_ν, so bucket probabilities integrate
// parameter (σ) uncertainty: small ν → fat tails → humble probabilities.
// lgamma (Lanczos), regularized incomplete beta I_x(a,b) (Lentz continued
// fraction, NR §6.4), then the t-CDF. ν=Infinity falls back to normCdf exactly.
function lgamma(z) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betacf(a, b, x) {
  const FPMIN = 1e-30, EPS = 1e-12;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d; let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b)
                      + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? bt * betacf(a, b, x) / a
    : 1 - bt * betacf(b, a, 1 - x) / b;
}
function studentTCdf(t, nu) {
  if (!Number.isFinite(nu) || nu > 1e6) return normCdf(t);
  const x = nu / (nu + t * t);
  const ib = 0.5 * betai(nu / 2, 0.5, x);
  return t > 0 ? 1 - ib : ib;
}

// Format today's local date in MMMddyy → kalshi event suffix "26APR30".
// We use the city's local date because the Kalshi event closes at midnight local.
function kalshiDateSuffix(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "2-digit", month: "short", day: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}${parts.month.toUpperCase()}${parts.day}`;
}

async function fetchPredictions() {
  // Pass auth so we don't get blocked by the Basic Auth edge function.
  const auth = "Basic " + btoa("internal:hydro");
  const r = await fetch(`${SITE_BASE}/api/weather`, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`weather API ${r.status}`);
  return await r.json();
}

async function fetchKalshiMarkets(eventTicker) {
  // Paginate so we don't silently truncate large bucket lists, AND retry on transient
  // failures — Kalshi's public markets endpoint flakes intermittently when /api/kalshi
  // hits 13 cities × 2 events = 26 sequential requests per cache miss. Without retry
  // the kalshi snapshot was non-deterministic: same query, 10 cities found one cycle,
  // 5 the next. We retry once with a 600ms backoff on non-2xx OR network throw, and
  // stop paginating once a page returns short of `PER_PAGE` (since the next cursor
  // sometimes lies — Kalshi returns a non-empty cursor for events that have nothing
  // more to fetch, and following it adds wasted requests + more rate-limit pressure).
  const MAX_PAGES = 3;
  const PER_PAGE = 200;
  async function fetchPage(cursor) {
    const url = `${KALSHI_API}/markets?event_ticker=${eventTicker}&limit=${PER_PAGE}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url);
        if (r.ok) return await r.json();
      } catch (_) { /* network error — fall through to retry */ }
      if (attempt === 0) await new Promise(res => setTimeout(res, 600));
    }
    return null;
  }
  const merged = { markets: [] };
  let cursor = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const j = await fetchPage(cursor);
    if (!j) return i === 0 ? null : merged;
    if (Array.isArray(j.markets)) merged.markets.push(...j.markets);
    // Stop if we got a short page — next cursor (if any) won't add real data.
    if (!Array.isArray(j.markets) || j.markets.length < PER_PAGE) break;
    cursor = j.cursor || "";
    if (!cursor) break;
  }
  return merged;
}

// σ_irreducible: quadrature-add a member-error prior so that even when the ensemble
// agrees, the predictive σ stays at or above the prior's natural width. Replaces a
// hard `max(σ, 1.0)` floor with a smooth hierarchical formulation:
//   σ_eff = √(σ_ensemble² + σ_irreducible²)
// Calibrated 2026-05-08 against the σ-floor A/B in backtest_gates.js — at irred=1.0
// the historical 49-bet sample shows +$82 net vs +$52 for the old floor (same scale).
// Theoretically justified by ensemble-mean RMSE 1.67°F (analyze.log) factored against
// typical ensemble-disagreement ~1°F: irreducible component ≈ √(1.67² − 1²) = 1.34°F.
// 2026-05-14: bumped 1.0 → 1.3 per pre-registered plan after reaching n=148 settled
// bets. Residual audit on May 5-7 carnage window (audit_carnage_window.js) showed
// |residual|/modelStd = 1.77 — model underestimates own σ. σ-sweep replay
// (backtest_sigma_irred.js) on 148 bets at current MIN_EDGE_HIGH=0.20/LOW=0.30/halfK=0.15
// gates: σ_irred=1.3 cuts 5 losses + 2 wins → +$103 net vs +$83 at σ_irred=1.0.
// Retention 40% (59/148 bets) — well above "never play, never lose" floor.
const SIGMA_IRREDUCIBLE_F = 1.3;

// 2026-05-28 σ-AUDIT FLOORS. Audit of 204 live settled bets vs ACIS ground truth
// (_sigma_audit.py): production σ is overconfident — HIGH |z|/exp = 1.64 (mean σ
// used 2.44, range 0.40-7.05); LOW |z|/exp = 5.91 (mean σ used 1.21, range
// 0.40-2.53), cov68 only 32%. The σ_revision (5/15) did NOT fix LOW (post-5/15
// ratio still 3.4×). The hierarchical formula produces sigmaEff = √(σ_ens² + 1.3²)
// × per-city calibration; the per-city Kalman calibration multiplier can scale
// the result BELOW physically-defensible widths (some bets used σ=0.40). Apply a
// hard FLOOR per variable so calibration can refine UP but never below the
// residual SD the data justifies.
//   HIGH 2.5 = the σ that gave +9.0% backtest ROI (_intraday_analyze_bayes.py); also
//   ≈ mean of σ_h fit (2.44 → 1.54 by hour-to-peak from 5yr data).
//   LOW  2.0 = ≈ calibrated σ_h max (2.00 → 1.54 by hour-to-trough); LOW backtest
//   at σ=2.5 gave +65.7% ROI, so floor of 2.0 stays inside the validated regime.
// Strictly conservative: floors only WIDEN σ; never tighten.
// ADAPTIVE (calibrated) HIGH predictive σ. This is the "learned parameter" form of the
// former hardcoded cap: calibration_update fits the POSTERIOR from the unselected snapshot
// population (prediction errors, NOT bet-matched — bet-matched is what inflated the old
// scale to 2.775× and cost ~$415), and this code reads it, re-clamps to the guardrails, and
// falls back to the PRIOR when the fit is absent.
//   - SIGMA_HIGH_PRIOR = seed + fallback (the backtested optimum).
//   - [FLOOR, CAP] = HARD guardrails: the whole envelope backtests profitable (1.5→+7.5%,
//     2.0→+3.7%, 2.5→+0.5%; 3.0+ loses), so a runaway fit physically can't leave +EV.
// Root cause it replaces: the old scale was fit on bet-matched residuals (selection bias),
// inflating effective σ to ~6-8°F → model under-weighted the market's correct tight buckets
// → bet NO against them at $0.02-0.04 → −45% ROI. Population RMS_z≈0.71 → true error σ≈2°F,
// no μ-bias, no fat tails. Walk-forward backtest (585 events): the adaptive σ self-converges
// to ~2.0, never nears a bound, matches fixed-σ=2.0 P&L (+3.5% vs +3.7%).
const SIGMA_HIGH_PRIOR = 2.0;
const SIGMA_HIGH_FLOOR = 1.5;
const SIGMA_HIGH_CAP   = 2.5;
// ADAPTIVE (calibrated) LOW predictive σ — exact twin of HIGH (2026-06-05). Same learned-
// parameter form: calibration_update fits the posterior from the UNSELECTED prediction
// population (actualLow−predLow, NOT bet-matched), this code re-clamps to [FLOOR,CAP] and
// falls back to PRIOR. Replaces the former hardcoded SIGMA_FLOOR_LOW=2.0, which was derived
// from a BET-MATCHED σ-audit (|z|/exp≈5.9) — the same selection bias that inflated HIGH to
// 2.775 — and forced LOW too WIDE. Population residual is RMS≈1.37 (bias −0.13, no fat
// tails) → honest posterior ≈1.45 → clamps to the 1.5 floor, TIGHTER than the old 2.0.
//   [FLOOR, CAP] = HARD guardrails: the whole envelope backtests +EV on _edge_raw_low.json
//   (231 real-fill events): 1.5→+30.8%, 2.0→+28.2%, 2.5→+25.3% at thr 0.15; +EV down to
//   σ=1.0 and up to 3.0, breaks only past 3.0. LOW edge is wider/less σ-sensitive than HIGH.
const SIGMA_LOW_PRIOR  = 2.0;
const SIGMA_LOW_FLOOR  = 1.5;
const SIGMA_LOW_CAP    = 2.5;

// Per-city staleness gate. MUST mirror jackson_trader's PER_CITY_FRESHNESS_MAX_MIN so the
// `stale` flags this endpoint exposes mean exactly what the live trader acts on. Gate is on
// composite observation age (dataAgeMin preferred), not NWS grid issuance age.
const TRADER_FRESHNESS_MAX_MIN = 180;

// Kalshi fee per $1 staked at a given binary contract price.
// Exact formula: fee_cents = ceil(7 × count × P × (1-P)) where P is yes_price ∈ [0,1].
// Per $1 staked at price P: fee ≈ 0.07 × (1−P) dollars (continuous approximation).
// Highest near P=0.5 (~3.5¢/$1), lowest near tails (P=0.01: ~7¢; P=0.99: ~0.07¢).
// Fees apply on BUY only; settlement is free; sell-to-close has separate fee (rare for us).
function kalshiFeePerDollar(price) {
  return 0.07 * (1 - price);
}
// Corrected fee model (EDGE_AUDIT.md finding E). The gross edge (p_model − price) is
// per CONTRACT, so the fee subtracted from it must also be per contract:
//   fee_per_contract = ceil(7 · P · (1−P)) / 100   (matches the settlement math in
// jackson_trader.js). The legacy kalshiFeePerDollar above is the fee per $1 STAKED,
// which over-charges by ~1/price and biases the bot too conservative on cheap bets.
// FLAG-GATED + OFF by default: switching the fee changes which bets clear MIN_EDGE,
// so MIN_EDGE_* must be re-swept first (run resweep_fee.js against settled bets).
// With FEE_PER_CONTRACT unset, kalshiEntryFee === kalshiFeePerDollar → byte-identical.
const FEE_PER_CONTRACT = process.env.FEE_PER_CONTRACT === "true";
function kalshiFeePerContract(price) {
  return Math.ceil(0.07 * price * (1 - price) * 100) / 100;
}
function kalshiEntryFee(price) {
  return FEE_PER_CONTRACT ? kalshiFeePerContract(price) : kalshiFeePerDollar(price);
}

// --- pWin recalibration (Platt), fit by pwin_calibration_fit.js, stored in the
// `pwin_calibration_state` blob. OFF by default: it is loaded every request but only
// APPLIED when PWIN_CALIBRATION_ENABLED=true. When disabled, calibratePWin is the
// identity, so every EV/Kelly number is byte-identical to the pre-scaffold behavior.
// Enable only after validating the fit against fresh residuals — see EDGE_AUDIT.md.
const PWIN_CALIBRATION_ENABLED = process.env.PWIN_CALIBRATION_ENABLED === "true";
function _sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function _logitClamp(p) { const e = 1e-6, q = Math.min(1 - e, Math.max(e, p)); return Math.log(q / (1 - q)); }
// Map a raw win probability through the fitted per-variable Platt recalibration.
// Returns pWin unchanged unless enabled AND a converged fit for this variable exists.
function calibratePWin(pWin, variable, pwinCal) {
  if (!PWIN_CALIBRATION_ENABLED || !pwinCal || !pwinCal.fit) return pWin;
  const fit = (variable === "low" ? pwinCal.platt_low : pwinCal.platt_high) ?? pwinCal.platt;
  if (!fit || fit.converged === false || !Number.isFinite(fit.A) || !Number.isFinite(fit.B)) return pWin;
  return _sigmoid(fit.A * _logitClamp(pWin) + fit.B);
}
async function readPwinCalibration() {
  try {
    const store = await getBlobStore("pwin_calibration_state");
    if (!store) return null;
    return await store.get("current.json", { type: "json" });
  } catch (e) { return null; }
}

// Synthesize a human-readable label for any bucket, even when Kalshi's subtitle is empty.
function bucketLabel(loInt, hiInt, subtitle) {
  if (subtitle && subtitle.trim()) return subtitle.trim();
  if (loInt === -Infinity || loInt == null) return `≤ ${hiInt}°F`;
  if (hiInt === Infinity || hiInt == null) return `≥ ${loInt}°F`;
  return loInt === hiInt ? `${loInt}°F` : `${loInt}–${hiInt}°F`;
}

// Parse a market's bucket boundaries. Returns { loInt, hiInt } where bucket means high ∈ [loInt, hiInt]
// (inclusive of integer-degree highs). For tail buckets, use ±Infinity.
function bucketBounds(market) {
  const t = market.ticker.split("-").pop();
  const fs = market.floor_strike;
  const cs = market.cap_strike;
  if (t.startsWith("T")) {
    // Tail: T<n> can mean either "<= n-1" (low tail) or ">= n+1" (high tail).
    // Kalshi strike values are EXCLUSIVE bounds — a "less" market with cs=77
    // settles on integer outcomes ≤ 76 (subtitle "76° or below"), and a
    // "greater" market with fs=84 settles on integer outcomes ≥ 85 (subtitle
    // "85° or above"). Earlier code returned the strike value as the inclusive
    // bound (off-by-one), which made adjacent T-tail and B-bucket ranges
    // overlap and inflated probSum above 1.0 — e.g., on 2026-05-05 KXLOWTBOS
    // the T52-greater bucket was scored over [51.5, ∞) instead of [52.5, ∞),
    // double-counting probability mass that B51.5 already covered.
    if (market.strike_type === "less" || (cs != null && fs == null)) {
      return { loInt: -Infinity, hiInt: cs - 1 };  // x < cs (strict)
    }
    if (market.strike_type === "greater" || (fs != null && cs == null)) {
      return { loInt: fs + 1, hiInt: Infinity };   // x > fs (strict)
    }
    // Fallback: parse from subtitle.
    const sub = market.subtitle || "";
    if (sub.includes("below") || sub.includes("or less")) return { loInt: -Infinity, hiInt: parseInt(sub) };
    if (sub.includes("above") || sub.includes("or more")) return { loInt: parseInt(sub), hiInt: Infinity };
  }
  // Between bucket: floor_strike to cap_strike inclusive of integer highs.
  return { loInt: fs, hiInt: cs };
}

// P(temp in [loInt, hiInt]) under N(mean, std), with integer-degree quantization.
// Continuity correction: bucket [a, b] integer ↔ (a-0.5, b+0.5) on the continuous distribution.
// Truncation:
//  - lowerFloor: temp >= lowerFloor (e.g., today's HIGH can't be < maxSoFar already observed)
//  - upperFloor: temp <= upperFloor (e.g., today's LOW can't be > minSoFar already observed)
// `nu` = Student-t degrees of freedom for the posterior predictive (parameter-
// uncertainty-aware). Omit / Infinity → standard normal (legacy behavior).
function bucketProb(mean, std, loInt, hiInt, lowerFloor = null, upperFloor = null, nu = Infinity) {
  let effLo = loInt === -Infinity ? -Infinity : loInt - 0.5;
  let effHi = hiInt === Infinity ? Infinity : hiInt + 0.5;
  if (lowerFloor != null) {
    if (effHi < lowerFloor) return 0;
    if (effLo < lowerFloor) effLo = lowerFloor;
  }
  if (upperFloor != null) {
    if (effLo > upperFloor) return 0;
    if (effHi > upperFloor) effHi = upperFloor;
  }
  const pHi = effHi === Infinity ? 1 : studentTCdf((effHi - mean) / std, nu);
  const pLo = effLo === -Infinity ? 0 : studentTCdf((effLo - mean) / std, nu);
  return Math.max(0, pHi - pLo);
}

// Market-implied μ/σ from the live Kalshi bucket prices (2026-05-26). Treats each
// bucket's mid-price as P(outcome ∈ bucket), normalizes across the event, and takes
// the probability-weighted center / spread. This is what the MARKET thinks the high/
// low will be — the benchmark our model must beat to have edge (the thesis: predict
// NWS deviations the market UNDER-prices). Logged per snapshot so model-vs-market
// skill becomes measurable. Tail buckets (≤N / ≥N) use an approximate ±1°F center.
function bucketCenter(b) {
  const lo = b.loInt, hi = b.hiInt;
  const loFin = lo != null && lo !== -Infinity, hiFin = hi != null && hi !== Infinity;
  if (loFin && hiFin) return (lo + hi) / 2;
  if (!loFin && hiFin) return hi - 1.0;   // "≤ hi" tail
  if (loFin && !hiFin) return lo + 1.0;   // "≥ lo" tail
  return null;
}
function marketImplied(buckets) {
  const pts = [];
  let sum = 0;
  for (const b of buckets || []) {
    const c = bucketCenter(b);
    const p = b.midPx;
    if (c == null || p == null || p <= 0) continue;
    pts.push({ c, p }); sum += p;
  }
  if (pts.length < 2 || sum <= 0) return null;
  const mean = pts.reduce((a, x) => a + (x.p / sum) * x.c, 0);
  const variance = pts.reduce((a, x) => a + (x.p / sum) * (x.c - mean) ** 2, 0);
  return {
    mean: Math.round(mean * 100) / 100,
    std: Math.round(Math.sqrt(Math.max(0, variance)) * 100) / 100,
    nBuckets: pts.length,
    probSum: Math.round(sum * 1000) / 1000   // ≈1 if the book is coherent; flags wide spreads
  };
}

// Lazy-import @netlify/blobs at handler time so local-only callers (tests, CLI
// invocations) still work without the runtime. Cached across calls.
let _blobGetStore = null;
async function getBlobStore(name) {
  if (!_blobGetStore) {
    try { _blobGetStore = (await import("@netlify/blobs")).getStore; }
    catch (e) { return null; }
  }
  return _blobGetStore(name);
}

// Read the live calibration state. Continuously updated by calibration_update.js.
// Returns inflation factors for HIGH and LOW; default 1.0 (no calibration) when
// the blob is missing or undeflfined for a side. See calibration_update.js for
// the residual-z-stdev computation.
async function readCalibration() {
  // Posterior-predictive params per side: scale (σ multiplier) + nu (Student-t dof).
  // Fallback when the blob/side is absent: scale 1.0, nu Infinity (= legacy Normal,
  // no inflation). A missing/stale blob is treated as a dead loop by jackson_trader's
  // liveness gate, which abstains — so this fallback is only a numeric default.
  const DFLT = { scale: 1.0, nu: Infinity };
  try {
    const store = await getBlobStore("calibration_state");
    if (!store) return { high: { ...DFLT }, low: { ...DFLT } };
    const blob = await store.get("current.json", { type: "json" });
    const side = (s) => ({
      scale: blob?.[s]?.predictive_scale ?? 1.0,
      nu:    blob?.[s]?.predictive_nu    ?? Infinity,
    });
    // Adaptive (population-fit) HIGH predictive σ. The hardcoded SIGMA_HIGH_PRIOR is the
    // PRIOR mean; calibration_update fits the posterior from the unselected snapshot
    // population (errors, NOT bet-matched) and hard-clamps it to the backtested-profitable
    // envelope. null here → caller falls back to the prior. See SIGMA_HIGH_* below.
    const sigmaHigh = blob?.sigma_high?.posterior ?? null;
    // Adaptive LOW predictive σ — exact twin of sigmaHigh (2026-06-05). Same population-fit,
    // same [1.5,2.5] guardrails. null → caller falls back to SIGMA_LOW_PRIOR.
    const sigmaLow = blob?.sigma_low?.posterior ?? null;
    return { high: side("high"), low: side("low"), sigmaHigh, sigmaLow };
  } catch (e) {
    return { high: { ...DFLT }, low: { ...DFLT }, sigmaHigh: null, sigmaLow: null };
  }
}

export default async () => {
  let predData;
  try {
    predData = await fetchPredictions();
  } catch (e) {
    return new Response(JSON.stringify({ error: "weather fetch failed", detail: String(e) }), {
      status: 502, headers: { "content-type": "application/json" }
    });
  }

  // Calibration factors widen σ_eff on each side based on empirical residual
  // stdev. Applied as a multiplicative scaler AFTER the hierarchical-prior
  // quadrature, so the irreducible floor is still respected as a lower bound.
  const calibration = await readCalibration();
  // pWin recalibration state — loaded always, applied only when PWIN_CALIBRATION_ENABLED
  // (default off). See calibratePWin; when off it never changes any EV/Kelly value.
  const pwinCal = await readPwinCalibration();

  const now = new Date();
  const cities = [];
  const allBets = [];

  // Freshness diagnostics. Two distinct notions of "stale" live here and they MUST NOT
  // be conflated:
  //   1. Per-city OBSERVATION staleness (the `stale` flag, `staleCities`) — composite
  //      obs-age (dataAgeMin preferred) vs the 180-min gate. This mirrors exactly what
  //      jackson_trader gates on, so it's the field downstream consumers should trust.
  //   2. Forecast-ISSUANCE age (oldest/newestForecastAgeMin, forecastIssuanceStale) — when
  //      NWS last re-issued a city's grid forecast. Western offices routinely sit 4-6h old
  //      overnight while ensemble + METAR are minutes fresh, so this is a longitude/
  //      time-of-day artifact, NOT a trading signal. `forecastStale` is retained only as a
  //      back-compat alias of forecastIssuanceStale for the legacy dashboard.
  const cacheAgeMs = predData.ageMs ?? 0;
  const forecastUpdateTimes = (predData.cities || [])
    .map(c => c.forecastUpdateTime)
    .filter(Boolean)
    .map(s => new Date(s).getTime())
    .filter(t => !isNaN(t));
  const oldestForecastMs = forecastUpdateTimes.length ? Math.min(...forecastUpdateTimes) : null;
  const newestForecastMs = forecastUpdateTimes.length ? Math.max(...forecastUpdateTimes) : null;
  const issuanceStale = oldestForecastMs ? (Date.now() - oldestForecastMs) > 90 * 60 * 1000 : false;

  // Per-city observation staleness — the trader-relevant view.
  const perCity = (predData.cities || []).filter(c => !c.error).map(c => {
    const nwsGridAgeMin = c.forecastUpdateTime
      ? Math.round((Date.now() - new Date(c.forecastUpdateTime).getTime()) / 60000) : null;
    const obsAgeMin = c.dataAgeMin ?? null;
    const composite = obsAgeMin ?? nwsGridAgeMin;
    return { name: c.name, obsAgeMin, nwsGridAgeMin,
             stale: composite != null ? composite > TRADER_FRESHNESS_MAX_MIN : false };
  });
  const staleCities = perCity.filter(c => c.stale).map(c => c.name);

  const freshness = {
    cacheAgeSec: Math.round(cacheAgeMs / 1000),
    cacheStale: cacheAgeMs > 5 * 60 * 1000,
    // Trader-relevant per-city staleness (observation-age basis, mirrors jackson_trader):
    staleThresholdMin: TRADER_FRESHNESS_MAX_MIN,
    cityCount: perCity.length,
    staleCount: staleCities.length,
    tradeableCityCount: perCity.length - staleCities.length,
    staleCities,
    anyStale: staleCities.length > 0,
    allStale: perCity.length > 0 && staleCities.length === perCity.length,
    perCity,
    // Forecast-ISSUANCE diagnostics (longitude/overnight artifact — NOT a trading signal):
    oldestForecastIssuedAt: oldestForecastMs ? new Date(oldestForecastMs).toISOString() : null,
    oldestForecastAgeMin: oldestForecastMs ? Math.round((Date.now() - oldestForecastMs) / 60000) : null,
    newestForecastAgeMin: newestForecastMs ? Math.round((Date.now() - newestForecastMs) / 60000) : null,
    forecastIssuanceStale: issuanceStale,
    forecastStale: issuanceStale,  // back-compat alias (legacy dashboard reads this)
  };

  // Helper: process one event (HIGH or LOW) for a city.
  // variable = "high" | "low"; mean / std come from our model for that variable;
  // lowerFloor / upperFloor are the truncation bounds from already-realized observations.
  async function processEvent(city, series, variable, mean, std, lowerFloor, upperFloor, nu = Infinity) {
    const eventTicker = `${series}-${kalshiDateSuffix(now, city.tz)}`;
    const m = await fetchKalshiMarkets(eventTicker);
    if (!m || !m.markets || !m.markets.length) return null;

    // Per-bet freshness, stamped so every topBet is self-describing AND matches the
    // gate the live trader actually applies. jackson_trader gates on OBSERVATION age
    // (dataAgeMin), not NWS grid issuance age — a western city's grid forecast often
    // sits 4-6h old overnight while ensemble + METAR are minutes fresh. `stale` below
    // uses the same composite (obs-age preferred, 180-min) the trader uses; nwsGridAgeMin
    // is exposed for visibility only and is NOT what disqualifies a bet.
    const nwsGridAgeMin = city.forecastUpdateTime
      ? Math.round((Date.now() - new Date(city.forecastUpdateTime).getTime()) / 60000) : null;
    const obsAgeMin = city.dataAgeMin ?? null;
    const compositeAgeMin = obsAgeMin ?? nwsGridAgeMin;
    const betStale = compositeAgeMin != null ? compositeAgeMin > TRADER_FRESHNESS_MAX_MIN : false;

    const bucketsRaw = m.markets.map(mkt => {
      const { loInt, hiInt } = bucketBounds(mkt);
      const yes_ask = mkt.yes_ask_dollars ? parseFloat(mkt.yes_ask_dollars) : null;
      const yes_bid = mkt.yes_bid_dollars ? parseFloat(mkt.yes_bid_dollars) : null;
      const no_ask  = mkt.no_ask_dollars  ? parseFloat(mkt.no_ask_dollars)  : null;
      const no_bid  = mkt.no_bid_dollars  ? parseFloat(mkt.no_bid_dollars)  : null;
      const last    = mkt.last_price_dollars ? parseFloat(mkt.last_price_dollars) : null;
      const midPx   = (yes_ask != null && yes_bid != null) ? (yes_ask + yes_bid) / 2 : last;
      const label   = bucketLabel(loInt, hiInt, mkt.subtitle);
      return { ticker: mkt.ticker, subtitle: mkt.subtitle, label, loInt, hiInt,
               yes_ask, yes_bid, no_ask, no_bid, last, midPx,
               volume: mkt.volume_fp || 0,
               // 24h volume for the trader's liquidity gate (the "traded recently" intent).
               // null when Kalshi doesn't supply it → trader falls back to lifetime volume.
               volume24h: mkt.volume_24h_fp ?? mkt.volume_24h ?? null };
    });
    const probSum = bucketsRaw.reduce((a, b) =>
      a + bucketProb(mean, std, b.loInt, b.hiInt, lowerFloor, upperFloor, nu), 0);
    const buckets = bucketsRaw.map(b => {
      const rawP = bucketProb(mean, std, b.loInt, b.hiInt, lowerFloor, upperFloor, nu);
      const p_model = probSum > 0 ? rawP / probSum : 0;
      // Gross EV = p_model - price. Net EV = gross - kalshi_fee_per_$_staked.
      // The trader's qualifying threshold checks NET EV (post-fee), so 5¢ "edge" means
      // 5¢ realized after Kalshi's take.
      const grossEvYes = b.yes_ask != null ? p_model - b.yes_ask : null;
      const grossEvNo  = b.no_ask  != null ? (1 - p_model) - b.no_ask : null;
      const feeYes = b.yes_ask != null ? kalshiEntryFee(b.yes_ask) : null;
      const feeNo  = b.no_ask  != null ? kalshiEntryFee(b.no_ask)  : null;
      const evYes = grossEvYes != null ? grossEvYes - feeYes : null;
      const evNo  = grossEvNo  != null ? grossEvNo  - feeNo  : null;
      return { ...b, p_model: Math.round(p_model * 1000) / 1000,
               grossEvYes, grossEvNo, feeYes, feeNo, evYes, evNo };
    });

    const kelly = (p, price) => Math.max(0, (p - price) / (1 - price));
    // Holding period for temp: a market for "today's high" settles when next morning's
    // CLI lands. Practically always within 24h of buy time → use 1 day. Rain is the
    // distance-asymmetric counterpart that gets actual TVM math (see rain.js).
    const HOLDING_DAYS = 1;
    const eventBets = [];
    for (const b of buckets) {
      if (b.evYes != null && b.evYes > 0.02 && b.yes_ask < 0.95) {
        // Default-off: pYes=b.p_model, evYes=b.evYes → identical to pre-scaffold. When
        // PWIN_CALIBRATION_ENABLED, recalibrate the win prob and re-derive EV (same fee).
        let pYes = b.p_model, evYes = b.evYes;
        if (PWIN_CALIBRATION_ENABLED) {
          pYes = Math.round(calibratePWin(b.p_model, variable, pwinCal) * 1000) / 1000;
          evYes = pYes - b.yes_ask - (b.feeYes ?? 0);
        }
        const k = kelly(pYes, b.yes_ask);
        eventBets.push({
          city: city.name, variable, bucket: b.label, ticker: b.ticker.split("-").pop(),
          side: "YES", price: b.yes_ask, bid: b.yes_bid, p_model: pYes, ev: evYes,
          evPerDay: evYes / HOLDING_DAYS, holdingDays: HOLDING_DAYS,
          kelly: k, halfKelly: k / 2, volume: b.volume, volume24h: b.volume24h,
          loInt: b.loInt, hiInt: b.hiInt, modelMean: mean, modelStd: std,
          obsAgeMin, nwsGridAgeMin, stale: betStale
        });
      }
      if (b.evNo != null && b.evNo > 0.02 && b.no_ask < 0.95) {
        // Default-off: pNo=1-b.p_model, evNo=b.evNo → identical to pre-scaffold.
        let pNo = 1 - b.p_model, evNo = b.evNo;
        if (PWIN_CALIBRATION_ENABLED) {
          pNo = Math.round(calibratePWin(1 - b.p_model, variable, pwinCal) * 1000) / 1000;
          evNo = pNo - b.no_ask - (b.feeNo ?? 0);
        }
        const k = kelly(pNo, b.no_ask);
        eventBets.push({
          city: city.name, variable, bucket: b.label, ticker: b.ticker.split("-").pop(),
          side: "NO", price: b.no_ask, bid: b.no_bid, p_model: pNo, ev: evNo,
          evPerDay: evNo / HOLDING_DAYS, holdingDays: HOLDING_DAYS,
          kelly: k, halfKelly: k / 2, volume: b.volume, volume24h: b.volume24h,
          loInt: b.loInt, hiInt: b.hiInt, modelMean: mean, modelStd: std,
          obsAgeMin, nwsGridAgeMin, stale: betStale
        });
      }
    }

    return { eventTicker, variable, mean, std, buckets, eventBets };
  }

  for (const city of predData.cities || []) {
    if (city.error) continue;
    const tickers = CITY_TO_KALSHI[city.name];
    if (!tickers) {
      cities.push({ name: city.name, station: city.station, kalshi: "no market" });
      continue;
    }
    const cityRecord = { name: city.name, station: city.station,
                         model: { highMean: city.mean, highStd: city.std, maxSoFar: city.maxSoFar,
                                  lowMean: city.lowMean, lowStd: city.lowStd, minSoFar: city.minSoFar,
                                  currentTemp: city.currentTemp },
                         // Per-source input ages — passthrough from weather.js for downstream
                         // traders (combo_trader) that consume /api/kalshi rather than /api/weather
                         // directly. Bayesian work-order #6b dataset feed; same fields as
                         // jackson_trader's cityInputAges block.
                         inputAges: {
                           nwsGridAgeMin: city.forecastUpdateTime
                             ? Math.round((Date.now() - new Date(city.forecastUpdateTime).getTime()) / 60000) : null,
                           metarAgeMin: city.lastMetarAgeMin ?? null,
                           dataAgeMin: city.dataAgeMin ?? null,
                           ensembleSourceCount: Array.isArray(city.ensembleSources) ? city.ensembleSources.length : null,
                           oneMinAsosAgeMin: city.oneMinAsos?.ageMin ?? null,
                           iemAgeMin: city.iemAgeMin ?? null,
                           currentTempSource: city.currentTempSource ?? null,
                           currentTempAgeMin: city.currentTempAgeMin ?? null,
                         } };

    // HIGH event. lowerFloor uses maxSoFarCli (integer °F) not raw maxSoFar — Kalshi
    // settles on NWS CLI which rounds to integer °F via a °C-internal path, so a raw
    // 87.8°F obs (= 31.0°C exact) can settle as 87°F. See feedback_weatherbot_cli_settlement.
    // σ_eff = √(σ_ensemble² + σ_irreducible²): hierarchical-prior formulation that
    // never collapses below the prior. See SIGMA_IRREDUCIBLE_F header.
    if (tickers.high) {
      // Adaptive σ: use the population-fit posterior (calibration.sigmaHigh), defensively
      // re-clamped to the guardrails, falling back to the prior when the fit is absent.
      // This replaces the old σ_ensemble×scale clamp — the bet-matched scale was the
      // selection-biased value that caused the over-inflation. Flat σ is what the
      // price-level + walk-forward backtests validated (per-city σ was never validated).
      const sigmaEff = Math.min(SIGMA_HIGH_CAP, Math.max(SIGMA_HIGH_FLOOR,
                                  calibration.sigmaHigh ?? SIGMA_HIGH_PRIOR));
      const r = await processEvent(city, tickers.high, "high", city.mean, sigmaEff,
                                    city.maxSoFarCli ?? city.maxSoFar, null, calibration.high.nu);
      if (r) {
        cityRecord.highEvent = r.eventTicker;
        cityRecord.highBuckets = r.buckets;
        cityRecord.impliedHigh = marketImplied(r.buckets);  // market μ/σ vs model μ=city.mean
        allBets.push(...r.eventBets);
      } else {
        cityRecord.highEvent = "not found";
      }
    }
    // LOW event. upperFloor uses minSoFarCli (integer °F) — symmetric to HIGH lowerFloor.
    if (tickers.low && city.lowMean != null && city.lowStd != null) {
      // Adaptive σ_low — exact twin of HIGH (2026-06-05). Population-fit posterior,
      // re-clamped to [SIGMA_LOW_FLOOR, SIGMA_LOW_CAP], prior fallback. Replaces the old
      // σ_ensemble×scale + SIGMA_FLOOR_LOW=2.0 form: that floor came from a bet-matched
      // audit (selection bias) and forced LOW too WIDE; the unselected population says
      // ~1.45 and the price-level backtest is +EV across the whole envelope. See kalshi.js
      // SIGMA_LOW_* header + calibration_update-background.js sigma_low.
      const sigmaEff = Math.min(SIGMA_LOW_CAP, Math.max(SIGMA_LOW_FLOOR,
                                  calibration.sigmaLow ?? SIGMA_LOW_PRIOR));
      const r = await processEvent(city, tickers.low, "low", city.lowMean, sigmaEff,
                                    null, city.minSoFarCli ?? city.minSoFar, calibration.low.nu);
      if (r) {
        cityRecord.lowEvent = r.eventTicker;
        cityRecord.lowBuckets = r.buckets;
        cityRecord.impliedLow = marketImplied(r.buckets);
        allBets.push(...r.eventBets);
      } else {
        cityRecord.lowEvent = "not found";
      }
    }
    cities.push(cityRecord);
  }

  // Sort by Kelly fraction (the "wisest choice" combining probability and edge).
  allBets.sort((a, b) => b.kelly - a.kelly);

  return new Response(JSON.stringify({
    ts: now.toISOString(),
    freshness,
    calibration,  // live σ-inflation factors applied this call
    disclaimer: "Educational only. EV is per $1 staked. Our model RMSE is ~1.7°F; individual bet edges can be noise. Volume = lifetime contract count. Edges from stale forecast data are FALSE — check freshness.",
    // Expanded from 30 → 200 to support the no-cap jackson_trader (2026-05-13).
    // Trader still threshold-gates on EV / halfKelly / Kelly-LCB so the long tail
    // gets filtered; this just stops cutting candidates the trader might want.
    topBets: allBets.slice(0, 200),
    cities
  }, null, 2), {
    // Short cache (30s): trader cron fires every ~5 min, so a 30s edge cache means each cycle
    // sees fresh model state. Previous 120s cache was a known cause of placement against stale
    // p_model when minSoFar / bias updates within a 2-min window.
    headers: { "content-type": "application/json", "cache-control": "public, max-age=30" }
  });
};

export const config = { path: "/api/kalshi" };
