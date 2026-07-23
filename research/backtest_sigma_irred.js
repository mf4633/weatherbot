// Replay jackson's 148 settled bets with varying σ_irreducible to find a value that:
//   (a) lifts net ROI by skipping bets the model was overconfident on, AND
//   (b) doesn't gate so hard that volume drops near zero ("never lose if you never play").
//
// Schema note: the bet ledger's `modelStd` IS the σ_eff that kalshi.js wrote, which
// was computed at σ_irred=1.0. To replay at σ_irred=X we recover σ_ensemble² and
// rebuild: σ_eff_new² = σ_ensemble² + X² = modelStd² + (X² - 1.0).
//
// Gate thresholds — match jackson_trader.js as of 2026-05-13:
//   MIN_EDGE_HIGH = 0.20, MIN_EDGE_LOW = 0.30, MIN_HALF_KELLY = 0.15, MIN_PRICE = 0.04.

import { readFileSync } from "node:fs";

const bets = readFileSync("jackson_settled.ndjson", "utf-8").trim().split(/\r?\n/).map(JSON.parse);

const MIN_EDGE_HIGH = 0.20;
const MIN_EDGE_LOW  = 0.30;
const MIN_HALF_KELLY = 0.15;
const MIN_PRICE = 0.04;
const CURRENT_SIGMA_IRRED = 1.0;

const minEdgeFor = b => b.variable === "low" ? MIN_EDGE_LOW : MIN_EDGE_HIGH;

import { erf } from "../erf.js";
const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));

function parseBucketStr(s) {
  if (!s) return null;
  s = s.replace(/°F?/g, "").trim();
  let m = s.match(/^(-?\d+)\s*[–-]\s*(-?\d+)$/);
  if (m) return { loInt: +m[1], hiInt: +m[2] };
  m = s.match(/^≤\s*(-?\d+)$/) || s.match(/^<=?\s*(-?\d+)$/);
  if (m) return { loInt: -Infinity, hiInt: +m[1] };
  m = s.match(/^≥\s*(-?\d+)$/) || s.match(/^>=?\s*(-?\d+)$/);
  if (m) return { loInt: +m[1], hiInt: Infinity };
  m = s.match(/^(-?\d+)$/);
  if (m) return { loInt: +m[1], hiInt: +m[1] };
  return null;
}

// Bucket probability with continuous bounds (B-bucket [a,b] → [a-0.5, b+0.5]).
function bucketProb(mean, std, loInt, hiInt) {
  const effLo = (loInt === -Infinity || loInt == null) ? -Infinity : loInt - 0.5;
  const effHi = (hiInt === Infinity  || hiInt == null) ? Infinity  : hiInt + 0.5;
  const pHi = effHi === Infinity ? 1 : normCdf((effHi - mean) / std);
  const pLo = effLo === -Infinity ? 0 : normCdf((effLo - mean) / std);
  return Math.max(0, pHi - pLo);
}

function replayAtIrred(sigmaIrred) {
  let placed = 0, placedPnl = 0, placedStake = 0;
  let skipEdge = 0, skipKelly = 0, skipParse = 0;
  let wouldHaveSkippedLoss = 0, wouldHaveSkippedLossPnl = 0;
  let wouldHaveSkippedWin = 0, wouldHaveSkippedWinPnl = 0;
  const placedBets = [];

  for (const b of bets) {
    // Recover σ_ensemble from recorded modelStd (= σ_eff at σ_irred=1.0)
    const sigmaEnsembleSq = (b.modelStd ?? 0) ** 2 - CURRENT_SIGMA_IRRED ** 2;
    if (sigmaEnsembleSq < 0) { skipParse++; continue; }
    const sigmaEffNew = Math.sqrt(sigmaEnsembleSq + sigmaIrred ** 2);

    const bb = parseBucketStr(b.bucket);
    if (!bb) { skipParse++; continue; }

    const pYesNew = bucketProb(b.modelMean, sigmaEffNew, bb.loInt, bb.hiInt);
    const side = (b.side || "").toLowerCase();
    const pWinNew = side === "yes" ? pYesNew : (1 - pYesNew);
    const fee = 0.07 * (1 - b.price);
    const evNew = (pWinNew - b.price) - fee;
    const kNew = b.price < 1 ? Math.max(0, (pWinNew - b.price) / (1 - b.price)) : 0;
    const halfKNew = kNew / 2;
    const passes = evNew >= minEdgeFor(b)
                && halfKNew >= MIN_HALF_KELLY
                && b.price >= MIN_PRICE;

    if (passes) {
      placed++;
      placedStake += b.stake_dollars || 0;
      placedPnl   += b.realized_pnl || 0;
      placedBets.push(b);
    } else {
      if (evNew < minEdgeFor(b)) skipEdge++;
      else if (halfKNew < MIN_HALF_KELLY) skipKelly++;
      if (b.outcome === "LOSS") { wouldHaveSkippedLoss++; wouldHaveSkippedLossPnl += b.realized_pnl || 0; }
      if (b.outcome === "WIN")  { wouldHaveSkippedWin++;  wouldHaveSkippedWinPnl  += b.realized_pnl || 0; }
    }
  }
  return { sigmaIrred, placed, placedPnl, placedStake,
           placedROI: placedStake > 0 ? placedPnl / placedStake : 0,
           skipEdge, skipKelly, skipParse,
           skippedLossCount: wouldHaveSkippedLoss, lossPnlAvoided: -wouldHaveSkippedLossPnl,
           skippedWinCount: wouldHaveSkippedWin,  winPnlForgone: wouldHaveSkippedWinPnl,
           placedBets };
}

