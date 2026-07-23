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

// Season classification by month. Cold: Oct-Mar (months 10,11,12,1,2,3). Warm: Apr-Sep.
// Captures the dominant seasonal mode for continental climates where σ_walk differs
// materially between dormant winter/summer (settled patterns) and active shoulder
// (frequent regime shifts at frontal passages).
function seasonOf(date) {
  const month = parseInt(date.slice(5, 7), 10);
  return (month >= 4 && month <= 9) ? "warm" : "cold";
}

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
    const actualMin = Math.min(...obs);
    const modelHighs = [], modelLows = [];
    for (const m of MODELS) {
      const dayFc = fcByModel[m]?.[date]; if (!dayFc?.length) continue;
      modelHighs.push(Math.max(...dayFc));
      modelLows.push(Math.min(...dayFc));
    }
    if (modelHighs.length < 3) continue;
    const forecastHighF = modelHighs.reduce((a,b)=>a+b,0)/modelHighs.length;
    const forecastLowF = modelLows.reduce((a,b)=>a+b,0)/modelLows.length;
    // Unit-mismatch guard — same threshold on HIGH ensemble (catches early-history
    // data quality artifacts; affects both HIGH and LOW the same way).
    let v = 0; for (const h of modelHighs) v += (h - forecastHighF) ** 2;
    const sd = Math.sqrt(v / Math.max(1, modelHighs.length - 1));
    if (sd > 10) continue;
    days.push({
      date, actualMax, actualMin, forecastHighF, forecastLowF,
      high_residual: forecastHighF - actualMax,
      low_residual:  forecastLowF  - actualMin,
      season: seasonOf(date),
    });
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

// Fit per-season σ_walk / σ_obs on a residual series (either HIGH or LOW).
function emFitPerSeason(daysSubset, residualKey, mu0) {
  if (daysSubset.length < 30) return null;
  const y = daysSubset.map(d => d[residualKey]);
  const fit = emFit(y, mu0);
  return { sigmaWalk: fit.sigmaWalk, sigmaObs: fit.sigmaObs, n: daysSubset.length, iters: fit.iterUsed };
}

// Fit a complete per-variable params block: {sigma_walk_cold, sigma_obs_cold,
// sigma_walk_warm, sigma_obs_warm, mu_seed, p_seed}. Used for both HIGH and LOW.
function fitVariable(days, residualKey) {
  const y = days.map(d => d[residualKey]);
  const yMean = y.reduce((a,b)=>a+b,0) / y.length;
  const cold = emFitPerSeason(days.filter(d => d.season === "cold"), residualKey, yMean);
  const warm = emFitPerSeason(days.filter(d => d.season === "warm"), residualKey, yMean);
  const fullFit = emFit(y, yMean);
  return {
    sigma_walk_cold: cold ? Number(cold.sigmaWalk.toFixed(4)) : Number(fullFit.sigmaWalk.toFixed(4)),
    sigma_obs_cold:  cold ? Number(cold.sigmaObs.toFixed(4))  : Number(fullFit.sigmaObs.toFixed(4)),
    sigma_walk_warm: warm ? Number(warm.sigmaWalk.toFixed(4)) : Number(fullFit.sigmaWalk.toFixed(4)),
    sigma_obs_warm:  warm ? Number(warm.sigmaObs.toFixed(4))  : Number(fullFit.sigmaObs.toFixed(4)),
    mu_seed:    Number(fullFit.muSeed.toFixed(4)),
    p_seed:     Number(fullFit.pSeed.toFixed(4)),
    n_cold:     cold ? cold.n : 0,
    n_warm:     warm ? warm.n : 0,
    y_mean:     Number(yMean.toFixed(3)),
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
  const high = fitVariable(days, "high_residual");
  const low  = fitVariable(days, "low_residual");
  out[name] = {
    high, low,
    n_total:    days.length,
    date_range: `${days[0].date}..${days[days.length-1].date}`,
    fitted_at:  new Date().toISOString().slice(0, 10),
  };
  summary.push({ name, high, low });
  console.log(`  ${name.padEnd(5)}  HIGH[cold σw=${high.sigma_walk_cold.toFixed(3)} σo=${high.sigma_obs_cold.toFixed(3)} | warm σw=${high.sigma_walk_warm.toFixed(3)} σo=${high.sigma_obs_warm.toFixed(3)} | μ=${high.mu_seed.toFixed(2)}]  LOW[cold σw=${low.sigma_walk_cold.toFixed(3)} σo=${low.sigma_obs_cold.toFixed(3)} | warm σw=${low.sigma_walk_warm.toFixed(3)} σo=${low.sigma_obs_warm.toFixed(3)} | μ=${low.mu_seed.toFixed(2)}]`);
}

writeFileSync("per_city_kalman_params.json", JSON.stringify(out, null, 2));
console.log(`\nWrote per_city_kalman_params.json with ${Object.keys(out).length} cities`);

// Print summary tables for both variables.
function kssFor(sw, so) {
  let P = P0;
  for (let i = 0; i < 200; i++) {
    const Pp = P + sw * sw;
    const K = Pp / (Pp + so * so);
    P = (1 - K) * Pp;
  }
  return (P + sw * sw) / (P + sw * sw + so * so);
}
function printTable(label, accessor, sortKey) {
  console.log(`\n${label} (sorted by ${sortKey}):`);
  console.log("  city    cold(σw σo K_ss)        warm(σw σo K_ss)         |Δσw|");
  const rows = summary.slice().sort((a, b) => accessor(b)[sortKey] - accessor(a)[sortKey]);
  for (const s of rows) {
    const p = accessor(s);
    const KssCold = kssFor(p.sigma_walk_cold, p.sigma_obs_cold);
    const KssWarm = kssFor(p.sigma_walk_warm, p.sigma_obs_warm);
    const dw = Math.abs(p.sigma_walk_cold - p.sigma_walk_warm);
    console.log(`  ${s.name.padEnd(5)}  ${p.sigma_walk_cold.toFixed(3)} ${p.sigma_obs_cold.toFixed(3)} ${KssCold.toFixed(3)}    ${p.sigma_walk_warm.toFixed(3)} ${p.sigma_obs_warm.toFixed(3)} ${KssWarm.toFixed(3)}     ${dw.toFixed(3)}`);
  }
}
printTable("HIGH-side fitted params", s => s.high, "sigma_walk_warm");
printTable("LOW-side fitted params", s => s.low, "sigma_walk_warm");
