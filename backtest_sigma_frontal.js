// σ_frontal A/B backtest: compare prediction calibration with and without
// the new σ_frontal third term added to weather.js on 2026-05-07.
//
// We don't expect mean (RMSE) to change — σ_frontal only affects σ. The
// hypothesis is that σ_frontal improves CALIBRATION (68%/95% coverage)
// specifically on frontal days where the old σ was too tight.
//
// Method:
//   1. Same prediction loop as analyze_low_coldfront.js (LOW market only).
//   2. For each (city, date, predHr), compute:
//        sigmaFrontal_forecast = (range of forecast over next 3h - 2.0) * 0.5,
//                                clamped [0, 1.5]
//        sigmaFrontal_obs       = (range of obs in last 90 min - 0.5),
//                                clamped [0, 1.5]
//        sigmaFrontal           = max(forecast, obs)
//      Then sigma_with = √(sigma_old² + sigmaFrontal²).
//   3. Compare both σs against the actual error |pred - actual|.
//   4. Slice by sigmaFrontal to expose the improvement on frontal days.
//
// Hourly granularity here is coarser than production (which has ASOS-1min +
// METAR :29 RMK groups), so we will UNDERSAMPLE intra-hour volatility. Treat
// these results as lower-bound calibration improvement.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const TEST_DAYS = 90;
const MODELS = data.models.filter(m => !["jma_seamless", "gem_seamless"].includes(m));
const PREDICTION_HOURS = [0, 3, 6, 9, 12, 15];
const RECENT_DAYS = 365;
const cutoffMs = Date.now() - RECENT_DAYS * 86400 * 1000;

const TZ_OFFSETS = {
  "America/New_York": -4, "America/Chicago": -5, "America/Denver": -6,
  "America/Los_Angeles": -7, "America/Phoenix": -7,
  "America/Indiana/Indianapolis": -4
};
function localHrAndDate(isoNoZ, tz) {
  const tsMs = Date.parse(isoNoZ + "Z");
  const off = TZ_OFFSETS[tz] ?? -5;
  const localMs = tsMs + off * 3600 * 1000;
  const d = new Date(localMs);
  return { date: `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`,
           hr: d.getUTCHours(), ms: tsMs };
}

console.log("Pre-processing 1y window...");
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
console.log(`done in ${((Date.now() - t0)/1000).toFixed(1)}s\n`);

function hoursToTrough(localHr) {
  if (localHr >= 7) return 0;
  return Math.max(0, 6 - localHr);
}

// Compute σ_frontal exactly as in weather.js. Hourly granularity here means
// the obs window catches ~last 1-2 obs (1h window in practice).
function computeFrontalSigma(obsBefore, hourlyForecast, predHr) {
  let sigmaForecast = 0, sigmaObs = 0;
  // Forward window: forecast for predHr+1, predHr+2, predHr+3 (3h horizon).
  if (hourlyForecast?.length) {
    const fwd = hourlyForecast.filter(p => p.localHr > predHr && p.localHr <= predHr + 3);
    if (fwd.length >= 2) {
      const temps = fwd.map(p => p.tempF);
      const range = Math.max(...temps) - Math.min(...temps);
      if (range > 2.0) sigmaForecast = Math.min(1.5, (range - 2.0) * 0.5);
    }
  }
  // Backward window: obs at predHr-1 and predHr (90min ≈ last 2 hourly samples).
  if (obsBefore?.length >= 2) {
    const recent = obsBefore.filter(o => o.localHr >= predHr - 1);
    if (recent.length >= 2) {
      const temps = recent.map(o => o.tempF);
      const range = Math.max(...temps) - Math.min(...temps);
      if (range > 1.0) sigmaObs = Math.min(1.5, range - 0.5);
    }
  }
  return Math.max(sigmaForecast, sigmaObs);
}

