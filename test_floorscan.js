// test_floorscan.js — the "sell the low tail" scan: predictor distribution → board
// bucket probs → nofloor gates, plus the cold-pool anomaly tailwind.
import { peaksToBinProbs, scanFloors } from "./netlify/functions/lib/floorscan.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };
const approx = (a, b, tol = 0.02) => a != null && Math.abs(a - b) <= tol;

// A Denver-style ladder (parity irrelevant here — the scan keys off loInt/hiInt).
const board = () => ({
  "<=88":  { loInt: null, hiInt: 88, no_ask: 0.80, yes_bid: 0.18 }, // NO pays 25%
  "89-90": { loInt: 89, hiInt: 90, no_ask: 0.85, yes_bid: 0.13 },   // NO pays 17.6%
  "91-92": { loInt: 91, hiInt: 92, no_ask: 0.70, yes_bid: 0.28 },
  "93-94": { loInt: 93, hiInt: 94, no_ask: 0.55, yes_bid: 0.43 },
  ">=95":  { loInt: 95, hiInt: null, no_ask: 0.90, yes_bid: 0.09 },
});

// ---- peaksToBinProbs: empirical peaks → per-bucket p_yes ----
{
  const bp = peaksToBinProbs([95, 96, 96, 97, 98], board());
  ok("binProbs: all mass in the open top bucket", bp[">=95"] === 1 && bp["<=88"] === 0);
  ok("binProbs: empty samples → empty map", Object.keys(peaksToBinProbs([], board())).length === 0);
  const split = peaksToBinProbs([88, 90, 92], board()); // one each in <=88 / 89-90 / 91-92
  ok("binProbs: splits across buckets", approx(split["<=88"], 1 / 3) && approx(split["89-90"], 1 / 3) && approx(split["91-92"], 1 / 3));
}

// ---- warm day: the bottom floor is a live, paying, not-yet-locked candidate ----
{
  const warm = { peak_samples: [95, 96, 96, 97, 98], anchor_anomaly_f: 1 };
  const r = scanFloors(warm, board(), 82); // max so far 82, below every lock temp
  const b88 = r.evaluated.find((e) => e.label === "<=88");
  ok("warm: ≤88 p_lock = 1 (every peak clears 88)", approx(b88.p_lock, 1));
  ok("warm: ≤88 NO pays 25%", approx(b88.return_pct, 25, 0.1));
  ok("warm: ≤88 is a candidate", b88.candidate === true && b88.already_locked === false);
  ok("warm: candidates ranked, ≤88 present", r.candidates.some((c) => c.label === "<=88"));
  ok("warm: no anomaly → no tailwind/headwind", r.context.floor_tailwind === false && r.context.floor_headwind === false);
}

// ---- monotonic lock: once max-so-far clears the ceilings, no edge left ----
{
  const warm = { peak_samples: [95, 96, 96, 97, 98], anchor_anomaly_f: 1 };
  const r = scanFloors(warm, board(), 95); // already 95 → every finite floor locked
  ok("locked: ≤88 already_locked, not a candidate", r.evaluated.find((e) => e.label === "<=88").already_locked === true);
  ok("locked: board offers no live floor", r.candidates.length === 0);
}

// ---- cold-pool morning: the honest KDEN case — raw p_lock UNDER-rates the floor,
//      but the tailwind flags that it's safer than the gate shows ----
{
  const cold = { peak_samples: [85, 87, 87, 87, 89], anchor_anomaly_f: -7 }; // today's 11:53 shape
  const r = scanFloors(cold, board(), 82);
  const b88 = r.evaluated.find((e) => e.label === "<=88");
  ok("cold: raw p_lock under-rates ≤88 (only 1/5 peaks clear 88)", approx(b88.p_lock, 0.2, 0.01));
  ok("cold: raw gate therefore rejects ≤88", b88.candidate === false);
  ok("cold: BUT tailwind fires (cold-pool → floor safer than modeled)", r.context.floor_tailwind === true);
  ok("cold: tailwind note explains the mispricing", r.context.note.includes("cold-pool") && r.context.note.includes("premium"));
}

// ---- warm-start headwind ----
{
  const hot = { peak_samples: [95, 96, 96, 97, 98], anchor_anomaly_f: 6 };
  const r = scanFloors(hot, board(), 82);
  ok("headwind: warm-start flags floor risk", r.context.floor_headwind === true && r.context.note.includes("warm-start"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
