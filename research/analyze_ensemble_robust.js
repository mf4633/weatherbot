// Does outlier-rejecting the multi-model ensemble beat the equal-weight mean?
//
// Motivation (2026-07-23): ECMWF returned 91.4F for KLAX against an ensemble median
// of 80.2 — +11.2F, in a 13kt onshore sea breeze. The equal-weight mean has no outlier
// rejection, so that single member dragged mu to 82.6 AND inflated sigma_ensemble to
// 5.25 (sigma enters quadratically), producing ci95 [80, 93.2] and fake edge on the
// Kalshi board. Same-day scan found >4F deviations from median at San Diego (-8.1),
// San Jose (-6.6), Denver (+5.9), San Antonio (+4.8) — routine, not a one-off.
//
// This tests aggregation ONLY. It does not touch bias weight, offsets, or truncation —
// those stay at the harness baseline so the aggregator is the single moving part.
//
// Two things must both hold before shipping a change:
//   1. TEST RMSE of the point must not regress.
//   2. sigma calibration must not regress. sigma_ensemble feeds sigma_post =
//      sqrt(sigma_ens^2 + sigma_res^2), which sets Kelly stake everywhere. An
//      aggregator that improves the mean while collapsing sigma would make the bot
//      MORE confident and is a net loss.
//
// Run: node --max-old-space-size=8192 analyze_ensemble_robust.js
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const PREDICTION_HOURS = [6, 9, 12, 15];
const TEST_DAYS = 180;           // hold out last 6 months (matches analyze_5yr.js)
const MODELS = data.models;
const BIAS_WEIGHT = 0.4;         // harness baseline
const SIGMA_RESOLUTION_F = 1.0;  // production value (weather.js)

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
      (byDay[localDateStr(ts, tz)] ??= []).push({ tempF: m.temps[i], localHr: localHour(ts, tz) });
    }
    fcByModel[model] = byDay;
  }
  cityProcessed[name] = { obsByDay, fcByModel };
}

// ---------- aggregators ----------
// Each takes the available member peaks and returns { keep: number[], point: number }.
// `keep` is the surviving member set; sigma_ensemble is the sample std over it.
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sampleStd = xs => xs.length > 1
  ? Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1)) : null;

// MAD clip. Guards that matter with n=5:
//   - scaled MAD (x1.4826) so k is in familiar sigma units
//   - absolute floor minAbs: when models agree tightly MAD collapses and a member
//     0.5F off would be "rejected"; we only ever reject genuinely distant members
//   - never drop below 3 survivors
function madClip(xs, k, minAbs) {
  if (xs.length < 4) return xs;
  const med = median(xs);
  const mad = 1.4826 * median(xs.map(x => Math.abs(x - med)));
  const thresh = Math.max(k * mad, minAbs);
  const kept = xs.filter(x => Math.abs(x - med) <= thresh);
  return kept.length >= 3 ? kept : xs;
}
function trimMinMax(xs) {
  if (xs.length < 5) return xs;
  const s = [...xs].sort((a, b) => a - b);
  return s.slice(1, -1);
}

const AGGREGATORS = [
  { label: "mean (PRODUCTION)",       fn: xs => xs },
  { label: "median",                  fn: xs => [median(xs)], medianPoint: true },
  { label: "trim min+max",            fn: trimMinMax },
  { label: "MAD k=2.0 minAbs=2",      fn: xs => madClip(xs, 2.0, 2.0) },
  { label: "MAD k=2.5 minAbs=2",      fn: xs => madClip(xs, 2.5, 2.0) },
  { label: "MAD k=3.0 minAbs=2",      fn: xs => madClip(xs, 3.0, 2.0) },
  { label: "MAD k=2.5 minAbs=3",      fn: xs => madClip(xs, 2.5, 3.0) },
  { label: "MAD k=2.5 minAbs=4",      fn: xs => madClip(xs, 2.5, 4.0) },
  { label: "MAD k=2.5 minAbs=5",      fn: xs => madClip(xs, 2.5, 5.0) },
];

