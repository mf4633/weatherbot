// Phase 1 — Offline EM fit of Kalman regime params per city.
//
// State-space model per city (HIGH residuals only):
//   μ_t = μ_{t-1} + w_t,    w_t ~ N(0, σ_walk²)
//   y_t = μ_t + ε_t,        ε_t ~ N(0, σ_obs²)
// where y_t = forecastHighF_t − actualMax_t  (sign matches weather.js residual).
//
// Output: per_city_kalman_params.json keyed by city short code.

import { readFileSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const MODELS = data.models.filter(m => !["jma_seamless", "gem_seamless"].includes(m));
const MIN_DAYS_TO_FIT = 90;
const MAX_EM_ITER = 30;
const EM_TOL = 1e-4;
const P0 = 4.0;             // wide initial-state variance
const SIGMA_WALK_INIT = 0.3;
const SIGMA_OBS_INIT = 1.5;

const fmtCache = {};
function intlFmt(tz) {
  if (!fmtCache[tz]) {
    fmtCache[tz] = {
      date: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }),
    };
  }
  return fmtCache[tz];
}
const localDateStr = (iso, tz) => intlFmt(tz).date.format(new Date(iso));

function buildDailyResiduals(c) {
  const tz = c.meta.tz;
  const obsByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    (obsByDay[localDateStr(ts, tz)] ??= []).push(c.obs.temps[i]);
  }
  const fcByModel = {};
  for (const m of MODELS) {
    const md = c.models[m]; if (!md) continue;
    const byDay = {};
    for (let i = 0; i < md.times.length; i++) {
      const ts = md.times[i] + "Z";
      (byDay[localDateStr(ts, tz)] ??= []).push(md.temps[i]);
    }
    fcByModel[m] = byDay;
  }
  const days = [];
  for (const date of Object.keys(obsByDay).sort()) {
    const obs = obsByDay[date]; if (obs.length < 18) continue;
    const actualMax = Math.max(...obs);
    const modelHighs = [];
    for (const m of MODELS) {
      const dayFc = fcByModel[m]?.[date]; if (!dayFc?.length) continue;
      modelHighs.push(Math.max(...dayFc));
    }
    if (modelHighs.length < 3) continue;
    const forecastHighF = modelHighs.reduce((a,b)=>a+b,0)/modelHighs.length;
    let v = 0; for (const h of modelHighs) v += (h - forecastHighF) ** 2;
    const sd = Math.sqrt(v / Math.max(1, modelHighs.length - 1));
    if (sd > 10) continue;  // unit-mismatch artifact
    days.push({ date, actualMax, forecastHighF, residual: forecastHighF - actualMax });
  }
  return days;
}

function forwardFilter(y, mu0, P0, sigmaWalk, sigmaObs) {
  const T = y.length;
  const muPred = new Array(T), Ppred = new Array(T);
  const muFilt = new Array(T), Pfilt = new Array(T);
  let mu = mu0, P = P0;
  for (let t = 0; t < T; t++) {
    muPred[t] = mu;
    Ppred[t]  = P + sigmaWalk * sigmaWalk;
    const K   = Ppred[t] / (Ppred[t] + sigmaObs * sigmaObs);
    muFilt[t] = muPred[t] + K * (y[t] - muPred[t]);
    Pfilt[t]  = (1 - K) * Ppred[t];
    mu = muFilt[t]; P = Pfilt[t];
  }
  return { muPred, Ppred, muFilt, Pfilt };
}

function smoother(filt, sigmaWalk) {
  const { muPred, Ppred, muFilt, Pfilt } = filt;
  const T = muFilt.length;
  const muSm = new Array(T), Psm = new Array(T), J = new Array(T);
  muSm[T-1] = muFilt[T-1]; Psm[T-1] = Pfilt[T-1];
  for (let t = T-2; t >= 0; t--) {
    J[t]    = Pfilt[t] / Ppred[t+1];
    muSm[t] = muFilt[t] + J[t] * (muSm[t+1] - muPred[t+1]);
    Psm[t]  = Pfilt[t]  + J[t] * (Psm[t+1] - Ppred[t+1]) * J[t];
  }
  return { muSm, Psm, J };
}

