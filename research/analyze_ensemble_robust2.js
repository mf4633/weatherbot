// Follow-up to analyze_ensemble_robust.js. Three questions:
//   1. Why is TRAIN garbage (RMSE 7.3, meanSigma 23.4)? Suspect: the Open-Meteo
//      historical-forecast archive doesn't carry all 5 models back to 2021-05, and
//      missing members collapse to ~0F, exploding the spread.
//   2. The tested clip thresholds (minAbs 2-5F) fire on 4.6-23.8% of city-days —
//      far too often to be "outlier rejection". Does a threshold high enough to catch
//      ONLY true garbage (the LAX ECMWF +11F case) behave differently?
//   3. Conditional: on the rare extreme-deviation days, is the outlier member noise
//      (clip helps) or signal (clip hurts)?
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const PREDICTION_HOURS = [6, 9, 12, 15];
const TEST_DAYS = 180;
const MODELS = data.models;
const BIAS_WEIGHT = 0.4;
const SIGMA_RESOLUTION_F = 1.0;

const localHour = (iso, tz) => parseInt(new Intl.DateTimeFormat("en-US",
  { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(iso)), 10);
const localDateStr = (iso, tz) => new Intl.DateTimeFormat("en-CA",
  { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

console.log("Pre-processing...");
const cityProcessed = {};
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const obsByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    (obsByDay[localDateStr(ts, tz)] ??= []).push({ tempF: c.obs.temps[i], localHr: localHour(ts, tz) });
  }
  const fcByModel = {};
  for (const model of MODELS) {
    const m = c.models[model];
    if (!m) continue;
    const byDay = {};
    for (let i = 0; i < m.times.length; i++) {
      const ts = m.times[i] + "Z";
      const t = m.temps[i];
      // Treat null/non-finite as MISSING rather than letting it coerce to 0.
      if (t == null || !isFinite(t)) continue;
      (byDay[localDateStr(ts, tz)] ??= []).push({ tempF: t, localHr: localHour(ts, tz) });
    }
    fcByModel[model] = byDay;
  }
  cityProcessed[name] = { obsByDay, fcByModel };
}

// ---------- Q1: per-year model availability ----------
console.log("\n=== Model availability by year (share of NYC city-days with >=12 hourly values) ===");
{
  const c = cityProcessed.NYC;
  const byYear = {};
  for (const date of Object.keys(c.obsByDay)) {
    const y = date.slice(0, 4);
    (byYear[y] ??= { days: 0, present: Object.fromEntries(MODELS.map(m => [m, 0])) });
    byYear[y].days++;
    for (const m of MODELS) if ((c.fcByModel[m]?.[date]?.length ?? 0) >= 12) byYear[y].present[m]++;
  }
  console.log("year   days   " + MODELS.map(m => m.slice(0, 10).padEnd(11)).join(""));
  for (const [y, v] of Object.entries(byYear).sort()) {
    console.log(`${y}   ${String(v.days).padEnd(6)} `
      + MODELS.map(m => `${(v.present[m] / v.days * 100).toFixed(0)}%`.padEnd(11)).join(""));
  }
}

const median = xs => { const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sampleStd = xs => xs.length > 1
  ? Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1)) : null;

function madClip(xs, k, minAbs) {
  if (xs.length < 4) return xs;
  const med = median(xs);
  const mad = 1.4826 * median(xs.map(x => Math.abs(x - med)));
  const thresh = Math.max(k * mad, minAbs);
  const kept = xs.filter(x => Math.abs(x - med) <= thresh);
  return kept.length >= 3 ? kept : xs;
}

const AGGREGATORS = [
  { label: "mean (PRODUCTION)", fn: xs => xs },
  { label: "MAD k=2.5 minAbs=5",  fn: xs => madClip(xs, 2.5, 5) },
  { label: "MAD k=2.5 minAbs=6",  fn: xs => madClip(xs, 2.5, 6) },
  { label: "MAD k=2.5 minAbs=8",  fn: xs => madClip(xs, 2.5, 8) },
  { label: "MAD k=2.5 minAbs=10", fn: xs => madClip(xs, 2.5, 10) },
  { label: "MAD k=2.5 minAbs=12", fn: xs => madClip(xs, 2.5, 12) },
  { label: "MAD k=2.5 minAbs=15", fn: xs => madClip(xs, 2.5, 15) },
];

