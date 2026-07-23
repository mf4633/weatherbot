// Is a trader-side ensemble-disagreement skip gate warranted?
//
// Key fact that reframes the question (verified in kalshi.js 2026-07-23): the trader
// does NOT consume the per-city sigma from weather.js. processEvent() is called with
//   sigmaEff = clamp(calibration.sigmaHigh, SIGMA_HIGH_FLOOR=1.5, SIGMA_HIGH_CAP=2.5)
// — a FLAT population-calibrated sigma (2.131 today), identical for every city. So
// LAX's sigma=5.38 never reached a bucket probability. Any outlier damage must travel
// through the MEAN, not the width.
//
// So the real question: holding sigma FLAT at the production value, is the model still
// calibrated on high-ensemble-disagreement days? Diagnostic is RMS_z with z =
// (actual - predMean)/sigma_flat:
//   RMS_z ~ 1.0  -> sigma is honest, no gate needed
//   RMS_z > 1.0  -> actual errors exceed the flat sigma = OVERCONFIDENT, gate warranted
// plus the bias term, since a systematic warm/cold lean on those days is directly
// tradeable damage even when the width is right.
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const PREDICTION_HOURS = [6, 9, 12, 15];
const MODELS = data.models;
const BIAS_WEIGHT = 0.4;
const SIGMA_FLAT = 2.131;   // production calibration.sigmaHigh, clamped to [1.5, 2.5]

const localHour = (iso, tz) => parseInt(new Intl.DateTimeFormat("en-US",
  { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(iso)), 10);
const localDateStr = (iso, tz) => new Intl.DateTimeFormat("en-CA",
  { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

console.log("Pre-processing...");
const cityProcessed = {};
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const obsByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    (obsByDay[localDateStr(ts, tz)] ??= []).push({ tempF: c.obs.temps[i], localHr: localHour(ts, tz) });
  }
  const fcByModel = {};
  for (const model of MODELS) {
    const m = c.models[model];
    if (!m) continue;
    const byDay = {};
    for (let i = 0; i < m.times.length; i++) {
      const t = m.temps[i];
      if (t == null || !isFinite(t)) continue;
      (byDay[localDateStr(m.times[i] + "Z", tz)] ??= []).push({ tempF: t, localHr: localHour(m.times[i] + "Z", tz) });
    }
    fcByModel[model] = byDay;
  }
  cityProcessed[name] = { obsByDay, fcByModel };
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sampleStd = xs => xs.length > 1
  ? Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1)) : 0;

// Collect rows over the clean window (2024+, all 5 members present).
const rows = [];
for (const [cityName, c] of Object.entries(cityProcessed)) {
  for (const [date, dayObs] of Object.entries(c.obsByDay)) {
    if (date < "2024-01-01") continue;
    if (dayObs.length < 12) continue;
    const actualMax = Math.max(...dayObs.map(o => o.tempF));
    const peakHour = dayObs.find(o => o.tempF === actualMax)?.localHr ?? 15;
    const peaks = {}, nowByHr = {};
    let ok = true;
    for (const m of MODELS) {
      const dayFc = c.fcByModel[m]?.[date];
      if (!dayFc || dayFc.length < 12) { ok = false; break; }
      peaks[m] = Math.max(...dayFc.map(o => o.tempF));
      for (const f of dayFc) (nowByHr[f.localHr] ??= {})[m] = f.tempF;
    }
    if (!ok) continue;
    const availPeaks = MODELS.map(m => peaks[m]);
    const sigmaEns = sampleStd(availPeaks);
    const point = mean(availPeaks);
    for (const predHr of PREDICTION_HOURS) {
      const obs = dayObs.filter(o => o.localHr <= predHr);
      if (!obs.length) continue;
      const maxSoFar = Math.max(...obs.map(o => o.tempF));
      const currentTemp = obs[obs.length - 1].tempF;
      const nows = nowByHr[predHr] || {};
      const nowVals = MODELS.map(m => nows[m]).filter(v => v != null);
      const forecastNow = nowVals.length ? mean(nowVals) : null;
      const bias = forecastNow != null ? currentTemp - forecastNow : 0;
      const predMean = Math.max(maxSoFar, point + BIAS_WEIGHT * bias);
      rows.push({
        city: cityName, sigmaEns, err: predMean - actualMax,
        z: (actualMax - predMean) / SIGMA_FLAT,
        hrsToPeak: Math.max(0, peakHour - predHr)
      });
    }
  }
}
console.log(`rows: ${rows.length}  (2024+, all 5 members present)\n`);