// ---------- evaluation ----------
function evaluate(agg, dateFilter) {
  const rows = [];
  let clipped = 0, total = 0;
  const clipByModel = {};
  for (const [name, c] of Object.entries(cityProcessed)) {
    for (const [date, dayObs] of Object.entries(c.obsByDay)) {
      if (!dateFilter(date)) continue;
      if (dayObs.length < 12) continue;
      const actualMax = Math.max(...dayObs.map(o => o.tempF));
      const peakHour = dayObs.find(o => o.tempF === actualMax)?.localHr ?? 15;

      // Per-model forecast peak today + per-hour "forecast now".
      const peaks = {}, nowByHr = {};
      for (const m of MODELS) {
        const dayFc = c.fcByModel[m]?.[date];
        if (!dayFc?.length) continue;
        peaks[m] = Math.max(...dayFc.map(o => o.tempF));
        for (const f of dayFc) (nowByHr[f.localHr] ??= {})[m] = f.tempF;
      }
      const avail = MODELS.filter(m => peaks[m] != null);
      if (avail.length < 3) continue;
      const availPeaks = avail.map(m => peaks[m]);

      // Aggregate. Surviving member set drives BOTH the point and sigma_ensemble.
      const keptVals = agg.fn(availPeaks);
      const point = agg.medianPoint ? keptVals[0] : mean(keptVals);
      // sigma over survivors; for the median aggregator use the full-set MAD-sigma
      // (a 1-element "kept" set has no spread, but the ensemble disagreement is real).
      let sigmaEns;
      if (agg.medianPoint) {
        sigmaEns = 1.4826 * median(availPeaks.map(x => Math.abs(x - keptVals[0])));
      } else {
        sigmaEns = sampleStd(keptVals);
      }
      if (sigmaEns == null || !isFinite(sigmaEns)) sigmaEns = 0.8;

      total++;
      if (!agg.medianPoint && keptVals.length < availPeaks.length) {
        clipped++;
        const keptSet = [...keptVals];
        for (const m of avail) {
          const i = keptSet.indexOf(peaks[m]);
          if (i === -1) clipByModel[m] = (clipByModel[m] || 0) + 1;
          else keptSet.splice(i, 1);
        }
      }

      // Which members survived, for the bias term.
      const survivors = agg.medianPoint ? avail : (() => {
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
        const bias = (currentTemp != null && forecastNow != null) ? currentTemp - forecastNow : 0;
        const predMean = Math.max(maxSoFar, point + BIAS_WEIGHT * bias);
        const sigmaPost = Math.sqrt(sigmaEns * sigmaEns + SIGMA_RESOLUTION_F * SIGMA_RESOLUTION_F);
        rows.push({
          err: predMean - actualMax,
          z: (actualMax - predMean) / sigmaPost,
          sigmaPost, sigmaEns,
          hrsToPeak: Math.max(0, peakHour - predHr)
        });
      }
    }
  }
  return { rows, clipRate: total ? clipped / total : 0, clipByModel, total };
}

function summarize(r) {
  const n = r.rows.length;
  const errs = r.rows.map(x => x.err);
  const rmse = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / n);
  const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / n;
  const bias = errs.reduce((a, e) => a + e, 0) / n;
  const cov68 = r.rows.filter(x => Math.abs(x.z) <= 1).length / n;
  const cov95 = r.rows.filter(x => Math.abs(x.z) <= 1.96).length / n;
  const meanSigma = r.rows.reduce((a, x) => a + x.sigmaPost, 0) / n;
  // p99 absolute error — the tail is where the outlier damage shows up.
  const sortedAbs = errs.map(Math.abs).sort((a, b) => a - b);
  const p99 = sortedAbs[Math.floor(0.99 * (n - 1))];
  return { n, rmse, mae, bias, cov68, cov95, meanSigma, p99 };
}

const allDates = Object.keys(cityProcessed[Object.keys(cityProcessed)[0]].obsByDay).sort();
const trainEnd = allDates[allDates.length - 1 - TEST_DAYS];
const inTrain = d => d <= trainEnd;
const inTest = d => d > trainEnd;
console.log(`TRAIN: → ${trainEnd} (${allDates.indexOf(trainEnd) + 1} days)`);
console.log(`TEST:  last ${TEST_DAYS} days\n`);

console.log("=== TRAIN (hyperparameter selection) ===");
console.log("aggregator                  RMSE    MAE    bias   cov68  cov95  meanSig  p99   clip%");
const trainRes = {};
for (const agg of AGGREGATORS) {
  const r = evaluate(agg, inTrain);
  const s = summarize(r);
  trainRes[agg.label] = s;
  console.log(`${agg.label.padEnd(26)} ${s.rmse.toFixed(3)}  ${s.mae.toFixed(3)}  ${s.bias.toFixed(3).padStart(6)}  `
    + `${(s.cov68 * 100).toFixed(1)}%  ${(s.cov95 * 100).toFixed(1)}%  ${s.meanSigma.toFixed(2)}    ${s.p99.toFixed(2)}  ${(r.clipRate * 100).toFixed(1)}%`);
}

console.log("\n=== TEST (held out) ===");
console.log("aggregator                  RMSE    MAE    bias   cov68  cov95  meanSig  p99   clip%");
const testRes = {};
let clipDetail = null;
for (const agg of AGGREGATORS) {
  const r = evaluate(agg, inTest);
  const s = summarize(r);
  testRes[agg.label] = s;
  if (agg.label.startsWith("MAD k=2.5 minAbs=3")) clipDetail = r;
  console.log(`${agg.label.padEnd(26)} ${s.rmse.toFixed(3)}  ${s.mae.toFixed(3)}  ${s.bias.toFixed(3).padStart(6)}  `
    + `${(s.cov68 * 100).toFixed(1)}%  ${(s.cov95 * 100).toFixed(1)}%  ${s.meanSigma.toFixed(2)}    ${s.p99.toFixed(2)}  ${(r.clipRate * 100).toFixed(1)}%`);
}

const base = testRes["mean (PRODUCTION)"];
console.log("\n=== TEST delta vs production equal-weight mean ===");
for (const agg of AGGREGATORS) {
  if (agg.label === "mean (PRODUCTION)") continue;
  const s = testRes[agg.label];
  const dR = (s.rmse - base.rmse) / base.rmse * 100;
  const dS = (s.meanSigma - base.meanSigma) / base.meanSigma * 100;
  console.log(`${agg.label.padEnd(26)} RMSE ${dR >= 0 ? "+" : ""}${dR.toFixed(2)}%   `
    + `meanSigma ${dS >= 0 ? "+" : ""}${dS.toFixed(2)}%   cov95 ${(s.cov95 * 100).toFixed(1)}% (base ${(base.cov95 * 100).toFixed(1)}%)`);
}

if (clipDetail) {
  console.log("\n=== Which models get clipped (MAD k=2.5 minAbs=3, TEST) ===");
  const tot = Object.values(clipDetail.clipByModel).reduce((a, b) => a + b, 0) || 1;
  for (const [m, n] of Object.entries(clipDetail.clipByModel).sort((a, b) => b[1] - a[1]))
    console.log(`  ${m.padEnd(22)} ${n}  (${(n / tot * 100).toFixed(1)}% of clips)`);
  console.log(`  city-days with >=1 clip: ${(clipDetail.clipRate * 100).toFixed(1)}%`);
}
