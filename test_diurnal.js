// Unit tests for the observation-lock-in physics (Strategy A). No network.
import { extremumBounds, lockinDecision, maxRemainingRise } from "./netlify/functions/lib/diurnal.js";
import { lockinBets } from "./netlify/functions/lib/strategy_lockin.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); }
                             else { fail++; console.log(`  ✗ ${name}`); } };

// --- bounds ---
const b5pm = extremumBounds("high", { maxSoFar: 94, localHour: 17 }); // rise(17)=2, margin 1
ok("5pm high bounds ≈ [93, 97]", b5pm && b5pm.floor === 93 && b5pm.ceil === 97);
const b9am = extremumBounds("high", { maxSoFar: 70, localHour: 9 });  // rise(9)=40
ok("9am high bounds wide (ceil ≥ 110)", b9am && b9am.ceil >= 110);
ok("no obs → null bounds", extremumBounds("high", { maxSoFar: null, localHour: 17 }) === null);

// --- lock-in decisions (5pm, high already 94, final in [93,97]) ---
// "≥93" YES (loInt=93): high is already 94 → certain WIN
ok("≥93 YES = certain win", lockinDecision("YES", 93, null, b5pm).certain === "win");
// "≥98" YES: unreachable → YES loss; NO = certain WIN
ok("≥98 NO = certain win (can't reach 98)", lockinDecision("NO", 98, null, b5pm).certain === "win");
ok("≥98 YES = certain loss", lockinDecision("YES", 98, null, b5pm).certain === "loss");
// exact bucket [94,94]: could settle 94..97 → uncertain, must ABSTAIN
ok("B[94,94] YES = abstain (null)", lockinDecision("YES", 94, 94, b5pm).certain === null);
ok("B[94,94] NO = abstain (null)", lockinDecision("NO", 94, 94, b5pm).certain === null);

// --- low, 2pm, minSoFar 52, final in [43,53] ---
const bLow = extremumBounds("low", { minSoFar: 52, localHour: 14 }); // fall(14)=8
ok("2pm low bounds ≈ [43, 53]", bLow && bLow.floor === 43 && bLow.ceil === 53);
// "≥55" NO: low won't reach 55 → NO certain WIN
ok("low ≥55 NO = certain win", lockinDecision("NO", 55, null, bLow).certain === "win");

// --- morning abstains entirely ---
ok("9am high: every decision abstains", ["YES","NO"].every(s =>
  lockinDecision(s, 80, null, b9am).certain === null));

// --- strategy: realistic fill + edge gate ---
const snap = { variable: "high", obs: { maxSoFar: 94, localHour: 17 }, buckets: [
  { ticker: "KXHIGHX-T92", loInt: 93, hiInt: null, yes_ask: 0.85, no_ask: 0.14 }, // ≥93 locked YES, underpriced
  { ticker: "KXHIGHX-T97", loInt: 98, hiInt: null, yes_ask: 0.06, no_ask: 0.93 }, // ≥98 locked NO, underpriced
  { ticker: "KXHIGHX-T90", loInt: 91, hiInt: null, yes_ask: 0.99, no_ask: 0.02 }, // ≥91 locked YES but fairly priced (0.99)
  { ticker: "KXHIGHX-B94", loInt: 94, hiInt: 94, yes_ask: 0.30, no_ask: 0.68 },   // uncertain → no bet
]};
const bets = lockinBets(snap);
const byTicker = Object.fromEntries(bets.map(b => [b.ticker.split("-").pop(), b]));
ok("bets ≥93 YES @0.85", byTicker["T92"]?.side === "YES" && byTicker["T92"].price === 0.85);
ok("bets ≥98 NO @0.93", byTicker["T97"]?.side === "NO" && byTicker["T97"].price === 0.93);
ok("skips fairly-priced 0.99 lock", !byTicker["T90"]);
ok("skips uncertain B94", !byTicker["B94"]);
ok("exactly 2 lock-in bets", bets.length === 2);
// edge math: 1 - 0.85 - fee(0.85). fee(0.85)=ceil(0.07*0.85*0.15*100)/100=ceil(0.8925)/100=0.01
ok("≥93 YES edge ≈ 0.14", Math.abs(byTicker["T92"].edge - 0.14) < 1e-9);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
