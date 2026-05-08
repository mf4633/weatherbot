// Backtest: warming-rate observation term vs baseline.
// Uses the same data.json and same chronological train/test split as analyze_5yr.js.
// Compares baseline modelPredict against v2 = baseline + warming-rate blend.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data.json", "utf-8"));
const PREDICTION_HOURS = [6, 9, 12, 15];
const TEST_DAYS = 180;

function localHour(isoUtc, tz) {
  return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false })
    .format(new Date(isoUtc)), 10);
}
function localDateStr(isoUtc, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(isoUtc));
}

console.log("Pre-processing 5y data...");
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

// Compute warming rate (°F/hr) from last ~4 hourly obs via linear regression.
// Mirrors weather.js:computeWarmingRate. obs is sorted by localHr ascending.
function computeWarmingRate(obs) {
  if (!obs || obs.length < 3) return null;
  const recent = obs.slice(-4);
  const n = recent.length;
  const x0 = recent[0].localHr;
  const xs = recent.map(o => o.localHr - x0);
  const ys = recent.map(o => o.tempF);
  const xMean = xs.reduce((a, x) => a + x, 0) / n;
  const yMean = ys.reduce((a, y) => a + y, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - xMean) * (ys[i] - yMean), 0);
  const den = xs.reduce((a, x) => a + (x - xMean) ** 2, 0);
  if (den < 0.01) return null;
  return Math.max(-3, Math.min(5, num / den));
}

// Baseline modelPredict (mirrors analyze_5yr.js).
function modelPredictBase(params, ctx, offsets) {
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
  return { mean, std };
}

// V2 = baseline + warming-rate observation term (early-morning extrapolates too aggressively).
function modelPredictV2(params, ctx, offsets) {
  const { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow, cityName, recentObs } = ctx;
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
    let priorMean = forecastHigh + params.biasWeight * bias;
    const warmingRate = computeWarmingRate(recentObs);
    if (warmingRate != null && currentTemp != null && hrsToPeak > 0.5) {
      const hrsWarming = Math.min(hrsToPeak, 4);
      const projectedMax = currentTemp + 0.6 * warmingRate * hrsWarming;
      const w_obs = Math.max(0.1, Math.min(0.6, 0.7 - 0.1 * hrsToPeak));
      priorMean = (1 - w_obs) * priorMean + w_obs * projectedMax;
    }
    mean = Math.max(maxSoFar, priorMean);
    std = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToPeak + params.stdBiasCoef * Math.abs(bias));
  }
  if (offsets && offsets[cityName] != null) mean -= offsets[cityName];
  return { mean, std };
}

// V4 = sinusoidal damping based on solar geometry. Physical model:
//   warming rate ≈ R_max · sin(π · hrsSinceSunrise / T_warming)
// Integrating remaining rise from now to peak under this curve, given observed R(t_now):
//   remainingRise ≈ R(t_now) · cot(π/(2·T) · hrsSinceSunrise)
// where cot diverges near sunrise (no signal yet) and goes to 0 at peak.
// Hard cap at +8°F to avoid sunrise blow-up. T_WARMING = 9 hrs (sunrise → peak temp).
function modelPredictV4(params, ctx, offsets) {
  const { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow, cityName, recentObs } = ctx;
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
    let priorMean = forecastHigh + params.biasWeight * bias;
    const warmingRate = computeWarmingRate(recentObs);
    if (warmingRate != null && currentTemp != null && hrsToPeak > 0.5) {
      const T = 9;
      const hrsSinceSunrise = T - hrsToPeak;
      const phase = (Math.PI / (2 * T)) * hrsSinceSunrise;
      // cot = cos / sin; clamp sin away from zero to avoid sunrise blow-up.
      const cot = Math.cos(phase) / Math.max(0.15, Math.sin(phase));
      const projectedMax = currentTemp + Math.min(8, Math.max(-3, warmingRate * cot));
      const w_obs = Math.max(0.1, Math.min(0.5, 0.5 - 0.05 * hrsToPeak));
      priorMean = (1 - w_obs) * priorMean + w_obs * projectedMax;
    }
    mean = Math.max(maxSoFar, priorMean);
    std = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToPeak + params.stdBiasCoef * Math.abs(bias));
  }
  if (offsets && offsets[cityName] != null) mean -= offsets[cityName];
  return { mean, std };
}

