// Tune σ formula on the 5-model ensemble. Goal: 68% empirical coverage of the 68% CI.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const PREDICTION_HOURS = [6, 9, 12, 15];
const TEST_DAYS = 90;
const MODELS = data.models.filter(m => !["jma_seamless", "gem_seamless"].includes(m));

const localHour = (iso, tz) => parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(iso)), 10);
const localDateStr = (iso, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

console.log("Pre-processing...");
const cityProcessed = {};
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const obsByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    (obsByDay[localDateStr(ts, tz)] ??= []).push({ ts, tempF: c.obs.temps[i], localHr: localHour(ts, tz) });
  }
  const fcByModel = {};
  for (const m of MODELS) {
    const md = c.models[m];
    if (!md) continue;
    const byDay = {};
    for (let i = 0; i < md.times.length; i++) {
      const ts = md.times[i] + "Z";
      (byDay[localDateStr(ts, tz)] ??= []).push({ ts, tempF: md.temps[i], localHr: localHour(ts, tz) });
    }
    fcByModel[m] = byDay;
  }
  cityProcessed[name] = { meta: c.meta, obsByDay, fcByModel, tz };
}

function predict(params, ctx) {
  const { hrsToPeak, maxSoFar, currentTemp, modelForecastHighs, modelForecastNows } = ctx;
  let sumW = 0, fhAccum = 0, fnAccum = 0;
  for (const m of MODELS) {
    const w = 1 / MODELS.length;
    if (modelForecastHighs[m] != null) {
      sumW += w; fhAccum += w * modelForecastHighs[m];
      fnAccum += (modelForecastNows[m] != null ? w * modelForecastNows[m] : 0);
    }
  }
  if (sumW <= 0 || maxSoFar == null) return null;
  const forecastHigh = fhAccum / sumW;
  let availForecastNowSum = 0;
  for (const m of MODELS) if (modelForecastNows[m] != null) availForecastNowSum += 1 / MODELS.length;
  const forecastNow = availForecastNowSum > 0 ? fnAccum / availForecastNowSum : null;
  const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
  const priorMean = forecastHigh + 0.4 * bias;
  const mean = Math.max(maxSoFar, priorMean);
  const std = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToPeak + params.stdBiasCoef * Math.abs(bias));
  return { mean, std };
}

function evaluate(params, dateFilter) {
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
        const p = predict(params, { hrsToPeak, maxSoFar, currentTemp, modelForecastHighs, modelForecastNows });
        if (!p) continue;
        const err = p.mean - actualMax;
        out.push({ pred: p.mean, std: p.std, actual: actualMax, err,
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

const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEnd = allDates[allDates.length - 1 - TEST_DAYS];
const inTrain = d => d <= trainEnd;
const inTest = d => d > trainEnd;

console.log(`Models: ${MODELS.join(", ")}`);
console.log(`TRAIN: → ${trainEnd}  TEST: ${TEST_DAYS} days\n`);

const grid = [];
for (const stdMin of [0.4, 0.5, 0.6, 0.7, 0.8]) {
  for (const stdBase of [0.4, 0.5, 0.6, 0.7, 0.8, 1.0]) {
    for (const stdLeadCoef of [0.05, 0.08, 0.10, 0.12, 0.15]) {
      for (const stdBiasCoef of [0.05, 0.08, 0.10, 0.12]) {
        grid.push({ stdMin, stdBase, stdLeadCoef, stdBiasCoef });
      }
    }
  }
}
console.log(`Sweeping ${grid.length} σ-formula combos on TRAIN, scoring by |cov68-0.68|+|cov95-0.95|...`);

let best = { score: Infinity, params: null };
for (const params of grid) {
  const s = summarize(evaluate(params, inTrain));
  const score = Math.abs(s.cov68 - 0.68) + Math.abs(s.cov95 - 0.95);
  if (score < best.score) best = { score, params, summary: s };
}
console.log(`\nBest TRAIN calibration:`);
console.log(`  params: stdMin=${best.params.stdMin} stdBase=${best.params.stdBase} stdLeadCoef=${best.params.stdLeadCoef} stdBiasCoef=${best.params.stdBiasCoef}`);
console.log(`  TRAIN: RMSE=${best.summary.rmse.toFixed(3)} σ̄=${best.summary.meanStd.toFixed(2)} 68%=${(best.summary.cov68*100).toFixed(1)}% 95%=${(best.summary.cov95*100).toFixed(1)}%`);

const testS = summarize(evaluate(best.params, inTest));
console.log(`  TEST:  RMSE=${testS.rmse.toFixed(3)} σ̄=${testS.meanStd.toFixed(2)} 68%=${(testS.cov68*100).toFixed(1)}% 95%=${(testS.cov95*100).toFixed(1)}%`);

// Show current production params for comparison.
const currentS = summarize(evaluate({ stdMin: 0.8, stdBase: 1.0, stdLeadCoef: 0.12, stdBiasCoef: 0.10 }, inTest));
console.log(`\nCurrent production (stdMin=0.8 stdBase=1.0 stdLeadCoef=0.12 stdBiasCoef=0.10):`);
console.log(`  TEST:  RMSE=${currentS.rmse.toFixed(3)} σ̄=${currentS.meanStd.toFixed(2)} 68%=${(currentS.cov68*100).toFixed(1)}% 95%=${(currentS.cov95*100).toFixed(1)}%`);
