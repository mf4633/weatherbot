// Per-city ensemble weight tuning for HIGH and LOW.
// For each city, grid-search non-negative weights over 5 models (sum to 1).
// Compare against equal-weighted baseline. Ship per-city weights only where
// held-out TEST RMSE beats equal-weight by a meaningful margin.

import { readFileSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const TEST_DAYS = 90;
const MODELS = ["gfs_seamless", "ecmwf_ifs025", "icon_seamless", "ukmo_seamless", "meteofrance_seamless"];
const PREDICTION_HOURS_HIGH = [6, 9, 12, 15];
const PREDICTION_HOURS_LOW = [0, 3, 6, 9, 12];
// Margin required to ship per-city weights (vs equal-weighted): 5%.
const SHIP_THRESHOLD_FRAC = 0.05;

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

// Generate weights summing to 1 with step 0.2.
function weightGrid(step = 0.2) {
  const N = MODELS.length;
  const grid = [];
  const stepsPerDim = Math.round(1 / step);
  function enumerate(remaining, depth, current) {
    if (depth === N - 1) {
      const w = Math.round(remaining * stepsPerDim) / stepsPerDim;
      if (w >= -0.001 && w <= 1.001) grid.push([...current, w]);
      return;
    }
    for (let v = 0; v <= remaining + 0.001; v += step) {
      const vr = Math.round(v * stepsPerDim) / stepsPerDim;
      enumerate(remaining - vr, depth + 1, [...current, vr]);
    }
  }
  enumerate(1, 0, []);
  return grid.filter(w => Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 0.01);
}
const WEIGHT_GRID = weightGrid(0.2);
console.log(`Searching ${WEIGHT_GRID.length} weight combinations per city.`);

const equalWeights = Array(MODELS.length).fill(1 / MODELS.length);

// Predict per direction. variable = "high" | "low"
function predict(variable, weights, ctx) {
  const { hrsLeft, observed, currentTemp, modelForecasts, modelForecastNows } = ctx;
  let sumW = 0, fhAccum = 0, fnAccum = 0;
  for (let i = 0; i < MODELS.length; i++) {
    const m = MODELS[i];
    if (modelForecasts[m] != null) { sumW += weights[i]; fhAccum += weights[i] * modelForecasts[m]; }
    fnAccum += (modelForecastNows[m] != null ? weights[i] * modelForecastNows[m] : 0);
  }
  if (sumW <= 0 || observed == null) return null;
  const forecast = fhAccum / sumW;
  let availForecastNowSum = 0;
  for (let i = 0; i < MODELS.length; i++) if (modelForecastNows[MODELS[i]] != null) availForecastNowSum += weights[i];
  const forecastNow = availForecastNowSum > 0 ? fnAccum / availForecastNowSum : null;
  const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
  const biasWeight = variable === "high" ? 0.4 : 0.5;
  const priorMean = forecast + biasWeight * bias;
  // Truncate: HIGH from below at observed (max so far); LOW from above at observed (min so far).
  const mean = variable === "high" ? Math.max(observed, priorMean) : Math.min(observed, priorMean);
  return { mean, forecast, bias };
}

function evaluateWeights(variable, weights, dateFilter) {
  const out = [];
  const predHours = variable === "high" ? PREDICTION_HOURS_HIGH : PREDICTION_HOURS_LOW;
  for (const [name, c] of Object.entries(cityProcessed)) {
    const cityResults = [];
    for (const [date, dayObs] of Object.entries(c.obsByDay)) {
      if (!dateFilter(date)) continue;
      if (dayObs.length < 12) continue;
      const actual = variable === "high"
        ? Math.max(...dayObs.map(o => o.tempF))
        : Math.min(...dayObs.map(o => o.tempF));
      const modelForecasts = {};
      const modelForecastNowByHr = {};
      for (const m of MODELS) {
        const dayFc = c.fcByModel[m]?.[date] || [];
        if (dayFc.length) {
          modelForecasts[m] = variable === "high"
            ? Math.max(...dayFc.map(o => o.tempF))
            : Math.min(...dayFc.map(o => o.tempF));
          for (const f of dayFc) (modelForecastNowByHr[f.localHr] ??= {})[m] = f.tempF;
        } else modelForecasts[m] = null;
      }
      for (const predHr of predHours) {
        const obs = dayObs.filter(o => o.localHr <= predHr);
        if (!obs.length) continue;
        const observed = variable === "high"
          ? Math.max(...obs.map(o => o.tempF))
          : Math.min(...obs.map(o => o.tempF));
        const currentTemp = obs[obs.length - 1].tempF;
        const modelForecastNows = modelForecastNowByHr[predHr] || {};
        const p = predict(variable, weights, { observed, currentTemp, modelForecasts, modelForecastNows });
        if (!p) continue;
        const err = p.mean - actual;
        cityResults.push({ city: name, err });
      }
    }
    out.push({ city: name, results: cityResults });
  }
  return out;
}

function rmseFromErrs(errs) {
  if (!errs.length) return 0;
  return Math.sqrt(errs.map(e => e * e).reduce((a, b) => a + b, 0) / errs.length);
}

// Run analysis per variable.
const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEnd = allDates[allDates.length - 1 - TEST_DAYS];
const inTrain = d => d <= trainEnd;
const inTest = d => d > trainEnd;

for (const variable of ["high", "low"]) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`PER-CITY WEIGHT TUNING — ${variable.toUpperCase()}`);
  console.log("=".repeat(70));

  // Equal-weight baseline on TRAIN and TEST per city.
  const equalTrain = evaluateWeights(variable, equalWeights, inTrain);
  const equalTest = evaluateWeights(variable, equalWeights, inTest);
  const equalTrainRmse = {};
  const equalTestRmse = {};
  for (const e of equalTrain) equalTrainRmse[e.city] = rmseFromErrs(e.results.map(r => r.err));
  for (const e of equalTest) equalTestRmse[e.city] = rmseFromErrs(e.results.map(r => r.err));

  // For each city, grid-search best weights on TRAIN.
  const cityBest = {};
  for (const cityName of Object.keys(cityProcessed)) {
    let best = { rmse: Infinity, w: null };
    for (const w of WEIGHT_GRID) {
      const r = evaluateWeights(variable, w, inTrain).find(x => x.city === cityName);
      if (!r) continue;
      const rmse = rmseFromErrs(r.results.map(x => x.err));
      if (rmse < best.rmse) best = { rmse, w };
    }
    cityBest[cityName] = best;
  }

  // Evaluate best per-city weights on TEST.
  const testRmsePerCity = {};
  for (const cityName of Object.keys(cityProcessed)) {
    const best = cityBest[cityName];
    const r = evaluateWeights(variable, best.w, inTest).find(x => x.city === cityName);
    testRmsePerCity[cityName] = r ? rmseFromErrs(r.results.map(x => x.err)) : Infinity;
  }

  // Signal-vs-noise gate: ship per-city weights only when improvement is
  // statistically significant. Paired t-test on squared errors:
  //   diff_i = err_eq_i² - err_tuned_i²
  //   t = mean(diff) / SE(diff)
  //   Ship if t > 1.96 (95% confidence improvement is real) AND improvement > 5%.
  console.log(`\n${'city'.padEnd(6)} ${'eq_TR'.padStart(7)} ${'tuned_TR'.padStart(8)} ${'eq_TE'.padStart(7)} ${'tuned_TE'.padStart(9)} ${'TE_Δ%'.padStart(7)} ${'t-stat'.padStart(7)}  ship?  weights`);
  const shipped = {};
  let totalEqWeightedTestErrSq = 0, totalTunedTestErrSq = 0, totalN = 0;
  for (const cityName of Object.keys(cityProcessed)) {
    const eqTR = equalTrainRmse[cityName];
    const eqTE = equalTestRmse[cityName];
    const tuTR = cityBest[cityName].rmse;
    const tuTE = testRmsePerCity[cityName];
    const teDelta = (tuTE - eqTE) / eqTE;

    // Paired errors on TEST.
    const eqErrs = (equalTest.find(x => x.city === cityName)?.results || []).map(r => r.err);
    const tunedTestRes = evaluateWeights(variable, cityBest[cityName].w, inTest).find(x => x.city === cityName);
    const tunedErrs = (tunedTestRes?.results || []).map(r => r.err);
    let tStat = 0;
    if (eqErrs.length === tunedErrs.length && eqErrs.length > 1) {
      const diffs = eqErrs.map((e, i) => e * e - tunedErrs[i] * tunedErrs[i]);
      const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const variance = diffs.reduce((a, d) => a + (d - meanDiff) ** 2, 0) / (diffs.length - 1);
      const se = Math.sqrt(variance / diffs.length);
      tStat = se > 0 ? meanDiff / se : 0;
    }
    // Ship only if (a) improvement > 5% AND (b) t-stat > 1.96 (signal beats noise).
    const ship = teDelta < -SHIP_THRESHOLD_FRAC && tStat > 1.96;
    const wStr = cityBest[cityName].w.map((x, i) => `${MODELS[i].split("_")[0].slice(0,3)}=${x.toFixed(1)}`).join(",");
    console.log(`  ${cityName.padEnd(6)} ${eqTR.toFixed(2).padStart(7)} ${tuTR.toFixed(2).padStart(8)} ${eqTE.toFixed(2).padStart(7)} ${tuTE.toFixed(2).padStart(9)} ${(teDelta*100).toFixed(1).padStart(6)}% ${tStat.toFixed(2).padStart(7)}  ${ship ? "✓" : "✗"}  ${wStr}`);
    if (ship) shipped[cityName] = cityBest[cityName].w;

    // Aggregate test errors for global summary (using shipped weights where applicable, equal otherwise).
    const r = evaluateWeights(variable, ship ? cityBest[cityName].w : equalWeights, inTest).find(x => x.city === cityName);
    if (r) {
      const errs = r.results.map(x => x.err);
      totalTunedTestErrSq += errs.map(e => e*e).reduce((a, b) => a + b, 0);
      totalN += errs.length;
    }
    const eqR = equalTest.find(x => x.city === cityName);
    if (eqR) {
      const errs = eqR.results.map(x => x.err);
      totalEqWeightedTestErrSq += errs.map(e => e*e).reduce((a, b) => a + b, 0);
    }
  }

  const overallEqRmse = Math.sqrt(totalEqWeightedTestErrSq / totalN);
  const overallTunedRmse = Math.sqrt(totalTunedTestErrSq / totalN);
  console.log(`\n${variable.toUpperCase()} SUMMARY (TEST):`);
  console.log(`  Equal-weighted everywhere:        RMSE ${overallEqRmse.toFixed(3)}°F`);
  console.log(`  Per-city (shipped) + equal else:  RMSE ${overallTunedRmse.toFixed(3)}°F`);
  console.log(`  Δ:                                ${((overallTunedRmse - overallEqRmse) / overallEqRmse * 100).toFixed(1)}%`);
  console.log(`  Cities with custom weights: ${Object.keys(shipped).length} / 20`);

  // Save weights.
  writeFileSync(`weights_${variable}.json`, JSON.stringify(shipped, null, 2));
  console.log(`  Written weights_${variable}.json`);
}