function emFit(y, mu0Init) {
  let sigmaWalk = SIGMA_WALK_INIT;
  let sigmaObs = SIGMA_OBS_INIT;
  let muInitSmoother = mu0Init;
  let iterUsed = MAX_EM_ITER;
  let finalFilt = null;
  for (let it = 0; it < MAX_EM_ITER; it++) {
    const filt = forwardFilter(y, muInitSmoother, P0, sigmaWalk, sigmaObs);
    const sm = smoother(filt, sigmaWalk);
    let sumObs = 0;
    for (let t = 0; t < y.length; t++) sumObs += (y[t] - sm.muSm[t]) ** 2 + sm.Psm[t];
    const newObs = Math.sqrt(sumObs / y.length);
    let sumWalk = 0;
    for (let t = 1; t < y.length; t++) {
      const dMu = sm.muSm[t] - sm.muSm[t-1];
      const cov = sm.J[t-1] * sm.Psm[t];
      sumWalk += dMu * dMu + sm.Psm[t-1] + sm.Psm[t] - 2 * cov;
    }
    const newWalk = Math.sqrt(sumWalk / Math.max(1, y.length - 1));
    const ds = Math.abs(newObs - sigmaObs) + Math.abs(newWalk - sigmaWalk);
    sigmaObs = newObs; sigmaWalk = newWalk;
    muInitSmoother = sm.muSm[0];
    finalFilt = filt;
    if (ds < EM_TOL) { iterUsed = it + 1; break; }
  }
  // Production seed: the filter's state at end of training data — best current
  // estimate of the regime bias. NOT the smoother's μ_0 (which is the inferred
  // state 5y ago and is contaminated by early-history unit-mismatch artifacts;
  // NYC fit to −10.81°F using the smoother estimate, vs ~0 for the current filter
  // state). When weather.js / logger.js boots with no blob state, this is the
  // initial (μ, P) the Kalman filter starts from.
  const T = y.length;
  return {
    sigmaWalk, sigmaObs,
    muSeed: finalFilt.muFilt[T-1],
    pSeed:  finalFilt.Pfilt[T-1],
    iterUsed,
  };
}

const out = {};
const summary = [];
for (const [name, c] of Object.entries(data.cities)) {
  const days = buildDailyResiduals(c);
  if (days.length < MIN_DAYS_TO_FIT) {
    console.log(`  ${name}: SKIP (${days.length} days < ${MIN_DAYS_TO_FIT})`);
    continue;
  }
  const y = days.map(d => d.residual);
  const yMean = y.reduce((a,b)=>a+b,0) / y.length;
  const fit = emFit(y, yMean);
  out[name] = {
    sigma_walk: Number(fit.sigmaWalk.toFixed(4)),
    sigma_obs:  Number(fit.sigmaObs.toFixed(4)),
    mu_seed:    Number(fit.muSeed.toFixed(4)),
    p_seed:     Number(fit.pSeed.toFixed(4)),
    n_days:     days.length,
    em_iters:   fit.iterUsed,
    date_range: `${days[0].date}..${days[days.length-1].date}`,
    fitted_at:  new Date().toISOString().slice(0, 10),
  };
  summary.push({ name, ...out[name], y_mean: Number(yMean.toFixed(3)) });
  console.log(`  ${name.padEnd(5)}  n=${String(days.length).padStart(4)}  σ_walk=${fit.sigmaWalk.toFixed(3)}  σ_obs=${fit.sigmaObs.toFixed(3)}  μ_seed=${fit.muSeed.toFixed(2)}  P_seed=${fit.pSeed.toFixed(3)}  EM_it=${fit.iterUsed}`);
}

writeFileSync("per_city_kalman_params.json", JSON.stringify(out, null, 2));
console.log(`\nWrote per_city_kalman_params.json with ${Object.keys(out).length} cities`);

// Print params table grouped by climate region for sanity check
console.log("\nFitted params by city (sorted by σ_walk):");
summary.sort((a, b) => b.sigma_walk - a.sigma_walk);
console.log("  city    σ_walk   σ_obs   K_ss    n     ȳ");
for (const s of summary) {
  // Steady-state Kalman gain: K_ss solves K = (P+σw²)/(P+σw²+σo²) with P = (1-K)(P+σw²)
  // → P_ss² = σw²·σo² / (σw² + σo²·... simplified: K_ss = (σw² + √(σw⁴ + 4σw²σo²)) / (2σo² + σw² + √(σw⁴ + 4σw²σo²))
  // Simpler: just simulate to steady state.
  let P = P0;
  for (let i = 0; i < 200; i++) {
    const Pp = P + s.sigma_walk * s.sigma_walk;
    const K = Pp / (Pp + s.sigma_obs * s.sigma_obs);
    P = (1 - K) * Pp;
  }
  const Kss = (P + s.sigma_walk * s.sigma_walk) / (P + s.sigma_walk * s.sigma_walk + s.sigma_obs * s.sigma_obs);
  console.log(`  ${s.name.padEnd(5)}  ${s.sigma_walk.toFixed(3)}   ${s.sigma_obs.toFixed(3)}   ${Kss.toFixed(3)}   ${String(s.n_days).padStart(4)}  ${s.y_mean.toFixed(2)}`);
}
