// 5-year analysis comparing untruncated vs truncated-normal posterior at maxSoFar.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data.json", "utf-8"));
const PREDICTION_HOURS = [6, 9, 12, 15];
const TEST_DAYS = 180;

const localHour = (iso, tz) => parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(iso)), 10);
const localDateStr = (iso, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

console.log("Pre-processing...");
const cityProcessed = {};
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const obsByDay = {}, fcByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    (obsByDay[localDateStr(ts, tz)] ??= []).push({ ts, tempF: c.obs.temps[i], localHr: localHour(ts, tz) });
  }
  for (let i = 0; i < c.fc.times.length; i++) {
    const ts = c.fc.times[i] + "Z";
    (fcByDay[localDateStr(ts, tz)] ??= []).push({ ts, tempF: c.fc.temps[i], localHr: localHour(ts, tz) });
  }
  cityProcessed[name] = { meta: c.meta, obsByDay, fcByDay, tz };
}

// Standard normal PDF and CDF (Abramowitz & Stegun 26.2.17, ~7-decimal accuracy).
function phi(x) { return Math.exp(-x*x/2) / Math.sqrt(2 * Math.PI); }
function Phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x*x/2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Truncated normal: X | X >= a where X ~ N(mu, sigma^2). Returns { mean, std }.
function truncNormal(mu, sigma, a) {
  const alpha = (a - mu) / sigma;
  if (alpha < -4) return { mean: mu, std: sigma };          // truncation negligible
  if (alpha > 8)  return { mean: a, std: Math.max(sigma * 0.05, 0.05) };  // extreme: pin to a
  const phiA = phi(alpha);
  const oneMinusPhiA = 1 - Phi(alpha);
  if (oneMinusPhiA < 1e-9) return { mean: a, std: Math.max(sigma * 0.05, 0.05) };
  const lambda = phiA / oneMinusPhiA;
  const newMean = mu + sigma * lambda;
  const variance = sigma * sigma * (1 + alpha * lambda - lambda * lambda);
  return { mean: newMean, std: Math.sqrt(Math.max(1e-4, variance)) };
}

// Predict with optional truncation.
// mode: "untruncated" | "full-trunc" | "hybrid" (truncated mean + empirical σ + clipped CI)
function modelPredict(params, ctx, offsets, mode = "untruncated") {
  const { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow, cityName } = ctx;
  if (forecastHigh == null && maxSoFar == null) return null;
  let priorMean, priorStd;
  if (hrsToPeak <= 0.25) {
    priorMean = maxSoFar ?? forecastHigh; priorStd = params.stdRealized;
  } else if (forecastHigh == null) {
    priorMean = (maxSoFar ?? currentTemp) + Math.min(hrsToPeak, 6) * 1.0; priorStd = params.stdPersistence;
  } else if (maxSoFar == null) {
    priorMean = forecastHigh; priorStd = params.stdForecastOnly;
  } else {
    const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
    priorMean = forecastHigh + params.biasWeight * bias;
    priorStd = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToPeak + params.stdBiasCoef * Math.abs(bias));
  }
  if (offsets && offsets[cityName] != null) priorMean -= offsets[cityName];

  if (mode === "untruncated" || maxSoFar == null) {
    return { mean: Math.max(maxSoFar ?? -Infinity, priorMean), std: priorStd };
  }
  if (mode === "full-trunc") {
    const { mean, std } = truncNormal(priorMean, priorStd, maxSoFar);
    return { mean, std, lowerBound: maxSoFar };
  }
  if (mode === "hybrid") {
    // Truncated MEAN, empirical σ, clipped CI lower bound.
    const { mean: truncMean } = truncNormal(priorMean, priorStd, maxSoFar);
    return { mean: truncMean, std: priorStd, lowerBound: maxSoFar };
  }
  throw new Error("unknown mode " + mode);
}

