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

// Climb-conditional undercount (2026-07-15 KDEN): regression slopes are trained on
// mostly-ordinary hours, so they compress (~0.6) and the estimate trails the official
// by 1.5-3°F during fast climbs — it read 79.5 against a real ~82-84 mid-ramp, twice.
// Fit: recency-weighted mean residual over pairs in hours where the official rose
// >= RAMP_RATE_F_PER_H vs its previous ob. Applied (by the caller) only while the
// latest officials are themselves rising fast — flat/falling hours get zero.
export const RAMP_RATE_F_PER_H = 2.5;

export function fitRampBias(pairs, statsList, officialObs, nowMs) {
  const byStation = Object.fromEntries(statsList.map(s => [s.station, s]));
  const rising = new Set();
  for (let i = 1; i < officialObs.length; i++) {
    const dt = (officialObs[i].tsMs - officialObs[i - 1].tsMs) / HOUR_MS;
    if (dt > 0 && dt <= 1.5 && (officialObs[i].tempF - officialObs[i - 1].tempF) / dt >= RAMP_RATE_F_PER_H)
      rising.add(officialObs[i].tsMs);
  }
  const byHour = {};
  for (const p of pairs) {
    const st = byStation[p.station];
    if (!st || !rising.has(p.hourMs)) continue;
    (byHour[p.hourMs] = byHour[p.hourMs] || []).push(p.knyc - (st.slope * p.proxy + st.intercept));
  }
  let acc = 0, ws = 0;
  for (const h of Object.keys(byHour)) {
    const m = byHour[h].reduce((a, b) => a + b, 0) / byHour[h].length;
    const w = recencyWeight((nowMs - +h) / HOUR_MS);
    acc += w * m; ws += w;
  }
  return ws > 0 ? Math.min(4, Math.max(0, acc / ws)) : 0;
}

