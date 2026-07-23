// Test whether spatial features (neighbor station temperatures) improve our ensemble model.

import { readFileSync } from "node:fs";

const neighborsData = JSON.parse(readFileSync("data_neighbors.json", "utf-8"));
const modelsData = JSON.parse(readFileSync("data_models.json", "utf-8"));

const PREDICTION_HOURS = [6, 9, 12, 15];
const TEST_DAYS = 90;
const MODELS = modelsData.models;

const localHour = (iso, tz) => parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(iso)), 10);
const localDateStr = (iso, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

console.log("Pre-processing...");
const cityProcessed = {};
for (const [name, mc] of Object.entries(modelsData.cities)) {
  const tz = mc.meta.tz;
  // Obs by day (from models data — same as neighbors center, but it's our source of truth).
  const obsByDay = {};
  for (let i = 0; i < mc.obs.times.length; i++) {
    const ts = mc.obs.times[i] + "Z";
    const d = localDateStr(ts, tz);
    (obsByDay[d] ??= []).push({ ts, tempF: mc.obs.temps[i], localHr: localHour(ts, tz), idx: i });
  }
  // Forecasts by day per model.
  const fcByModel = {};
  for (const m of MODELS) {
    const md = mc.models[m];
    if (!md) continue;
    const byDay = {};
    for (let i = 0; i < md.times.length; i++) {
      const ts = md.times[i] + "Z";
      const d = localDateStr(ts, tz);
      (byDay[d] ??= []).push({ ts, tempF: md.temps[i], localHr: localHour(ts, tz) });
    }
    fcByModel[m] = byDay;
  }
  // Neighbor temps — index-aligned with obs.times (both pulled at the same hourly grid).
  const ndata = neighborsData.cities[name];
  if (!ndata) {
    console.warn(`  no neighbors for ${name}`);
    continue;
  }
  cityProcessed[name] = {
    meta: mc.meta, obsByDay, fcByModel, tz,
    centerTimes: ndata.times,
    centerTemps: ndata.center,
    neighbors: ndata.neighbors  // { dir: { lat, lon, temps } }
  };
}

const BASE = {
  biasWeight: 0.4, stdMin: 0.8, stdBase: 1.0, stdLeadCoef: 0.12, stdBiasCoef: 0.10
};

// Prediction with optional spatial correction. spatialFn returns a delta to add to the prediction mean.
function predict(ctx, weights, spatialFn = null) {
  const { hrsToPeak, maxSoFar, currentTemp, modelForecastHighs, modelForecastNows } = ctx;
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
  let availForecastNowSum = 0;
  for (const m of MODELS) {
    if (modelForecastNows[m] != null && weights[m] > 0) availForecastNowSum += weights[m];
  }
  const forecastNow = availForecastNowSum > 0 ? fnAccum / availForecastNowSum : null;
  const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
  let priorMean = forecastHigh + BASE.biasWeight * bias;
  if (spatialFn) priorMean += spatialFn(ctx);
  const mean = Math.max(maxSoFar, priorMean);
  const std = Math.max(BASE.stdMin, BASE.stdBase + BASE.stdLeadCoef * hrsToPeak + BASE.stdBiasCoef * Math.abs(bias));
  return { mean, std };
}

function evaluate(weights, dateFilter, spatialFn) {
  const out = [];
  for (const [name, c] of Object.entries(cityProcessed)) {
    for (const [date, dayObs] of Object.entries(c.obsByDay)) {
      if (!dateFilter(date)) continue;
      if (dayObs.length < 12) continue;
      const actualMax = Math.max(...dayObs.map(o => o.tempF));
      const peakHour = dayObs.find(o => o.tempF === actualMax)?.localHr ?? 15;
      const modelForecastHighs = {};
      const modelForecastNowByHr = {};
      for (const m of MODELS) {
        const dayFc = c.fcByModel[m]?.[date] || [];
        if (dayFc.length) {
          modelForecastHighs[m] = Math.max(...dayFc.map(o => o.tempF));
          for (const f of dayFc) (modelForecastNowByHr[f.localHr] ??= {})[m] = f.tempF;
        } else {
          modelForecastHighs[m] = null;
        }
      }

      for (const predHr of PREDICTION_HOURS) {
        const obs = dayObs.filter(o => o.localHr <= predHr);
        if (!obs.length) continue;
        const last = obs[obs.length - 1];
        const maxSoFar = Math.max(...obs.map(o => o.tempF));
        const currentTemp = last.tempF;
        const modelForecastNows = modelForecastNowByHr[predHr] || {};
        const hrsToPeak = Math.max(0, peakHour - predHr);

        // Spatial features at the prediction time (use last obs's index).
        const idxNow = last.idx;
        const idx3hAgo = Math.max(0, idxNow - 3);
        const neighborTempsNow = {};
        const neighborTemps3hAgo = {};
        for (const [dir, nd] of Object.entries(c.neighbors)) {
          neighborTempsNow[dir] = nd.temps[idxNow];
          neighborTemps3hAgo[dir] = nd.temps[idx3hAgo];
        }
        const ctx = {
          hrsToPeak, maxSoFar, currentTemp, modelForecastHighs, modelForecastNows,
          neighborTempsNow, neighborTemps3hAgo, centerNow: currentTemp
        };
        const p = predict(ctx, weights, spatialFn);
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

// Best ensemble weights from prior backtest (from analyze_ensemble.js result):
const W = { gfs_seamless: 0.2, ecmwf_ifs025: 0.4, icon_seamless: 0.3, gem_seamless: 0.1 };

console.log(`TRAIN: → ${trainEnd} (${allDates.indexOf(trainEnd)+1} days)`);
console.log(`TEST:  ${TEST_DAYS} days\n`);

// Baseline (no spatial feature).
console.log("=== Baseline (ensemble, no spatial) ===");
const baseTrain = summarize(evaluate(W, inTrain, null), "");
const baseTest = summarize(evaluate(W, inTest, null), "");
console.log(`  TRAIN RMSE=${baseTrain.rmse.toFixed(3)}  TEST RMSE=${baseTest.rmse.toFixed(3)}  bias=${baseTest.bias.toFixed(3)}`);

// Spatial features to test.
const features = [
  {
    name: "mean-neighbor-delta",
    desc: "mean neighbor temp now - center temp now",
    fn: ctx => {
      const vals = Object.values(ctx.neighborTempsNow).filter(v => v != null);
      if (!vals.length) return 0;
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      return m - ctx.centerNow;
    }
  },
  {
    name: "upstream(W+NW+SW)-now-vs-center",
    desc: "avg of W,NW,SW now - center now",
    fn: ctx => {
      const vals = ["W", "NW", "SW"].map(d => ctx.neighborTempsNow[d]).filter(v => v != null);
      if (!vals.length) return 0;
      return vals.reduce((a, b) => a + b, 0) / vals.length - ctx.centerNow;
    }
  },
  {
    name: "upstream-3h-cooling",
    desc: "avg upstream(W+NW+SW) (now - 3h ago); negative = cooling",
    fn: ctx => {
      const dirs = ["W", "NW", "SW"];
      const deltas = dirs.map(d => {
        const now = ctx.neighborTempsNow[d];
        const past = ctx.neighborTemps3hAgo[d];
        return (now != null && past != null) ? (now - past) : null;
      }).filter(v => v != null);
      if (!deltas.length) return 0;
      return deltas.reduce((a, b) => a + b, 0) / deltas.length;
    }
  },
  {
    name: "max-lateral-gradient",
    desc: "max(neighbor) - min(neighbor); large = active boundary",
    fn: ctx => {
      const vals = Object.values(ctx.neighborTempsNow).filter(v => v != null);
      if (vals.length < 2) return 0;
      return Math.max(...vals) - Math.min(...vals);
    }
  }
];

console.log("\n=== Sweep: each spatial feature × beta on TRAIN ===");
const results = [];
for (const f of features) {
  for (const beta of [-0.5, -0.3, -0.2, -0.1, 0.1, 0.2, 0.3, 0.5]) {
    const spatialFn = ctx => beta * f.fn(ctx);
    const trS = summarize(evaluate(W, inTrain, spatialFn), `${f.name} β=${beta}`);
    results.push({ name: f.name, beta, train: trS, fn: spatialFn });
  }
}
results.sort((a, b) => a.train.rmse - b.train.rmse);
console.log("Top 10 by TRAIN RMSE:");
for (const r of results.slice(0, 10)) {
  console.log(`  ${r.train.label.padEnd(40)} RMSE=${r.train.rmse.toFixed(3)}  Δ=${(r.train.rmse - baseTrain.rmse).toFixed(3)}`);
}

// Evaluate top 3 on TEST.
console.log("\n=== HELD-OUT TEST: top 3 from train ===");
const top3 = results.slice(0, 3);
for (const r of top3) {
  const teS = summarize(evaluate(W, inTest, r.fn), r.train.label);
  const delta = teS.rmse - baseTest.rmse;
  console.log(`  ${r.train.label.padEnd(40)} TEST RMSE=${teS.rmse.toFixed(3)}  Δ=${delta.toFixed(3)} (${(delta / baseTest.rmse * 100).toFixed(1)}%)  ${delta < -0.005 ? "✓" : "✗ no real gain"}`);
}

// Headline.
const winner = top3.find(r => {
  const teS = summarize(evaluate(W, inTest, r.fn), "");
  return (teS.rmse - baseTest.rmse) < -0.01;
});
console.log("\n=== HEADLINE ===");
if (winner) {
  const teS = summarize(evaluate(W, inTest, winner.fn), "");
  console.log(`  Best spatial feature: ${winner.train.label}`);
  console.log(`  TEST RMSE: ${baseTest.rmse.toFixed(3)} → ${teS.rmse.toFixed(3)} (${((teS.rmse - baseTest.rmse) / baseTest.rmse * 100).toFixed(1)}%)`);
  console.log(`  ✓ Worth shipping.`);
} else {
  console.log(`  No spatial feature improved held-out RMSE meaningfully.`);
  console.log(`  Conclusion: ensemble forecast already absorbs the spatial signal. Don't ship.`);
}
