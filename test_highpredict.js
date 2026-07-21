// test_highpredict.js — the daily-HIGH predictor + backtest. Synthetic multi-day
// traces in America/Denver (July = MDT, UTC-6), so local hour H → UTC H+6, all inside
// one UTC day for H in 6..17 — deterministic, no live fetch.
import {
  localParts, bucketOf, dailyRecords, calibrateRiseByHour, predictHigh, backtestHigh,
} from "./netlify/functions/lib/highpredict.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };
const approx = (a, b, tol = 0.05) => a != null && Math.abs(a - b) <= tol;

const TZ = "America/Denver";
const OFF = 6; // MDT
const at = (dnum, h, t) => ({ tsMs: Date.UTC(2026, 6, dnum, h + OFF, 53), tempF: t });
const day = (dnum, pairs) => pairs.map(([h, t]) => at(dnum, h, t));

// ---- localParts: UTC ms → local hour/day ----
{
  const p = localParts(at(14, 13, 53).tsMs, TZ);
  ok("localParts: 13:53 MDT hour", p.hour === 13);
  ok("localParts: dayKey", p.dayKey === "2026-07-14");
}

// ---- bucketOf: market-specific parity ----
{
  ok("bucket even: 98 → 98-99", bucketOf(98, 0).label === "98-99");
  ok("bucket even: 99 → 98-99", bucketOf(99, 0).label === "98-99");
  ok("bucket even: 100 → 100-101", bucketOf(100, 0).label === "100-101");
  ok("bucket odd: 90 → 89-90", bucketOf(90, 1).label === "89-90");
  ok("bucket odd: 89 → 89-90", bucketOf(89, 1).label === "89-90");
  ok("bucket odd: 91 → 91-92", bucketOf(91, 1).label === "91-92");
  ok("bucket odd: 88 → 87-88", bucketOf(88, 1).label === "87-88");
  ok("bucket rounds before splitting", bucketOf(89.4, 1).label === "89-90");
  ok("bucket null-safe", bucketOf(null) === null);
}

// ---- calibrateRiseByHour: rise = peak − :53 temp at that hour, anchors ≤ peak ----
{
  const prior = [
    ...day(14, [[8, 70], [11, 85], [15, 90]]),  // peak 90 @15 → rise@11 = 5
    ...day(15, [[8, 70], [11, 85], [15, 91]]),  // rise@11 = 6
    ...day(16, [[8, 70], [11, 85], [15, 92]]),  // rise@11 = 7
  ];
  const cal = calibrateRiseByHour(dailyRecords(prior, TZ));
  ok("cal: hour-11 has 3 rises", cal[11].n === 3);
  ok("cal: hour-11 rises ascending [5,6,7]", JSON.stringify(cal[11].rises) === "[5,6,7]");
  ok("cal: hour-11 median 6", cal[11].median === 6);
  ok("cal: hour-11 min/max 5/7", cal[11].min === 5 && cal[11].max === 7);
  ok("cal: peak-hour rise is 0", cal[15].median === 0);
  ok("cal: early-hour bigger rise", cal[8].median === 21);
}

// ---- predictHigh: latest :53 + empirical rises = high distribution ----
{
  const prior = [
    ...day(14, [[8, 70], [11, 85], [15, 90]]),
    ...day(15, [[8, 70], [11, 85], [15, 91]]),
    ...day(16, [[8, 70], [11, 85], [15, 92]]),
  ];
  const cal = calibrateRiseByHour(dailyRecords(prior, TZ));
  const today = day(17, [[8, 77], [11, 87]]);   // 87 at 11:53
  const r = predictHigh(today, TZ, { calibration: cal, asOfMs: at(17, 11, 87).tsMs, bucketAnchor: 1 });
  ok("predict: point = latest + median rise (87+6)", r.predicted === 93);
  ok("predict: bucket 93-94 (odd ladder)", r.bucket.label === "93-94");
  ok("predict: range [92,94]", r.range[0] === 92 && r.range[1] === 94);
  ok("predict: max_so_far floor is 87", r.max_so_far === 87);
  ok("predict: n_cal_days 3, confident", r.n_cal_days === 3 && r.low_confidence === false);
  const p9192 = r.bucket_probs.find(b => b.label === "91-92")?.prob;
  const p9394 = r.bucket_probs.find(b => b.label === "93-94")?.prob;
  ok("predict: P(91-92) ≈ 0.333", approx(p9192, 0.333));
  ok("predict: P(93-94) ≈ 0.667", approx(p9394, 0.667));

  // End-to-end (no explicit calibration): derives it from the prior days in obs.
  const e2e = predictHigh([...prior, ...today], TZ, { asOfMs: at(17, 11, 87).tsMs, bucketAnchor: 1 });
  ok("predict: derives calibration from obs when omitted", e2e.predicted === 93);
}

