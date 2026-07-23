// A/B backtest of LOW-side Kalman vs no-correction baseline.
//
// Existing weather.js LOW branch has bias-correction + CITY_OFFSETS_LOW but NO
// regime damping (unlike HIGH which has the 7d × damping heuristic). So the
// baseline here is "forecast_low only" and Kalman is the proposed addition.
//
// Causal one-step: forward filter using past LOW residuals only, predict-step
// μ_t|t-1 as the correction applied to today's prediction.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const params = JSON.parse(readFileSync("per_city_kalman_params.json", "utf-8"));
const MODELS = data.models.filter(m => !["jma_seamless", "gem_seamless"].includes(m));
const BURN_IN = 30;
const KALMAN_FLOOR_F = 0.5;
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
    const actualMin = Math.min(...obs);
    const modelHighs = [], modelLows = [];
    for (const m of MODELS) {
      const dayFc = fcByModel[m]?.[date]; if (!dayFc?.length) continue;
      modelHighs.push(Math.max(...dayFc));
      modelLows.push(Math.min(...dayFc));
    }
    if (modelHighs.length < 3) continue;
    const forecastHighF = modelHighs.reduce((a,b)=>a+b,0)/modelHighs.length;
    let v = 0; for (const h of modelHighs) v += (h - forecastHighF) ** 2;
    const sd = Math.sqrt(v / Math.max(1, modelHighs.length - 1));
    if (sd > 10) continue;
    const forecastLowF = modelLows.reduce((a,b)=>a+b,0)/modelLows.length;
    days.push({ date, actualMin, forecastLowF, residual: forecastLowF - actualMin });
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

const overall = { raw: new Stats(), kal: new Stats() };
const regime  = { raw: new Stats(), kal: new Stats() };
const sustainedRegime = { raw: new Stats(), kal: new Stats() };
const quiet   = { raw: new Stats(), kal: new Stats() };
const correctionMag = { kal: [] };
const perCity = [];

for (const [name, c] of Object.entries(data.cities)) {
  const p = params[name]; if (!p?.low) continue;
  const pl = p.low;
  const days = buildDailyResiduals(c);
  if (days.length < BURN_IN + 30) continue;
  const y = days.map(d => d.residual);

  function seasonalSig(date) {
    const m = parseInt(date.slice(5, 7), 10);
    const cold = (m >= 10 || m <= 3);
    return cold
      ? { sw: pl.sigma_walk_cold, so: pl.sigma_obs_cold }
      : { sw: pl.sigma_walk_warm, so: pl.sigma_obs_warm };
  }
  let mu = pl.mu_seed, P = P0;
  const muPred = new Array(y.length);
  for (let t = 0; t < y.length; t++) {
    const ss = seasonalSig(days[t].date);
    muPred[t] = mu;
    const Pp = P + ss.sw * ss.sw;
    const K = Pp / (Pp + ss.so * ss.so);
    mu = muPred[t] + K * (y[t] - muPred[t]);
    P  = (1 - K) * Pp;
  }

  const cityRaw = new Stats(), cityKal = new Stats(), cityRegimeKal = new Stats(), cityRegimeRaw = new Stats();
  let sustainedRun = 0, sustainedSign = 0;
  for (let t = BURN_IN; t < y.length; t++) {
    const yRaw = y[t];
    const kalCorr = Math.abs(muPred[t]) >= KALMAN_FLOOR_F ? muPred[t] : 0;
    const yKal = y[t] - kalCorr;

    cityRaw.add(yRaw); cityKal.add(yKal);
    overall.raw.add(yRaw); overall.kal.add(yKal);
    if (Math.abs(yRaw) > 1.5) {
      regime.raw.add(yRaw); regime.kal.add(yKal);
      cityRegimeRaw.add(yRaw); cityRegimeKal.add(yKal);
      correctionMag.kal.push(Math.abs(kalCorr));
    } else if (Math.abs(yRaw) < 0.5) {
      quiet.raw.add(yRaw); quiet.kal.add(yKal);
    }
    const sign = Math.sign(yRaw);
    if (Math.abs(yRaw) > 1.5 && sign === sustainedSign && sign !== 0) sustainedRun++;
    else { sustainedRun = (Math.abs(yRaw) > 1.5 && sign !== 0) ? 1 : 0; sustainedSign = sign; }
    if (sustainedRun >= 3) {
      sustainedRegime.raw.add(yRaw);
      sustainedRegime.kal.add(yKal);
    }
  }
  perCity.push({
    name, n: cityRaw.n,
    raw: cityRaw.rmse(), kal: cityKal.rmse(),
    regimeRaw: cityRegimeRaw.rmse(), regimeKal: cityRegimeKal.rmse(),
    regimeN: cityRegimeRaw.n,
    muSeed: pl.mu_seed,
  });
}

