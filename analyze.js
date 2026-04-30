// Run model evaluation on cached data.json with chronological train/test split.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data.json", "utf-8"));
const PREDICTION_HOURS = [6, 9, 12, 15];
const TEST_DAYS = 90;

function localHour(isoUtc, tz) {
  return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false })
    .format(new Date(isoUtc)), 10);
}
function localDateStr(isoUtc, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(isoUtc));
}

// Pre-process each city once: group by local date.
const cityProcessed = {};
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const obsByDay = {}, fcByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    const d = localDateStr(ts, tz);
    if (!obsByDay[d]) obsByDay[d] = [];
    obsByDay[d].push({ ts, tempF: c.obs.temps[i], localHr: localHour(ts, tz) });
  }
  for (let i = 0; i < c.fc.times.length; i++) {
    const ts = c.fc.times[i] + "Z";
    const d = localDateStr(ts, tz);
    if (!fcByDay[d]) fcByDay[d] = [];
    fcByDay[d].push({ ts, tempF: c.fc.temps[i], localHr: localHour(ts, tz) });
  }
  cityProcessed[name] = { meta: c.meta, obsByDay, fcByDay, tz };
}

function modelPredict(params, ctx, offsets, sigmaScale) {
  const { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow, cityName } = ctx;
  if (forecastHigh == null && maxSoFar == null) return null;

  let mean, std;
  if (hrsToPeak <= 0.25) {
    mean = maxSoFar ?? forecastHigh; std = params.stdRealized;
  } else if (forecastHigh == null) {
    mean = (maxSoFar ?? currentTemp) + Math.min(hrsToPeak, 6) * 1.0;
    std = params.stdPersistence;
  } else if (maxSoFar == null) {
    mean = forecastHigh; std = params.stdForecastOnly;
  } else {
    const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
    mean = Math.max(maxSoFar, forecastHigh + params.biasWeight * bias);
    std = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToPeak + params.stdBiasCoef * Math.abs(bias));
  }
  if (offsets && offsets[cityName] != null) mean -= offsets[cityName];
  if (sigmaScale && sigmaScale[cityName] != null) std *= sigmaScale[cityName];
  return { mean, std };
}

function evaluate(params, dateFilter, offsets, sigmaScale) {
  const out = [];
  for (const [name, c] of Object.entries(cityProcessed)) {
    for (const [date, dayObs] of Object.entries(c.obsByDay)) {
      if (!dateFilter(date)) continue;
      if (dayObs.length < 12) continue;
      const dayFc = c.fcByDay[date] || [];
      const actualMax = Math.max(...dayObs.map(o => o.tempF));
      const forecastHigh = dayFc.length ? Math.max(...dayFc.map(o => o.tempF)) : null;
      const peakHour = dayObs.find(o => o.tempF === actualMax)?.localHr ?? 15;

      for (const predHr of PREDICTION_HOURS) {
        const obs = dayObs.filter(o => o.localHr <= predHr);
        if (!obs.length) continue;
        const maxSoFar = Math.max(...obs.map(o => o.tempF));
        const currentTemp = obs[obs.length - 1].tempF;
        const fc = dayFc.find(f => f.localHr === predHr);
        const forecastNow = fc ? fc.tempF : null;
        const hrsToPeak = Math.max(0, peakHour - predHr);
        const p = modelPredict(params, { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow, cityName: name },
                               offsets, sigmaScale);
        if (!p) continue;
        const err = p.mean - actualMax;
        out.push({ city: name, predHr, hrsToPeak, pred: p.mean, std: p.std, actual: actualMax, err,
                   in68: Math.abs(err) <= p.std, in95: Math.abs(err) <= 1.96 * p.std });
      }
    }
  }
  return out;
}

function summarize(results, label) {
  if (!results.length) return { label, n: 0 };
  const errs = results.map(r => r.err);
  return {
    label, n: results.length,
    rmse: Math.sqrt(errs.map(e => e*e).reduce((a,b)=>a+b,0) / results.length),
    mae: errs.map(Math.abs).reduce((a,b)=>a+b,0) / results.length,
    bias: errs.reduce((a,b)=>a+b,0) / results.length,
    cov68: results.filter(r => r.in68).length / results.length,
    cov95: results.filter(r => r.in95).length / results.length,
    meanStd: results.reduce((a,r) => a + r.std, 0) / results.length
  };
}

function summarizeBy(results, key) {
  const g = {};
  for (const r of results) { (g[r[key]] ??= []).push(r); }
  return Object.entries(g).map(([k, rs]) => summarize(rs, k));
}

