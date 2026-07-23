// LOW-temp backtest (mirror of analyze_5yr.js but for daily MIN).
// Goals: validate σ formula, fit per-city offsets, choose biasWeight.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const TEST_DAYS = 90;

// Use the same 5 best models as HIGH (drop JMA, GEM).
const MODELS = data.models.filter(m => !["jma_seamless", "gem_seamless"].includes(m));

// Prediction times (local hours) — chosen for LOW context. The day's low usually occurs
// 4-7 AM local. Predictions at 0/3 are pre-low (true uncertainty); 6 is at-low; 9/12/15
// are post-low (the value is essentially realized; bias correction has minimal effect).
const PREDICTION_HOURS = [0, 3, 6, 9, 12, 15];

// Restrict to last 1 year before any per-record processing — cuts pre-processing
// time 5x and avoids early-year forecast quality issues that broke prior runs.
const RECENT_DAYS = 365;
const cutoffMs = Date.now() - RECENT_DAYS * 86400 * 1000;

// Fast TZ-offset cache: Intl.DateTimeFormat per-record is the bottleneck (~5M calls
// → 30+ min). Compute the UTC-offset once per (tz, hour) bucket and reuse.
const TZ_OFFSETS = {
  "America/New_York": -4, "America/Chicago": -5, "America/Denver": -6,
  "America/Los_Angeles": -7, "America/Phoenix": -7,  // Arizona is fixed -7 year-round
  "America/Indiana/Indianapolis": -4
};
function localHrAndDate(isoNoZ, tz) {
  const tsMs = Date.parse(isoNoZ + "Z");
  const off = TZ_OFFSETS[tz] ?? -5;
  const localMs = tsMs + off * 3600 * 1000;
  const d = new Date(localMs);
  const yr = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return { date: `${yr}-${mo}-${da}`, hr: d.getUTCHours(), ms: tsMs };
}

console.log("Pre-processing (1y window, fast)...");
const t0 = Date.now();
const cityProcessed = {};
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const obsByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i];
    const { date, hr, ms } = localHrAndDate(ts, tz);
    if (ms < cutoffMs) continue;
    (obsByDay[date] ??= []).push({ tempF: c.obs.temps[i], localHr: hr });
  }
  const fcByModel = {};
  for (const m of MODELS) {
    const md = c.models[m];
    if (!md) continue;
    const byDay = {};
    for (let i = 0; i < md.times.length; i++) {
      const ts = md.times[i];
      const { date, hr, ms } = localHrAndDate(ts, tz);
      if (ms < cutoffMs) continue;
      (byDay[date] ??= []).push({ tempF: md.temps[i], localHr: hr });
    }
    fcByModel[m] = byDay;
  }
  cityProcessed[name] = { meta: c.meta, obsByDay, fcByModel, tz };
}
console.log(`Pre-process took ${((Date.now() - t0)/1000).toFixed(1)}s`);

// For LOW prediction: hrs until typical trough (~6 AM local). After 7 AM, trough is realized.
function hoursToTrough(localHr) {
  if (localHr >= 7) return 0;
  return Math.max(0, 6 - localHr);
}

function predict(params, ctx, offsets = null) {
  const { hrsToTrough, minSoFar, currentTemp, modelForecastLows, modelForecastNows, cityName } = ctx;
  let sumW = 0, flAccum = 0, fnAccum = 0;
  for (const m of MODELS) {
    const w = 1 / MODELS.length;
    if (modelForecastLows[m] != null) { sumW += w; flAccum += w * modelForecastLows[m]; }
    fnAccum += (modelForecastNows[m] != null ? w * modelForecastNows[m] : 0);
  }
  if (sumW <= 0 || minSoFar == null) return null;
  const forecastLow = flAccum / sumW;
  let availForecastNowSum = 0;
  for (const m of MODELS) if (modelForecastNows[m] != null) availForecastNowSum += 1 / MODELS.length;
  const forecastNow = availForecastNowSum > 0 ? fnAccum / availForecastNowSum : null;
  const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
  let priorMean = forecastLow + params.biasWeight * bias;
  if (offsets && offsets[cityName] != null) priorMean -= offsets[cityName];
  const mean = Math.min(minSoFar, priorMean);  // truncate from above (low can't exceed observed min)
  const std = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToTrough + params.stdBiasCoef * Math.abs(bias));
  return { mean, std };
}

