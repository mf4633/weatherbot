// highpredict.js — daily-HIGH predictor + backtest (2026-07-21).
//
// The /api/interp endpoint is a NOWCASTER: it estimates the official temperature
// RIGHT NOW between the :53 METARs. It does not predict the daily high — which is
// what every Kalshi daily-high market actually settles on. This module is the
// missing piece: a settlement-high predictor, plus the backtest that scores it.
//
// It is a faithful port of the idea in the user's backtest_houston.py (predict the
// day's max, score it in Kalshi 2° buckets against the CLI settlement), but built on
// the OFFICIAL trace via an HOUR-CONDITIONAL rise-to-peak calibration rather than the
// PWS interpolation. That choice is deliberate: (1) the official trace is always
// reachable (PWS/api.weather.com is not, and is the interp's fragile leg — see the
// Denver DCVZ/puddle failures documented in interp_knyc.js); (2) it is the deployable
// generalization of the hand rule we ran live on 2026-07-21 — "Denver added +5°F on
// average from its 11:53 reading to its peak (range +3..+7)" — which called the
// afternoon better than the market's forecast anchor. This encodes that rule, learned
// per station from its own recent days, and applied at whatever hour we're standing in.
//
// Core object: for each prior day and each clock hour h, the RISE = (day's peak) −
// (that day's :53 temperature at hour h), counting only anchors at/before the peak.
// The empirical set of rises from the current hour, added to today's latest official,
// IS the predictive distribution of today's high — bucketed to give per-contract odds.
// Pure math only; fetching lives in the function so this stays unit-testable offline.

const HOUR_MS = 3600e3;

// A same-hour anchor this far off the recent norm means we're out of the regime the
// calibration was trained on — the point estimate is soft and the tail toward the
// anomaly is under-modeled. This threshold drives the always-on low-confidence flag
// (the validated survivor of the 2026-07-21 KDEN post-mortem: the slope-regression
// correction did NOT beat the base on the 6-day sample, but this DETECTION would have
// flagged the cold-pool morning that burned us).
export const ANOMALY_WARN_F = 5;

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const median = (sortedAsc) => {
  const n = sortedAsc.length;
  if (!n) return null;
  const m = Math.floor(n / 2);
  return n % 2 ? sortedAsc[m] : (sortedAsc[m - 1] + sortedAsc[m]) / 2;
};

// Local {dayKey:'YYYY-MM-DD', hour:0-23, min:0-59} for a UTC ms in a tz.
export function localParts(tsMs, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(tsMs));
  const g = (t) => parts.find((x) => x.type === t).value;
  let hour = +g("hour");
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  return { dayKey: `${g("year")}-${g("month")}-${g("day")}`, hour, min: +g("minute") };
}

// Kalshi 2° bucket for a temperature. The ladder's parity is market-specific:
//   anchor 0 → EVEN-start pairs  (98-99, 100-101 …)  — Houston/CLIHOU
//   anchor 1 → ODD-start pairs   (89-90, 91-92 …)    — Denver
// Pass the parity the live board uses; default even (matches backtest_houston.py).
export function bucketOf(temp, anchor = 0) {
  if (temp == null || !Number.isFinite(temp)) return null;
  const t = Math.round(temp);
  const low = t - ((((t - anchor) % 2) + 2) % 2);
  return { low, high: low + 1, label: `${low}-${low + 1}` };
}

// The representative :53 official for one day at clock hour h: prefer the :45-:59 ob
// (the hourly METAR), else the last ob inside the hour. null if the hour is empty.
function anchorAtHour(dayRows, h) {
  const inHour = dayRows.filter((r) => r.hour === h);
  if (!inHour.length) return null;
  const official = inHour.filter((r) => r.min >= 45).sort((a, b) => a.min - b.min);
  const pick = official.length ? official[official.length - 1] : inHour[inHour.length - 1];
  return { tempF: pick.tempF, tsMs: pick.tsMs, hour: h };
}

// Group obs [{tsMs, tempF}] into local days, each with its peak (max) and peak time.
export function dailyRecords(obs, tz) {
  const byDay = new Map();
  for (const o of obs) {
    if (!Number.isFinite(o.tempF) || !Number.isFinite(o.tsMs)) continue;
    const { dayKey, hour, min } = localParts(o.tsMs, tz);
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push({ tsMs: o.tsMs, tempF: o.tempF, hour, min, dayKey });
  }
  const days = [];
  for (const [dayKey, rows] of byDay) {
    rows.sort((a, b) => a.tsMs - b.tsMs);
    let peak = -Infinity, peakTsMs = null;
    for (const r of rows) if (r.tempF > peak) { peak = r.tempF; peakTsMs = r.tsMs; }
    days.push({ dayKey, rows, peak, peakTsMs });
  }
  days.sort((a, b) => (a.dayKey < b.dayKey ? -1 : 1));
  return days;
}

