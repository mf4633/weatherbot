// Continuously-updated σ-inflation calibration. Scheduled every 30 min.
//
// For each settled bet, computes the residual z-score: z = (actual − modelMean) / modelStd.
// If the model's σ is calibrated, stdev(z) should equal 1.0. If stdev(z) > 1.0,
// σ is systematically too tight (model overconfident), and the inflation factor
// = max(1.0, stdev(z)) widens σ_eff at the kalshi.js bucket-probability stage to
// restore calibration.
//
// Computed separately for HIGH and LOW so each side's σ_eff inflates by its own
// empirical factor. Trader / kalshi.js read the blob each cycle — closed-loop
// calibration: settled bet → blob update → next prediction inflates σ.
//
// 2026-07-24 join repair (see test_calibration_join.js for the measured decomposition):
//   - the actuals index is now DEMAND-DRIVEN — it fetches exactly the `${cli}/${date}`
//     records the settled bets ask for, so the join no longer depends on the retention
//     window happening to contain those days (that cost 50 of 176 HIGH matches);
//   - the retention window itself is sorted by keyDate(), not by raw key, because the
//     store is keyed CLI-first and a lexicographic cap was slicing by city, not by date;
//   - settled bets targeting a day older than the store's first record are reported as
//     out_of_coverage rather than counted as eligible, so join_rate measures the pipe.
// What remains broken is producer-side and out of this file's reach: prediction records
// settled before 2026-06-01 have actualHigh but no actualLow (logger.js runSettle only
// began writing pred.actualLow that day) and May was never backfilled, so every LOW bet
// from May stays unmatched.

import { getStore } from "@netlify/blobs";

const SETTLED_STORE      = "jackson_settled_bets";
const PREDICTIONS_STORE  = "predictions";
const CALIBRATION_STORE  = "calibration_state";
const CALIBRATION_KEY    = "current.json";

// Bayesian shrinkage replaces the old "n<20 → factor=1.0" cliff. The prior is
// "model is well-calibrated" (factor=1.0) with PRIOR_EFFECTIVE_N synthetic
// observations. Posterior factor is a precision-weighted blend of prior and
// data: at n=0, factor=1.0; at n=10, half-weight to data; at n=100, ~91% to
// data. Smooth transition — no discontinuity.
const PRIOR_EFFECTIVE_N = 10;
const PRIOR_FACTOR      = 1.0;
// Never shrink σ_eff below the raw σ_ensemble — model is allowed to be
// conservative, just not allowed to be more confident than it claimed.
const FLOOR_FACTOR      = 1.0;

// 2026-06-01: BAYESIAN POSTERIOR-PREDICTIVE params (replaces the point
// inflation_factor as kalshi.js's σ source). Model: z = (actual−μ)/σ_model ~
// N(0, k²) with k² the unknown calibration factor. Conjugate scaled-inverse-χ²
// prior on k²: ν₀ pseudo-observations asserting k²=σ₀²=1 (model is calibrated).
// Posterior over k² is scaled-inv-χ²(ν_n, σ_n²) with
//     ν_n   = ν₀ + n
//     σ_n²  = (ν₀·1 + Σz²) / (ν₀ + n)
// Marginalizing k² out of the outcome's N(μ, σ_model²·k²) gives a Student-t
// posterior predictive: actual ~ μ + (σ_model·σ_n)·t_{ν_n}. kalshi.js builds
// bucket probabilities from this t (not Normal·point-factor), so small n → low
// ν_n → fat tails → extreme bucket probs pulled toward 0.5 → EV shrinks →
// the bot abstains *organically* (no hard n-threshold). We use Σz² (2nd moment
// about 0, not about the mean) so that uncorrected μ-bias widens the predictive
// honestly — and once a μ-offset is added, z̄→0 and Σz²→variance automatically.
// ν₀ small ⇒ humble with little data; sweep validated in backtest_tpred.mjs.
const PRIOR_DOF = 4;