// Only evaluate days where ALL 5 models are present, so member availability is not
// a confound (this is the regime production actually runs in).
function evaluate(agg, dateFilter, opts = {}) {
  const rows = [];
  let clipped = 0, total = 0;
  for (const [, c] of Object.entries(cityProcessed)) {
    for (const [date, dayObs] of Object.entries(c.obsByDay)) {
      if (!dateFilter(date)) continue;
      if (dayObs.length < 12) continue;
      const actualMax = Math.max(...dayObs.map(o => o.tempF));
      const peakHour = dayObs.find(o => o.tempF === actualMax)?.localHr ?? 15;
      const peaks = {}, nowByHr = {};
      let allPresent = true;
      for (const m of MODELS) {
        const dayFc = c.fcByModel[m]?.[date];
        if (!dayFc || dayFc.length < 12) { allPresent = false; break; }
        peaks[m] = Math.max(...dayFc.map(o => o.tempF));
        for (const f of dayFc) (nowByHr[f.localHr] ??= {})[m] = f.tempF;
      }
      if (!allPresent) continue;
      const avail = MODELS.slice();
      const availPeaks = avail.map(m => peaks[m]);
      const med = median(availPeaks);
      const maxDev = Math.max(...availPeaks.map(x => Math.abs(x - med)));
      if (opts.minMaxDev != null && maxDev < opts.minMaxDev) continue;

      const keptVals = agg.fn(availPeaks);
      const point = mean(keptVals);
      let sigmaEns = sampleStd(keptVals);
      if (sigmaEns == null || !isFinite(sigmaEns)) sigmaEns = 0.8;
      total++;
      if (keptVals.length < availPeaks.length) clipped++;

      const survivors = (() => {
        const pool = [...keptVals]; const out = [];
        for (const m of avail) { const i = pool.indexOf(peaks[m]); if (i !== -1) { pool.splice(i, 1); out.push(m); } }
        return out;
      })();

      for (const predHr of PREDICTION_HOURS) {
        const obs = dayObs.filter(o => o.localHr <= predHr);
        if (!obs.length) continue;
        const maxSoFar = Math.max(...obs.map(o => o.tempF));
        const currentTemp = obs[obs.length - 1].tempF;
        const nows = nowByHr[predHr] || {};
        const nowVals = survivors.map(m => nows[m]).filter(v => v != null);
        const forecastNow = nowVals.length ? mean(nowVals) : null;
        const bias = forecastNow != null ? currentTemp - forecastNow : 0;
        const predMean = Math.max(maxSoFar, point + BIAS_WEIGHT * bias);
        const sigmaPost = Math.sqrt(sigmaEns ** 2 + SIGMA_RESOLUTION_F ** 2);
        rows.push({ err: predMean - actualMax, z: (actualMax - predMean) / sigmaPost, sigmaPost });
      }
    }
  }
  return { rows, clipRate: total ? clipped / total : 0, total };
}

function summarize(r) {
  const n = r.rows.length;
  if (!n) return null;
  const errs = r.rows.map(x => x.err);
  const sortedAbs = errs.map(Math.abs).sort((a, b) => a - b);
  return {
    n,
    rmse: Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / n),
    mae: errs.reduce((a, e) => a + Math.abs(e), 0) / n,
    bias: errs.reduce((a, e) => a + e, 0) / n,
    cov68: r.rows.filter(x => Math.abs(x.z) <= 1).length / n,
    cov95: r.rows.filter(x => Math.abs(x.z) <= 1.96).length / n,
    meanSigma: r.rows.reduce((a, x) => a + x.sigmaPost, 0) / n,
    p99: sortedAbs[Math.floor(0.99 * (n - 1))]
  };
}

const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEnd = allDates[allDates.length - 1 - TEST_DAYS];
const inTest = d => d > trainEnd;
// Clean TRAIN: only 2024+ where all models are actually present.
const inCleanTrain = d => d <= trainEnd && d >= "2024-01-01";

for (const [splitName, filt] of [["CLEAN TRAIN (2024-01-01 → " + trainEnd + ")", inCleanTrain],
                                 ["TEST (last 180d)", inTest]]) {
  console.log(`\n=== ${splitName} — all-5-models-present days only ===`);
  console.log("aggregator                  RMSE    MAE    bias   cov68  cov95  meanSig  p99   clip%");
  const base = summarize(evaluate(AGGREGATORS[0], filt));
  for (const agg of AGGREGATORS) {
    const r = evaluate(agg, filt);
    const s = summarize(r);
    const d = agg.label === AGGREGATORS[0].label ? "" :
      `  [RMSE ${((s.rmse - base.rmse) / base.rmse * 100) >= 0 ? "+" : ""}${((s.rmse - base.rmse) / base.rmse * 100).toFixed(2)}%]`;
    console.log(`${agg.label.padEnd(26)} ${s.rmse.toFixed(3)}  ${s.mae.toFixed(3)}  ${s.bias.toFixed(3).padStart(6)}  `
      + `${(s.cov68 * 100).toFixed(1)}%  ${(s.cov95 * 100).toFixed(1)}%  ${s.meanSigma.toFixed(2)}    ${s.p99.toFixed(2)}  ${(r.clipRate * 100).toFixed(1)}%${d}`);
  }
}

// ---------- Q3: conditional on a genuinely extreme member ----------
for (const dev of [6, 8, 10]) {
  console.log(`\n=== CONDITIONAL: days with max|member − median| >= ${dev}F (TEST + clean train) ===`);
  const filt = d => d >= "2024-01-01";
  console.log("aggregator                  RMSE    MAE    bias   cov95  meanSig   n");
  for (const agg of AGGREGATORS) {
    const r = evaluate(agg, filt, { minMaxDev: dev });
    const s = summarize(r);
    if (!s) { console.log(`${agg.label.padEnd(26)} (no rows)`); continue; }
    console.log(`${agg.label.padEnd(26)} ${s.rmse.toFixed(3)}  ${s.mae.toFixed(3)}  ${s.bias.toFixed(3).padStart(6)}  `
      + `${(s.cov95 * 100).toFixed(1)}%  ${s.meanSigma.toFixed(2)}   ${s.n}`);
  }
}
