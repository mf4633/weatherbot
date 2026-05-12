// Phase 1 — A/B backtest: Kalman regime correction vs current heuristic.
//
// Causal one-step comparison across all 20 cities. Both methods use the same baseline
// prediction (forecastHighF, raw ensemble mean) and apply a regime correction. We
// compare the residual AFTER correction (y_t − correction_t).
//
//   Heuristic: correction = damping × residual_7d_{t-1}  (using PAST data only)
//              damping = 0.6 if |3d|>1.5°F AND sign(3d)==sign(7d), else 0.3
//              Floor: skip if |residual_7d| < 0.5°F (matches weather.js REGIME_FLOOR_F)
//   Kalman:    correction = μ_t|t-1  (forward filter, predict step, using PAST data)
//              Params per city from per_city_kalman_params.json
//              σ contribution: P_t|t-1 (added in quadrature to other σ sources)
//
// Burn-in: skip first 30 days per city for RMSE computation.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const params = JSON.parse(readFileSync("per_city_kalman_params.json", "utf-8"));
const MODELS = data.models.filter(m => !["jma_seamless", "gem_seamless"].includes(m));
const BURN_IN = 30;
const REGIME_DAMPING = 0.3;
const REGIME_DAMPING_ADAPTIVE = 0.6;
const REGIME_CHANGE_THRESHOLD_F = 1.5;
const REGIME_FLOOR_F = 0.5;
const P0 = 4.0;

const fmtCache = {};
function intlFmt(tz) {
  if (!fmtCache[tz]) fmtCache[tz] = {
    date: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }),
  };
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
    if (sd > 10) continue;
    days.push({ date, actualMax, forecastHighF, residual: forecastHighF - actualMax, sigmaEnsemble: sd });
  }
  return days;
}

class Stats {
  constructor() { this.n = 0; this.sumSq = 0; this.sum = 0; this.absSum = 0; }
  add(err) { this.n++; this.sumSq += err*err; this.sum += err; this.absSum += Math.abs(err); }
  rmse() { return this.n ? Math.sqrt(this.sumSq / this.n) : 0; }
  bias() { return this.n ? this.sum / this.n : 0; }
  mae()  { return this.n ? this.absSum / this.n : 0; }
}

// Aggregated across all cities.
const overall = { raw: new Stats(), heur: new Stats(), kal: new Stats() };
const regime  = { raw: new Stats(), heur: new Stats(), kal: new Stats() };  // |y_t|>1.5°F
const sustainedRegime = { raw: new Stats(), heur: new Stats(), kal: new Stats() };  // 3+ same-sign |y|>1.5
const quiet   = { raw: new Stats(), heur: new Stats(), kal: new Stats() };  // |y_t|<0.5°F
const correctionMag = { heur: [], kal: [] };  // magnitudes of corrections applied on regime days

const perCity = [];