function predict(ctx) {
  const { hrsToTrough, minSoFar, currentTemp, modelForecastLows, modelForecastNows,
          modelRemainingLows, sigmaFrontal } = ctx;
  let sumW = 0, flAccum = 0, fnAccum = 0, fnW = 0;
  const lows = [];
  for (const m of MODELS) {
    const w = 1 / MODELS.length;
    if (modelForecastLows[m] != null) {
      sumW += w;
      flAccum += w * modelForecastLows[m];
      lows.push(modelForecastLows[m]);
    }
    if (modelForecastNows[m] != null) { fnW += w; fnAccum += w * modelForecastNows[m]; }
  }
  if (sumW <= 0 || minSoFar == null) return null;
  const forecastLow = flAccum / sumW;
  const forecastNow = fnW > 0 ? fnAccum / fnW : null;
  const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
  // σ_ensemble across forecast lows.
  const sigmaEns = lows.length > 1
    ? Math.sqrt(lows.reduce((a, x) => a + (x - forecastLow) ** 2, 0) / (lows.length - 1))
    : 0.5;
  const SIGMA_RES = 0.7;

  // Bias-corrected mean (matches production bias-corrected branch).
  const priorMean = forecastLow + 0.5 * bias;
  let mean = Math.min(minSoFar, priorMean);
  // Base σ (production formulas without any σ_frontal): trough-realized when
  // hrsToTrough < 1, else bias-corrected.
  let baseStd;
  if (hrsToTrough < 1) {
    baseStd = Math.sqrt(SIGMA_RES * SIGMA_RES + (0.3 * hrsToTrough) ** 2);
    mean = minSoFar - 0.2 - 0.3 * hrsToTrough;  // trough-realized mean
  } else {
    baseStd = Math.sqrt(sigmaEns * sigmaEns + SIGMA_RES * SIGMA_RES);
  }
  // Cold-front check: production fires when ensemble's remaining-day trough is
  // materially below minSoFar. When fired, sets mean = remTrough and σ floor=1.5.
  let availRem = 0, remAccum = 0;
  for (const m of MODELS) {
    if (modelRemainingLows && modelRemainingLows[m] != null) {
      availRem += 1 / MODELS.length;
      remAccum += (1 / MODELS.length) * modelRemainingLows[m];
    }
  }
  const remTrough = availRem > 0 ? remAccum / availRem : null;
  let coldFrontFired = false;
  let meanFinal = mean, postCfStd = baseStd;
  if (remTrough != null && remTrough < minSoFar - 0.5 && remTrough < mean) {
    meanFinal = remTrough;
    postCfStd = Math.max(baseStd, 1.5);
    coldFrontFired = true;
  }

  // Two policies under comparison:
  //   STACK (deployed 2026-05-07 morning): σ_frontal added always.
  //   DEDUP (today's follow-up):            σ_frontal added only if cold-front DIDN'T fire.
  const stdStack = Math.sqrt(postCfStd * postCfStd + sigmaFrontal * sigmaFrontal);
  const stdDedup = coldFrontFired
                   ? postCfStd
                   : Math.sqrt(postCfStd * postCfStd + sigmaFrontal * sigmaFrontal);
  // The third reference point: "no σ_frontal at all" (pre-2026-05-07 production).
  const stdBaseline = postCfStd;

  return { mean: meanFinal, stdBaseline, stdStack, stdDedup,
           sigmaFrontal, coldFrontFired };
}

function evaluate() {
  const out = [];
  for (const [name, c] of Object.entries(cityProcessed)) {
    for (const [date, dayObs] of Object.entries(c.obsByDay)) {
      if (dayObs.length < 12) continue;
      const actualMin = Math.min(...dayObs.map(o => o.tempF));
      const modelHourly = {};
      for (const m of MODELS) {
        modelHourly[m] = c.fcByModel[m]?.[date] || [];
      }
      const ensembleHourly = [];  // average across models, by localHr
      const hrSet = new Set();
      for (const m of MODELS) for (const f of modelHourly[m]) hrSet.add(f.localHr);
      for (const hr of [...hrSet].sort((a,b)=>a-b)) {
        let sum = 0, n = 0;
        for (const m of MODELS) {
          const f = modelHourly[m].find(x => x.localHr === hr);
          if (f) { sum += f.tempF; n++; }
        }
        if (n > 0) ensembleHourly.push({ localHr: hr, tempF: sum / n });
      }
      for (const predHr of PREDICTION_HOURS) {
        const obsBefore = dayObs.filter(o => o.localHr <= predHr);
        if (!obsBefore.length) continue;
        const minSoFar = Math.min(...obsBefore.map(o => o.tempF));
        const currentTemp = obsBefore[obsBefore.length - 1].tempF;
        const modelForecastLows = {};
        for (const m of MODELS) {
          modelForecastLows[m] = modelHourly[m].length
            ? Math.min(...modelHourly[m].map(o => o.tempF)) : null;
        }
        const modelForecastNows = {};
        for (const m of MODELS) {
          const f = modelHourly[m].find(x => x.localHr === predHr);
          if (f) modelForecastNows[m] = f.tempF;
        }
        const modelRemainingLows = {};
        for (const m of MODELS) {
          const future = modelHourly[m].filter(f => f.localHr > predHr);
          modelRemainingLows[m] = future.length ? Math.min(...future.map(f => f.tempF)) : null;
        }
        const sigmaFrontal = computeFrontalSigma(obsBefore, ensembleHourly, predHr);
        const hrs = hoursToTrough(predHr);
        const p = predict({ hrsToTrough: hrs, minSoFar, currentTemp,
                            modelForecastLows, modelForecastNows,
                            modelRemainingLows, sigmaFrontal });
        if (!p) continue;
        const err = p.mean - actualMin;
        out.push({ city: name, date, predHr, sigmaFrontal, coldFrontFired: p.coldFrontFired,
                   pred: p.mean,
                   stdBaseline: p.stdBaseline, stdStack: p.stdStack, stdDedup: p.stdDedup,
                   err });
      }
    }
  }
  return out;
}

