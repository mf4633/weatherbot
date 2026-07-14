// interp_knyc.js — JS port of the user's interpolatornyc pipeline (Python upload,
// 2026-07-14): estimate the official KNYC (Central Park ASOS) temperature between
// :51 METARs from 6 nearby Weather.com PWS. Five stages, kept faithful to the
// upload's constants so its hand-validated calibration carries over:
//   1. pair each KNYC ob with PWS tempHigh max in (t-1h, t]   (mergeKnycPws)
//   2. per-station recency-weighted WLS  T_KNYC = b1*T_PWS + b0 (12h half-life)
//   3. combine stations with w = r^2 / (rmse^2 + 0.01)
//   4. learned peak bias on KNYC>=90F hours, clip [0,3], ramp 85->95, 65% strength
//   5. blend {PWS regression 1.0, delta nowcast 0.85, official anchor 1.2/0.7}
// Pure math only — fetching lives in the function so this is unit-testable.
// KNOWN REFINEMENT (not yet applied, keep parity first): METAR temps are
// instantaneous at :51, not trailing-hour maxima, so pairing vs tempHigh slightly
// compresses slopes on decline hours. Revisit once the card has a scored history.

export const PWS_STATIONS = {
  KNYNEWYO2109: "200WEA (Upper West Side)",
  KNYNEWYO1686: "Tempest 4076",
  KNYNEWYO270: "AMNH roof",
  KNYNEWYO1596: "PWS 1596",
  KNYNEWYO1931: "PWS 1931",
  INEWYO2: "PWS INEWYO2",
};

export const RECENCY_HALF_LIFE_H = 12.0;
export const PEAK_TEMP_THRESHOLD_F = 90.0;
export const PEAK_BIAS_BLEND = 0.65;
const HOUR_MS = 3600e3;

// Weighted least squares y = slope*x + intercept (closed form).
export function weightedPolyfit(x, y, w) {
  const ws = w.reduce((a, b) => a + b, 0);
  if (!(ws > 0)) return { slope: 0, intercept: 0 };
  const xbar = x.reduce((a, v, i) => a + w[i] * v, 0) / ws;
  const ybar = y.reduce((a, v, i) => a + w[i] * v, 0) / ws;
  let cov = 0, varx = 0;
  for (let i = 0; i < x.length; i++) { cov += w[i] * (x[i] - xbar) * (y[i] - ybar); varx += w[i] * (x[i] - xbar) ** 2; }
  if (varx < 1e-9) return { slope: 0, intercept: ybar };
  const slope = cov / varx;
  return { slope, intercept: ybar - slope * xbar };
}

export const recencyWeight = (ageH) => Math.exp(-Math.max(0, ageH) / RECENCY_HALF_LIFE_H);