function report(label, group) {
  console.log(`\n[${label}] n=${group.raw.n}`);
  console.log(`  NO CORRECTION:  RMSE=${group.raw.rmse().toFixed(3)}  bias=${group.raw.bias().toFixed(3)}  MAE=${group.raw.mae().toFixed(3)}`);
  console.log(`  KALMAN LOW:     RMSE=${group.kal.rmse().toFixed(3)}  bias=${group.kal.bias().toFixed(3)}  MAE=${group.kal.mae().toFixed(3)}`);
  const delta = group.kal.rmse() - group.raw.rmse();
  console.log(`  Δ(Kal−Raw) RMSE: ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}°F (${((group.kal.rmse() - group.raw.rmse())/group.raw.rmse()*100).toFixed(1)}%)`);
}

console.log("=== LOW-side aggregated across 20 cities ===");
report("OVERALL (all days)", overall);
report("REGIME (|y_t|>1.5°F)", regime);
report("SUSTAINED REGIME (3+ same-sign |y|>1.5)", sustainedRegime);
report("QUIET (|y_t|<0.5°F)", quiet);

const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
console.log(`\n=== Correction magnitude on regime days (n=${correctionMag.kal.length}) ===`);
console.log(`  Kalman LOW |correction|:  mean=${mean(correctionMag.kal).toFixed(2)}°F`);

console.log(`\n=== Per-city LOW RMSE ===`);
perCity.sort((a,b) => (a.kal-a.raw) - (b.kal-b.raw));
console.log(`  city    n     raw    kal    Δ       regime_n  regime_raw  regime_kal  regime_Δ   μ_seed`);
for (const p of perCity) {
  const delta = p.kal - p.raw;
  const regimeDelta = p.regimeKal - p.regimeRaw;
  console.log(`  ${p.name.padEnd(5)}  ${String(p.n).padStart(4)}  ${p.raw.toFixed(2)}   ${p.kal.toFixed(2)}   ${delta>=0?"+":""}${delta.toFixed(3)}   ${String(p.regimeN).padStart(4)}      ${p.regimeRaw.toFixed(2)}        ${p.regimeKal.toFixed(2)}       ${regimeDelta>=0?"+":""}${regimeDelta.toFixed(3)}    ${p.muSeed.toFixed(2)}`);
}

console.log(`\n=== HEADLINE ===`);
const overallDelta = overall.kal.rmse() - overall.raw.rmse();
const regimeDelta = regime.kal.rmse() - regime.raw.rmse();
const sustainedDelta = sustainedRegime.kal.rmse() - sustainedRegime.raw.rmse();
const overallPct = overallDelta / overall.raw.rmse() * 100;
const regimePct = regimeDelta / regime.raw.rmse() * 100;
const sustainedPct = sustainedDelta / sustainedRegime.raw.rmse() * 100;
console.log(`  Overall ΔRMSE: ${overallDelta>=0?"+":""}${overallDelta.toFixed(3)}°F (${overallPct>=0?"+":""}${overallPct.toFixed(1)}%, n=${overall.raw.n})`);
console.log(`  Regime ΔRMSE:  ${regimeDelta>=0?"+":""}${regimeDelta.toFixed(3)}°F (${regimePct>=0?"+":""}${regimePct.toFixed(1)}%, n=${regime.raw.n})`);
console.log(`  Sustained Δ:   ${sustainedDelta>=0?"+":""}${sustainedDelta.toFixed(3)}°F (${sustainedPct>=0?"+":""}${sustainedPct.toFixed(1)}%, n=${sustainedRegime.raw.n})`);
const winners = perCity.filter(p => p.kal < p.raw).length;
console.log(`  Per-city wins: Kalman LOW beats baseline in ${winners}/${perCity.length} cities`);
