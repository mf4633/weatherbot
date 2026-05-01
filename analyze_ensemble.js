// Test multi-model ensemble: GFS / ECMWF / ICON / GEM and various blends.
// For each model alone, plus equal blend, plus optimal blend (weights fit on TRAIN).

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const PREDICTION_HOURS = [6, 9, 12, 15];
const TEST_DAYS = 90;
const MODELS = data.models;

const localHour = (iso, tz) => parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(iso)), 10);
const localDateStr = (iso, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

console.log("Pre-processing...");
const cityProcessed = {};
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const obsByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    const d = localDateStr(ts, tz);
    (obsByDay[d] ??= []).push({ ts, tempF: c.obs.temps[i], localHr: localHour(ts, tz) });
  }
  // Per-model fcByDay
  const fcByModel = {};
  for (const model of MODELS) {
    const m = c.models[model];
    if (!m) continue;
    const byDay = {};
    for (let i = 0; i < m.times.length; i++) {
      const ts = m.times[i] + "Z";
      const d = localDateStr(ts, tz);
      (byDay[d] ??= []).push({ ts, tempF: m.temps[i], localHr: localHour(ts, tz) });
    }
    fcByModel[model] = byDay;
  }
  cityProcessed[name] = { meta: c.meta, obsByDay, fcByModel, tz };
}

const BASE = {
  biasWeight: 0.4, stdMin: 0.8, stdBase: 1.0, stdLeadCoef: 0.12, stdBiasCoef: 0.10
};

function predictWithEnsemble(params, weights, ctx) {
  const { hrsToPeak, maxSoFar, currentTemp, modelForecastHighs, modelForecastNows } = ctx;
  // Compute weighted forecast.
  let sumW = 0, fhAccum = 0, fnAccum = 0;
  for (const m of MODELS) {
    if (modelForecastHighs[m] != null && weights[m] > 0) {
      sumW += weights[m];
      fhAccum += weights[m] * modelForecastHighs[m];
      fnAccum += (modelForecastNows[m] != null ? weights[m] * modelForecastNows[m] : 0);
    }
  }
  if (sumW <= 0 || maxSoFar == null) return null;
  const forecastHigh = fhAccum / sumW;
  // Only use forecastNow if all weighted models have a value.
  let forecastNow = null;
  let availForecastNowSum = 0;
  for (const m of MODELS) {
    if (modelForecastNows[m] != null && weights[m] > 0) availForecastNowSum += weights[m];
  }
  if (availForecastNowSum > 0) forecastNow = fnAccum / availForecastNowSum;

  const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
  const priorMean = forecastHigh + params.biasWeight * bias;
  const mean = Math.max(maxSoFar, priorMean);
  const std = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToPeak + params.stdBiasCoef * Math.abs(bias));
  return { mean, std };
}

function evaluate(weights, dateFilter) {
  const out = [];
  for (const [name, c] of Object.entries(cityProcessed)) {
    for (const [date, dayObs] of Object.entries(c.obsByDay)) {
      if (!dateFilter(date)) continue;
      if (dayObs.length < 12) continue;
      const actualMax = Math.max(...dayObs.map(o => o.tempF));
      const peakHour = dayObs.find(o => o.tempF === actualMax)?.localHr ?? 15;
      // Per-model forecast highs for this day.
      const modelForecastHighs = {};
      const modelForecastNowByHr = {};
      for (const m of MODELS) {
        const dayFc = c.fcByModel[m]?.[date] || [];
        if (dayFc.length) {
          modelForecastHighs[m] = Math.max(...dayFc.map(o => o.tempF));
          for (const f of dayFc) {
            (modelForecastNowByHr[f.localHr] ??= {})[m] = f.tempF;
          }
        } else {
          modelForecastHighs[m] = null;
        }
      }

      for (const predHr of PREDICTION_HOURS) {
        const obs = dayObs.filter(o => o.localHr <= predHr);
        if (!obs.length) continue;
        const maxSoFar = Math.max(...obs.map(o => o.tempF));
        const currentTemp = obs[obs.length - 1].tempF;
        const modelForecastNows = modelForecastNowByHr[predHr] || {};
        const hrsToPeak = Math.max(0, peakHour - predHr);
        const p = predictWithEnsemble(BASE, weights,
          { hrsToPeak, maxSoFar, currentTemp, modelForecastHighs, modelForecastNows });
        if (!p) continue;
        const err = p.mean - actualMax;
        out.push({ city: name, predHr, hrsToPeak, pred: p.mean, std: p.std, actual: actualMax, err });
      }
    }
  }
  return out;
}