// City name → CLI code, mirrored from weather.js CITIES to keep this file
// self-contained (no cross-import side effects).
const CITY_TO_CLI = {
  "New York": "NYC", "Los Angeles": "LAX", "Chicago": "MDW", "Houston": "HOU",
  "Phoenix": "PHX", "Philadelphia": "PHL", "San Antonio": "SAT", "San Diego": "SAN",
  "Dallas-Fort Worth": "DFW", "Jacksonville": "JAX", "Austin": "AUS", "Tampa": "TPA",
  "San Jose": "SJC", "Columbus": "CMH", "Charlotte": "CLT", "Indianapolis": "IND",
  "Seattle": "SEA", "Denver": "DEN", "Washington DC": "DCA", "Boston": "BOS"
};

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / (xs.length || 1); }
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

async function loadAllBlobEntries(storeName, maxEntries = Infinity) {
  const store = getStore(storeName);
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  let keys = (blobs || []).map(b => b.key);
  // 2026-06-04: cap the load to the most-recent maxEntries. Loading ALL blobs OOM'd/
  // timed-out the function on HTTP invocation (the cause of the cal-cron's 502 →
  // calibration_state going stale → cal-stale halting the bot). A recent window is all
  // the calibration needs.
  if (keys.length > maxEntries) { keys.sort().reverse(); keys = keys.slice(0, maxEntries); }
  const entries = await Promise.all(
    keys.map(k => store.get(k, { type: "json" }).catch(() => null))
  );
  return entries.filter(Boolean);
}

// 2026-07-24: the predictions store is keyed `${cli}/${date}` — CLI FIRST, not date.
// loadAllBlobEntries' sort-desc-then-slice therefore ordered by CITY: the 600-key cap
// kept 100% of TPA…NYC and 0% of AUS…MDW (10 of 28 cities in the store). Measured
// consequences: 50 of 176 settled HIGH bets whose prediction record existed and carried
// actualHigh were simply not loaded, and σ_high/σ_low were fit on a fixed Sunbelt/West
// subset (σ_high raw 2.139 vs 1.895 on an unbiased same-size window).
// keyDate() pulls the date segment so "most recent N" means a recent window across all
// cities. The `.json` strip covers 16 legacy keys from 2026-05-03/04.
export function keyDate(key) {
  const s = String(key);
  const i = s.indexOf("/");
  return (i < 0 ? s : s.slice(i + 1)).replace(/\.json$/, "");
}

async function listKeys(storeName) {
  const store = getStore(storeName);
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  return (blobs || []).map(b => b.key);
}

// Chunked parallel get — same shape as loadAllBlobEntries' Promise.all but bounded so a
// large key list can't open thousands of sockets at once.
async function getMany(storeName, keys, chunkSize = 100) {
  const store = getStore(storeName);
  const out = new Map();
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const vals = await Promise.all(
      chunk.map(k => store.get(k, { type: "json" }).catch(() => null))
    );
    chunk.forEach((k, j) => { if (vals[j]) out.set(k, vals[j]); });
  }
  return out;
}

// Build {cli/date → actualHigh, actualLow} index from the predictions blob.
export function indexActualsByCliDate(predictions) {
  const idx = {};
  for (const p of predictions) {
    if (!p.cli || !p.date) continue;
    const k = `${p.cli}/${p.date}`;
    idx[k] = { actualHigh: p.actualHigh ?? null, actualLow: p.actualLow ?? null };
  }
  return idx;
}

// Settled bet's target date (the local day whose high/low the bet was for).
// We use placedAtUTC (more reliable than settledAtUTC for date arithmetic):
// the bet was placed during local day D — extract D in the city's TZ. The
// predictions blob is keyed by local-date string.
export function targetLocalDate(bet, tz) {
  if (!bet.placedAtUTC) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "America/Chicago",
      year: "numeric", month: "2-digit", day: "2-digit"
    });
    return fmt.format(new Date(bet.placedAtUTC));
  } catch (e) { return null; }
}

