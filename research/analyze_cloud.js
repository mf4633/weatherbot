// Test: does adding a cloud-cover deviation correction improve our model?
// Compare baseline (current production) vs cloud-corrected variants on held-out data.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_clouds.json", "utf-8"));
const PREDICTION_HOURS = [6, 9, 12, 15];
const TEST_DAYS = 90;

const localHour = (iso, tz) => parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(iso)), 10);
const localDateStr = (iso, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

console.log("Pre-processing...");
const cityProcessed = {};
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const obsByDay = {}, fcByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    const d = localDateStr(ts, tz);
    (obsByDay[d] ??= []).push({ ts, tempF: c.obs.temps[i], cloud: c.obs.clouds[i], localHr: localHour(ts, tz) });
  }
  for (let i = 0; i < c.fc.times.length; i++) {
    const ts = c.fc.times[i] + "Z";
    const d = localDateStr(ts, tz);
    (fcByDay[d] ??= []).push({ ts, tempF: c.fc.temps[i], cloud: c.fc.clouds[i], localHr: localHour(ts, tz) });
  }
  cityProcessed[name] = { meta: c.meta, obsByDay, fcByDay, tz };
}

// Baseline params from production.
const BASE = {
  biasWeight: 0.4, stdMin: 0.8, stdBase: 1.0, stdLeadCoef: 0.12, stdBiasCoef: 0.10,
  stdRealized: 0.5, stdPersistence: 4.5, stdForecastOnly: 3.0
};

// Predict — variant takes optional cloud correction params.
function predict(params, ctx, cloudParams = null) {
  const { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow,
          currentCloud, forecastCloudNow, forecastDailyAvgCloud } = ctx;
  if (forecastHigh == null && maxSoFar == null) return null;
  let mean, std;
  if (forecastHigh == null) {
    mean = (maxSoFar ?? currentTemp) + Math.min(hrsToPeak, 6) * 1.0; std = params.stdPersistence;
  } else if (maxSoFar == null) {
    mean = forecastHigh; std = params.stdForecastOnly;
  } else {
    const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
    let priorMean = forecastHigh + params.biasWeight * bias;

    // Cloud correction (optional). cloudDev = obs cloud - forecast cloud at this hour.
    // Or alternatively: avg cloud over the rest of day vs forecast.
    if (cloudParams && currentCloud != null && forecastCloudNow != null) {
      const cloudDev = currentCloud - forecastCloudNow;
      // tempPerCloud: e.g., -0.04°F per 1% cloud increase = -4°F if 100% more cloud
      priorMean += cloudParams.weight * cloudParams.tempPerCloud * cloudDev;
    }

    mean = Math.max(maxSoFar, priorMean);
    std = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToPeak + params.stdBiasCoef * Math.abs(bias));
  }
  return { mean, std };
}

function evaluate(params, dateFilter, cloudParams) {
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
        const last = obs[obs.length - 1];
        const maxSoFar = Math.max(...obs.map(o => o.tempF));
        const currentTemp = last.tempF;
        const currentCloud = last.cloud;
        const fc = dayFc.find(f => f.localHr === predHr);
        const forecastNow = fc ? fc.tempF : null;
        const forecastCloudNow = fc ? fc.cloud : null;
        const hrsToPeak = Math.max(0, peakHour - predHr);
        const p = predict(params, {
          hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow,
          currentCloud, forecastCloudNow
        }, cloudParams);
        if (!p) continue;
        const err = p.mean - actualMax;
        out.push({ city: name, predHr, hrsToPeak, pred: p.mean, std: p.std,
                   actual: actualMax, err, currentCloud, forecastCloudNow });
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
    rmse: Math.sqrt(errs.map(e => e*e).reduce((a, b) => a + b, 0) / r.length),
    mae: errs.map(Math.abs).reduce((a, b) => a + b, 0) / r.length,
    bias: errs.reduce((a, b) => a + b, 0) / r.length
  };
}

