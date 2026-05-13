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

async function loadAllBlobEntries(storeName) {
  const store = getStore(storeName);
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  const entries = await Promise.all(
    blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null))
  );
  return entries.filter(Boolean);
}

// Build {cli/date → actualHigh, actualLow} index from the predictions blob.
function indexActualsByCliDate(predictions) {
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
function targetLocalDate(bet, tz) {
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

async function computeCalibration() {
  const [settled, predictions] = await Promise.all([
    loadAllBlobEntries(SETTLED_STORE),
    loadAllBlobEntries(PREDICTIONS_STORE),
  ]);
  const actuals = indexActualsByCliDate(predictions);

  const zHigh = [], zLow = [];
  let matched = 0, unmatched = 0;

  for (const b of settled) {
    if (b.variable !== "high" && b.variable !== "low") continue;
    if (b.modelMean == null || b.modelStd == null || b.modelStd <= 0) continue;
    const cli = CITY_TO_CLI[b.city];
    const tz  = CITY_TZ[b.city];
    if (!cli || !tz) continue;
    const date = targetLocalDate(b, tz);
    if (!date) continue;
    const a = actuals[`${cli}/${date}`];
    const actual = b.variable === "high" ? a?.actualHigh : a?.actualLow;
    if (actual == null) { unmatched++; continue; }
    const z = (actual - b.modelMean) / b.modelStd;
    if (!Number.isFinite(z)) continue;
    if (b.variable === "high") zHigh.push(z); else zLow.push(z);
    matched++;
  }

  // Learning calibration factor:
  //   - shrunk: Bayesian-shrunk empirical stdev (smooths the n→0 transition)
  //   - cap: adaptive 95th-percentile cap (data-derived ceiling — wider tails
  //          require a higher cap to keep coverage honest; with few obs the
  //          cap is loose so well-calibrated data can express itself)
  //   - factor = max(FLOOR, min(shrunk, cap))
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
  return {
    updated_at: new Date().toISOString(),
    high: {
      n: zHigh.length,
      mean_z: zHigh.length ? Math.round(mean(zHigh) * 1000) / 1000 : null,
      stdev_z: zHigh.length ? Math.round(stdev(zHigh) * 1000) / 1000 : null,
      coverage_68: coverageFraction(zHigh, 1.0),
      coverage_95: coverageFraction(zHigh, 1.96),
      inflation_factor: cHigh.factor,
      shrunk_estimate: cHigh.shrunk,
      adaptive_cap: cHigh.cap,
      p95_abs_z: cHigh.p95_abs_z,
      data_weight: cHigh.data_weight
    },
    low: {
      n: zLow.length,
      mean_z: zLow.length ? Math.round(mean(zLow) * 1000) / 1000 : null,
      stdev_z: zLow.length ? Math.round(stdev(zLow) * 1000) / 1000 : null,
      coverage_68: coverageFraction(zLow, 1.0),
      coverage_95: coverageFraction(zLow, 1.96),
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

export const config = { schedule: "*/30 * * * *" };