// Hour-conditional rise-to-peak calibration over a set of (prior) day records.
// stats[h] = { n, rises:[…ascending], min, max, median, mean } — the distribution of
// how many more degrees the day climbed after its hour-h :53 reading. Only anchors
// AT OR BEFORE the peak are counted (an anchor past the peak carries no "how much more
// will it climb" signal and would bias the rise toward zero).
export function calibrateRiseByHour(days, opts = {}) {
  const minHour = opts.minHour ?? 6;
  const maxHour = opts.maxHour ?? 20;
  const byHour = {};
  for (const d of days) {
    for (let h = minHour; h <= maxHour; h++) {
      const a = anchorAtHour(d.rows, h);
      if (!a || a.tsMs > d.peakTsMs) continue;
      (byHour[h] = byHour[h] || []).push(d.peak - a.tempF);
    }
  }
  const stats = {};
  for (const h of Object.keys(byHour)) {
    const rises = byHour[h].slice().sort((a, b) => a - b);
    stats[h] = {
      n: rises.length, rises, min: rises[0], max: rises[rises.length - 1],
      median: median(rises), mean: rises.reduce((a, b) => a + b, 0) / rises.length,
    };
  }
  return stats;
}

// Least-squares fit of the day's PEAK on its hour-h :53 anchor, over prior days.
// WHY (the 2026-07-21 KDEN post-mortem): the base predictor is `peak = anchor +
// median rise`, which implicitly FORCES slope = 1 — it assumes the peak moves
// one-for-one with the anchor. That day a shallow overnight cold pool depressed the
// morning anchor ~14°F below the same-hour norm; the slope-1 model carried that whole
// deficit straight to the peak and under-called the high by ~4°F. Fitting the slope
// lets the data say how much of an anchor anomaly is TRANSIENT (slope < 1 → a cold
// anchor is pulled back UP toward the climatological peak, because the peak is set by
// the mixed-layer airmass, not the suppressed surface reading) vs REAL AIRMASS
// (slope → 1 → the original behavior). Prediction = a + b·anchor, with the historical
// residuals as the spread — which also un-caps the upper tail the median-rise method
// bounded at (anchor + max historical rise). Returns null under minN pairs.
export function fitPeakOnAnchor(days, hour, opts = {}) {
  const minN = opts.minN ?? 4;
  const xs = [], ys = [];
  for (const d of days) {
    const a = anchorAtHour(d.rows, hour);
    if (!a || a.tsMs > d.peakTsMs) continue;
    xs.push(a.tempF); ys.push(d.peak);
  }
  const n = xs.length;
  if (n < minN) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, varx = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); varx += (xs[i] - mx) ** 2; }
  // Clip the slope to a sane range: a noisy few-point fit must not extrapolate wildly.
  // varx≈0 (no anchor spread) → fall back to slope 1 (the base behavior).
  const b = varx > 1e-9 ? Math.min(1.5, Math.max(0, cov / varx)) : 1;
  const a = my - b * mx;
  const residuals = xs.map((x, i) => ys[i] - (a + b * x)).sort((p, q) => p - q);
  const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n);
  return { a, b, n, residuals, rmse, xmin: Math.min(...xs), xmax: Math.max(...xs) };
}

// Nearest hour with calibration data, searching outward from h (so a 12:10 ob still
// finds the hour-12 curve, and an odd gap falls back to an adjacent hour).
function pickHourStat(cal, h) {
  if (cal[h]?.n) return cal[h];
  for (let d = 1; d <= 6; d++) {
    if (cal[h - d]?.n) return cal[h - d];
    if (cal[h + d]?.n) return cal[h + d];
  }
  return null;
}

// Empirical bucket distribution from a set of candidate peaks.
function bucketProbs(peaks, anchor) {
  const counts = new Map();
  for (const p of peaks) {
    const b = bucketOf(p, anchor);
    if (b) counts.set(b.label, (counts.get(b.label) || 0) + 1);
  }
  const n = peaks.length || 1;
  return [...counts.entries()]
    .map(([label, c]) => ({ label, prob: Math.round((c / n) * 1000) / 1000 }))
    .sort((a, b) => parseInt(a.label, 10) - parseInt(b.label, 10));
}