// ---- monotonic floor: prediction never below today's max so far ----
{
  const prior = [
    ...day(14, [[8, 70], [11, 85], [15, 90]]),
    ...day(15, [[8, 70], [11, 85], [15, 91]]),
    ...day(16, [[8, 70], [11, 85], [15, 92]]),
  ];
  const cal = calibrateRiseByHour(dailyRecords(prior, TZ));
  // Today already hit 90 at 13:53, dipped to 88 at 15:53. Hour-15 rise ≈ 0.
  const today = day(17, [[13, 90], [15, 88]]);
  const r = predictHigh(today, TZ, { calibration: cal, asOfMs: at(17, 15, 88).tsMs, bucketAnchor: 1 });
  ok("floor: predicted held at max-so-far 90 (not latest 88)", r.predicted === 90);
  ok("floor: max_so_far reported", r.max_so_far === 90);
}

// ---- low_confidence when the hour has < 3 calibration days ----
{
  const prior = [
    ...day(14, [[11, 85], [15, 90]]),
    ...day(15, [[11, 85], [15, 91]]),
  ];
  const cal = calibrateRiseByHour(dailyRecords(prior, TZ));
  const r = predictHigh(day(17, [[11, 87]]), TZ, { calibration: cal, asOfMs: at(17, 11, 87).tsMs, bucketAnchor: 1 });
  ok("confidence: 2 cal days → low_confidence", r.n_cal_days === 2 && r.low_confidence === true);
}

// ---- backtestHigh: exact-rise series scores perfectly ----
{
  const obs = [];
  for (let d = 14; d <= 19; d++) obs.push(...day(d, [[8, 70], [11, 85], [15, 91]])); // every day +6 → peak 91
  const bt = backtestHigh(obs, TZ, { asOfHour: 11, minPriorDays: 3, bucketAnchor: 1 });
  ok("backtest: scores days after the 3-day warmup", bt.n === 3);
  ok("backtest: perfect series → MAE 0", bt.mae === 0);
  ok("backtest: perfect series → bias 0", bt.bias === 0);
  ok("backtest: perfect series → 100% bucket hit", bt.bucket_hit_pct === 100);
  ok("backtest: perfect series → 100% within-1", bt.within1_pct === 100);
}

// ---- backtestHigh: a surprise-hot day surfaces as a miss + error ----
{
  const obs = [];
  for (let d = 14; d <= 18; d++) obs.push(...day(d, [[8, 70], [11, 85], [15, 91]])); // +6, peak 91
  obs.push(...day(19, [[8, 70], [11, 85], [15, 93]]));                               // +8, peak 93 (surprise)
  const bt = backtestHigh(obs, TZ, { asOfHour: 11, minPriorDays: 3, bucketAnchor: 1 });
  ok("backtest(noisy): 3 scored days", bt.n === 3);
  ok("backtest(noisy): the +8 day misses its bucket", bt.bucket_hit_pct === 66.7);
  ok("backtest(noisy): MAE reflects the 2°F miss (0.7 rounded)", bt.mae === 0.7);
  ok("backtest(noisy): within-1 drops below 100", bt.within1_pct === 66.7);
  const miss = bt.days.find(d => d.day === "2026-07-19");
  ok("backtest(noisy): 07-19 err = -2 (predicted 91 vs actual 93)", miss.err === -2 && miss.hit === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