console.log("Replaying 148 bets with new σ_irred (current = 1.0)");
console.log("Gates: ev≥0.20 (HIGH) / 0.30 (LOW), halfKelly≥0.15, price≥0.04\n");
console.log("σ_irred | placed | %retain |    staked    |     pnl      |   ROI   | lossSkipped$ | winForgone$ | NET impact");
console.log("--------+--------+---------+--------------+--------------+---------+--------------+-------------+----------");
const baseline = replayAtIrred(1.0);
const total148Stake = bets.reduce((a,b)=>a+(b.stake_dollars||0),0);

for (const σ of [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.0]) {
  const r = replayAtIrred(σ);
  const retain = (100 * r.placed / 148).toFixed(0);
  const net = r.lossPnlAvoided - r.winPnlForgone;
  console.log(` ${σ.toFixed(1)}   |   ${String(r.placed).padStart(3)}  |   ${retain.padStart(2)}%   |   $${r.placedStake.toFixed(2).padStart(8)}  |   $${r.placedPnl.toFixed(2).padStart(8)}  | ${(r.placedROI*100).toFixed(1).padStart(5)}%  |   $${r.lossPnlAvoided.toFixed(2).padStart(7)}   |   $${r.winPnlForgone.toFixed(2).padStart(6)}   |   $${net.toFixed(2)}`);
}

// Show which bets get cut at σ_irred=1.5 vs baseline
console.log(`\nBets cut at σ_irred=1.5 (vs σ=1.0 baseline) — sorted by impact:`);
const r15 = replayAtIrred(1.5);
const baselineSet = new Set(baseline.placedBets.map(b => b.betId));
const r15Set = new Set(r15.placedBets.map(b => b.betId));
const cut = bets.filter(b => baselineSet.has(b.betId) && !r15Set.has(b.betId));
console.log(`  ${cut.length} bets cut.`);
const sortedCut = cut.sort((a,b)=>a.realized_pnl - b.realized_pnl);
console.log(`  10 biggest losses cut (i.e., losses saved):`);
sortedCut.slice(0, 10).forEach(b => console.log(`    ${b.placedAtUTC.slice(0,10)} ${b.ticker} ${b.side} stake=$${b.stake_dollars} pnl=$${b.realized_pnl.toFixed(2)} ev=${b.ev.toFixed(2)} hK=${b.halfKelly.toFixed(2)}`));
console.log(`  5 biggest wins cut (i.e., wins forgone):`);
sortedCut.slice(-5).reverse().forEach(b => console.log(`    ${b.placedAtUTC.slice(0,10)} ${b.ticker} ${b.side} stake=$${b.stake_dollars} pnl=$${b.realized_pnl.toFixed(2)} ev=${b.ev.toFixed(2)} hK=${b.halfKelly.toFixed(2)}`));

// What stays the same: count of bets that pass at every σ_irred up through 1.5
const r17 = replayAtIrred(1.7);
console.log(`\nVolume floor check: even at σ_irred=1.7, ${r17.placed}/148 (${(100*r17.placed/148).toFixed(0)}%) bets would still pass current May-13 gates.`);

// What if we ALSO need to deal with the May 13 stake-volume cliff?
// Current post-May-13 was n=9, ~$1/day. Replay with σ_irred=1.5 ONLY on pre-May-13 portion
// to validate the principle on the larger sample.
const preMay13 = bets.filter(b => b.placedAtUTC < "2026-05-13T00:00:00.000Z");
const preStake = preMay13.reduce((a,b)=>a+(b.stake_dollars||0),0);
const prePnl   = preMay13.reduce((a,b)=>a+(b.realized_pnl||0),0);
console.log(`\nPre-May-13 actual: n=${preMay13.length}, staked=$${preStake.toFixed(2)}, pnl=$${prePnl.toFixed(2)}, ROI=${(prePnl/preStake*100).toFixed(1)}%`);
