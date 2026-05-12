// Proof-of-concept: Kalman regime variable for PHX, compared to current
// 7d-rolling-mean heuristic.
//
// State-space model:
//   μ_t = μ_{t-1} + w_t,    w_t ~ N(0, σ_walk²)         [hidden bias state]
//   y_t = μ_t + ε_t,        ε_t ~ N(0, σ_obs²)          [observed residual]
//
// y_t = predicted_t - actual_t, using forecastHighF (raw ensemble mean, no
// regime correction) as the prediction so the Kalman state μ_t captures
// "what regime correction SHOULD be applied" — analogous to what weather.js
// computes via the rolling-mean heuristic + per-city offset.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const MODELS = data.models.filter(m => !["jma_seamless", "gem_seamless"].includes(m));
const CITY = "PHX";

const fmtCache = {};
function intlFmt(tz) {
  if (!fmtCache[tz]) {
    fmtCache[tz] = {
      hour: new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }),
      date: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }),
    };
  }
  return fmtCache[tz];
}
const localHour = (iso, tz) => parseInt(intlFmt(tz).hour.format(new Date(iso)), 10);
const localDateStr = (iso, tz) => intlFmt(tz).date.format(new Date(iso));

const c = data.cities[CITY];
if (!c) { console.error(`City ${CITY} not in data_models.json`); process.exit(1); }
const tz = c.meta.tz;

// Build daily (date, actualMax, forecastHighF) pairs.
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
  const obs = obsByDay[date];
  if (obs.length < 18) continue;
  const actualMax = Math.max(...obs);
  const modelHighs = [];
  for (const m of MODELS) {
    const dayFc = fcByModel[m]?.[date]; if (!dayFc?.length) continue;
    modelHighs.push(Math.max(...dayFc));
  }
  if (modelHighs.length < 3) continue;
  const forecastHighF = modelHighs.reduce((a,b)=>a+b,0)/modelHighs.length;
  // Skip unit-mismatch artifacts.
  let v = 0; for (const h of modelHighs) v += (h - forecastHighF)**2;
  const sd = Math.sqrt(v / Math.max(1, modelHighs.length - 1));
  if (sd > 10) continue;
  const residual = forecastHighF - actualMax;  // weather.js sign: positive = over-predict
  days.push({ date, actualMax, forecastHighF, residual });
}
console.log(`PHX days with valid forecast+obs: ${days.length}  (range ${days[0].date} → ${days[days.length-1].date})`);

const y = days.map(d => d.residual);
const T = y.length;

// --- Kalman forward filter + RTS smoother ---
function forwardFilter(y, mu0, P0, sigmaWalk, sigmaObs) {
  const muPred = new Array(T), Ppred = new Array(T);
  const muFilt = new Array(T), Pfilt = new Array(T);
  const K = new Array(T);
  let mu = mu0, P = P0;
  for (let t = 0; t < T; t++) {
    // Predict
    muPred[t] = mu;
    Ppred[t]  = P + sigmaWalk * sigmaWalk;
    // Update
    K[t]      = Ppred[t] / (Ppred[t] + sigmaObs * sigmaObs);
    muFilt[t] = muPred[t] + K[t] * (y[t] - muPred[t]);
    Pfilt[t]  = (1 - K[t]) * Ppred[t];
    mu = muFilt[t]; P = Pfilt[t];
  }
  return { muPred, Ppred, muFilt, Pfilt, K };
}
function smoother(filt, sigmaWalk) {
  const { muPred, Ppred, muFilt, Pfilt } = filt;
  const muSm = new Array(T), Psm = new Array(T), J = new Array(T);
  muSm[T-1] = muFilt[T-1]; Psm[T-1] = Pfilt[T-1];
  for (let t = T-2; t >= 0; t--) {
    J[t]    = Pfilt[t] / Ppred[t+1];
    muSm[t] = muFilt[t] + J[t] * (muSm[t+1] - muPred[t+1]);
    Psm[t]  = Pfilt[t]  + J[t] * (Psm[t+1] - Ppred[t+1]) * J[t];
  }
  return { muSm, Psm, J };
}