function evaluate(params, dateFilter, offsets) {
  const out = [];
  for (const [name, c] of Object.entries(cityProcessed)) {
    for (const [date, dayObs] of Object.entries(c.obsByDay)) {
      if (!dateFilter(date)) continue;
      if (dayObs.length < 12) continue;
      const actualMin = Math.min(...dayObs.map(o => o.tempF));
      const modelForecastLows = {};
      const modelForecastNowByHr = {};
      for (const m of MODELS) {
        const dayFc = c.fcByModel[m]?.[date] || [];
        if (dayFc.length) {
          modelForecastLows[m] = Math.min(...dayFc.map(o => o.tempF));
          for (const f of dayFc) (modelForecastNowByHr[f.localHr] ??= {})[m] = f.tempF;
        } else modelForecastLows[m] = null;
      }
      for (const predHr of PREDICTION_HOURS) {
        const obs = dayObs.filter(o => o.localHr <= predHr);
        if (!obs.length) continue;
        const minSoFar = Math.min(...obs.map(o => o.tempF));
        const currentTemp = obs[obs.length - 1].tempF;
        const modelForecastNows = modelForecastNowByHr[predHr] || {};
        const hrs = hoursToTrough(predHr);
        const p = predict(params, { hrsToTrough: hrs, minSoFar, currentTemp,
                                     modelForecastLows, modelForecastNows, cityName: name }, offsets);
        if (!p) continue;
        const err = p.mean - actualMin;
        out.push({ city: name, predHr, hrsToTrough: hrs, pred: p.mean, std: p.std, actual: actualMin, err,
                   in68: Math.abs(err) <= p.std, in95: Math.abs(err) <= 1.96 * p.std });
      }
    }
  }
  return out;
}
function summarize(r) {
  if (!r.length) return { n: 0 };
  const errs = r.map(x => x.err);
  return {
    n: r.length,
    rmse: Math.sqrt(errs.map(e => e*e).reduce((a,b)=>a+b,0) / r.length),
    mae: errs.map(Math.abs).reduce((a,b)=>a+b,0) / r.length,
    bias: errs.reduce((a,b)=>a+b,0) / r.length,
    cov68: r.filter(x => x.in68).length / r.length,
    cov95: r.filter(x => x.in95).length / r.length,
    meanStd: r.reduce((a,x)=>a+x.std,0) / r.length
  };
}
function summarizeBy(r, key) {
  const g = {};
  for (const x of r) (g[x[key]] ??= []).push(x);
  return Object.entries(g).map(([k, rs]) => ({ key: k, ...summarize(rs) }));
}

// Pre-process already filtered to last RECENT_DAYS at top. Use the resulting dates directly.
const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEnd = allDates[allDates.length - 1 - TEST_DAYS];
const inTrain = d => d <= trainEnd;
const inTest = d => d > trainEnd;
console.log(`Window: ${allDates[0]} → ${allDates[allDates.length-1]}  (${allDates.length} days)`);
console.log(`TRAIN: → ${trainEnd}  TEST: ${TEST_DAYS} days\n`);

// Step 1: sweep biasWeight + σ params on TRAIN (compact grid since LOW data is similar).
const grid = [];
for (const bw of [0.2, 0.3, 0.4, 0.5]) {
  for (const stdMin of [0.4, 0.6, 0.8]) {
    for (const stdBase of [0.5, 0.7, 0.9, 1.1]) {
      for (const stdLeadCoef of [0.05, 0.10, 0.15, 0.20]) {
        for (const stdBiasCoef of [0.05, 0.10, 0.15]) {
          grid.push({ biasWeight: bw, stdMin, stdBase, stdLeadCoef, stdBiasCoef });
        }
      }
    }
  }
}
console.log(`Sweeping ${grid.length} param combos on TRAIN...`);
let best = { score: Infinity, params: null };
for (const params of grid) {
  const s = summarize(evaluate(params, inTrain, null));
  // Score: RMSE primarily, calibration secondarily.
  const score = s.rmse + 0.5 * Math.abs(s.cov68 - 0.68) + 0.5 * Math.abs(s.cov95 - 0.95);
  if (score < best.score) best = { score, params, summary: s };
}
console.log(`Best params: bw=${best.params.biasWeight} stdMin=${best.params.stdMin} stdBase=${best.params.stdBase} stdLeadCoef=${best.params.stdLeadCoef} stdBiasCoef=${best.params.stdBiasCoef}`);
console.log(`  TRAIN: RMSE=${best.summary.rmse.toFixed(3)} σ̄=${best.summary.meanStd.toFixed(2)} 68%=${(best.summary.cov68*100).toFixed(1)}% 95%=${(best.summary.cov95*100).toFixed(1)}%`);

// Step 2: fit per-city offsets on TRAIN.
const trainResults = evaluate(best.params, inTrain, null);
const offsets = {};
for (const sub of summarizeBy(trainResults, "city")) offsets[sub.key] = sub.bias;

// Step 3: held-out TEST eval.
console.log(`\n=== HELD-OUT TEST ===`);
for (const cfg of [
  { label: "global only", offsets: null },
  { label: "+ per-city offset", offsets }
]) {
  const r = evaluate(best.params, inTest, cfg.offsets);
  const s = summarize(r);
  console.log(`  [${cfg.label}] RMSE=${s.rmse.toFixed(3)} bias=${s.bias.toFixed(2)} σ̄=${s.meanStd.toFixed(2)} 68%=${(s.cov68*100).toFixed(1)}% 95%=${(s.cov95*100).toFixed(1)}%`);
}

console.log(`\n=== Per-city HELD-OUT (with offsets) ===`);
const finalResults = evaluate(best.params, inTest, offsets);
const cityRows = summarizeBy(finalResults, "city").sort((a, b) => b.rmse - a.rmse);
for (const sub of cityRows) {
  console.log(`  ${sub.key.padEnd(6)} n=${sub.n}  RMSE=${sub.rmse.toFixed(2)}  bias=${sub.bias.toFixed(2)}  68%=${(sub.cov68*100).toFixed(0)}%`);
}

console.log(`\n=== By prediction hour (HELD-OUT, with offsets) ===`);
for (const sub of summarizeBy(finalResults, "predHr").sort((a, b) => parseInt(a.key) - parseInt(b.key))) {
  console.log(`  hr=${sub.key.padStart(2)} n=${sub.n}  RMSE=${sub.rmse.toFixed(2)}  bias=${sub.bias.toFixed(2)}  68%=${(sub.cov68*100).toFixed(0)}%`);
}

console.log(`\n=== Final corrections ===`);
console.log(`bestParams = ${JSON.stringify(best.params, null, 2)}`);
console.log(`offsets = ${JSON.stringify(offsets, null, 2)}`);
