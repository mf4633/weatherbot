// A/B backtest of adaptive REGIME_DAMPING (Change #2).
// Replay 5y per city. At each day, compute running 7d and 3d residuals from prior days,
// then form the prediction with either constant damping (0.3) or adaptive (0.6 when 3d
// regime-change condition fires). Measure RMSE / cov on subset where adaptive fires.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const MODELS = data.models.filter(m => !["jma_seamless", "gem_seamless"].includes(m));
const BIAS_BASE = 0.4;
const BIAS_TAU_HR = 5;
const SIGMA_RESOLUTION_F = 1.0;
const REGIME_FLOOR_F = 0.5;
const REGIME_DAMPING = 0.3;
const REGIME_DAMPING_ADAPTIVE = 0.6;
const REGIME_CHANGE_THRESHOLD_F = 1.5;
const ROLLING_WINDOW = 7;
const SHORT_WINDOW = 3;
const PRED_HR = 12;  // single mid-day check (logger.js captures around 14-15 local but
                     // the regime adjustment is the same; predHr=12 isolates the effect).

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

function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const t = 1 / (1 + p*x);
  return s * (1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x));
}
function expectedMaxNormal(mu, sigma, a) {
  const z = (a - mu) / sigma;
  const phi = Math.exp(-z*z/2) / Math.sqrt(2*Math.PI);
  const Phi = 0.5 * (1 + erf(z / Math.SQRT2));
  return mu + (a - mu) * Phi + sigma * phi;
}

function predict(forecastHighF, biasF, hrsToPeak, maxSoFar, sigmaEnsemblePeak, residual7d, damping) {
  if (forecastHighF == null || maxSoFar == null) return null;
  const biasDecay = 1 - Math.exp(-Math.max(0, hrsToPeak) / BIAS_TAU_HR);
  const biasWeight = BIAS_BASE * biasDecay;
  let priorMean = forecastHighF + (biasF != null ? biasWeight * biasF : 0);
  if (residual7d != null && Math.abs(residual7d) > REGIME_FLOOR_F) {
    priorMean -= damping * residual7d;
  }
  const sigEns = sigmaEnsemblePeak ?? 0.8;
  const priorStd = Math.sqrt(sigEns * sigEns + SIGMA_RESOLUTION_F * SIGMA_RESOLUTION_F);
  return { mean: expectedMaxNormal(priorMean, priorStd, maxSoFar), std: priorStd };
}

class Stats {
  constructor() { this.n = 0; this.sumSq = 0; this.sum = 0; this.cov68 = 0; this.cov95 = 0; this.sumStd = 0; }
  add(err, std) {
    this.n++;
    this.sumSq += err*err; this.sum += err; this.sumStd += std;
    if (Math.abs(err) <= std) this.cov68++;
    if (Math.abs(err) <= 1.96*std) this.cov95++;
  }
  report(label) {
    if (!this.n) { console.log(`[${label}] n=0`); return; }
    const rmse = Math.sqrt(this.sumSq / this.n);
    const bias = this.sum / this.n;
    const sd = this.sumStd / this.n;
    console.log(`[${label}] n=${this.n}  RMSE=${rmse.toFixed(3)}  bias=${bias.toFixed(3)}  σ̄=${sd.toFixed(2)}  cov68=${(this.cov68/this.n*100).toFixed(1)}%  cov95=${(this.cov95/this.n*100).toFixed(1)}%`);
  }
}

const overallC = new Stats(), overallA = new Stats();
const fireC = new Stats(), fireA = new Stats();
const phxCheck = { residuals: [] };