// EM: 10 iterations starting from reasonable defaults.
let sigmaWalk = 0.3, sigmaObs = 1.5;
const mu0 = 0, P0 = 4.0;  // wide prior
for (let it = 0; it < 12; it++) {
  const filt = forwardFilter(y, mu0, P0, sigmaWalk, sigmaObs);
  const sm = smoother(filt, sigmaWalk);
  // M-step for σ_obs²
  let sumObs = 0;
  for (let t = 0; t < T; t++) sumObs += (y[t] - sm.muSm[t]) ** 2 + sm.Psm[t];
  const newObs = Math.sqrt(sumObs / T);
  // M-step for σ_walk² (lag-1 covariance term included)
  let sumWalk = 0;
  for (let t = 1; t < T; t++) {
    const dMu = sm.muSm[t] - sm.muSm[t-1];
    const cov = sm.J[t-1] * sm.Psm[t];
    sumWalk += dMu * dMu + sm.Psm[t-1] + sm.Psm[t] - 2 * cov;
  }
  const newWalk = Math.sqrt(sumWalk / Math.max(1, T - 1));
  const ds = Math.abs(newObs - sigmaObs) + Math.abs(newWalk - sigmaWalk);
  sigmaObs = newObs; sigmaWalk = newWalk;
  if (it < 4 || it === 11) {
    console.log(`  EM it=${it}: σ_walk=${sigmaWalk.toFixed(3)}  σ_obs=${sigmaObs.toFixed(3)}  Δ=${ds.toFixed(5)}`);
  }
  if (ds < 1e-4) { console.log(`  converged at it=${it}`); break; }
}
console.log(`\nFitted PHX parameters: σ_walk=${sigmaWalk.toFixed(3)}°F   σ_obs=${sigmaObs.toFixed(3)}°F`);

// Final forward filter with fitted params.
const filtFinal = forwardFilter(y, mu0, P0, sigmaWalk, sigmaObs);

// 7d and 3d rolling means (causal — only past data, like weather.js).
const roll = (arr, w) => arr.map((_, i) => {
  const slice = arr.slice(Math.max(0, i - w + 1), i + 1);
  return slice.reduce((a,b)=>a+b,0) / slice.length;
});
const roll7 = roll(y, 7);
const roll3 = roll(y, 3);

// Per-day "effective damping" — what fraction of the raw signal does each method
// pull into the priorMean correction?
//   Kalman: K_t (the gain) IS the effective damping on the most recent observation.
//   7d-mean: 1/7 ≈ 0.143 per day (uniform weight). Then multiplied by REGIME_DAMPING=0.3
//            in weather.js → effective damping per recent day ≈ 0.143 × 0.3 = 0.043.
//            Or, when adaptive fires (|3d|>1.5), 0.143 × 0.6 = 0.086.
// We'll compare the cumulative "shift applied" instead — that's cleaner.

console.log(`\nLast 30 days of PHX — μ_t trajectory comparison:`);
console.log(`  date         y_t      Kalman_μ  ±√P     7d_mean   3d_mean   K_t   adaptive?`);
for (let t = Math.max(0, T - 30); t < T; t++) {
  const d = days[t];
  const r3 = roll3[t], r7 = roll7[t];
  const adaptive = Math.abs(r3) > 1.5 && Math.sign(r3) === Math.sign(r7);
  const mu = filtFinal.muFilt[t];
  const sd = Math.sqrt(filtFinal.Pfilt[t]);
  console.log(`  ${d.date}  ${y[t].toFixed(2).padStart(6)}  ${mu.toFixed(2).padStart(7)}  ±${sd.toFixed(2)}   ${r7.toFixed(2).padStart(6)}  ${r3.toFixed(2).padStart(6)}  ${filtFinal.K[t].toFixed(3)}  ${adaptive ? "ADAPT" : ""}`);
}