function pearson(x, y) {
  const n = x.length;
  if (n < 2) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

// Pair each KNYC ob {tsMs, tempF} with each station's PWS max over (ts-1h, ts].
// pwsRows: [{tsMs, station, tempF}] (hourly tempHigh rows from weather.com).
export function mergeKnycPws(knycObs, pwsRows) {
  const pairs = [];
  for (const k of knycObs) {
    const start = k.tsMs - HOUR_MS;
    const inWin = pwsRows.filter(p => p.tsMs > start && p.tsMs <= k.tsMs);
    const byStation = {};
    for (const p of inWin) if (byStation[p.station] == null || p.tempF > byStation[p.station]) byStation[p.station] = p.tempF;
    for (const [station, proxy] of Object.entries(byStation))
      pairs.push({ hourMs: k.tsMs, knyc: k.tempF, station, proxy });
  }
  return pairs;
}

// Recency-weighted regression for one station over its pairs. null if n < 6.
export function stationStats(pairs, station, nowMs) {
  const sub = pairs.filter(p => p.station === station && Number.isFinite(p.knyc) && Number.isFinite(p.proxy));
  if (sub.length < 6) return null;
  const w = sub.map(p => recencyWeight((nowMs - p.hourMs) / HOUR_MS));
  const x = sub.map(p => p.proxy), y = sub.map(p => p.knyc);
  const { slope, intercept } = weightedPolyfit(x, y, w);
  const ws = w.reduce((a, b) => a + b, 0);
  const rmse = Math.sqrt(sub.reduce((a, p, i) => a + w[i] * (y[i] - (slope * x[i] + intercept)) ** 2, 0) / ws);
  return { station, n: sub.length, r: pearson(x, y), slope, intercept, rmse };
}

// Station combination weights: r^2 / (rmse^2 + 0.01), normalized over given stats.
export function stationWeights(statsList) {
  const raw = statsList.map(s => (s.r * s.r) / (s.rmse * s.rmse + 0.01));
  const sum = raw.reduce((a, b) => a + b, 0);
  return statsList.map((s, i) => ({ ...s, weight: sum > 0 ? raw[i] / sum : 1 / statsList.length }));
}

// Learned warm-hours undercount: recency-weighted mean residual on KNYC>=90F
// pairs (residuals averaged across stations per hour first), clipped to [0,3].
export function fitPeakBias(pairs, statsList, nowMs) {
  const byStation = Object.fromEntries(statsList.map(s => [s.station, s]));
  const byHour = {};
  for (const p of pairs) {
    const st = byStation[p.station];
    if (!st || p.knyc < PEAK_TEMP_THRESHOLD_F) continue;
    const resid = p.knyc - (st.slope * p.proxy + st.intercept);
    (byHour[p.hourMs] = byHour[p.hourMs] || []).push(resid);
  }
  const hours = Object.keys(byHour);
  if (!hours.length) return 0;
  let acc = 0, wsum = 0;
  for (const h of hours) {
    const mean = byHour[h].reduce((a, b) => a + b, 0) / byHour[h].length;
    const w = recencyWeight((nowMs - +h) / HOUR_MS);
    acc += w * mean; wsum += w;
  }
  const bias = wsum > 0 ? acc / wsum : 0;
  return Math.min(3, Math.max(0, bias));
}

// Ramp the peak bias in as the PWS reading goes 85 -> 95F.
export function peakBiasFactor(proxyF) {
  if (proxyF < PEAK_TEMP_THRESHOLD_F - 5) return 0;
  return Math.min(1, Math.max(0, (proxyF - (PEAK_TEMP_THRESHOLD_F - 5)) / 10));
}

export const applyPeakBias = (est, proxyF, bias) => est + bias * peakBiasFactor(proxyF) * PEAK_BIAS_BLEND;

// Weighted PWS regression estimate from current readings.
// currents: [{station, tempF}]. Returns {estimate, perStation} or null.
export function pwsRegressionEstimate(weightedStats, currents, peakBias) {
  const per = [];
  for (const c of currents) {
    const st = weightedStats.find(s => s.station === c.station);
    if (!st || !Number.isFinite(c.tempF)) continue;
    per.push({ station: c.station, pws: c.tempF, weight: st.weight,
               est: applyPeakBias(st.slope * c.tempF + st.intercept, c.tempF, peakBias) });
  }
  if (!per.length) return null;
  const wsum = per.reduce((a, p) => a + p.weight, 0);
  return { estimate: per.reduce((a, p) => a + p.est * (p.weight / wsum), 0), perStation: per };
}

// Delta nowcast: official anchor + slope-scaled PWS movement since the anchor,
// r^2-weighted across stations (level-unbiased by construction).
// anchors: {station: pwsTempAtAnchorTime}
export function deltaNowcast(officialTempF, anchors, currents, statsList) {
  let acc = 0, wsum = 0;
  for (const c of currents) {
    const st = statsList.find(s => s.station === c.station);
    const a = anchors[c.station];
    if (!st || a == null || !Number.isFinite(c.tempF)) continue;
    const w = st.r * st.r;
    acc += w * st.slope * (c.tempF - a); wsum += w;
  }
  if (!(wsum > 0)) return null;
  return officialTempF + acc / wsum;
}

// Final three-way blend (upload's documented weights).
export function blendNowEstimate(pwsWeighted, officialLatest, delta, nowMs) {
  const parts = [pwsWeighted], weights = [1.0];
  if (delta != null) { parts.push(delta); weights.push(0.85); }
  if (officialLatest != null) {
    const ageH = (nowMs - officialLatest.tsMs) / HOUR_MS;
    if (ageH <= 2) { parts.push(officialLatest.tempF); weights.push(ageH <= 1 ? 1.2 : 0.7); }
  }
  const ws = weights.reduce((a, b) => a + b, 0);
  return parts.reduce((a, p, i) => a + p * (weights[i] / ws), 0);
}