let totalDays = 0;
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const obsByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    (obsByDay[localDateStr(ts, tz)] ??= []).push({ tempF: c.obs.temps[i], localHr: localHour(ts, tz) });
  }
  const fcByModel = {};
  for (const m of MODELS) {
    const md = c.models[m]; if (!md) continue;
    const byDay = {};
    for (let i = 0; i < md.times.length; i++) {
      const ts = md.times[i] + "Z";
      (byDay[localDateStr(ts, tz)] ??= []).push({ tempF: md.temps[i], localHr: localHour(ts, tz) });
    }
    fcByModel[m] = byDay;
  }

  const sortedDates = Object.keys(obsByDay).sort();
  // Per-day pre-compute the prediction inputs and actualMax.
  const dayData = [];
  for (const date of sortedDates) {
    const dayObs = obsByDay[date];
    if (dayObs.length < 18) continue;
    let actualMax = -Infinity, peakHour = 15;
    for (const o of dayObs) if (o.tempF > actualMax) { actualMax = o.tempF; peakHour = o.localHr; }
    const obsThru = dayObs.filter(o => o.localHr <= PRED_HR);
    if (!obsThru.length) continue;
    let maxSoFar = -Infinity, currentTemp = null;
    for (const o of obsThru) { if (o.tempF > maxSoFar) maxSoFar = o.tempF; currentTemp = o.tempF; }
    const modelHighs = [];
    const modelNows = [];
    for (const m of MODELS) {
      const dayFc = fcByModel[m]?.[date]; if (!dayFc?.length) continue;
      let h = -Infinity; let nowVal = null;
      for (const f of dayFc) {
        if (f.tempF > h) h = f.tempF;
        if (f.localHr === PRED_HR) nowVal = f.tempF;
      }
      modelHighs.push(h);
      if (nowVal != null) modelNows.push(nowVal);
    }
    if (modelHighs.length < 3 || modelNows.length < 3) continue;
    const forecastHighF = modelHighs.reduce((a,b)=>a+b,0)/modelHighs.length;
    let v = 0; for (const h of modelHighs) v += (h - forecastHighF)**2;
    const sigmaEnsemblePeak = modelHighs.length > 1 ? Math.sqrt(v/(modelHighs.length-1)) : null;
    if (sigmaEnsemblePeak != null && sigmaEnsemblePeak > 10) continue;  // unit-mismatch artifact
    const ensembleNow = modelNows.reduce((a,b)=>a+b,0)/modelNows.length;
    const biasF = currentTemp - ensembleNow;
    const hrsToPeak = Math.max(0, peakHour - PRED_HR);
    dayData.push({ date, actualMax, forecastHighF, biasF, maxSoFar, currentTemp, hrsToPeak, sigmaEnsemblePeak });
  }

  // Sequential replay: for each day, use last 7d and 3d of (predicted - actual) from
  // the constant-damping run. (Adaptive uses same history so we compare predictions on
  // the same inputs.)
  const histC = [];   // history of residuals (predicted-actual) under constant damping
  const histA = [];   // history under adaptive damping
  for (const d of dayData) {
    const last7C = histC.slice(-ROLLING_WINDOW);
    const last7A = histA.slice(-ROLLING_WINDOW);
    const last3A = histA.slice(-SHORT_WINDOW);
    const r7C = last7C.length ? last7C.reduce((a,b)=>a+b,0)/last7C.length : null;
    const r7A = last7A.length ? last7A.reduce((a,b)=>a+b,0)/last7A.length : null;
    const r3A = last3A.length >= SHORT_WINDOW ? last3A.reduce((a,b)=>a+b,0)/last3A.length : null;
    let dampingA = REGIME_DAMPING;
    let adaptiveFires = false;
    if (r7A != null && r3A != null && Math.sign(r7A) === Math.sign(r3A)
        && Math.abs(r3A) > REGIME_CHANGE_THRESHOLD_F) {
      dampingA = REGIME_DAMPING_ADAPTIVE;
      adaptiveFires = true;
    }
    const predC = predict(d.forecastHighF, d.biasF, d.hrsToPeak, d.maxSoFar, d.sigmaEnsemblePeak, r7C, REGIME_DAMPING);
    const predA = predict(d.forecastHighF, d.biasF, d.hrsToPeak, d.maxSoFar, d.sigmaEnsemblePeak, r7A, dampingA);
    if (!predC || !predA) continue;
    const errC = predC.mean - d.actualMax;
    const errA = predA.mean - d.actualMax;
    overallC.add(errC, predC.std);
    overallA.add(errA, predA.std);
    if (adaptiveFires) {
      fireC.add(errC, predC.std);
      fireA.add(errA, predA.std);
    }
    histC.push(predC.mean - d.actualMax);
    histA.push(predA.mean - d.actualMax);
    totalDays++;
  }
  if (name === "Phoenix") {
    // Print a check on the recent PHX dates (last 10 days of history) to verify adaptive
    // would have caught the 5/7-5/10 series.
    const last10 = dayData.slice(-30);
    console.log(`\nPHX last 30 days replay (adaptive-fires marker):`);
    const histC2 = [], histA2 = [];
    for (const d of dayData.slice(0, dayData.length - 30)) {
      // Quick warmup so histories are populated
      const last7C2 = histC2.slice(-ROLLING_WINDOW);
      const last7A2 = histA2.slice(-ROLLING_WINDOW);
      const last3A2 = histA2.slice(-SHORT_WINDOW);
      const r7C2 = last7C2.length ? last7C2.reduce((a,b)=>a+b,0)/last7C2.length : null;
      const r7A2 = last7A2.length ? last7A2.reduce((a,b)=>a+b,0)/last7A2.length : null;
      const r3A2 = last3A2.length >= SHORT_WINDOW ? last3A2.reduce((a,b)=>a+b,0)/last3A2.length : null;
      let damping = REGIME_DAMPING;
      if (r7A2 != null && r3A2 != null && Math.sign(r7A2) === Math.sign(r3A2)
          && Math.abs(r3A2) > REGIME_CHANGE_THRESHOLD_F) damping = REGIME_DAMPING_ADAPTIVE;
      const pC = predict(d.forecastHighF, d.biasF, d.hrsToPeak, d.maxSoFar, d.sigmaEnsemblePeak, r7C2, REGIME_DAMPING);
      const pA = predict(d.forecastHighF, d.biasF, d.hrsToPeak, d.maxSoFar, d.sigmaEnsemblePeak, r7A2, damping);
      if (pC && pA) { histC2.push(pC.mean - d.actualMax); histA2.push(pA.mean - d.actualMax); }
    }
    for (const d of last10) {
      const last7C2 = histC2.slice(-ROLLING_WINDOW);
      const last7A2 = histA2.slice(-ROLLING_WINDOW);
      const last3A2 = histA2.slice(-SHORT_WINDOW);
      const r7C2 = last7C2.length ? last7C2.reduce((a,b)=>a+b,0)/last7C2.length : null;
      const r7A2 = last7A2.length ? last7A2.reduce((a,b)=>a+b,0)/last7A2.length : null;
      const r3A2 = last3A2.length >= SHORT_WINDOW ? last3A2.reduce((a,b)=>a+b,0)/last3A2.length : null;
      let damping = REGIME_DAMPING;
      let fired = false;
      if (r7A2 != null && r3A2 != null && Math.sign(r7A2) === Math.sign(r3A2)
          && Math.abs(r3A2) > REGIME_CHANGE_THRESHOLD_F) { damping = REGIME_DAMPING_ADAPTIVE; fired = true; }
      const pC = predict(d.forecastHighF, d.biasF, d.hrsToPeak, d.maxSoFar, d.sigmaEnsemblePeak, r7C2, REGIME_DAMPING);
      const pA = predict(d.forecastHighF, d.biasF, d.hrsToPeak, d.maxSoFar, d.sigmaEnsemblePeak, r7A2, damping);
      if (pC && pA) {
        histC2.push(pC.mean - d.actualMax);
        histA2.push(pA.mean - d.actualMax);
        const r3s = r3A2 != null ? r3A2.toFixed(2) : "—";
        const r7s = r7A2 != null ? r7A2.toFixed(2) : "—";
        console.log(`  ${d.date}: actual=${d.actualMax.toFixed(0)}  fc=${d.forecastHighF.toFixed(1)}  predC=${pC.mean.toFixed(1)} (err=${(pC.mean-d.actualMax).toFixed(1)})  predA=${pA.mean.toFixed(1)} (err=${(pA.mean-d.actualMax).toFixed(1)})  r3=${r3s} r7=${r7s} damp=${damping.toFixed(2)} ${fired ? "ADAPT" : ""}`);
      }
    }
  }
}