function summarize(rs, label) {
  const n = rs.length;
  if (!n) return { label, n: 0 };
  const errs = rs.map(x => x.err);
  const cov = (key, k) => rs.filter(x => Math.abs(x.err) <= k * x[key]).length / n;
  return {
    label, n,
    rmse: Math.sqrt(errs.reduce((a, e) => a + e*e, 0) / n),
    bias: errs.reduce((a, e) => a + e, 0) / n,
    sigmaBaseline: rs.reduce((a, x) => a + x.stdBaseline, 0) / n,
    sigmaStack:    rs.reduce((a, x) => a + x.stdStack, 0) / n,
    sigmaDedup:    rs.reduce((a, x) => a + x.stdDedup, 0) / n,
    cov68_baseline: cov("stdBaseline", 1),
    cov68_stack:    cov("stdStack", 1),
    cov68_dedup:    cov("stdDedup", 1),
    cov95_baseline: cov("stdBaseline", 1.96),
    cov95_stack:    cov("stdStack", 1.96),
    cov95_dedup:    cov("stdDedup", 1.96),
  };
}

function row(s) {
  if (!s.n) return `${s.label.padEnd(28)} (no data)`;
  return `${s.label.padEnd(28)} n=${String(s.n).padStart(6)}  `
       + `RMSE=${s.rmse.toFixed(2)}  `
       + `σ̄ base/stack/dedup=${s.sigmaBaseline.toFixed(2)}/${s.sigmaStack.toFixed(2)}/${s.sigmaDedup.toFixed(2)}  `
       + `68%=${(s.cov68_baseline*100).toFixed(0)}/${(s.cov68_stack*100).toFixed(0)}/${(s.cov68_dedup*100).toFixed(0)}`;
}

console.log("Running A/B...");
const r = evaluate();
console.log(`Total predictions: ${r.length}\n`);

console.log("=== Overall (all days, all hours) ===");
console.log(row(summarize(r, "all")));

console.log("\n=== Dedup verification: σ_frontal application by cold-front state ===");
const cfFired = r.filter(x => x.coldFrontFired);
const cfNotFired = r.filter(x => !x.coldFrontFired);
console.log(row(summarize(cfFired, "cold-front fired")));
console.log(row(summarize(cfNotFired, "cold-front NOT fired")));
console.log(row(summarize(cfNotFired.filter(x => x.sigmaFrontal > 0), "cf-not-fired & σ_f>0")));

console.log("\n=== Sliced by σ_frontal magnitude ===");
const buckets = [
  { label: "calm    σ_frontal=0", filter: x => x.sigmaFrontal === 0 },
  { label: "minor   0<σ_f≤0.5",  filter: x => x.sigmaFrontal > 0 && x.sigmaFrontal <= 0.5 },
  { label: "moderate 0.5<σ_f≤1.0", filter: x => x.sigmaFrontal > 0.5 && x.sigmaFrontal <= 1.0 },
  { label: "strong  σ_f>1.0",     filter: x => x.sigmaFrontal > 1.0 }
];
for (const b of buckets) console.log(row(summarize(r.filter(b.filter), b.label)));

console.log("\n=== Frontal days only (σ_f > 0.5) by prediction hour ===");
for (const ph of PREDICTION_HOURS) {
  const sub = r.filter(x => x.sigmaFrontal > 0.5 && x.predHr === ph);
  console.log(row(summarize(sub, `predHr=${ph} (frontal)`)));
}

