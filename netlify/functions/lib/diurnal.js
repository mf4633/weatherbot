// Observation-lock-in physics (Strategy A). Computes CONSERVATIVE hard bounds on
// the day's final CLI-settled extremum from observations already in hand — NO forecast
// model. The whole point: bet only on outcomes physics has already (near-)decided, where
// the only open question is whether the market has repriced. This is a nowcasting/latency
// edge, not a forecasting edge, which is why it can beat an efficient forecast market.
//
// SAFETY PRINCIPLE: bounds are intentionally generous so `lockinDecision` returns a
// certain WIN/LOSS only when the outcome is genuinely locked. When in doubt it returns
// null (abstain). Better to miss a bet than to assert a false certainty.
//
// The maxRemainingRise / maxRemainingFall tables are CONSERVATIVE PLACEHOLDERS. Before
// this strategy is trusted with real money, fit them from shadow-logged pairs of
// (obs-at-local-hour, final-CLI-extremum) — that is exactly the dataset market_logger.js
// collects and eval_strategy.mjs consumes. Until then, treat every lock-in as a hypothesis.

import { RISE, FALL } from "./diurnal_bounds.js";

// Table lookup: first { ltHour, val } whose ltHour > localHour. Null hour → widest bound.
const lookup = (table, h) => (table.find(e => (h == null ? Infinity : h) < e.ltHour) || table[table.length - 1]).val;

// Upper bound (°F) on how much MORE the daily high can rise after `localHour`. Large in
// the morning (whole warming day ahead → no certainty), collapsing toward ~0 after peak.
// Tables live in diurnal_bounds.js — regenerate from data with fit_diurnal.mjs.
export function maxRemainingRise(localHour) { return lookup(RISE, localHour); }

// Upper bound (°F) on how much LOWER the daily low can still fall after `localHour`. Lows
// trough near dawn, but a CLI calendar day can see a late evening frontal drop, so LOW
// stays deliberately un-lockable longer than HIGH (larger allowance = fewer, safer locks).
export function maxRemainingFall(localHour) { return lookup(FALL, localHour); }

// Settlement uncertainty (°F): CLI rounds via a °C-internal path and reads a specific
// station, so an 87.8°F obs can settle 87°F. Widen bounds by this before any containment
// test — a bucket boundary must be cleared by more than SETTLE_MARGIN to count as certain.
export const SETTLE_MARGIN_F = 1.0;

// Hard [floor, ceil] on the final CLI extremum (continuous °F, settle-margin included).
// Returns null when observations can't bound it yet (no obs, or too early in the day).
export function extremumBounds(variable, obs) {
  const { maxSoFar, minSoFar, localHour } = obs || {};
  if (variable === "high") {
    if (maxSoFar == null) return null;
    return { floor: maxSoFar - SETTLE_MARGIN_F,
             ceil:  maxSoFar + maxRemainingRise(localHour) + SETTLE_MARGIN_F };
  }
  if (variable === "low") {
    if (minSoFar == null) return null;
    return { floor: minSoFar - maxRemainingFall(localHour) - SETTLE_MARGIN_F,
             ceil:  minSoFar + SETTLE_MARGIN_F };
  }
  return null;
}

// Winning set (continuous °F interval, rounding-corrected) for a bucket + side.
// loInt/hiInt are the integer CLI bounds from kalshi.js bucketBounds:
//   B bucket: both finite  → YES wins if CLI in [loInt, hiInt]  → cont [loInt-0.5, hiInt+0.5]
//   T ">= N": loInt finite, hiInt null → YES wins if CLI >= loInt → cont [loInt-0.5, +inf)
//   T "<= N": hiInt finite, loInt null → YES wins if CLI <= hiInt → cont (-inf, hiInt+0.5]
// NO is the complement.
function winInterval(side, loInt, hiInt) {
  const loFinite = loInt != null && loInt !== -Infinity;
  const hiFinite = hiInt != null && hiInt !== Infinity;
  let lo = loFinite ? loInt - 0.5 : -Infinity;
  let hi = hiFinite ? hiInt + 0.5 : Infinity;
  const yesLo = lo, yesHi = hi;
  if (side?.toLowerCase() === "yes") return [[yesLo, yesHi]];
  // NO = complement of [yesLo, yesHi]
  const parts = [];
  if (yesLo > -Infinity) parts.push([-Infinity, yesLo]);
  if (yesHi < Infinity)  parts.push([yesHi, Infinity]);
  return parts.length ? parts : [[NaN, NaN]]; // NO of the whole line never wins
}

const contained = (b, [lo, hi]) => b.floor >= lo && b.ceil <= hi;
const disjoint  = (b, [lo, hi]) => b.ceil < lo || b.floor > hi;

// Is this (bucket, side) an observation-LOCKED outcome given the bounds?
// Returns { certain: 'win' | 'loss' | null }. 'win'/'loss' only when the entire
// [floor, ceil] bound sits inside / outside the winning set; otherwise null (abstain).
export function lockinDecision(side, loInt, hiInt, bounds) {
  if (!bounds) return { certain: null };
  const intervals = winInterval(side, loInt, hiInt);
  const anyWin = intervals.some(iv => contained(bounds, iv));
  if (anyWin) return { certain: "win" };
  const allOut = intervals.every(iv => disjoint(bounds, iv));
  if (allOut) return { certain: "loss" };
  return { certain: null };
}