function stats(rs) {
  const n = rs.length;
  if (!n) return null;
  const errs = rs.map(r => r.err);
  return {
    n,
    bias: mean(errs),
    rmse: Math.sqrt(mean(errs.map(e => e * e))),
    rmsZ: Math.sqrt(mean(rs.map(r => r.z * r.z))),
    cov68: rs.filter(r => Math.abs(r.z) <= 1).length / n,
    cov95: rs.filter(r => Math.abs(r.z) <= 1.96).length / n
  };
}

// --- calibration by ensemble-disagreement bin, at the PRODUCTION flat sigma ---
const BINS = [[0, 0.5], [0.5, 1], [1, 1.5], [1.5, 2], [2, 3], [3, 4], [4, 6], [6, 99]];
console.log(`=== Calibration by ensemble disagreement, sigma FLAT at ${SIGMA_FLAT} (production) ===`);
console.log("sigma_ens bin    n        share   bias    RMSE    RMS_z   cov68  cov95");
for (const [lo, hi] of BINS) {
  const rs = rows.filter(r => r.sigmaEns >= lo && r.sigmaEns < hi);
  const s = stats(rs);
  if (!s) continue;
  console.log(`[${String(lo).padStart(3)}, ${String(hi).padStart(3)})    ${String(s.n).padEnd(8)} `
    + `${(s.n / rows.length * 100).toFixed(1)}%`.padEnd(7)
    + ` ${s.bias.toFixed(3).padStart(6)}  ${s.rmse.toFixed(3)}   ${s.rmsZ.toFixed(3)}   `
    + `${(s.cov68 * 100).toFixed(1)}%  ${(s.cov95 * 100).toFixed(1)}%`);
}

// --- what a skip gate would cost/save at each threshold ---
console.log("\n=== Skip-gate sizing: drop all candidates with sigma_ens >= T ===");
console.log("   T    %rows dropped   kept RMS_z   kept bias   dropped RMS_z  dropped bias");
for (const T of [1.5, 2, 2.5, 3, 3.5, 4, 5, 6]) {
  const kept = rows.filter(r => r.sigmaEns < T);
  const drop = rows.filter(r => r.sigmaEns >= T);
  const k = stats(kept), d = stats(drop);
  if (!d || d.n < 50) { console.log(` ${String(T).padStart(4)}   (dropped n=${d ? d.n : 0} too small)`); continue; }
  console.log(` ${String(T).padStart(4)}    ${(d.n / rows.length * 100).toFixed(2)}%`.padEnd(22)
    + `  ${k.rmsZ.toFixed(3)}       ${k.bias.toFixed(3).padStart(6)}       `
    + `${d.rmsZ.toFixed(3)}        ${d.bias.toFixed(3).padStart(6)}`);
}

// --- does disagreement even predict error, once sigma is flat? ---
console.log("\n=== Correlation: sigma_ens vs |error| ===");
{
  const x = rows.map(r => r.sigmaEns), y = rows.map(r => Math.abs(r.err));
  const mx = mean(x), my = mean(y);
  const cov = mean(rows.map((r, i) => (x[i] - mx) * (y[i] - my)));
  const corr = cov / (Math.sqrt(mean(x.map(v => (v - mx) ** 2))) * Math.sqrt(mean(y.map(v => (v - my) ** 2))));
  console.log(`  corr(sigma_ens, |err|) = ${corr.toFixed(4)}   mean sigma_ens = ${mx.toFixed(2)}`);
}
