// A/B backtest of obs-disagreement σ override (Change #1) — tight version.
// Streams summary stats by city instead of accumulating row objects.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const MODELS = data.models.filter(m => !["jma_seamless", "gem_seamless"].includes(m));
const PREDICTION_HOURS = [6, 9, 12, 15];
const BIAS_BASE = 0.4;
const BIAS_TAU_HR = 5;
const SIGMA_RESOLUTION_F = 1.0;

// Reuse Intl objects (otherwise re-allocation tanks runtime)
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
function localHour(iso, tz) { return parseInt(intlFmt(tz).hour.format(new Date(iso)), 10); }
function localDateStr(iso, tz) { return intlFmt(tz).date.format(new Date(iso)); }

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
function computeWarmingRate(obs) {
  if (!obs || obs.length < 3) return null;
  const a = obs[obs.length - 3], b = obs[obs.length - 1];
  const dt = b.localHr - a.localHr;
  if (dt <= 0) return null;
  return (b.tempF - a.tempF) / dt;
}

function predict(ctx, useOverride) {
  const { hrsToPeak, maxSoFar, forecastHighF, biasF, currentTemp, warmingRate, sigmaEnsemblePeak } = ctx;
  if (forecastHighF == null || maxSoFar == null) return null;
  const biasDecay = 1 - Math.exp(-Math.max(0, hrsToPeak) / BIAS_TAU_HR);
  const biasWeight = BIAS_BASE * biasDecay;
  let priorMean = forecastHighF + (biasF != null ? biasWeight * biasF : 0);
  const sigEns = sigmaEnsemblePeak ?? 0.8;
  let priorStd = Math.sqrt(sigEns * sigEns + SIGMA_RESOLUTION_F * SIGMA_RESOLUTION_F);
  let override = false;
  if (useOverride && biasF != null && biasF > 2.0 && hrsToPeak > 0 && hrsToPeak < 6
      && currentTemp != null && maxSoFar != null) {
    // σ-only override: widen uncertainty when obs has falsified the forecast, but DON'T
    // shift priorMean. Rationale from backtest: priorMean shifts (persistent-bias and
    // obs-projection) both overshoot on false-alarms (~27% of fires). σ widening alone
    // preserves RMSE on benign days and gives the trader's bucket-prob math wider mass
    // (less edge, smaller stake) when the forecast is being actively contradicted.
    priorStd = Math.max(priorStd, Math.min(3.0, Math.abs(biasF)));
    override = true;
  }
  return { mean: expectedMaxNormal(priorMean, priorStd, maxSoFar), std: priorStd, override };
}

class Stats {
  constructor() { this.n = 0; this.sumSq = 0; this.sum = 0; this.cov68 = 0; this.cov95 = 0; this.sumStd = 0; }
  add(err, std) {
    this.n++;
    this.sumSq += err * err;
    this.sum += err;
    this.sumStd += std;
    if (Math.abs(err) <= std) this.cov68++;
    if (Math.abs(err) <= 1.96 * std) this.cov95++;
  }
  report(label) {
    if (this.n === 0) { console.log(`[${label}] n=0`); return; }
    const rmse = Math.sqrt(this.sumSq / this.n);
    const bias = this.sum / this.n;
    const sd = this.sumStd / this.n;
    const c68 = this.cov68 / this.n * 100;
    const c95 = this.cov95 / this.n * 100;
    console.log(`[${label}] n=${this.n}  RMSE=${rmse.toFixed(3)}  bias=${bias.toFixed(3)}  σ̄=${sd.toFixed(2)}  cov68=${c68.toFixed(1)}%  cov95=${c95.toFixed(1)}%`);
  }
}

const overallBase = new Stats(), overallNew = new Stats();
const overrideBase = new Stats(), overrideNew = new Stats();
const quietBase = new Stats(), quietNew = new Stats();
const phxLikeBase = new Stats(), phxLikeNew = new Stats();
const falseAlarmBase = new Stats(), falseAlarmNew = new Stats();