// V5 = V4 + per-city T_WARMING (latitude-driven sunrise time) + empirical scaling factor.
// Latitude → typical sunrise lag; T_warming grows from ~8.4h at 25°N to ~9.6h at 47°N.
// Scaling factor applied to the cot-projection magnitude (tuned via TRAIN-fit later).
const CITY_LAT = {
  NYC: 40.78, LAX: 33.94, ORD: 41.97, MDW: 41.79, IAH: 29.98, PHX: 33.43,
  PHL: 39.87, SAT: 29.53, SAN: 32.73, DFW: 32.90, JAX: 30.49, AUS: 30.19,
  TPA: 27.98, SJC: 37.36, CMH: 39.99, CLT: 35.21, IND: 39.72, SEA: 47.45,
  DEN: 39.86, DCA: 38.85, BOS: 42.37
};
function tWarmingHours(lat) {
  if (lat == null) return 9;
  // Linear approx: T = 9 + 0.05·(lat - 35). Range 8.0 (25°N) → 10.5 (47°N).
  return 9 + 0.05 * (lat - 35);
}
function modelPredictV5(params, ctx, offsets, scale = 1.0) {
  const { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow, cityName, recentObs } = ctx;
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
    let priorMean = forecastHigh + params.biasWeight * bias;
    const warmingRate = computeWarmingRate(recentObs);
    if (warmingRate != null && currentTemp != null && hrsToPeak > 0.5) {
      const T = tWarmingHours(CITY_LAT[cityName]);
      const hrsSinceSunrise = T - hrsToPeak;
      const phase = (Math.PI / (2 * T)) * hrsSinceSunrise;
      const cot = Math.cos(phase) / Math.max(0.15, Math.sin(phase));
      const projectedMax = currentTemp + Math.min(8, Math.max(-3, scale * warmingRate * cot));
      const w_obs = Math.max(0.1, Math.min(0.5, 0.5 - 0.05 * hrsToPeak));
      priorMean = (1 - w_obs) * priorMean + w_obs * projectedMax;
    }
    mean = Math.max(maxSoFar, priorMean);
    std = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToPeak + params.stdBiasCoef * Math.abs(bias));
  }
  if (offsets && offsets[cityName] != null) mean -= offsets[cityName];
  return { mean, std };
}

// V3 = warming rate gated to hrsToPeak ≤ 3 only. Afternoon temperature curves are
// near-linear so extrapolation works; early-morning ramps decelerate sharply and
// linear extrapolation over-shoots.
function modelPredictV3(params, ctx, offsets) {
  const { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow, cityName, recentObs } = ctx;
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
    let priorMean = forecastHigh + params.biasWeight * bias;
    // Only blend in warming rate when peak is near (≤ 3h away). Tighter damping (0.4)
    // and lower weight ceiling (0.4) reflect the smaller window of usefulness.
    const warmingRate = computeWarmingRate(recentObs);
    if (warmingRate != null && currentTemp != null && hrsToPeak > 0.5 && hrsToPeak <= 3) {
      const projectedMax = currentTemp + 0.4 * warmingRate * hrsToPeak;
      const w_obs = Math.max(0.1, Math.min(0.4, 0.5 - 0.1 * hrsToPeak));
      priorMean = (1 - w_obs) * priorMean + w_obs * projectedMax;
    }
    mean = Math.max(maxSoFar, priorMean);
    std = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToPeak + params.stdBiasCoef * Math.abs(bias));
  }
  if (offsets && offsets[cityName] != null) mean -= offsets[cityName];
  return { mean, std };
}