// Effective bias correction applied by each method (what gets subtracted from priorMean).
// Kalman: μ_t directly.
// Heuristic: REGIME_DAMPING × roll7[t] (or REGIME_DAMPING_ADAPTIVE if adaptive fires).
console.log(`\n--- Effective bias correction (°F subtracted from priorMean) ---`);
console.log(`  date         y_t   actual_residual_was   Kalman_correction   heuristic_correction`);
for (let t = Math.max(0, T - 15); t < T; t++) {
  const d = days[t];
  const r3 = roll3[t], r7 = roll7[t];
  const adaptive = Math.abs(r3) > 1.5 && Math.sign(r3) === Math.sign(r7);
  const damping = adaptive ? 0.6 : 0.3;
  const heuristicCorr = Math.abs(r7) > 0.5 ? damping * r7 : 0;
  const kalmanCorr = filtFinal.muFilt[t];
  console.log(`  ${d.date}  y=${y[t].toFixed(2).padStart(6)}  actual=${d.actualMax}  fc=${d.forecastHighF.toFixed(1)}   K=${kalmanCorr.toFixed(2).padStart(6)}    H=${heuristicCorr.toFixed(2).padStart(6)} ${adaptive ? "[adaptive]" : ""}`);
}

// Overall RMSE of corrected predictions:
//   y_t = predicted_t - actual_t (raw)
//   y_corrected = (predicted_t - correction_t) - actual_t = y_t - correction_t
// Lower |y_corrected| = better.
let ssK = 0, ssH = 0, ssRaw = 0;
let countLate = 0;
for (let t = 7; t < T; t++) {  // skip burn-in
  const r3 = roll3[t-1], r7 = roll7[t-1];  // use PRIOR day's rolling — causal
  const adaptive = Math.abs(r3) > 1.5 && Math.sign(r3) === Math.sign(r7);
  const damping = adaptive ? 0.6 : 0.3;
  const heuristicCorr = Math.abs(r7) > 0.5 ? damping * r7 : 0;
  // Kalman: use one-step prediction μ_t|t-1 (causal, like trading day open)
  const kalmanCorr = filtFinal.muPred[t];
  const yK = y[t] - kalmanCorr;
  const yH = y[t] - heuristicCorr;
  ssK += yK * yK;
  ssH += yH * yH;
  ssRaw += y[t] * y[t];
  countLate++;
}
const rmseK = Math.sqrt(ssK / countLate);
const rmseH = Math.sqrt(ssH / countLate);
const rmseRaw = Math.sqrt(ssRaw / countLate);
console.log(`\n--- Causal one-step RMSE of forecast-after-correction (n=${countLate}) ---`);
console.log(`  Raw (no correction):    ${rmseRaw.toFixed(3)}°F`);
console.log(`  Heuristic (7d × damp):  ${rmseH.toFixed(3)}°F`);
console.log(`  Kalman (μ_t|t-1):       ${rmseK.toFixed(3)}°F`);
console.log(`  ΔRMSE (Kalman − Heuristic):  ${(rmseK - rmseH >= 0 ? "+" : "")}${(rmseK - rmseH).toFixed(3)}°F`);

// Regime-shift response: synthetic test. Take a stretch where heuristic struggles and
// see how fast each method picks up the shift.
// Find the longest run of consecutive same-sign |y|>1.5°F days.
let bestStart = -1, bestLen = 0;
let curStart = 0, curLen = 0, curSign = 0;
for (let t = 0; t < T; t++) {
  const sign = Math.sign(y[t]);
  if (Math.abs(y[t]) > 1.5 && sign !== 0 && sign === curSign) {
    curLen++;
  } else {
    if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    curStart = t; curLen = (Math.abs(y[t]) > 1.5 ? 1 : 0); curSign = sign;
  }
}
if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
console.log(`\nLongest sustained regime (|y|>1.5°F same-sign): ${bestLen} days starting ${days[bestStart]?.date}`);
if (bestLen >= 4) {
  console.log(`  Day   y_t     Kalman_μ   7d_mean   K_t`);
  for (let t = Math.max(0, bestStart - 2); t < Math.min(T, bestStart + bestLen + 2); t++) {
    const d = days[t];
    console.log(`  ${d.date}  ${y[t].toFixed(2).padStart(6)}  ${filtFinal.muFilt[t].toFixed(2).padStart(7)}   ${roll7[t].toFixed(2).padStart(6)}  ${filtFinal.K[t].toFixed(3)}`);
  }
}