// City TZ table — same mapping kalshi.js / weather.js use. Keep minimal copy.
const CITY_TZ = {
  "New York": "America/New_York", "Los Angeles": "America/Los_Angeles",
  "Chicago": "America/Chicago", "Houston": "America/Chicago",
  "Phoenix": "America/Phoenix", "Philadelphia": "America/New_York",
  "San Antonio": "America/Chicago", "San Diego": "America/Los_Angeles",
  "Dallas-Fort Worth": "America/Chicago", "Jacksonville": "America/New_York",
  "Austin": "America/Chicago", "Tampa": "America/New_York",
  "San Jose": "America/Los_Angeles", "Columbus": "America/New_York",
  "Charlotte": "America/New_York", "Indianapolis": "America/Indiana/Indianapolis",
  "Seattle": "America/Los_Angeles", "Denver": "America/Denver",
  "Washington DC": "America/New_York", "Boston": "America/New_York"
};

// A settled bet reduced to what the join needs, or null if it can't be joined at all.
export function betJoinTarget(b) {
  if (!b) return null;
  if (b.variable !== "high" && b.variable !== "low") return null;
  if (b.modelMean == null || b.modelStd == null || b.modelStd <= 0) return null;
  const cli = CITY_TO_CLI[b.city];
  const tz  = CITY_TZ[b.city];
  if (!cli || !tz) return null;
  const date = targetLocalDate(b, tz);
  if (!date) return null;
  return { cli, date, key: `${cli}/${date}`, variable: b.variable };
}

// Join settled bets against the actuals index.
//
// `coverageStart` = the oldest date present in the predictions store. Bets targeting a
// day before that can NEVER join (the store simply doesn't go back that far — its first
// record is 2026-05-11, while the ledger starts 2026-05-05), so they are counted
// separately instead of being folded into `eligible`. Otherwise the broken-pipe alarm
// stays permanently tripped by prehistory and stops meaning anything — which is exactly
// how the real degradation went unnoticed.
export function joinSettledToActuals(settled, actuals, coverageStart = null) {
  const zHigh = [], zLow = [];
  let matched = 0, unmatched = 0;
  // Per-side "eligible" = join was attempted against a day the predictions store covers.
  // eligible≫matched on a side ⇒ the actuals join is broken for that side (the exact
  // failure that killed LOW: actualLow never written). This is the only hard liveness
  // check the trader keeps — it's a broken-pipe detector, not a statistical threshold.
  let eligibleHigh = 0, eligibleLow = 0;
  let outOfCoverageHigh = 0, outOfCoverageLow = 0;

  for (const b of settled) {
    const t = betJoinTarget(b);
    if (!t) continue;
    if (coverageStart && t.date < coverageStart) {
      if (t.variable === "high") outOfCoverageHigh++; else outOfCoverageLow++;
      continue;
    }
    if (t.variable === "high") eligibleHigh++; else eligibleLow++;
    const a = actuals[t.key];
    const actual = t.variable === "high" ? a?.actualHigh : a?.actualLow;
    if (actual == null) { unmatched++; continue; }
    const z = (actual - b.modelMean) / b.modelStd;
    if (!Number.isFinite(z)) continue;
    if (t.variable === "high") zHigh.push(z); else zLow.push(z);
    matched++;
  }
  return { zHigh, zLow, matched, unmatched, eligibleHigh, eligibleLow,
           outOfCoverageHigh, outOfCoverageLow };
}

// How many prediction records to load for the population fit (σ_high/σ_low, ν/scale),
// and how many extra targeted gets the actuals join may spend on days that fall outside
// that window. The join is demand-driven so it no longer depends on the retention window
// happening to contain the days the settled bets need.
const PRED_POPULATION_MAX = 600;
const JOIN_FETCH_MAX      = 800;
// Current predictions key shape, `${cli}/${YYYY-MM-DD}` (logger.js runCapture).
export const PRED_KEY_RE = /^[A-Z]{3}\/\d{4}-\d{2}-\d{2}$/;

