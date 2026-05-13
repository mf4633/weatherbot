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

const MIN_N_FOR_INFLATE = 20;  // below this, ship factor=1.0 (insufficient data)
const MAX_INFLATION     = 2.5; // cap to avoid pathological blow-ups

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

  const inflate = (zs) => {
    if (zs.length < MIN_N_FOR_INFLATE) return 1.0;
    const s = stdev(zs);
    if (!Number.isFinite(s) || s <= 1.0) return 1.0;
    return Math.min(MAX_INFLATION, s);
  };
  // Empirical 68% / 95% coverage diagnostics — useful for the dashboard.
  const coverageFraction = (zs, z_crit) =>
    zs.length ? zs.filter(z => Math.abs(z) <= z_crit).length / zs.length : null;

  return {
    updated_at: new Date().toISOString(),
    high: {
      n: zHigh.length,
      mean_z: zHigh.length ? mean(zHigh) : null,
      stdev_z: zHigh.length ? stdev(zHigh) : null,
      coverage_68: coverageFraction(zHigh, 1.0),
      coverage_95: coverageFraction(zHigh, 1.96),
      inflation_factor: inflate(zHigh)
    },
    low: {
      n: zLow.length,
      mean_z: zLow.length ? mean(zLow) : null,
      stdev_z: zLow.length ? stdev(zLow) : null,
      coverage_68: coverageFraction(zLow, 1.0),
      coverage_95: coverageFraction(zLow, 1.96),
      inflation_factor: inflate(zLow)
    },
    matched, unmatched,
    notes: `Inflation = max(1.0, stdev(z)); floor 1.0, cap ${MAX_INFLATION}. Requires n≥${MIN_N_FOR_INFLATE} for non-trivial value.`
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