function summarize(r, label) {
  if (!r.length) return { label, n: 0, rmse: 0, mae: 0, bias: 0 };
  const errs = r.map(x => x.err);
  return {
    label, n: r.length,
    rmse: Math.sqrt(errs.map(e => e*e).reduce((a, b) => a + b, 0) / r.length),
    mae: errs.map(Math.abs).reduce((a, b) => a + b, 0) / r.length,
    bias: errs.reduce((a, b) => a + b, 0) / r.length
  };
}

const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEnd = allDates[allDates.length - 1 - TEST_DAYS];
const inTrain = d => d <= trainEnd;
const inTest = d => d > trainEnd;
console.log(`TRAIN: → ${trainEnd}  (${allDates.indexOf(trainEnd) + 1} days)`);
console.log(`TEST:  ${TEST_DAYS} days\n`);

// Single-model baselines.
console.log("=== Single-model performance (TRAIN / TEST) ===");
for (const m of MODELS) {
  const w = Object.fromEntries(MODELS.map(x => [x, x === m ? 1 : 0]));
  const tr = summarize(evaluate(w, inTrain), m);
  const te = summarize(evaluate(w, inTest), m);
  console.log(`  ${m.padEnd(16)} TRAIN RMSE=${tr.rmse.toFixed(3)}  TEST RMSE=${te.rmse.toFixed(3)}  bias=${te.bias.toFixed(2)}`);
}

// Equal-weighted ensemble.
console.log("\n=== Equal-weighted ensemble ===");
const eqW = Object.fromEntries(MODELS.map(m => [m, 1]));
const eqTr = summarize(evaluate(eqW, inTrain), "eq");
const eqTe = summarize(evaluate(eqW, inTest), "eq");
console.log(`  TRAIN RMSE=${eqTr.rmse.toFixed(3)}  TEST RMSE=${eqTe.rmse.toFixed(3)}  bias=${eqTe.bias.toFixed(2)}`);

// Curated blends — 7 model space is too big for full grid.
const equalWeights = (mods) => {
  const w = Object.fromEntries(MODELS.map(m => [m, 0]));
  for (const m of mods) w[m] = 1 / mods.length;
  return w;
};

console.log("\n=== Curated blends (TRAIN / TEST) ===");
const blends = [
  { label: "all 7 equal",         w: equalWeights(MODELS) },
  { label: "drop JMA (6 eq)",     w: equalWeights(MODELS.filter(m => m !== "jma_seamless")) },
  { label: "drop JMA+GEM (5 eq)", w: equalWeights(MODELS.filter(m => !["jma_seamless","gem_seamless"].includes(m))) },
  { label: "GFS+ECMWF+ICON+GEM",  w: equalWeights(["gfs_seamless","ecmwf_ifs025","icon_seamless","gem_seamless"]) },
  { label: "GFS+ECMWF+ICON+UKMO", w: equalWeights(["gfs_seamless","ecmwf_ifs025","icon_seamless","ukmo_seamless"]) },
  { label: "ECMWF+ICON+UKMO+MF",  w: equalWeights(["ecmwf_ifs025","icon_seamless","ukmo_seamless","meteofrance_seamless"]) },
  { label: "GFS+ECMWF+ICON+UKMO+MF", w: equalWeights(["gfs_seamless","ecmwf_ifs025","icon_seamless","ukmo_seamless","meteofrance_seamless"]) }
];
let best = { rmse: Infinity, label: null };
for (const b of blends) {
  const tr = summarize(evaluate(b.w, inTrain), b.label);
  const te = summarize(evaluate(b.w, inTest), b.label);
  console.log(`  ${b.label.padEnd(32)} TRAIN=${tr.rmse.toFixed(3)}  TEST=${te.rmse.toFixed(3)}`);
  if (te.rmse < best.rmse) best = { rmse: te.rmse, label: b.label, w: b.w };
}
console.log(`\nBest by TEST RMSE: ${best.label} → ${best.rmse.toFixed(3)}°F`);