let totalDays = 0;
let cityCount = 0;
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  // Build obsByDay + fcByModel per city, then immediately consume.
  const obsByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    const date = localDateStr(ts, tz);
    (obsByDay[date] ??= []).push({ tempF: c.obs.temps[i], localHr: localHour(ts, tz) });
  }
  const fcByModel = {};
  for (const m of MODELS) {
    const md = c.models[m]; if (!md) continue;
    const byDay = {};
    for (let i = 0; i < md.times.length; i++) {
      const ts = md.times[i] + "Z";
      const date = localDateStr(ts, tz);
      (byDay[date] ??= []).push({ tempF: md.temps[i], localHr: localHour(ts, tz) });
    }
    fcByModel[m] = byDay;
  }

  let cityDays = 0;
  for (const [date, dayObs] of Object.entries(obsByDay)) {
    if (dayObs.length < 18) continue;
    let actualMax = -Infinity, peakHour = 15;
    for (const o of dayObs) {
      if (o.tempF > actualMax) { actualMax = o.tempF; peakHour = o.localHr; }
    }
    const modelHighs = [];
    const modelNowsByHr = {};
    for (const m of MODELS) {
      const dayFc = fcByModel[m]?.[date]; if (!dayFc?.length) continue;
      let h = -Infinity;
      for (const f of dayFc) {
        if (f.tempF > h) h = f.tempF;
        (modelNowsByHr[f.localHr] ??= []).push(f.tempF);
      }
      modelHighs.push(h);
    }
    if (modelHighs.length < 3) continue;
    const forecastHighF = modelHighs.reduce((a,b)=>a+b,0)/modelHighs.length;
    let varSum = 0;
    for (const h of modelHighs) varSum += (h - forecastHighF) ** 2;
    const sigmaEnsemblePeak = modelHighs.length > 1 ? Math.sqrt(varSum/(modelHighs.length-1)) : null;
    if (sigmaEnsemblePeak != null && sigmaEnsemblePeak > 10) continue;  // unit-mismatch artifact

    for (const predHr of PREDICTION_HOURS) {
      const obsThru = [];
      let maxSoFar = -Infinity, currentTemp = null;
      for (const o of dayObs) {
        if (o.localHr <= predHr) {
          obsThru.push(o);
          if (o.tempF > maxSoFar) maxSoFar = o.tempF;
          currentTemp = o.tempF;
        }
      }
      if (!obsThru.length) continue;
      const nowList = modelNowsByHr[predHr]; if (!nowList || nowList.length < 3) continue;
      const ensembleNow = nowList.reduce((a,b)=>a+b,0)/nowList.length;
      const biasF = currentTemp - ensembleNow;
      const hrsToPeak = Math.max(0, peakHour - predHr);
      const warmingRate = computeWarmingRate(obsThru);
      const ctx = { hrsToPeak, maxSoFar, forecastHighF, biasF, currentTemp, warmingRate, sigmaEnsemblePeak };
      const base = predict(ctx, false);
      const next = predict(ctx, true);
      if (!base || !next) continue;
      const baseErr = base.mean - actualMax;
      const newErr = next.mean - actualMax;
      overallBase.add(baseErr, base.std);
      overallNew.add(newErr, next.std);
      if (next.override) {
        overrideBase.add(baseErr, base.std);
        overrideNew.add(newErr, next.std);
        if (actualMax > forecastHighF + 1.0) {
          phxLikeBase.add(baseErr, base.std);
          phxLikeNew.add(newErr, next.std);
        }
        if (Math.abs(actualMax - forecastHighF) <= 1.0) {
          falseAlarmBase.add(baseErr, base.std);
          falseAlarmNew.add(newErr, next.std);
        }
      } else {
        quietBase.add(baseErr, base.std);
        quietNew.add(newErr, next.std);
      }
      cityDays++;
    }
  }
  cityCount++;
  totalDays += cityDays;
  console.error(`  [${cityCount}/20] ${name}: ${cityDays} prediction rows`);
}

console.log(`\nTotal prediction rows: ${totalDays}`);
console.log(`\n=== Overall (regression check) ===`);
overallBase.report("BASELINE");
overallNew.report("NEW     ");
console.log(`\n=== Override-quiet subset (should be IDENTICAL) ===`);
quietBase.report("BASELINE");
quietNew.report("NEW     ");
console.log(`\n=== Override-fires subset (the fix target) ===`);
overrideBase.report("BASELINE");
overrideNew.report("NEW     ");
console.log(`\n=== Override fires AND actual > forecast+1°F (PHX-like failure regime) ===`);
phxLikeBase.report("BASELINE");
phxLikeNew.report("NEW     ");
console.log(`\n=== Override fires but day was fine (false-alarm cost) ===`);
falseAlarmBase.report("BASELINE");
falseAlarmNew.report("NEW     ");

const cov = (s) => s.n === 0 ? 0 : s.cov95 / s.n;
console.log(`\n=== Headline ===`);
const overallDelta = Math.sqrt(overallNew.sumSq/overallNew.n) - Math.sqrt(overallBase.sumSq/overallBase.n);
const overrideDelta = overrideBase.n ? Math.sqrt(overrideNew.sumSq/overrideNew.n) - Math.sqrt(overrideBase.sumSq/overrideBase.n) : 0;
const phxDelta = phxLikeBase.n ? Math.sqrt(phxLikeNew.sumSq/phxLikeNew.n) - Math.sqrt(phxLikeBase.sumSq/phxLikeBase.n) : 0;
console.log(`  Overall ΔRMSE:    ${overallDelta >= 0 ? "+" : ""}${overallDelta.toFixed(3)}°F`);
console.log(`  Override ΔRMSE:   ${overrideDelta >= 0 ? "+" : ""}${overrideDelta.toFixed(3)}°F (this is what the fix targets)`);
console.log(`  PHX-like ΔRMSE:   ${phxDelta >= 0 ? "+" : ""}${phxDelta.toFixed(3)}°F (the actual failure regime)`);
console.log(`  Override cov95: ${(cov(overrideBase)*100).toFixed(1)}% → ${(cov(overrideNew)*100).toFixed(1)}%`);
console.log(`  PHX-like cov95: ${(cov(phxLikeBase)*100).toFixed(1)}% → ${(cov(phxLikeNew)*100).toFixed(1)}%`);