// Chronological split.
const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEnd = allDates[allDates.length - 1 - TEST_DAYS];
const inTrain = d => d <= trainEnd;
const inTest = d => d > trainEnd;
console.log(`TRAIN: → ${trainEnd}  (${allDates.indexOf(trainEnd) + 1} days)`);
console.log(`TEST:  ${TEST_DAYS} days\n`);

// Baseline (no cloud).
const baseTrain = evaluate(BASE, inTrain, null);
const baseTest = evaluate(BASE, inTest, null);
console.log("=== Baseline (no cloud correction) ===");
console.log(`  TRAIN: ${JSON.stringify(summarize(baseTrain, ""))}`);
console.log(`  TEST:  ${JSON.stringify(summarize(baseTest, ""))}\n`);

// Cloud-correction sweep.
console.log("=== Cloud correction sweep ===\n");
const cloudGrid = [];
for (const w of [0.0, 0.2, 0.3, 0.5, 0.7, 1.0]) {
  for (const t of [-0.02, -0.04, -0.06, -0.08]) {
    cloudGrid.push({ weight: w, tempPerCloud: t });
  }
}

let best = { rmse: Infinity, params: null };
const trainSummaries = [];
for (const cp of cloudGrid) {
  const r = evaluate(BASE, inTrain, cp);
  const s = summarize(r, `w=${cp.weight} tpc=${cp.tempPerCloud}`);
  trainSummaries.push({ ...s, cp });
  if (s.rmse < best.rmse) best = { rmse: s.rmse, params: cp, summary: s };
}
console.log(`TRAIN sweep (sorted by RMSE):`);
trainSummaries.sort((a, b) => a.rmse - b.rmse).slice(0, 10).forEach(s => {
  console.log(`  ${s.label.padEnd(28)} RMSE=${s.rmse.toFixed(3)}  MAE=${s.mae.toFixed(3)}  bias=${s.bias.toFixed(3)}`);
});

// Best from train, evaluate on test.
console.log(`\nBest on train: w=${best.params.weight} tpc=${best.params.tempPerCloud}`);
const baseTestSum = summarize(baseTest, "baseline");
const cloudTestSum = summarize(evaluate(BASE, inTest, best.params), "cloud-corrected");
console.log(`\n=== HELD-OUT TEST (${TEST_DAYS} days, n=${baseTest.length}) ===`);
console.log(`  baseline:        RMSE=${baseTestSum.rmse.toFixed(3)}  MAE=${baseTestSum.mae.toFixed(3)}  bias=${baseTestSum.bias.toFixed(3)}`);
console.log(`  cloud-corrected: RMSE=${cloudTestSum.rmse.toFixed(3)}  MAE=${cloudTestSum.mae.toFixed(3)}  bias=${cloudTestSum.bias.toFixed(3)}`);
const delta = cloudTestSum.rmse - baseTestSum.rmse;
console.log(`  Δ RMSE: ${delta.toFixed(3)} (${(delta / baseTestSum.rmse * 100).toFixed(1)}%)  ${delta < 0 ? "✓ improvement" : "✗ no improvement / worse"}`);

// Subset analysis: high-cloud-deviation cases.
const highDev = evaluate(BASE, inTest, best.params).filter(r => Math.abs((r.currentCloud ?? 0) - (r.forecastCloudNow ?? 0)) > 30);
const baseHighDev = evaluate(BASE, inTest, null).filter(r => Math.abs((r.currentCloud ?? 0) - (r.forecastCloudNow ?? 0)) > 30);
if (highDev.length > 50) {
  console.log(`\n  Subset where |cloudDev| > 30% (n=${highDev.length}):`);
  console.log(`    baseline:        RMSE=${summarize(baseHighDev, "").rmse.toFixed(3)}`);
  console.log(`    cloud-corrected: RMSE=${summarize(highDev, "").rmse.toFixed(3)}`);
}