// Predict today's settlement high from obs up to asOfMs.
//   obs: [{tsMs, tempF}]  (official trace, any span; days before today calibrate)
//   opts.asOfMs: prediction time (default = latest ob)
//   opts.bucketAnchor: 0 even-start / 1 odd-start ladder
//   opts.calibration: precomputed rise-by-hour (backtest passes this; else derived
//                     from every day strictly before today)
// Returns the point prediction, a low/high range, the per-bucket odds, and the
// monotonic floor (today's max so far — the high can never settle below it).
export function predictHigh(obs, tz, opts = {}) {
  const anchor = opts.bucketAnchor ?? 0;
  const finite = obs.filter((o) => Number.isFinite(o.tempF) && Number.isFinite(o.tsMs));
  if (!finite.length) return null;
  const asOfMs = opts.asOfMs ?? Math.max(...finite.map((o) => o.tsMs));
  const upto = finite.filter((o) => o.tsMs <= asOfMs);
  if (!upto.length) return null;

  const todayKey = localParts(asOfMs, tz).dayKey;
  const todayObs = upto.filter((o) => localParts(o.tsMs, tz).dayKey === todayKey);
  const priorDays = opts._priorDays || dailyRecords(upto.filter((o) => localParts(o.tsMs, tz).dayKey !== todayKey), tz);
  const cal = opts.calibration || calibrateRiseByHour(priorDays);

  const maxSoFar = todayObs.length ? Math.max(...todayObs.map((o) => o.tempF)) : null;
  const latest = upto.reduce((a, b) => (b.tsMs > a.tsMs ? b : a));
  const latestHour = localParts(latest.tsMs, tz).hour;
  const floor = maxSoFar == null ? -Infinity : maxSoFar;

  // Anchor-anomaly correction (opt-in): fit peak ~ anchor rather than forcing slope 1.
  // Falls through to the base rise method when no fit is available (too few days).
  if (opts.anchorAnomaly) {
    const fit = fitPeakOnAnchor(priorDays, latestHour, { minN: opts.anchorMinN ?? 4 });
    if (fit) {
      const center = fit.a + fit.b * latest.tempF;
      const peaksA = fit.residuals.map((r) => Math.max(floor, center + r)).sort((a, b) => a - b);
      const predictedA = Math.max(floor, center);
      // Today's anchor outside the training range means we're extrapolating the fit —
      // flag it (2026-07-21's 82°F sat below every prior 11:53, the failure signature).
      const extrapolating = latest.tempF < fit.xmin - 0.5 || latest.tempF > fit.xmax + 0.5;
      return {
        // EXPERIMENTAL — off by default. On the 6-day KDEN sample this regression did
        // NOT beat the base rise method (11:53 MAE 2.0 vs 0.5); the historical slope is
        // ~0.9 (a cool anchor mostly DID predict a cool peak), so the few-point fit only
        // added intercept noise. Kept as an opt-in to re-evaluate once more days accrue.
        method: "anchor", experimental: true,
        predicted: round1(predictedA), bucket: bucketOf(predictedA, anchor),
        bucket_probs: bucketProbs(peaksA, anchor),
        range: [round1(peaksA[0]), round1(peaksA[peaksA.length - 1])],
        max_so_far: maxSoFar, latest_temp: latest.tempF, latest_hour: latestHour,
        slope: round1(fit.b), fit_rmse: round1(fit.rmse), n_cal_days: fit.n,
        extrapolating, low_confidence: fit.n < 4 || extrapolating,
      };
    }
  }

  // Base method: latest :53 + median rise-to-peak (implicitly slope 1).
  const hourStat = pickHourStat(cal, latestHour);
  const rises = hourStat ? hourStat.rises : [0];
  const peaks = rises.map((r) => Math.max(floor, latest.tempF + r)).sort((a, b) => a - b);
  const predicted = Math.max(floor, latest.tempF + (hourStat ? hourStat.median : 0));

  // Always-on anchor-anomaly DETECTION (the validated 2026-07-21 lesson). Compare
  // today's current-hour anchor to the recent same-hour climatology. A big cold anomaly
  // that also sits below the training range is the cold-pool morning signature: the
  // peak is set by the airmass, not this suppressed reading, and the rise distribution
  // (trained on warmer anchors) under-models the upside — so we WIDEN the top of the
  // range toward the airmass and flag low confidence rather than pretending precision.
  const sameHour = priorDays.map((d) => anchorAtHour(d.rows, latestHour)).filter(Boolean).map((a) => a.tempF);
  let anomaly = null, note;
  let [rangeLo, rangeHi] = [round1(peaks[0]), round1(peaks[peaks.length - 1])];
  if (sameHour.length >= 3) {
    const mean = sameHour.reduce((s, v) => s + v, 0) / sameHour.length;
    const mn = Math.min(...sameHour), mx = Math.max(...sameHour);
    anomaly = round1(latest.tempF - mean);
    if (anomaly <= -ANOMALY_WARN_F && latest.tempF < mn) {
      rangeHi = round1(rangeHi + (mn - latest.tempF)); // room to mix out to the airmass
      note = `anchor ${Math.abs(anomaly)}°F below the same-hour norm and below the training ` +
        `range — likely a cold-pool morning that can mix out well above the point estimate; ` +
        `upper range widened, treat the high as under-modeled (2026-07-21 KDEN failure mode)`;
    } else if (anomaly >= ANOMALY_WARN_F && latest.tempF > mx) {
      rangeLo = round1(rangeLo - (latest.tempF - mx));
      note = `anchor ${anomaly}°F above the same-hour norm and above the training range — ` +
        `unusually warm start; lower range widened`;
    }
  }
  const lowConfidence = !hourStat || hourStat.n < 3 || (anomaly != null && Math.abs(anomaly) >= ANOMALY_WARN_F);

  return {
    method: "rise", predicted: round1(predicted), bucket: bucketOf(predicted, anchor),
    bucket_probs: bucketProbs(peaks, anchor),
    range: [rangeLo, rangeHi],
    max_so_far: maxSoFar, latest_temp: latest.tempF, latest_hour: latestHour,
    rise_median: hourStat ? round1(hourStat.median) : null,
    rise_range: hourStat ? [hourStat.min, hourStat.max] : null,
    anchor_anomaly_f: anomaly, n_cal_days: hourStat ? hourStat.n : 0,
    low_confidence: lowConfidence, note,
  };
}