console.log(`\nTotal day-replay rows: ${totalDays}`);
console.log(`\n=== Overall (across all cities/days, sequential replay) ===`);
overallC.report("CONSTANT damp=0.3");
overallA.report("ADAPTIVE 0.3/0.6 ");

console.log(`\n=== Subset: adaptive damping fired (regime-change condition met) ===`);
fireC.report("CONSTANT damp=0.3");
fireA.report("ADAPTIVE damp=0.6");

const rmseC = overallC.n ? Math.sqrt(overallC.sumSq/overallC.n) : 0;
const rmseA = overallA.n ? Math.sqrt(overallA.sumSq/overallA.n) : 0;
const fireRmseC = fireC.n ? Math.sqrt(fireC.sumSq/fireC.n) : 0;
const fireRmseA = fireA.n ? Math.sqrt(fireA.sumSq/fireA.n) : 0;
console.log(`\n=== Headline ===`);
console.log(`  Overall ΔRMSE:    ${(rmseA - rmseC >= 0 ? "+" : "")}${(rmseA-rmseC).toFixed(3)}°F (${fireC.n} adaptive-fires out of ${overallC.n} = ${(fireC.n/overallC.n*100).toFixed(2)}%)`);
console.log(`  Subset ΔRMSE:     ${(fireRmseA - fireRmseC >= 0 ? "+" : "")}${(fireRmseA-fireRmseC).toFixed(3)}°F`);