function evaluate(params, dateFilter, offsets, mode) {
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
                               offsets, mode);
        if (!p) continue;
        const err = p.mean - actualMax;
        // CI: respect the lower bound if truncated.
        const lo68 = p.lowerBound != null ? Math.max(p.lowerBound, p.mean - p.std) : p.mean - p.std;
        const hi68 = p.mean + p.std;
        const lo95 = p.lowerBound != null ? Math.max(p.lowerBound, p.mean - 1.96 * p.std) : p.mean - 1.96 * p.std;
        const hi95 = p.mean + 1.96 * p.std;
        const in68 = actualMax >= lo68 && actualMax <= hi68;
        const in95 = actualMax >= lo95 && actualMax <= hi95;
        const ciSpan = hi68 - lo68;  // sharpness: smaller is better, given correct coverage
        // Track when truncation actually mattered (maxSoFar bound is binding).
        const truncBinding = maxSoFar != null && forecastHigh != null && maxSoFar > forecastHigh;
        out.push({ city: name, date, predHr, hrsToPeak, pred: p.mean, std: p.std,
                   actual: actualMax, err, in68, in95, ciSpan, truncBinding });
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
    meanStd: results.reduce((a,r) => a + r.std, 0) / results.length,
    meanCI68Span: results.reduce((a,r) => a + r.ciSpan, 0) / results.length
  };
}
function summarizeBy(results, key) {
  const g = {};
  for (const r of results) (g[r[key]] ??= []).push(r);
  return Object.entries(g).map(([k, rs]) => summarize(rs, k));
}

// Best params from prior tuning.
const params = {
  biasWeight: 0.4, stdMin: 0.4, stdBase: 1.0, stdLeadCoef: 0.12, stdBiasCoef: 0.10,
  stdRealized: 0.5, stdPersistence: 4.5, stdForecastOnly: 3.0
};

const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEndStr = allDates[allDates.length - 1 - TEST_DAYS];
const inTrain = d => d <= trainEndStr;
const inTest = d => d > trainEndStr;
console.log(`TRAIN: → ${trainEndStr}  (${allDates.indexOf(trainEndStr)+1} days)`);
console.log(`TEST:  ${TEST_DAYS} days\n`);

// Fit per-city offsets on train using OLD (non-truncated) approach.
const trainResults = evaluate(params, inTrain, null, "untruncated");
const offsets = {};
for (const sub of summarizeBy(trainResults, "city")) offsets[sub.label] = sub.bias;

console.log(`=== HELD-OUT TEST: untruncated vs full-trunc vs hybrid ===\n`);
const modes = ["untruncated", "full-trunc", "hybrid"];
const all = {};
for (const mode of modes) {
  const r = evaluate(params, inTest, offsets, mode);
  all[mode] = r;
  const s = summarize(r, mode);
  console.log(`  [${s.label}]`);
  console.log(`    n=${s.n}  RMSE=${s.rmse.toFixed(2)}  MAE=${s.mae.toFixed(2)}  bias=${s.bias.toFixed(2)}`);
  console.log(`    σ̄=${s.meanStd.toFixed(2)}  68%CI span=${s.meanCI68Span.toFixed(2)}  68%cov=${(s.cov68*100).toFixed(1)}%  95%cov=${(s.cov95*100).toFixed(1)}%`);
}

console.log(`\n=== Subset: BINDING (maxSoFar > forecastHigh) ===\n`);
for (const mode of modes) {
  const s = summarize(all[mode].filter(r => r.truncBinding), mode + ", binding");
  console.log(`  [${s.label}]  n=${s.n}  RMSE=${s.rmse.toFixed(2)}  bias=${s.bias.toFixed(2)}  span=${s.meanCI68Span.toFixed(2)}  68%=${(s.cov68*100).toFixed(0)}%  95%=${(s.cov95*100).toFixed(0)}%`);
}

console.log(`\n=== Subset: NON-binding ===\n`);
for (const mode of modes) {
  const s = summarize(all[mode].filter(r => !r.truncBinding), mode + ", non-binding");
  console.log(`  [${s.label}]  n=${s.n}  RMSE=${s.rmse.toFixed(2)}  bias=${s.bias.toFixed(2)}  span=${s.meanCI68Span.toFixed(2)}  68%=${(s.cov68*100).toFixed(0)}%  95%=${(s.cov95*100).toFixed(0)}%`);
}