// Walk-forward backtest — the port of backtest_houston.py's scoring loop. For each
// local day with >= minPriorDays of history, predict as-of clock hour asOfHour using
// ONLY prior days for calibration + that day's obs up to asOfHour, then score the
// predicted 2° bucket and error against the day's actual peak (the CLI settlement).
// Reports MAE, bias, bucket-hit rate and within-1°F rate — the same metrics the
// Python harness printed, so "how good is this" is a measured number, not a promise.
export function backtestHigh(obs, tz, opts = {}) {
  const anchor = opts.bucketAnchor ?? 0;
  const asOfHour = opts.asOfHour ?? 12;
  const minPriorDays = opts.minPriorDays ?? 3;
  const anchorAnomaly = opts.anchorAnomaly ?? false;
  const finite = obs.filter((o) => Number.isFinite(o.tempF) && Number.isFinite(o.tsMs));
  const days = dailyRecords(finite, tz);
  const results = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const a = anchorAtHour(d.rows, asOfHour);
    if (!a) continue;                       // no reading by the decision hour
    if (i < minPriorDays) continue;         // not enough history to calibrate
    const priorDays = days.slice(0, i);
    const uptoObs = finite.filter((o) => o.tsMs <= a.tsMs);
    const pred = predictHigh(uptoObs, tz, {
      asOfMs: a.tsMs, calibration: calibrateRiseByHour(priorDays), bucketAnchor: anchor,
      anchorAnomaly, _priorDays: priorDays, anchorMinN: opts.anchorMinN,
    });
    if (!pred) continue;
    const actB = bucketOf(d.peak, anchor);
    results.push({
      day: d.dayKey, as_of_temp: a.tempF, predicted: pred.predicted, actual: d.peak,
      err: round1(pred.predicted - d.peak), method: pred.method,
      pred_bucket: pred.bucket.label, act_bucket: actB.label,
      hit: pred.bucket.label === actB.label,
    });
  }
  const n = results.length;
  const agg = (f) => (n ? results.reduce((a, r) => a + f(r), 0) / n : null);
  return {
    as_of_hour: asOfHour, method: anchorAnomaly ? "anchor" : "rise", n,
    mae: n ? round1(agg((r) => Math.abs(r.err))) : null,
    bias: n ? round1(agg((r) => r.err)) : null,
    bucket_hit_pct: n ? Math.round((results.filter((r) => r.hit).length / n) * 1000) / 10 : null,
    within1_pct: n ? Math.round((results.filter((r) => Math.abs(r.err) <= 1).length / n) * 1000) / 10 : null,
    days: results,
  };
}
