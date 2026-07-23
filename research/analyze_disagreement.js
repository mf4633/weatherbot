// Test: does widening σ when models disagree improve calibration?
// Hypothesis: when ensemble members span a wide range, our prediction is genuinely
// more uncertain. A spread-aware σ should give better coverage of 68%/95% CIs without
// changing the mean prediction (so RMSE same, but CI calibration improves).

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
  const fcByModel = {};
  for (const m of MODELS) {
    const md = c.models[m];
    if (!md) continue;
    const byDay = {};
    for (let i = 0; i < md.times.length; i++) {
      const ts = md.times[i] + "Z";
      const d = localDateStr(ts, tz);
      (byDay[d] ??= []).push({ ts, tempF: md.temps[i], localHr: localHour(ts, tz) });
    }
    fcByModel[m] = byDay;
  }
  cityProcessed[name] = { meta: c.meta, obsByDay, fcByModel, tz };
}

const BASE = { biasWeight: 0.4, stdMin: 0.8, stdBase: 1.0, stdLeadCoef: 0.12, stdBiasCoef: 0.10 };

function predict(weights, ctx, kSpread = 0) {
  const { hrsToPeak, maxSoFar, currentTemp, modelForecastHighs, modelForecastNows } = ctx;
  let sumW = 0, fhAccum = 0, fnAccum = 0;
  const peaks = [];
  for (const m of MODELS) {
    if (modelForecastHighs[m] != null && weights[m] > 0) {
      sumW += weights[m];
      fhAccum += weights[m] * modelForecastHighs[m];
      fnAccum += (modelForecastNows[m] != null ? weights[m] * modelForecastNows[m] : 0);
      peaks.push(modelForecastHighs[m]);
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
  const priorMean = forecastHigh + BASE.biasWeight * bias;
  const mean = Math.max(maxSoFar, priorMean);
  const spread = peaks.length > 1 ? Math.max(...peaks) - Math.min(...peaks) : 0;
  const std = Math.max(BASE.stdMin,
    BASE.stdBase + BASE.stdLeadCoef * hrsToPeak + BASE.stdBiasCoef * Math.abs(bias) + kSpread * spread);
  return { mean, std, spread };
}

function evaluate(weights, dateFilter, kSpread) {
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
        } else modelForecastHighs[m] = null;
      }
      for (const predHr of PREDICTION_HOURS) {
        const obs = dayObs.filter(o => o.localHr <= predHr);
        if (!obs.length) continue;
        const maxSoFar = Math.max(...obs.map(o => o.tempF));
        const currentTemp = obs[obs.length - 1].tempF;
        const modelForecastNows = modelForecastNowByHr[predHr] || {};
        const hrsToPeak = Math.max(0, peakHour - predHr);
        const p = predict(weights, { hrsToPeak, maxSoFar, currentTemp, modelForecastHighs, modelForecastNows }, kSpread);
        if (!p) continue;
        const err = p.mean - actualMax;
        out.push({
          city: name, predHr, hrsToPeak, pred: p.mean, std: p.std, spread: p.spread,
          actual: actualMax, err,
          in68: Math.abs(err) <= p.std,
          in95: Math.abs(err) <= 1.96 * p.std
        });
      }
    }
  }
  return out;
}

function summarize(r, label) {
  if (!r.length) return { label, n: 0 };
  const errs = r.map(x => x.err);
  return {
    label, n: r.length,
    rmse: Math.sqrt(errs.map(e => e * e).reduce((a, b) => a + b, 0) / r.length),
    mae: errs.map(Math.abs).reduce((a, b) => a + b, 0) / r.length,
    bias: errs.reduce((a, b) => a + b, 0) / r.length,
    cov68: r.filter(x => x.in68).length / r.length,
    cov95: r.filter(x => x.in95).length / r.length,
    meanStd: r.reduce((a, x) => a + x.std, 0) / r.length,
    meanSpread: r.reduce((a, x) => a + x.spread, 0) / r.length
  };
}

const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEnd = allDates[allDates.length - 1 - TEST_DAYS];
const inTrain = d => d <= trainEnd;
const inTest = d => d > trainEnd;

const W = (() => {
  const w = {};
  const n = MODELS.length;
  for (const m of MODELS) w[m] = 1 / n;
  return w;
})();

console.log(`Models: ${MODELS.join(", ")}`);
console.log(`TRAIN: → ${trainEnd} (${allDates.indexOf(trainEnd) + 1} days)`);
console.log(`TEST:  ${TEST_DAYS} days\n`);

console.log("=== Sweep k_spread on TRAIN ===");
const krange = [0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20];
const results = krange.map(k => ({ k, ...summarize(evaluate(W, inTrain, k), `k=${k}`) }));
console.log(`  ${'k'.padStart(5)}  ${'RMSE'.padStart(7)}  ${'σ̄'.padStart(7)}  ${'68%cov'.padStart(7)}  ${'95%cov'.padStart(7)}`);
for (const r of results) {
  console.log(`  ${r.k.toFixed(2).padStart(5)}  ${r.rmse.toFixed(3).padStart(7)}  ${r.meanStd.toFixed(3).padStart(7)}  ${(r.cov68*100).toFixed(1).padStart(6)}%  ${(r.cov95*100).toFixed(1).padStart(6)}%`);
}
// Pick k that gives best calibration (closest to 68%/95% targets simultaneously).
let bestK = 0, bestErr = Infinity;
for (const r of results) {
  const err = Math.abs(r.cov68 - 0.68) + Math.abs(r.cov95 - 0.95);
  if (err < bestErr) { bestErr = err; bestK = r.k; }
}
console.log(`\nBest calibrated k on TRAIN: ${bestK}`);

console.log("\n=== HELD-OUT TEST ===");
const baseTest = summarize(evaluate(W, inTest, 0), "k=0");
const newTest = summarize(evaluate(W, inTest, bestK), `k=${bestK}`);
for (const s of [baseTest, newTest]) {
  console.log(`  [${s.label}] RMSE=${s.rmse.toFixed(3)}  σ̄=${s.meanStd.toFixed(2)}  68%=${(s.cov68*100).toFixed(1)}%  95%=${(s.cov95*100).toFixed(1)}%`);
}

console.log("\n=== Subset where spread > 5°F (active disagreement, n=...) ===");
const baseHighSpread = summarize(evaluate(W, inTest, 0).filter(x => x.spread > 5), "k=0,spread>5");
const newHighSpread = summarize(evaluate(W, inTest, bestK).filter(x => x.spread > 5), `k=${bestK},spread>5`);
for (const s of [baseHighSpread, newHighSpread]) {
  console.log(`  [${s.label}] n=${s.n} RMSE=${s.rmse.toFixed(3)}  σ̄=${s.meanStd.toFixed(2)}  68%=${(s.cov68*100).toFixed(1)}%  95%=${(s.cov95*100).toFixed(1)}%`);
}
