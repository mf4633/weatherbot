// Production HIGH uses STACK (HIGH_DEDUP_ALPHA=1.0 in weather.js). Warm-front-fired
// days are intrinsically noisy (RMSE 1.64°F vs 0.95°F on calm days), so the σ_frontal
// contribution is genuinely informative even when warm-front fires — pure dedup cost
// 26pp tail-risk regression on the strong-frontal subset, much worse than LOW's 5pp.
// Asymmetric to LOW (which dedups) — see backtest_sigma_frontal.js for that side's
// policy. The dedup-vs-stack choice is calibrated per side, proportional to the
// measured tail-risk cost of dedup.
//
// HIGH-market analog of backtest_sigma_frontal.js. Verifies that:
//   1. The new warm-front branch fires when ensemble's remaining-day peak is
//      materially above maxSoFar (mirror of cold-front for LOW).
//   2. σ_frontal dedup behaves correctly: skipped when warm-front branch
//      fires, applied as fallback when it doesn't.
//
// Same A/B/C structure: baseline (no σ_frontal at all) / stack (σ_frontal
// always added) / dedup (σ_frontal added only when warm-front doesn't fire).

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const MODELS = data.models.filter(m => !["jma_seamless", "gem_seamless"].includes(m));
const PREDICTION_HOURS = [9, 12, 15, 18];  // afternoon — when peak-realized matters
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

// HIGH analog of hoursToTrough — hours until typical peak (~3 PM local).
function hoursToPeak(localHr) {
  if (localHr >= 16) return 0;
  return Math.max(0, 15 - localHr);
}

function computeFrontalSigma(obsBefore, ensembleHourly, predHr) {
  let sigmaForecast = 0, sigmaObs = 0;
  if (ensembleHourly?.length) {
    const fwd = ensembleHourly.filter(p => p.localHr > predHr && p.localHr <= predHr + 3);
    if (fwd.length >= 2) {
      const temps = fwd.map(p => p.tempF);
      const range = Math.max(...temps) - Math.min(...temps);
      if (range > 2.0) sigmaForecast = Math.min(1.5, (range - 2.0) * 0.5);
    }
  }
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
  const { hrsToPeak, maxSoFar, currentTemp, modelForecastHighs, modelForecastNows,
          modelRemainingPeaks, sigmaFrontal } = ctx;
  let sumW = 0, fhAccum = 0, fnAccum = 0, fnW = 0;
  const peaks = [];
  for (const m of MODELS) {
    const w = 1 / MODELS.length;
    if (modelForecastHighs[m] != null) {
      sumW += w;
      fhAccum += w * modelForecastHighs[m];
      peaks.push(modelForecastHighs[m]);
    }
    if (modelForecastNows[m] != null) { fnW += w; fnAccum += w * modelForecastNows[m]; }
  }
  if (sumW <= 0 || maxSoFar == null) return null;
  const forecastHigh = fhAccum / sumW;
  const forecastNow = fnW > 0 ? fnAccum / fnW : null;
  const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
  const sigmaEns = peaks.length > 1
    ? Math.sqrt(peaks.reduce((a, x) => a + (x - forecastHigh) ** 2, 0) / (peaks.length - 1))
    : 0.8;
  const SIGMA_RES = 1.0;  // HIGH is harder than LOW

  const priorMean = forecastHigh + 0.4 * bias;
  let mean = Math.max(maxSoFar, priorMean);
  let baseStd;
  if (hrsToPeak < 1) {
    baseStd = Math.sqrt(SIGMA_RES * SIGMA_RES + (0.3 * hrsToPeak) ** 2);
    mean = maxSoFar + 0.2 + 0.3 * hrsToPeak;  // peak-realized
  } else {
    baseStd = Math.sqrt(sigmaEns * sigmaEns + SIGMA_RES * SIGMA_RES);
  }

  // Warm-front check (mirror of cold-front for LOW): if ensemble's remaining-day
  // peak is materially above maxSoFar, day's actual max will likely be that
  // future value.
  let availRem = 0, remAccum = 0;
  for (const m of MODELS) {
    if (modelRemainingPeaks && modelRemainingPeaks[m] != null) {
      availRem += 1 / MODELS.length;
      remAccum += (1 / MODELS.length) * modelRemainingPeaks[m];
    }
  }
  const remPeak = availRem > 0 ? remAccum / availRem : null;
  let warmFrontFired = false, meanFinal = mean, postWfStd = baseStd;
  if (remPeak != null && remPeak > maxSoFar + 0.5 && remPeak > mean) {
    meanFinal = remPeak;
    postWfStd = Math.max(baseStd, 1.5);
    warmFrontFired = true;
  }

  const stdBaseline = postWfStd;  // no σ_frontal at all
  const stdStack    = Math.sqrt(postWfStd * postWfStd + sigmaFrontal * sigmaFrontal);
  const stdDedup    = warmFrontFired
                      ? postWfStd
                      : Math.sqrt(postWfStd * postWfStd + sigmaFrontal * sigmaFrontal);

  return { mean: meanFinal, stdBaseline, stdStack, stdDedup,
           sigmaFrontal, warmFrontFired };
}

