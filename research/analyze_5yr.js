// 5-year analysis with trend detection and detrending evaluation.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data.json", "utf-8"));
const PREDICTION_HOURS = [6, 9, 12, 15];
const TEST_DAYS = 180;  // hold out last 6 months

function localHour(isoUtc, tz) {
  return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false })
    .format(new Date(isoUtc)), 10);
}
function localDateStr(isoUtc, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(isoUtc));
}

// Pre-process.
console.log("Pre-processing...");
const cityProcessed = {};
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const obsByDay = {}, fcByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    const d = localDateStr(ts, tz);
    (obsByDay[d] ??= []).push({ ts, tempF: c.obs.temps[i], localHr: localHour(ts, tz) });
  }
  for (let i = 0; i < c.fc.times.length; i++) {
    const ts = c.fc.times[i] + "Z";
    const d = localDateStr(ts, tz);
    (fcByDay[d] ??= []).push({ ts, tempF: c.fc.temps[i], localHr: localHour(ts, tz) });
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
    mean = (maxSoFar ?? currentTemp) + Math.min(hrsToPeak, 6) * 1.0; std = params.stdPersistence;
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
        const yearMonth = date.slice(0, 7);  // YYYY-MM
        out.push({ city: name, date, yearMonth, predHr, hrsToPeak, pred: p.mean, std: p.std, actual: actualMax, err,
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
  for (const r of results) (g[r[key]] ??= []).push(r);
  return Object.entries(g).map(([k, rs]) => summarize(rs, k));
}

// ===== Step 1: chronological split =====
const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEndStr = allDates[allDates.length - 1 - TEST_DAYS];
const inTrain = d => d <= trainEndStr;
const inTest = d => d > trainEndStr;
console.log(`\nWindow: ${allDates[0]} → ${allDates[allDates.length-1]}  (${allDates.length} days)`);
console.log(`TRAIN: → ${trainEndStr}  (${allDates.indexOf(trainEndStr)+1} days)`);
console.log(`TEST:  ${allDates[allDates.indexOf(trainEndStr)+1]} → end  (${TEST_DAYS} days)\n`);

// ===== Step 2: param grid sweep on train =====
const grid = [];
for (const bw of [0.0, 0.3, 0.4, 0.5]) {
  for (const sb of [0.6, 0.8, 1.0]) {
    for (const sl of [0.10, 0.12, 0.15]) {
      grid.push({ biasWeight: bw, stdMin: 0.4, stdBase: sb, stdLeadCoef: sl, stdBiasCoef: 0.10,
                  stdRealized: 0.5, stdPersistence: 4.5, stdForecastOnly: 3.0,
                  label: `bw=${bw} σb=${sb} σl=${sl}` });
    }
  }
}
console.log(`Sweeping ${grid.length} param combos on TRAIN (5-yr data)...`);
let best = null;
for (const params of grid) {
  const r = evaluate(params, inTrain, null, null);
  const s = summarize(r, params.label);
  const score = s.rmse + 1.0 * Math.abs(s.cov68 - 0.68) + 1.0 * Math.abs(s.cov95 - 0.95);
  if (!best || score < best.score) best = { params, score, summary: s };
}
console.log(`Best: ${best.params.label}`);
console.log(`  TRAIN: n=${best.summary.n}  RMSE=${best.summary.rmse.toFixed(2)}  bias=${best.summary.bias.toFixed(2)}  68%=${(best.summary.cov68*100).toFixed(0)}%  95%=${(best.summary.cov95*100).toFixed(0)}%\n`);

// ===== Step 3: per-city corrections (fit on TRAIN, no detrend yet) =====
const trainResults = evaluate(best.params, inTrain, null, null);
const offsets = {}, sigmaScale = {};
for (const sub of summarizeBy(trainResults, "city")) {
  offsets[sub.label] = sub.bias;
  sigmaScale[sub.label] = sub.rmse / sub.meanStd;
}

// ===== Step 4: TREND ANALYSIS — residuals vs time =====
console.log(`=== Residual trend analysis ===`);
// Group residuals by year and by year-month.
const byYear = {};
const byYM = {};
for (const r of trainResults) {
  const yr = r.date.slice(0, 4);
  (byYear[yr] ??= []).push(r);
  (byYM[r.yearMonth] ??= []).push(r);
}
console.log(`Annual mean residual (model bias):`);
const yrSorted = Object.keys(byYear).sort();
for (const yr of yrSorted) {
  const rs = byYear[yr];
  const m = rs.reduce((a,r) => a + r.err, 0) / rs.length;
  console.log(`  ${yr}  n=${rs.length.toString().padStart(5)}  mean_err=${m.toFixed(3)}°F`);
}
// Linear regression of residual on time (years since start).
function linearRegression(xs, ys) {
  const n = xs.length;
  const sx = xs.reduce((a,b)=>a+b,0), sy = ys.reduce((a,b)=>a+b,0);
  const sxy = xs.reduce((a,b,i)=>a+b*ys[i],0);
  const sxx = xs.reduce((a,b)=>a+b*b,0);
  const slope = (n*sxy - sx*sy) / (n*sxx - sx*sx);
  const intercept = (sy - slope*sx) / n;
  return { slope, intercept };
}
// Use month index for finer time resolution.
const ymSorted = Object.keys(byYM).sort();
const startMs = new Date(ymSorted[0] + "-01").getTime();
const xs = [], ys = [];
for (const ym of ymSorted) {
  const ageYears = (new Date(ym + "-01").getTime() - startMs) / (365.25 * 86400000);
  const rs = byYM[ym];
  const meanErr = rs.reduce((a,r)=>a+r.err,0) / rs.length;
  xs.push(ageYears);
  ys.push(meanErr);
}
const { slope, intercept } = linearRegression(xs, ys);
console.log(`\nLinear trend in residual: slope = ${slope.toFixed(3)}°F/yr, intercept = ${intercept.toFixed(3)}°F`);
console.log(`(Positive slope = model warm-biased increasing over time)`);

// ===== Step 5: evaluate on TEST set with various corrections =====
console.log(`\n=== HELD-OUT TEST EVALUATION ===`);

// Detrend strategy: subtract slope * (years since start) from prediction.
function detrendCorrection(date) {
  const ageYears = (new Date(date.slice(0,7) + "-01").getTime() - startMs) / (365.25 * 86400000);
  return slope * ageYears + intercept;
}
function evaluateWithDetrend(params, dateFilter, offsets, sigmaScale) {
  // Re-evaluate but subtract trend correction from each prediction.
  const out = [];
  for (const [name, c] of Object.entries(cityProcessed)) {
    for (const [date, dayObs] of Object.entries(c.obsByDay)) {
      if (!dateFilter(date)) continue;
      if (dayObs.length < 12) continue;
      const dayFc = c.fcByDay[date] || [];
      const actualMax = Math.max(...dayObs.map(o => o.tempF));
      const forecastHigh = dayFc.length ? Math.max(...dayFc.map(o => o.tempF)) : null;
      const peakHour = dayObs.find(o => o.tempF === actualMax)?.localHr ?? 15;
      const trendCorr = detrendCorrection(date);
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
        const adjustedMean = p.mean - trendCorr;
        const err = adjustedMean - actualMax;
        out.push({ city: name, date, yearMonth: date.slice(0,7), predHr, pred: adjustedMean, std: p.std,
                   actual: actualMax, err,
                   in68: Math.abs(err) <= p.std, in95: Math.abs(err) <= 1.96 * p.std });
      }
    }
  }
  return out;
}

const configs = [
  { label: "global only",                     fn: () => evaluate(best.params, inTest, null, null) },
  { label: "+ per-city offset",               fn: () => evaluate(best.params, inTest, offsets, null) },
  { label: "+ offset + σ-scale",              fn: () => evaluate(best.params, inTest, offsets, sigmaScale) },
  { label: "+ offset + detrend",              fn: () => evaluateWithDetrend(best.params, inTest, offsets, null) },
  { label: "+ offset + σ-scale + detrend",    fn: () => evaluateWithDetrend(best.params, inTest, offsets, sigmaScale) }
];
for (const cfg of configs) {
  const r = cfg.fn();
  const s = summarize(r, cfg.label);
  console.log(`  [${cfg.label}]`);
  console.log(`    n=${s.n}  RMSE=${s.rmse.toFixed(2)}°F  MAE=${s.mae.toFixed(2)}°F  bias=${s.bias.toFixed(2)}°F  σ̄=${s.meanStd.toFixed(2)}  68%=${(s.cov68*100).toFixed(1)}%  95%=${(s.cov95*100).toFixed(1)}%`);
}

// ===== Per-city test breakdown (best config: offset only) =====
console.log(`\n=== Per-city HELD-OUT (offset only) ===`);
const finalResults = evaluate(best.params, inTest, offsets, null);
const byCity = summarizeBy(finalResults, "city").sort((a,b)=>b.rmse-a.rmse);
for (const sub of byCity) {
  console.log(`  ${sub.label.padEnd(6)} n=${sub.n}  RMSE=${sub.rmse.toFixed(2)}  MAE=${sub.mae.toFixed(2)}  bias=${sub.bias.toFixed(2)}  68%=${(sub.cov68*100).toFixed(0)}%  95%=${(sub.cov95*100).toFixed(0)}%`);
}

// ===== By year on TEST: did the trend matter? =====
console.log(`\n=== By year on TEST ===`);
const testByYear = summarizeBy(finalResults, "yearMonth").sort((a,b) => a.label < b.label ? -1 : 1);
const yearGroups = {};
for (const sub of testByYear) {
  const yr = sub.label.slice(0,4);
  if (!yearGroups[yr]) yearGroups[yr] = { sum: 0, n: 0, errs: [] };
}
for (const r of finalResults) {
  const yr = r.date.slice(0,4);
  (yearGroups[yr].errs ??= []).push(r);
}
for (const [yr, g] of Object.entries(yearGroups)) {
  const s = summarize(g.errs, yr);
  console.log(`  ${yr}  n=${s.n}  RMSE=${s.rmse.toFixed(2)}  bias=${s.bias.toFixed(2)}`);
}

console.log(`\n=== Final corrections ===`);
console.log(`bestParams = ${JSON.stringify(best.params, null, 2)}`);
console.log(`offsets = ${JSON.stringify(offsets, null, 2)}`);
console.log(`trend slope (°F/year) = ${slope.toFixed(4)}`);