for (const [name, c] of Object.entries(data.cities)) {
  const p = params[name];
  if (!p) { console.log(`  ${name}: SKIP (no fitted params)`); continue; }
  const days = buildDailyResiduals(c);
  if (days.length < BURN_IN + 30) continue;
  const y = days.map(d => d.residual);

  // Run Kalman forward filter using SEASONAL fitted params (cold = Oct-Mar, warm
  // = Apr-Sep). Picks (σ_walk, σ_obs) per day by month of `days[t].date`.
  function seasonalSig(date) {
    const m = parseInt(date.slice(5, 7), 10);
    const cold = (m >= 10 || m <= 3);
    return cold
      ? { sw: p.sigma_walk_cold, so: p.sigma_obs_cold }
      : { sw: p.sigma_walk_warm, so: p.sigma_obs_warm };
  }
  let mu = p.mu_seed, P = P0;
  const muPred = new Array(y.length), Ppred = new Array(y.length);
  for (let t = 0; t < y.length; t++) {
    const ss = seasonalSig(days[t].date);
    muPred[t] = mu;
    Ppred[t]  = P + ss.sw * ss.sw;
    const K   = Ppred[t] / (Ppred[t] + ss.so * ss.so);
    mu = muPred[t] + K * (y[t] - muPred[t]);
    P  = (1 - K) * Ppred[t];
  }
  // Heuristic: 7d and 3d rolling means (causal).
  const cityStats = { raw: new Stats(), heur: new Stats(), kal: new Stats() };
  const cityRegime = { heur: new Stats(), kal: new Stats() };
  let sustainedRun = 0, sustainedSign = 0;
  for (let t = BURN_IN; t < y.length; t++) {
    // Causal: use observations 0..t-1 to predict for day t.
    const w7 = y.slice(Math.max(0, t-7), t);
    const w3 = y.slice(Math.max(0, t-3), t);
    if (!w7.length) continue;
    const r7 = w7.reduce((a,b)=>a+b,0) / w7.length;
    const r3 = w3.length ? w3.reduce((a,b)=>a+b,0) / w3.length : 0;
    const adaptive = w3.length >= 3 && Math.abs(r3) > REGIME_CHANGE_THRESHOLD_F && Math.sign(r3) === Math.sign(r7);
    const damping = adaptive ? REGIME_DAMPING_ADAPTIVE : REGIME_DAMPING;
    const heurCorr = Math.abs(r7) > REGIME_FLOOR_F ? damping * r7 : 0;
    const kalCorr  = muPred[t];

    const yRaw  = y[t];
    const yHeur = y[t] - heurCorr;
    const yKal  = y[t] - kalCorr;

    cityStats.raw.add(yRaw); cityStats.heur.add(yHeur); cityStats.kal.add(yKal);
    overall.raw.add(yRaw); overall.heur.add(yHeur); overall.kal.add(yKal);
    if (Math.abs(yRaw) > 1.5) {
      regime.raw.add(yRaw); regime.heur.add(yHeur); regime.kal.add(yKal);
      cityRegime.heur.add(yHeur); cityRegime.kal.add(yKal);
      correctionMag.heur.push(Math.abs(heurCorr));
      correctionMag.kal.push(Math.abs(kalCorr));
    } else if (Math.abs(yRaw) < 0.5) {
      quiet.raw.add(yRaw); quiet.heur.add(yHeur); quiet.kal.add(yKal);
    }
    // Sustained regime tracker
    const sign = Math.sign(yRaw);
    if (Math.abs(yRaw) > 1.5 && sign === sustainedSign && sign !== 0) {
      sustainedRun++;
    } else {
      sustainedRun = (Math.abs(yRaw) > 1.5 && sign !== 0) ? 1 : 0;
      sustainedSign = sign;
    }
    if (sustainedRun >= 3) {
      sustainedRegime.raw.add(yRaw);
      sustainedRegime.heur.add(yHeur);
      sustainedRegime.kal.add(yKal);
    }
  }
  perCity.push({
    name,
    n: cityStats.raw.n,
    raw: cityStats.raw.rmse(),
    heur: cityStats.heur.rmse(),
    kal:  cityStats.kal.rmse(),
    regimeHeur: cityRegime.heur.rmse(),
    regimeKal:  cityRegime.kal.rmse(),
    regimeN:    cityRegime.heur.n
  });
}

function report(label, group) {
  console.log(`\n[${label}] n=${group.raw.n}`);
  console.log(`  RAW:        RMSE=${group.raw.rmse().toFixed(3)}  bias=${group.raw.bias().toFixed(3)}  MAE=${group.raw.mae().toFixed(3)}`);
  console.log(`  HEURISTIC:  RMSE=${group.heur.rmse().toFixed(3)}  bias=${group.heur.bias().toFixed(3)}  MAE=${group.heur.mae().toFixed(3)}`);
  console.log(`  KALMAN:     RMSE=${group.kal.rmse().toFixed(3)}  bias=${group.kal.bias().toFixed(3)}  MAE=${group.kal.mae().toFixed(3)}`);
  const delta = group.kal.rmse() - group.heur.rmse();
  console.log(`  Δ(Kal−Heur) RMSE: ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}°F`);
}