// Weighted median — the robust center for split networks (2026-07-15: five sensors,
// 7°F apart, sun-exposed vs shaded; the weighted MEAN is a coin toss between siting
// regimes, the weighted median sides with the majority regime).
export function weightedMedian(items) {
  const s = items.filter(x => Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
  if (!s.length) return null;
  const tot = s.reduce((a, x) => a + x.w, 0);
  let c = 0;
  for (const x of s) { c += x.w; if (c >= tot / 2) return x.v; }
  return s[s.length - 1].v;
}

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

// --- walk-forward backtest (2026-07-15) -----------------------------------------
// Replay every official ob after a warmup, computing the estimate exactly as the
// live pipeline would at that minute using ONLY prior data (prior officials for
// calibration + anchor, proxy rows up to the minute). The target ob is held out.
// This is the hardest live case — the anchor is a full hour stale — so scores here
// lower-bound live accuracy. ramp/robust toggle the 2026-07-15 upgrades so old and
// new pipelines score on identical data.
export function replayInterp({ officialObs, rows, stations, warmupH = 24, ramp = false, robust = false }) {
  const out = [];
  for (let i = 2; i < officialObs.length; i++) {
    const t = officialObs[i];
    if (t.tsMs - officialObs[0].tsMs < warmupH * HOUR_MS) continue;
    const priorObs = officialObs.slice(0, i);
    const priorRows = rows.filter(r => r.tsMs <= t.tsMs);
    const pairs = mergeKnycPws(priorObs, priorRows);
    const statsList = stations.map(s => stationStats(pairs, s, t.tsMs)).filter(Boolean);
    if (!statsList.length) continue;
    const weighted = stationWeights(statsList);
    const peakBias = fitPeakBias(pairs, statsList, t.tsMs);
    // "current" per station: max in (t-1h, t] — hourly-history stand-in for the live
    // 5-min instantaneous (same for every variant, so the A/B stays fair).
    const currents = [];
    for (const s of stations) {
      const inWin = priorRows.filter(r => r.station === s && r.tsMs > t.tsMs - HOUR_MS && r.tsMs <= t.tsMs);
      if (inWin.length) currents.push({ station: s, tempF: Math.max(...inWin.map(r => r.tempF)) });
    }
    const reg = pwsRegressionEstimate(weighted, currents, peakBias);
    if (!reg) continue;
    let regEst = reg.estimate;
    if (robust) {
      const spread = assessSpread(reg.perStation);
      if (!spread.reliable) {
        const med = weightedMedian(reg.perStation.map(p => ({ v: p.est, w: p.weight })));
        if (med != null) regEst = med;
      }
    }
    const anchor = priorObs[priorObs.length - 1], prev = priorObs[priorObs.length - 2];
    const anchors = {};
    for (const s of stations) {
      const inWin = priorRows.filter(r => r.station === s && r.tsMs > anchor.tsMs - HOUR_MS && r.tsMs <= anchor.tsMs);
      if (inWin.length) anchors[s] = Math.max(...inWin.map(r => r.tempF));
    }
    const delta = deltaNowcast(anchor.tempF, anchors, currents, statsList);
    const anchorRate = (anchor.tempF - prev.tempF) / Math.max(0.25, (anchor.tsMs - prev.tsMs) / HOUR_MS);
    const rising = anchor.tempF > prev.tempF + 0.2;
    let est = blendNowEstimate(regEst, { tempF: anchor.tempF, tsMs: anchor.tsMs }, delta, t.tsMs, rising);
    let rampApplied = 0;
    if (ramp && rising && anchorRate >= RAMP_RATE_F_PER_H) {
      rampApplied = fitRampBias(pairs, statsList, priorObs, t.tsMs);
      est += rampApplied;
    }
    const targetRising = (t.tempF - anchor.tempF) / Math.max(0.25, (t.tsMs - anchor.tsMs) / HOUR_MS) >= RAMP_RATE_F_PER_H;
    out.push({ tsMs: t.tsMs, truth: t.tempF, est: +est.toFixed(2), err: +(est - t.tempF).toFixed(2),
               rising: targetRising, rampApplied: +rampApplied.toFixed(2) });
  }
  return out;
}

// MAE/bias overall and split by whether the target hour was itself a fast climb —
// the bucket where the old pipeline demonstrably failed.
export function scoreReplay(rows) {
  const sc = (xs) => xs.length ? {
    n: xs.length,
    mae: +(xs.reduce((a, r) => a + Math.abs(r.err), 0) / xs.length).toFixed(2),
    bias: +(xs.reduce((a, r) => a + r.err, 0) / xs.length).toFixed(2),
  } : { n: 0, mae: null, bias: null };
  return { all: sc(rows), rising: sc(rows.filter(r => r.rising)), steady: sc(rows.filter(r => !r.rising)) };
}

// Candidate selection for cities WITHOUT a hand-validated station list (DEN, LAX):
// evaluate every discovered PWS with stationStats, keep those that actually track
// the official sensor (r^2 >= 0.5, rmse <= 4F), rank by the same combination
// weight used everywhere, and keep the top `max`. The weighting IS the selection.
export function selectStations(statsList, max = 6) {
  const good = statsList.filter(s => s && s.r * s.r >= 0.5 && s.rmse <= 4);
  const weighted = stationWeights(good.length ? good : statsList.filter(Boolean));
  return weighted.sort((a, b) => b.weight - a.weight).slice(0, max).map(s => s.station);
}

// Spread reliability (2026-07-15, first big-heat late morning): the per-station
// estimate band blew out to ±6°F at 11:25 AM — rooftop PWS in full sun screaming
// mid-90s while shaded units read upper 80s — and a transient 92 nearly triggered
// a panic trade against a position the 11:51 official then vindicated. When the
// network splits like this the weighted mean is a coin toss between siting
// regimes, not a measurement: label it so no one (human or bot) trades on it.
export const SPREAD_SPLIT_F = 6.0;

export function assessSpread(perStation) {
  const ests = (perStation || []).map(p => p.est).filter(Number.isFinite);
  if (ests.length < 2) return { width: null, reliable: true, note: "" };
  const width = Math.max(...ests) - Math.min(...ests);
  if (width < SPREAD_SPLIT_F) return { width, reliable: true, note: "" };
  return { width, reliable: false, note:
    `PWS network split (${width.toFixed(1)}°F across stations) — sun-exposed vs shaded ` +
    `sensors diverging; estimate unreliable, wait for the official :51 print` };
}

// Final three-way blend (upload's documented weights), plus a ramp floor the
// upload doesn't have (2026-07-14, first live day): the compressed regression
// slopes (~0.6, learned from afternoon PWS overheating) trail the trace during
// fast synchronized warm-ups, and the anchor IS the past — so mid-ramp the blend
// read 81 against a minutes-old official 82. When the official trace is RISING
// and the anchor is fresh (<=20 min), temperature is near-monotone: never
// estimate below the anchor. rising: pass true when the last two official obs
// climbed (caller computes); null/false leaves the blend untouched.
export function blendNowEstimate(pwsWeighted, officialLatest, delta, nowMs, rising = false) {
  const parts = [pwsWeighted], weights = [1.0];
  if (delta != null) { parts.push(delta); weights.push(0.85); }
  if (officialLatest != null) {
    const ageH = (nowMs - officialLatest.tsMs) / HOUR_MS;
    if (ageH <= 2) { parts.push(officialLatest.tempF); weights.push(ageH <= 1 ? 1.2 : 0.7); }
  }
  const ws = weights.reduce((a, b) => a + b, 0);
  let est = parts.reduce((a, p, i) => a + p * (weights[i] / ws), 0);
  if (rising && officialLatest != null && (nowMs - officialLatest.tsMs) <= 20 * 60e3)
    est = Math.max(est, officialLatest.tempF);
  return est;
}
