// floorscan.js — "sell the low tail" operational scan (2026-07-22).
//
// This is the reorientation the week kept pointing at: stop trying to forecast the
// exact daily HIGH (the hard, losing game — 2026-07-21 KDEN, called ~89 vs actual 92+)
// and instead harvest the LOW-tail NO, which is MONOTONIC — a NO on a bottom bucket is
// won the instant the observed temp clears that bucket's ceiling, hours before settle,
// capital freed, gain banked. It fuses two existing pieces:
//   • lib/highpredict.js  — the empirical peak distribution → p_yes for each board bucket
//   • lib/nofloor.js      — the monotonic-lock + return gates (p_lock>=0.93, return>=0.20)
// and adds the one thing that turns the KDEN failure into an edge: the predictor's
// cold-pool ANOMALY flag, surfaced as a FLOOR TAILWIND. The same signal that made the
// high un-forecastable (a cool morning that mixes out hot) is exactly what makes the
// floor SAFE and, crucially, what makes the crowd LEAVE PREMIUM on the low buckets —
// they see a cool morning and underprice the NO. That morning is when the low-tail NO
// actually pays; the rest of the time the market prices a dead-obvious floor to ~1%.

import { scanNoFloor } from "./nofloor.js";
import { ANOMALY_WARN_F } from "./highpredict.js";

// Map the predictor's empirical peak samples onto the board's buckets → {label: p_yes}.
// Buckets settle on whole degrees; a null loInt/hiInt is an open bottom/top bucket.
export function peaksToBinProbs(peakSamples, books) {
  const out = {};
  const n = (peakSamples || []).length;
  if (!n) return out;
  for (const [label, b] of Object.entries(books || {})) {
    const lo = b.loInt == null ? -Infinity : b.loInt;
    const hi = b.hiInt == null ? Infinity : b.hiInt;
    const c = peakSamples.filter((p) => { const r = Math.round(p); return r >= lo && r <= hi; }).length;
    out[label] = c / n;
  }
  return out;
}

// prediction: a predictHigh() result (needs peak_samples + anchor_anomaly_f).
// books:      { label: {loInt, hiInt, no_ask, yes_bid, ...} }  — the live Kalshi board.
// maxSoFarF:  today's max observed so far (the monotonic floor; free lock once cleared).
// Returns nofloor's {candidates, evaluated} plus a `context` block carrying the anomaly
// tailwind/headwind — the human-facing "trust the floor more / less than the raw gate".
export function scanFloors(prediction, books, maxSoFarF, opts = {}) {
  const binProbs = peaksToBinProbs(prediction?.peak_samples, books);
  const { candidates, evaluated } = scanNoFloor(books, binProbs, maxSoFarF, opts);

  const anomaly = prediction?.anchor_anomaly_f ?? null;
  const tailwind = anomaly != null && anomaly <= -ANOMALY_WARN_F; // cold-pool → floors safer
  const headwind = anomaly != null && anomaly >= ANOMALY_WARN_F;  // warm start → floors riskier
  return {
    candidates, evaluated,
    context: {
      anchor_anomaly_f: anomaly,
      floor_tailwind: tailwind,
      floor_headwind: headwind,
      note: tailwind
        ? `cold-pool morning (anchor ${Math.abs(anomaly)}°F below norm): the predictor's p_lock is a ` +
          `LOWER bound — the day mixes out hotter than modeled, so cheap low-bucket NOs are safer than ` +
          `they look and the crowd is likely leaving premium on the floor. This is the window to lean in.`
        : headwind
        ? `warm-start morning (anchor +${anomaly}°F): the high tail is fatter than modeled, so a low bucket ` +
          `can stay live longer — trust the monotonic max-so-far, not the early p_lock, before selling a floor.`
        : "",
    },
  };
}