function evaluate(predictFn, params, dateFilter, offsets) {
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
        const p = predictFn(params, {
          hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow,
          cityName: name, recentObs: obs
        }, offsets);
        if (!p) continue;
        const err = p.mean - actualMax;
        out.push({ city: name, date, predHr, hrsToPeak, pred: p.mean, std: p.std, actual: actualMax, err,
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

// ===== Setup =====
const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEndStr = allDates[allDates.length - 1 - TEST_DAYS];
const inTrain = d => d <= trainEndStr;
const inTest = d => d > trainEndStr;
console.log(`Window: ${allDates[0]} → ${allDates[allDates.length-1]}  (${allDates.length} days)`);
console.log(`TRAIN: → ${trainEndStr}\nTEST: 180 days\n`);

// Use the published-best params from analyze_5yr.js (no re-tuning, isolate warming-rate effect).
const params = {
  biasWeight: 0.4, stdMin: 0.4, stdBase: 1.0, stdLeadCoef: 0.12, stdBiasCoef: 0.10,
  stdRealized: 0.5, stdPersistence: 4.5, stdForecastOnly: 3.0,
  label: "production"
};

// Step 1: per-city offsets fit on train (using BASELINE so the comparison is apples-to-apples
// for the warming-rate effect, isolated from any offset re-tuning).
console.log("Fitting per-city offsets on TRAIN (baseline model)...");
const trainBase = evaluate(modelPredictBase, params, inTrain, null);
const offsets = {};
for (const sub of summarizeBy(trainBase, "city")) offsets[sub.label] = sub.bias;

// Step 2: HELD-OUT evaluation across baseline, V2, V3, V4, V5.
console.log("Evaluating on TEST...\n");

// V5 needs an empirical scaling factor — tune on TRAIN by minimizing RMSE.
console.log("Tuning V5 scale on TRAIN...");
let bestScale = 1.0, bestRmse = Infinity;
for (const s of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2]) {
  const trainV5 = evaluate((p, c, o) => modelPredictV5(p, c, o, s), params, inTrain, null);
  const summary = summarize(trainV5);
  if (summary.rmse < bestRmse) { bestRmse = summary.rmse; bestScale = s; }
}
console.log(`Best V5 scale on TRAIN: ${bestScale} (TRAIN RMSE ${bestRmse.toFixed(3)})\n`);

const testBase = evaluate(modelPredictBase, params, inTest, offsets);
const testV2 = evaluate(modelPredictV2, params, inTest, offsets);
const testV3 = evaluate(modelPredictV3, params, inTest, offsets);
const testV4 = evaluate(modelPredictV4, params, inTest, offsets);
const testV5 = evaluate((p, c, o) => modelPredictV5(p, c, o, bestScale), params, inTest, offsets);

const sBase = summarize(testBase, "BASELINE");
const sV2 = summarize(testV2);
const sV3 = summarize(testV3);
const sV4 = summarize(testV4);
const sV5 = summarize(testV5);

console.log(`=== HELD-OUT TEST (n=${sBase.n}) ===`);
const row = (lbl, s) => `  ${lbl.padEnd(38)} RMSE=${s.rmse.toFixed(3)}  bias=${s.bias.toFixed(3).padStart(6)}  68%=${(s.cov68*100).toFixed(1)}%   ΔRMSE=${(s.rmse-sBase.rmse).toFixed(3).padStart(6)}  (${((1 - s.rmse/sBase.rmse) * 100).toFixed(1)}%)`;
console.log(`  BASELINE                                RMSE=${sBase.rmse.toFixed(3)}  bias=${sBase.bias.toFixed(3).padStart(6)}  68%=${(sBase.cov68*100).toFixed(1)}%`);
console.log(row("V2 (linear, all hrs)", sV2));
console.log(row("V3 (linear, hrsToPeak≤3 gate)", sV3));
console.log(row("V4 (sinusoidal cot, fixed T=9)", sV4));
console.log(row(`V5 (sinusoidal cot, per-city T, scale=${bestScale})`, sV5));
console.log();

console.log("=== Best (V5 vs V3 vs baseline) by prediction hour ===");
const baseByHr = Object.fromEntries(summarizeBy(testBase, "predHr").map(s => [s.label, s]));
const v3ByHr = Object.fromEntries(summarizeBy(testV3, "predHr").map(s => [s.label, s]));
const v5ByHr = Object.fromEntries(summarizeBy(testV5, "predHr").map(s => [s.label, s]));
console.log(`  predHr  n      base       v3        v5        v3 Δ%   v5 Δ%`);
for (const hr of PREDICTION_HOURS) {
  const b = baseByHr[hr], v3 = v3ByHr[hr], v5 = v5ByHr[hr];
  if (!b || !v3 || !v5) continue;
  const pct3 = ((1 - v3.rmse/b.rmse) * 100).toFixed(1);
  const pct5 = ((1 - v5.rmse/b.rmse) * 100).toFixed(1);
  console.log(`  ${String(hr).padStart(4)}    ${String(b.n).padStart(5)}  ${b.rmse.toFixed(3)}     ${v3.rmse.toFixed(3)}     ${v5.rmse.toFixed(3)}     ${pct3.padStart(5)}%  ${pct5.padStart(5)}%`);
}

console.log("\n=== Per-city (V5 vs baseline) ===");
const baseByCity = Object.fromEntries(summarizeBy(testBase, "city").map(s => [s.label, s]));
const v5ByCity = Object.fromEntries(summarizeBy(testV5, "city").map(s => [s.label, s]));
const cities = Object.keys(baseByCity).sort();
let nWin = 0, nLoss = 0;
console.log(`  city  base RMSE  v5 RMSE  Δ        base bias  v5 bias  result`);
for (const c of cities) {
  const b = baseByCity[c], v = v5ByCity[c];
  if (!b || !v) continue;
  const pct = ((1 - v.rmse/b.rmse) * 100).toFixed(1);
  const arrow = v.rmse < b.rmse ? "✓" : "✗";
  if (v.rmse < b.rmse) nWin++; else nLoss++;
  console.log(`  ${c.padEnd(5)} ${b.rmse.toFixed(3)}      ${v.rmse.toFixed(3)}    ${(v.rmse-b.rmse).toFixed(3).padStart(6)}   ${b.bias.toFixed(3).padStart(7)}   ${v.bias.toFixed(3).padStart(7)}   ${arrow} (${pct}%)`);
}
console.log(`\n  V5 vs baseline: ${nWin} cities improved, ${nLoss} got worse.\n`);
console.log(`Best variant: ${[
  {label: "V3", rmse: sV3.rmse},
  {label: "V4", rmse: sV4.rmse},
  {label: "V5", rmse: sV5.rmse}
].sort((a,b) => a.rmse - b.rmse)[0].label}`);
console.log("Done.");