console.log("=== Aggregated across 20 cities ===");
report("OVERALL (all days)", overall);
report("REGIME (|y_t|>1.5°F)", regime);
report("SUSTAINED REGIME (3+ same-sign |y|>1.5)", sustainedRegime);
report("QUIET (|y_t|<0.5°F)", quiet);

console.log(`\n=== Correction magnitude on regime days (n=${correctionMag.heur.length}) ===`);
const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
const med = a => { const s = [...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
console.log(`  Heuristic |correction|:  mean=${mean(correctionMag.heur).toFixed(2)}°F  median=${med(correctionMag.heur).toFixed(2)}°F`);
console.log(`  Kalman    |correction|:  mean=${mean(correctionMag.kal).toFixed(2)}°F  median=${med(correctionMag.kal).toFixed(2)}°F`);

console.log(`\n=== Per-city RMSE (sorted by ΔRMSE Kal vs Heur) ===`);
perCity.sort((a,b) => (a.kal-a.heur) - (b.kal-b.heur));
console.log(`  city    n     raw    heur    kal    Δ(K-H)   regime_n  regime_heur  regime_kal  regime_Δ`);
for (const p of perCity) {
  const delta = p.kal - p.heur;
  const regimeDelta = p.regimeKal - p.regimeHeur;
  console.log(`  ${p.name.padEnd(5)}  ${String(p.n).padStart(4)}  ${p.raw.toFixed(2)}   ${p.heur.toFixed(2)}   ${p.kal.toFixed(2)}   ${delta>=0?"+":""}${delta.toFixed(3)}    ${String(p.regimeN).padStart(4)}      ${p.regimeHeur.toFixed(2)}         ${p.regimeKal.toFixed(2)}       ${regimeDelta>=0?"+":""}${regimeDelta.toFixed(3)}`);
}

// Final summary
console.log(`\n=== HEADLINE ===`);
const overallDelta = overall.kal.rmse() - overall.heur.rmse();
const regimeDelta = regime.kal.rmse() - regime.heur.rmse();
const sustainedDelta = sustainedRegime.kal.rmse() - sustainedRegime.heur.rmse();
console.log(`  Overall ΔRMSE (Kalman − Heuristic):              ${overallDelta>=0?"+":""}${overallDelta.toFixed(3)}°F  (n=${overall.raw.n})`);
console.log(`  Regime-day ΔRMSE (|y|>1.5°F):                    ${regimeDelta>=0?"+":""}${regimeDelta.toFixed(3)}°F  (n=${regime.raw.n}, ${(regime.raw.n/overall.raw.n*100).toFixed(1)}% of days)`);
console.log(`  Sustained-regime ΔRMSE (3+ consec same-sign):    ${sustainedDelta>=0?"+":""}${sustainedDelta.toFixed(3)}°F  (n=${sustainedRegime.raw.n}, ${(sustainedRegime.raw.n/overall.raw.n*100).toFixed(1)}% of days)`);
console.log(`  Correction magnitude on regime days:             Kalman ${mean(correctionMag.kal).toFixed(2)}°F vs Heuristic ${mean(correctionMag.heur).toFixed(2)}°F (${(mean(correctionMag.kal)/mean(correctionMag.heur)).toFixed(1)}× more aggressive)`);
const winners = perCity.filter(p => p.kal < p.heur).length;
console.log(`  Per-city wins: Kalman beats heuristic in ${winners}/${perCity.length} cities on overall RMSE`);
const regimeWinners = perCity.filter(p => p.regimeKal < p.regimeHeur).length;
console.log(`                  Kalman beats heuristic in ${regimeWinners}/${perCity.length} cities on regime-day RMSE`);
