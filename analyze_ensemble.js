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

// Grid-search optimal blend.
console.log("\n=== Optimal blend (grid search on TRAIN) ===");
const grid = [];
const step = 0.1;
for (let g = 0; g <= 1; g += step) {
  for (let e = 0; e <= 1 - g; e += step) {
    for (let i = 0; i <= 1 - g - e; i += step) {
      const j = 1 - g - e - i;
      if (j < -0.001 || j > 1.001) continue;
      grid.push({ gfs_seamless: g, ecmwf_ifs025: e, icon_seamless: i, gem_seamless: j });
    }
  }
}
console.log(`Searching ${grid.length} weight combinations...`);
let best = { rmse: Infinity, w: null };
for (const w of grid) {
  const s = summarize(evaluate(w, inTrain), "");
  if (s.rmse < best.rmse) best = { rmse: s.rmse, w, summary: s };
}
const wStr = MODELS.map(m => `${m.split("_")[0]}=${best.w[m].toFixed(1)}`).join(" ");
console.log(`Best on TRAIN: ${wStr}  RMSE=${best.rmse.toFixed(3)}`);

// Evaluate best blend on test.
const optTe = summarize(evaluate(best.w, inTest), "opt");
console.log(`On TEST: RMSE=${optTe.rmse.toFixed(3)}  MAE=${optTe.mae.toFixed(3)}  bias=${optTe.bias.toFixed(2)}`);

// Also test 50/50 GFS+ECMWF and 33/33/33 (no GEM).
console.log("\n=== Ad hoc blends ===");
const blends = [
  { label: "50/50 GFS+ECMWF",       gfs_seamless: 0.5, ecmwf_ifs025: 0.5, icon_seamless: 0,   gem_seamless: 0 },
  { label: "GFS+ECMWF+ICON eq",      gfs_seamless: 1/3, ecmwf_ifs025: 1/3, icon_seamless: 1/3, gem_seamless: 0 },
  { label: "70 GFS / 30 ECMWF",      gfs_seamless: 0.7, ecmwf_ifs025: 0.3, icon_seamless: 0,   gem_seamless: 0 },
  { label: "60/40 ECMWF+GFS",        gfs_seamless: 0.4, ecmwf_ifs025: 0.6, icon_seamless: 0,   gem_seamless: 0 }
];
for (const b of blends) {
  const w = { gfs_seamless: b.gfs_seamless, ecmwf_ifs025: b.ecmwf_ifs025, icon_seamless: b.icon_seamless, gem_seamless: b.gem_seamless };
  const tr = summarize(evaluate(w, inTrain), b.label);
  const te = summarize(evaluate(w, inTest), b.label);
  console.log(`  ${b.label.padEnd(28)} TRAIN=${tr.rmse.toFixed(3)}  TEST=${te.rmse.toFixed(3)}`);
}

// Compare best vs GFS-only.
const gfsW = { gfs_seamless: 1, ecmwf_ifs025: 0, icon_seamless: 0, gem_seamless: 0 };
const gfsTe = summarize(evaluate(gfsW, inTest), "gfs");
const delta = optTe.rmse - gfsTe.rmse;
console.log(`\n=== HEADLINE: best ensemble vs GFS-only on TEST ===`);
console.log(`  GFS-only:  RMSE=${gfsTe.rmse.toFixed(3)}`);
console.log(`  Ensemble:  RMSE=${optTe.rmse.toFixed(3)}`);
console.log(`  Δ:         ${delta.toFixed(3)}°F (${(delta / gfsTe.rmse * 100).toFixed(1)}%)  ${delta < -0.01 ? "✓ improvement" : "✗ no real gain"}`);
