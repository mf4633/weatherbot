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
  const cal = opts.calibration
    || calibrateRiseByHour(dailyRecords(upto.filter((o) => localParts(o.tsMs, tz).dayKey !== todayKey), tz));

  const maxSoFar = todayObs.length ? Math.max(...todayObs.map((o) => o.tempF)) : null;
  const latest = upto.reduce((a, b) => (b.tsMs > a.tsMs ? b : a));
  const latestHour = localParts(latest.tsMs, tz).hour;
  const hourStat = pickHourStat(cal, latestHour);

  const floor = maxSoFar == null ? -Infinity : maxSoFar;
  const rises = hourStat ? hourStat.rises : [0];
  const peaks = rises.map((r) => Math.max(floor, latest.tempF + r)).sort((a, b) => a - b);
  const predicted = Math.max(floor, latest.tempF + (hourStat ? hourStat.median : 0));

  return {
    predicted: round1(predicted),
    bucket: bucketOf(predicted, anchor),
    bucket_probs: bucketProbs(peaks, anchor),
    range: [round1(peaks[0]), round1(peaks[peaks.length - 1])],
    max_so_far: maxSoFar,
    latest_temp: latest.tempF,
    latest_hour: latestHour,
    rise_median: hourStat ? round1(hourStat.median) : null,
    rise_range: hourStat ? [hourStat.min, hourStat.max] : null,
    n_cal_days: hourStat ? hourStat.n : 0,
    low_confidence: !hourStat || hourStat.n < 3,
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
  const finite = obs.filter((o) => Number.isFinite(o.tempF) && Number.isFinite(o.tsMs));
  const days = dailyRecords(finite, tz);
  const results = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const a = anchorAtHour(d.rows, asOfHour);
    if (!a) continue;                       // no reading by the decision hour
    if (i < minPriorDays) continue;         // not enough history to calibrate
    const cal = calibrateRiseByHour(days.slice(0, i));
    const uptoObs = finite.filter((o) => o.tsMs <= a.tsMs);
    const pred = predictHigh(uptoObs, tz, { asOfMs: a.tsMs, calibration: cal, bucketAnchor: anchor });
    if (!pred) continue;
    const actB = bucketOf(d.peak, anchor);
    results.push({
      day: d.dayKey, as_of_temp: a.tempF, predicted: pred.predicted, actual: d.peak,
      err: round1(pred.predicted - d.peak),
      pred_bucket: pred.bucket.label, act_bucket: actB.label,
      hit: pred.bucket.label === actB.label,
    });
  }
  const n = results.length;
  const agg = (f) => (n ? results.reduce((a, r) => a + f(r), 0) / n : null);
  return {
    as_of_hour: asOfHour, n,
    mae: n ? round1(agg((r) => Math.abs(r.err))) : null,
    bias: n ? round1(agg((r) => r.err)) : null,
    bucket_hit_pct: n ? Math.round((results.filter((r) => r.hit).length / n) * 1000) / 10 : null,
    within1_pct: n ? Math.round((results.filter((r) => Math.abs(r.err) <= 1).length / n) * 1000) / 10 : null,
    days: results,
  };
}