function evaluate() {
  const out = [];
  for (const [name, c] of Object.entries(cityProcessed)) {
    for (const [date, dayObs] of Object.entries(c.obsByDay)) {
      if (dayObs.length < 12) continue;
      const actualMax = Math.max(...dayObs.map(o => o.tempF));
      const modelHourly = {};
      for (const m of MODELS) modelHourly[m] = c.fcByModel[m]?.[date] || [];
      const ensembleHourly = [];
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
        const maxSoFar = Math.max(...obsBefore.map(o => o.tempF));
        const currentTemp = obsBefore[obsBefore.length - 1].tempF;
        const modelForecastHighs = {};
        for (const m of MODELS) {
          modelForecastHighs[m] = modelHourly[m].length
            ? Math.max(...modelHourly[m].map(o => o.tempF)) : null;
        }
        const modelForecastNows = {};
        for (const m of MODELS) {
          const f = modelHourly[m].find(x => x.localHr === predHr);
          if (f) modelForecastNows[m] = f.tempF;
        }
        const modelRemainingPeaks = {};
        for (const m of MODELS) {
          const future = modelHourly[m].filter(f => f.localHr > predHr);
          modelRemainingPeaks[m] = future.length ? Math.max(...future.map(f => f.tempF)) : null;
        }
        const sigmaFrontal = computeFrontalSigma(obsBefore, ensembleHourly, predHr);
        const hrs = hoursToPeak(predHr);
        const p = predict({ hrsToPeak: hrs, maxSoFar, currentTemp,
                            modelForecastHighs, modelForecastNows,
                            modelRemainingPeaks, sigmaFrontal });
        if (!p) continue;
        const err = p.mean - actualMax;
        out.push({ city: name, date, predHr, sigmaFrontal, warmFrontFired: p.warmFrontFired,
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
    sigmaBaseline: rs.reduce((a, x) => a + x.stdBaseline, 0) / n,
    sigmaStack:    rs.reduce((a, x) => a + x.stdStack, 0) / n,
    sigmaDedup:    rs.reduce((a, x) => a + x.stdDedup, 0) / n,
    cov68_baseline: cov("stdBaseline", 1),
    cov68_stack:    cov("stdStack", 1),
    cov68_dedup:    cov("stdDedup", 1),
  };
}
function row(s) {
  if (!s.n) return `${s.label.padEnd(28)} (no data)`;
  return `${s.label.padEnd(28)} n=${String(s.n).padStart(6)}  RMSE=${s.rmse.toFixed(2)}  `
       + `σ̄ b/s/d=${s.sigmaBaseline.toFixed(2)}/${s.sigmaStack.toFixed(2)}/${s.sigmaDedup.toFixed(2)}  `
       + `68%=${(s.cov68_baseline*100).toFixed(0)}/${(s.cov68_stack*100).toFixed(0)}/${(s.cov68_dedup*100).toFixed(0)}`;
}

console.log("Running A/B/C...");
const r = evaluate();
console.log(`Total predictions: ${r.length}\n`);

console.log("=== Overall ===");
console.log(row(summarize(r, "all")));

console.log("\n=== Dedup verification: σ_frontal application by warm-front state ===");
console.log(row(summarize(r.filter(x => x.warmFrontFired), "warm-front fired")));
console.log(row(summarize(r.filter(x => !x.warmFrontFired), "warm-front NOT fired")));
console.log(row(summarize(r.filter(x => !x.warmFrontFired && x.sigmaFrontal > 0), "wf-not-fired & σ_f>0")));

console.log("\n=== Sliced by σ_frontal magnitude ===");
console.log(row(summarize(r.filter(x => x.sigmaFrontal === 0), "calm σ_f=0")));
console.log(row(summarize(r.filter(x => x.sigmaFrontal > 0 && x.sigmaFrontal <= 0.5), "minor 0<σ_f≤0.5")));
console.log(row(summarize(r.filter(x => x.sigmaFrontal > 0.5 && x.sigmaFrontal <= 1.0), "moderate 0.5<σ_f≤1.0")));
console.log(row(summarize(r.filter(x => x.sigmaFrontal > 1.0), "strong σ_f>1.0")));

console.log("\n=== Tail-risk: P(|err| > 2σ) ===");
function tailRate(rs, key) { return rs.filter(x => Math.abs(x.err) > 2 * x[key]).length / rs.length; }
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
console.log(fmtTail(r.filter(x => x.sigmaFrontal > 0.5 && x.sigmaFrontal <= 1.0), "moderate 0.5<σ_f≤1.0"));
console.log(fmtTail(r.filter(x => x.sigmaFrontal > 1.0), "strong σ_f>1.0"));

console.log("\n=== Conservatism σ̄/RMSE per policy ===");
function cons(rs, label) {
  if (!rs.length) return `${label} (no data)`;
  const rmse = Math.sqrt(rs.reduce((a,x)=>a+x.err*x.err,0)/rs.length);
  const sB = rs.reduce((a,x)=>a+x.stdBaseline,0)/rs.length;
  const sS = rs.reduce((a,x)=>a+x.stdStack,0)/rs.length;
  const sD = rs.reduce((a,x)=>a+x.stdDedup,0)/rs.length;
  return `${label.padEnd(28)} RMSE=${rmse.toFixed(2)}  σ̄/RMSE b=${(sB/rmse).toFixed(2)} s=${(sS/rmse).toFixed(2)} d=${(sD/rmse).toFixed(2)}`;
}
console.log(cons(r, "all"));
console.log(cons(r.filter(x => x.warmFrontFired), "warm-front fired"));
console.log(cons(r.filter(x => !x.warmFrontFired && x.sigmaFrontal > 0), "wf-not-fired & σ_f>0"));