// Compute training-set chronology cutoff.
const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEndStr = allDates[allDates.length - 1 - TEST_DAYS];
const inTrain = d => d <= trainEndStr;
const inTest = d => d > trainEndStr;
console.log(`Train: ${allDates[0]} → ${trainEndStr}  (${allDates.indexOf(trainEndStr) + 1} days)`);
console.log(`Test:  ${allDates[allDates.indexOf(trainEndStr) + 1]} → ${allDates[allDates.length - 1]}  (${TEST_DAYS} days)\n`);

// Param grid (smaller, focused).
const paramGrid = [];
for (const bw of [0.0, 0.2, 0.3, 0.4, 0.5]) {
  for (const sb of [0.6, 0.8, 1.0]) {
    for (const sl of [0.12, 0.18]) {
      paramGrid.push({
        biasWeight: bw, stdMin: 0.4, stdBase: sb, stdLeadCoef: sl, stdBiasCoef: 0.10,
        stdRealized: 0.5, stdPersistence: 4.5, stdForecastOnly: 3.0,
        label: `bw=${bw} σb=${sb} σl=${sl}`
      });
    }
  }
}

console.log(`Sweeping ${paramGrid.length} param combos on TRAIN...`);
let bestGlobal = null;
for (const params of paramGrid) {
  const r = evaluate(params, inTrain, null, null);
  const s = summarize(r, params.label);
  // Score: minimize RMSE, penalize CI miscalibration.
  const score = s.rmse + 1.0 * Math.abs(s.cov68 - 0.68) + 1.0 * Math.abs(s.cov95 - 0.95);
  if (!bestGlobal || score < bestGlobal.score) bestGlobal = { params, score, summary: s };
}
console.log(`Best: ${bestGlobal.params.label}`);
console.log(`  TRAIN: n=${bestGlobal.summary.n} RMSE=${bestGlobal.summary.rmse.toFixed(2)} MAE=${bestGlobal.summary.mae.toFixed(2)} bias=${bestGlobal.summary.bias.toFixed(2)} 68%=${(bestGlobal.summary.cov68*100).toFixed(0)}% 95%=${(bestGlobal.summary.cov95*100).toFixed(0)}%`);

// Fit per-city corrections on train.
const trainResults = evaluate(bestGlobal.params, inTrain, null, null);
const offsets = {}, sigmaScale = {};
for (const sub of summarizeBy(trainResults, "city")) {
  offsets[sub.label] = sub.bias;
  sigmaScale[sub.label] = sub.rmse / sub.meanStd;
}

// Held-out evaluation.
console.log(`\n=== HELD-OUT TEST EVAL (${TEST_DAYS} days, n=${TEST_DAYS * 20 * PREDICTION_HOURS.length} expected) ===`);
const configs = [
  { label: "global only",                offsets: null,    sigma: null },
  { label: "+ per-city offset",          offsets,          sigma: null },
  { label: "+ per-city offset + σ-scale", offsets,         sigma: sigmaScale }
];
const finalConfigs = [];
for (const cfg of configs) {
  const r = evaluate(bestGlobal.params, inTest, cfg.offsets, cfg.sigma);
  const s = summarize(r, cfg.label);
  console.log(`  [${cfg.label}]`);
  console.log(`    n=${s.n}  RMSE=${s.rmse.toFixed(2)}°F  MAE=${s.mae.toFixed(2)}°F  bias=${s.bias.toFixed(2)}°F  σ̄=${s.meanStd.toFixed(2)}  68%=${(s.cov68*100).toFixed(1)}%  95%=${(s.cov95*100).toFixed(1)}%`);
  finalConfigs.push({ cfg, results: r, summary: s });
}

// Per-city test breakdown for best config.
const final = finalConfigs[2];
console.log(`\n=== Per-city HELD-OUT (with offset + σ-scale) ===`);
const byCity = summarizeBy(final.results, "city").sort((a,b) => b.rmse - a.rmse);
for (const sub of byCity) {
  console.log(`  ${sub.label.padEnd(6)} n=${sub.n}  RMSE=${sub.rmse.toFixed(2)}  MAE=${sub.mae.toFixed(2)}  bias=${sub.bias.toFixed(2)}  68%=${(sub.cov68*100).toFixed(0)}%  95%=${(sub.cov95*100).toFixed(0)}%`);
}

// By lead time.
console.log(`\n=== By lead time (best config, held-out) ===`);
for (const sub of summarizeBy(final.results, "predHr")) {
  console.log(`  predHr=${sub.label}  n=${sub.n}  RMSE=${sub.rmse.toFixed(2)}  68%=${(sub.cov68*100).toFixed(0)}%  95%=${(sub.cov95*100).toFixed(0)}%`);
}

console.log(`\n=== Fitted corrections (apply in production) ===`);
console.log(`offsets =`, JSON.stringify(offsets, null, 2));
console.log(`sigmaScale =`, JSON.stringify(sigmaScale, null, 2));
console.log(`bestParams =`, JSON.stringify(bestGlobal.params, null, 2));