// Exported so the join can be exercised read-only against the live blobs (it never
// writes — only the handler below does).
export async function computeCalibration() {
  const [settled, allPredKeys] = await Promise.all([
    loadAllBlobEntries(SETTLED_STORE, 1500),
    listKeys(PREDICTIONS_STORE),
  ]);

  // logger.js runCapture writes `${cli}/${date}`. 16 surviving `${cli}/${date}.json` keys
  // from 2026-05-03/04 are a previous generation with a different schema (localDate/mean,
  // no cli/date/predHigh) — inert for the index and misleading for the coverage floor.
  const predKeys = allPredKeys.filter(k => PRED_KEY_RE.test(k));
  const predKeySet = new Set(predKeys);
  const predDates  = predKeys.map(keyDate).sort();
  const coverageStart = predDates.length ? predDates[0] : null;

  // Population window: most recent PRED_POPULATION_MAX records BY DATE (see keyDate).
  const popKeys = [...predKeys]
    .sort((a, b) => keyDate(b).localeCompare(keyDate(a)) || a.localeCompare(b))
    .slice(0, PRED_POPULATION_MAX);
  const popKeySet = new Set(popKeys);

  // Demand-driven join keys: exactly the `${cli}/${date}` records the settled bets ask
  // for, minus the ones the population window already loads. Filtered against the store's
  // real key list so prehistoric days cost zero gets.
  const wanted = new Set();
  for (const b of settled) {
    const t = betJoinTarget(b);
    if (t && predKeySet.has(t.key) && !popKeySet.has(t.key)) wanted.add(t.key);
  }
  const joinKeys = [...wanted].sort((a, b) => keyDate(b).localeCompare(keyDate(a)))
    .slice(0, JOIN_FETCH_MAX);

  const [popRecs, joinRecs] = await Promise.all([
    getMany(PREDICTIONS_STORE, popKeys),
    getMany(PREDICTIONS_STORE, joinKeys),
  ]);
  // Population fit uses ONLY the recent window; the join index also sees the older
  // records the settled bets pointed at.
  const predictions = [...popRecs.values()];
  const actuals = indexActualsByCliDate([...popRecs.values(), ...joinRecs.values()]);

  const { zHigh, zLow, matched, unmatched, eligibleHigh, eligibleLow,
          outOfCoverageHigh, outOfCoverageLow } =
    joinSettledToActuals(settled, actuals, coverageStart);

  // Learning calibration factor:
  //   - shrunk: Bayesian-shrunk empirical stdev (smooths the n→0 transition)
  //   - cap: adaptive 95th-percentile cap (data-derived ceiling — wider tails
  //          require a higher cap to keep coverage honest; with few obs the
  //          cap is loose so well-calibrated data can express itself)
  //   - factor = max(FLOOR, min(shrunk, cap))
  // Bayesian posterior-predictive (ν_n, σ_n) from the conjugate scaled-inv-χ²
  // prior. Defined for ALL n including 0 (prior-only): ν_n=ν₀, σ_n=1 → t_{ν₀}.
  const predictive = (zs) => {
    const n = zs.length;
    const sumZ2 = zs.reduce((a, z) => a + z * z, 0);
    const nu = PRIOR_DOF + n;
    const scale = Math.sqrt((PRIOR_DOF * 1 + sumZ2) / (PRIOR_DOF + n));
    return { nu, scale: Math.round(scale * 1000) / 1000 };
  };
  const calibrate = (zs) => {
    if (zs.length === 0) {
      return { factor: PRIOR_FACTOR, shrunk: PRIOR_FACTOR, cap: null, p95_abs_z: null };
    }
    const sd = stdev(zs);
    // Bayesian shrinkage of stdev toward the PRIOR_FACTOR (1.0).
    const w_data  = zs.length / (zs.length + PRIOR_EFFECTIVE_N);
    const shrunk  = Number.isFinite(sd) && sd > 0
      ? PRIOR_FACTOR * (1 - w_data) + sd * w_data
      : PRIOR_FACTOR;
    // Adaptive cap: 95th percentile of |z| / 1.96. Translates "the wildest
    // observation we've seen (in the tail) needs to fit inside a 95% CI" into
    // a σ multiplier. With <10 obs the cap is Infinity (let the data speak).
    const abs_zs = zs.map(Math.abs).sort((a, b) => b - a);
    const idx95  = Math.floor(0.05 * abs_zs.length);
    const p95    = abs_zs[idx95] ?? abs_zs[0];
    const cap    = (zs.length >= 10) ? Math.max(FLOOR_FACTOR, p95 / 1.96) : Infinity;
    const factor = Math.max(FLOOR_FACTOR, Math.min(shrunk, cap));
    return {
      factor: Math.round(factor * 1000) / 1000,
      shrunk: Math.round(shrunk * 1000) / 1000,
      cap: Number.isFinite(cap) ? Math.round(cap * 1000) / 1000 : null,
      p95_abs_z: Math.round(p95 * 1000) / 1000,
      data_weight: Math.round(w_data * 1000) / 1000  // how much we trust the data vs. the prior
    };
  };
  // Empirical 68% / 95% coverage diagnostics — useful for the dashboard.
  const coverageFraction = (zs, z_crit) =>
    zs.length ? zs.filter(z => Math.abs(z) <= z_crit).length / zs.length : null;

  const cHigh = calibrate(zHigh);
  const cLow  = calibrate(zLow);
  // pHigh / pLow are computed AFTER the sigma posteriors below — they now fit on the
  // unselected prediction population, which needs sigmaHighPost / sigmaLowPost as the
  // z denominator. See the block following sigmaLowPost.

  // ADAPTIVE sigma_high (calibrated parameter). Posterior predictive σ for HIGH, fit from
  // the UNSELECTED prediction population (errors actual−pred, NOT bet-matched — that
  // selection bias is what inflated the old scale). Scaled-inverse-χ² form seeded at the
  // prior σ₀ with ν₀ pseudo-observations, then hard-clamped to the backtested-profitable
  // guardrails. kalshi.js reads .posterior, re-clamps, and falls back to .prior. Walk-
  // forward backtest (585 events): converges to ~2.0, stays inside the bounds, matches
  // fixed-σ=2.0 P&L. The prior/bounds MUST mirror kalshi.js SIGMA_HIGH_{PRIOR,FLOOR,CAP}.
  const SIGMA_HIGH_PRIOR = 2.0, SIGMA_HIGH_NU0 = 30, SIGMA_HIGH_FLOOR = 1.5, SIGMA_HIGH_CAP = 2.5;
  const highErrs = predictions
    .map(p => (p?.actualHigh != null && p?.predHigh != null) ? p.actualHigh - p.predHigh : null)
    .filter(e => Number.isFinite(e) && Math.abs(e) < 25);  // drop absurd values / broken joins
  const sumErr2 = highErrs.reduce((a, e) => a + e * e, 0);
  const nErr = highErrs.length;
  const sigmaHighRaw = Math.sqrt(
    (SIGMA_HIGH_NU0 * SIGMA_HIGH_PRIOR ** 2 + sumErr2) / (SIGMA_HIGH_NU0 + nErr));
  const sigmaHighPost = Math.min(SIGMA_HIGH_CAP, Math.max(SIGMA_HIGH_FLOOR, sigmaHighRaw));

  // ADAPTIVE sigma_low — exact twin of sigma_high (2026-06-05). Same population-fit form,
  // same guardrails. The old hardcoded SIGMA_FLOOR_LOW=2.0 came from a BET-MATCHED residual
  // audit (|z|/exp≈5.9) — the same selection bias that inflated HIGH to 2.775. The UNSELECTED
  // population residual (actualLow−predLow) is RMS≈1.37, bias≈−0.13, no fat tails → honest
  // posterior ≈1.45 (clamps to the 1.5 floor), TIGHTER than the old 2.0 floor. Price-level
  // backtest (_edge_raw_low.json, 231 events, real fills + CLI settle, backtest_bucket_pnl_low.mjs)
  // is +EV across the ENTIRE [1.5,2.5] envelope (1.5→+30.8%, 2.0→+28.2%, 2.5→+25.3% at thr 0.15;
  // breaks down only past σ=3.0) — so a runaway fit can't leave +EV, the guardrail invariant.
  // Requires logger.js pred.actualLow (the keystone fix); population grows as LOW settles.
  const SIGMA_LOW_PRIOR = 2.0, SIGMA_LOW_NU0 = 30, SIGMA_LOW_FLOOR = 1.5, SIGMA_LOW_CAP = 2.5;
  const lowErrs = predictions
    .map(p => (p?.actualLow != null && p?.predLow != null) ? p.actualLow - p.predLow : null)
    .filter(e => Number.isFinite(e) && Math.abs(e) < 25);
  const sumErr2Low = lowErrs.reduce((a, e) => a + e * e, 0);
  const nErrLow = lowErrs.length;
  const sigmaLowRaw = Math.sqrt(
    (SIGMA_LOW_NU0 * SIGMA_LOW_PRIOR ** 2 + sumErr2Low) / (SIGMA_LOW_NU0 + nErrLow));
  const sigmaLowPost = Math.min(SIGMA_LOW_CAP, Math.max(SIGMA_LOW_FLOOR, sigmaLowRaw));

  // Posterior-predictive (ν, scale), fit on the UNSELECTED prediction population rather
  // than on settled bets (2026-07-24).
  //
  // predictive() sets ν = PRIOR_DOF + n, so ν is a direct function of SAMPLE SIZE. The
  // settled-bet population is both selection-biased and starving: with the trader halted
  // nothing new settles, and the actuals join was matching only 30/176 HIGH and 1/42 LOW
  // — the file's own "eligible≫matched ⇒ broken pipe" criterion, tripped and unnoticed.
  // LOW was therefore publishing ν=5 (a Student-t on FIVE dof, derived from ONE
  // observation) into every LOW bucket probability in kalshi.js. That fattens the tails
  // exactly where the edge audit found the losses: buckets priced under 5¢ realize 0.6%
  // against 1.0% priced (z=−5.5, diagnose_edge.js). A broken join was funding cheap-tail
  // bets.
  //
  // The unselected population already drives sigma_high / sigma_low successfully (n=566
  // and 416 today vs 30 and 1). Reuse it, with the SERVED posterior σ as the denominator
  // — "given the σ we actually publish, how do the residuals behave" is precisely what ν
  // parameterises. This keeps calibration learning while the trader is halted and removes
  // the selection bias that inflated the old scale to 2.775 and cost ~$415.
  //
  // Falls back to the bet-matched population when the unselected one is too small, so a
  // cold start is never worse than before.
  const POP_MIN_N = 50;
  const popZ = (errs, sigma) =>
    (Number.isFinite(sigma) && sigma > 0) ? errs.map(e => e / sigma).filter(Number.isFinite) : [];
  const zHighPop = popZ(highErrs, sigmaHighPost);
  const zLowPop  = popZ(lowErrs,  sigmaLowPost);
  const useHighPop = zHighPop.length >= POP_MIN_N && zHighPop.length > zHigh.length;
  const useLowPop  = zLowPop.length  >= POP_MIN_N && zLowPop.length  > zLow.length;
  const pHigh = predictive(useHighPop ? zHighPop : zHigh);
  const pLow  = predictive(useLowPop  ? zLowPop  : zLow);

  // Broken-pipe alarm. This condition was already true and silent; make it loud so a
  // degraded join surfaces instead of quietly steering ν.
  const joinHigh = eligibleHigh ? zHigh.length / eligibleHigh : null;
  const joinLow  = eligibleLow  ? zLow.length  / eligibleLow  : null;
  if (joinHigh != null && joinHigh < 0.5)
    console.error(`[calibration] HIGH actuals join DEGRADED: ${zHigh.length}/${eligibleHigh} `
      + `(${(joinHigh * 100).toFixed(0)}%) in-coverage (+${outOfCoverageHigh} bets predate `
      + `${coverageStart}) — ν now fit on the unselected population instead`);
  if (joinLow != null && joinLow < 0.5)
    console.error(`[calibration] LOW actuals join DEGRADED: ${zLow.length}/${eligibleLow} `
      + `(${(joinLow * 100).toFixed(0)}%) in-coverage (+${outOfCoverageLow} bets predate `
      + `${coverageStart}) — ν now fit on the unselected population instead`);

  return {
    updated_at: new Date().toISOString(),
    prior_dof: PRIOR_DOF,
    // Join plumbing, so a degraded window/coverage is visible instead of inferred.
    predictions_window: {
      store_keys: allPredKeys.length,
      usable_keys: predKeys.length,
      population_n: predictions.length,
      population_cap: PRED_POPULATION_MAX,
      join_keys_fetched: joinKeys.length,
      coverage_start: coverageStart
    },
    sigma_high: {
      posterior: Math.round(sigmaHighPost * 1000) / 1000,
      raw_posterior: Math.round(sigmaHighRaw * 1000) / 1000,
      prior: SIGMA_HIGH_PRIOR, nu0: SIGMA_HIGH_NU0,
      floor: SIGMA_HIGH_FLOOR, cap: SIGMA_HIGH_CAP, n: nErr
    },
    sigma_low: {
      posterior: Math.round(sigmaLowPost * 1000) / 1000,
      raw_posterior: Math.round(sigmaLowRaw * 1000) / 1000,
      prior: SIGMA_LOW_PRIOR, nu0: SIGMA_LOW_NU0,
      floor: SIGMA_LOW_FLOOR, cap: SIGMA_LOW_CAP, n: nErrLow
    },
    high: {
      n: zHigh.length,
      eligible: eligibleHigh,
      out_of_coverage: outOfCoverageHigh,
      mean_z: zHigh.length ? Math.round(mean(zHigh) * 1000) / 1000 : null,
      stdev_z: zHigh.length ? Math.round(stdev(zHigh) * 1000) / 1000 : null,
      coverage_68: coverageFraction(zHigh, 1.0),
      coverage_95: coverageFraction(zHigh, 1.96),
      // Posterior-predictive params consumed by kalshi.js (Student-t bucket probs).
      predictive_nu: pHigh.nu,
      predictive_scale: pHigh.scale,
      // Which population ν/scale came from, and the join health that decided it.
      predictive_source: useHighPop ? "unselected-population" : "settled-bets",
      predictive_n: useHighPop ? zHighPop.length : zHigh.length,
      join_rate: joinHigh != null ? Math.round(joinHigh * 1000) / 1000 : null,
      inflation_factor: cHigh.factor,    // retained for dashboard continuity
      shrunk_estimate: cHigh.shrunk,
      adaptive_cap: cHigh.cap,
      p95_abs_z: cHigh.p95_abs_z,
      data_weight: cHigh.data_weight
    },
    low: {
      n: zLow.length,
      eligible: eligibleLow,
      out_of_coverage: outOfCoverageLow,
      mean_z: zLow.length ? Math.round(mean(zLow) * 1000) / 1000 : null,
      stdev_z: zLow.length ? Math.round(stdev(zLow) * 1000) / 1000 : null,
      coverage_68: coverageFraction(zLow, 1.0),
      coverage_95: coverageFraction(zLow, 1.96),
      predictive_nu: pLow.nu,
      predictive_scale: pLow.scale,
      predictive_source: useLowPop ? "unselected-population" : "settled-bets",
      predictive_n: useLowPop ? zLowPop.length : zLow.length,
      join_rate: joinLow != null ? Math.round(joinLow * 1000) / 1000 : null,
      inflation_factor: cLow.factor,
      shrunk_estimate: cLow.shrunk,
      adaptive_cap: cLow.cap,
      p95_abs_z: cLow.p95_abs_z,
      data_weight: cLow.data_weight
    },
    matched, unmatched,
    notes: `Factor = max(${FLOOR_FACTOR}, min(shrunk, adaptive_cap)). `
         + `Shrunk = Bayesian blend of empirical stdev(z) with prior 1.0 at effective n=${PRIOR_EFFECTIVE_N}. `
         + `Adaptive cap = quantile95(|z|) / 1.96, active once n≥10. No hard sample-size cliff.`
  };
}

export default async () => {
  try {
    const state = await computeCalibration();
    const store = getStore(CALIBRATION_STORE);
    await store.setJSON(CALIBRATION_KEY, state);
    return new Response(JSON.stringify({ ok: true, ...state }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
      { status: 500, headers: { "content-type": "application/json" } });
  }
};

// Background function (filename -background suffix): 15-min limit, returns 202.
// HTTP/cron-triggered via /api/calibration_update — no Netlify schedule (the throttled
// scheduler was the failure mode). External cron (cron-job.org primary + GH Actions
// backstop) drives it every ~30 min; the trader's cal-stale gate (180 min) tolerates gaps.