console.log("\n=== Per-city on frontal days (σ_f > 0.5) ===");
const byCity = {};
for (const x of r) if (x.sigmaFrontal > 0.5) (byCity[x.city] ??= []).push(x);
const cityRows = Object.entries(byCity).map(([k, v]) => summarize(v, k));
cityRows.sort((a, b) => b.n - a.n);
for (const c of cityRows.slice(0, 20)) console.log(row(c));

// === Tail-risk (|err| > 2σ): the "near-arb-but-wrong" failure mode the trader
// gets stake-piled into. Lower is better.
console.log("\n=== Tail-risk: P(|err| > 2σ) — directly maps to stake-pile failures ===");
function tailRate(rs, key) {
  return rs.filter(x => Math.abs(x.err) > 2 * x[key]).length / rs.length;
}
function fmtTail(rs, label) {
  if (!rs.length) return `${label} (no data)`;
  const tB = tailRate(rs, "stdBaseline");
  const tS = tailRate(rs, "stdStack");
  const tD = tailRate(rs, "stdDedup");
  return `${label.padEnd(28)} n=${String(rs.length).padStart(6)}  `
       + `baseline=${(tB*100).toFixed(2)}%  stack=${(tS*100).toFixed(2)}%  dedup=${(tD*100).toFixed(2)}%  `
       + `(stack-vs-base ${tB > 0 ? ((1 - tS/tB)*100).toFixed(0) : "-"}%, dedup-vs-base ${tB > 0 ? ((1 - tD/tB)*100).toFixed(0) : "-"}%)`;
}
console.log(fmtTail(r, "all"));
console.log(fmtTail(r.filter(x => x.sigmaFrontal === 0), "calm σ_f=0"));
console.log(fmtTail(r.filter(x => x.sigmaFrontal > 0 && x.sigmaFrontal <= 0.5), "minor 0<σ_f≤0.5"));
console.log(fmtTail(r.filter(x => x.sigmaFrontal > 0.5 && x.sigmaFrontal <= 1.0), "moderate 0.5<σ_f≤1.0"));
console.log(fmtTail(r.filter(x => x.sigmaFrontal > 1.0), "strong σ_f>1.0"));

console.log("\n=== Conservatism cost: σ̄/RMSE per policy (1.0 = perfectly calibrated) ===");
function cons(rs, label) {
  if (!rs.length) return `${label} (no data)`;
  const rmse = Math.sqrt(rs.reduce((a,x)=>a+x.err*x.err,0)/rs.length);
  const sB = rs.reduce((a,x)=>a+x.stdBaseline,0)/rs.length;
  const sS = rs.reduce((a,x)=>a+x.stdStack,0)/rs.length;
  const sD = rs.reduce((a,x)=>a+x.stdDedup,0)/rs.length;
  return `${label.padEnd(28)} RMSE=${rmse.toFixed(2)}  `
       + `σ̄/RMSE baseline=${(sB/rmse).toFixed(2)}  stack=${(sS/rmse).toFixed(2)}  dedup=${(sD/rmse).toFixed(2)}`;
}
console.log(cons(r, "all"));
console.log(cons(r.filter(x => x.sigmaFrontal > 0), "any σ_f>0"));
console.log(cons(r.filter(x => x.coldFrontFired), "cold-front fired"));
console.log(cons(r.filter(x => !x.coldFrontFired && x.sigmaFrontal > 0), "cf-not-fired & σ_f>0"));

console.log("\n=== Stake-pile rescue: what >2σ_baseline events are rescued? ===");
const tail2 = r.filter(x => Math.abs(x.err) > 2 * x.stdBaseline);
const rescStack = tail2.filter(x => Math.abs(x.err) <= 2 * x.stdStack).length;
const rescDedup = tail2.filter(x => Math.abs(x.err) <= 2 * x.stdDedup).length;
console.log(`  >2σ_baseline events: ${tail2.length} (${(tail2.length/r.length*100).toFixed(2)}% of all)`);
console.log(`  Rescued by stack:    ${rescStack} (${(rescStack/tail2.length*100).toFixed(0)}%)`);
console.log(`  Rescued by dedup:    ${rescDedup} (${(rescDedup/tail2.length*100).toFixed(0)}%)`);
console.log(`  Lost by dedup vs stack: ${rescStack - rescDedup} events the dedup gives up to recover stake-size on calm-front days`);
