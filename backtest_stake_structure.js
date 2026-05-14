// Re-stake jackson's settled bets under combo's stake structure and compare ROI.
// Goal: isolate whether jackson's underperformance is driven by (1) stake size,
// (2) sell-loop drag, or (3) gates.
//
// Usage: node backtest_stake_structure.js [jackson_settled.ndjson]

import { readFileSync } from "node:fs";

const NDJSON = process.argv[2] || "jackson_settled.ndjson";
const bets = readFileSync(NDJSON, "utf-8").trim().split(/\r?\n/).map(JSON.parse);

// Outcome contract economics:
//   contracts = stake / price
//   WIN  → proceeds = contracts × $1   → pnl =  stake × (1-price)/price   (minus fees)
//   LOSS → proceeds = 0                → pnl = -stake
//   SOLD → realized_pnl already net    → scale linearly with stake
// We approximate fees as recorded fees scaled by stake ratio.

function pnlAtStake(bet, newStake) {
  const oldStake = bet.stake_dollars;
  if (!(oldStake > 0)) return 0;
  const r = newStake / oldStake;
  // Just scale realized_pnl by ratio — same outcome, smaller bet.
  // For WIN/LOSS this is exact. For SOLD it assumes the sell would have happened
  // at the same price (true since it's the same market state).
  return (bet.realized_pnl || 0) * r;
}

function summarize(label, stakes) {
  let totalStake = 0, totalPnl = 0, wins = 0, losses = 0, sold = 0;
  for (let i = 0; i < bets.length; i++) {
    const b = bets[i];
    const stake = stakes[i];
    if (stake <= 0) continue;
    totalStake += stake;
    totalPnl   += pnlAtStake(b, stake);
    if (b.outcome === "WIN")  wins++;
    if (b.outcome === "LOSS") losses++;
    if (b.outcome === "SOLD") sold++;
  }
  const roi = totalStake > 0 ? (totalPnl / totalStake) * 100 : 0;
  console.log(` ${label.padEnd(38)} | n=${bets.length} (W/L/S=${wins}/${losses}/${sold}) | staked=$${totalStake.toFixed(2).padStart(8)} | pnl=$${totalPnl.toFixed(2).padStart(8)} | ROI=${roi.toFixed(1)}%`);
}

// --- Scenarios ---
// A. Actual jackson (10% of bankroll, varied stake_dollars as recorded)
const actualStakes = bets.map(b => b.stake_dollars);

// B. Combo's $1 floor, $5 hard cap.
//    Combo sets stake = halfKelly × bankroll, clamped [1, 5]. We don't know bankroll
//    over time, but halfKelly is recorded. Combo started at Đ100. Simulate path:
//    stake_i = clamp(halfKelly_i × bankroll_i, 1, 5); bankroll_{i+1} = bankroll_i + pnl_i.
let bankrollCombo = 100;
const comboStakes = [];
for (const b of bets) {
  const desired = (b.halfKelly || 0) * bankrollCombo;
  const stake = Math.max(1, Math.min(5, desired));
  comboStakes.push(stake);
  bankrollCombo += pnlAtStake(b, stake);
}
console.log(`  combo path bankroll end: $${bankrollCombo.toFixed(2)}`);

// C. Flat $5 — strip Kelly to test pure cap effect
const flat5Stakes = bets.map(_ => 5);

// D. Flat $1 — extreme conservatism
const flat1Stakes = bets.map(_ => 1);

// E. Jackson sizing but capped at $5 (Kelly intact under cap)
const jacksonCapped5 = bets.map(b => Math.min(5, b.stake_dollars));

// F. Jackson sizing but capped at $10
const jacksonCapped10 = bets.map(b => Math.min(10, b.stake_dollars));

console.log("=== STAKE-STRUCTURE BACKTEST on jackson's 148 settled bets ===\n");
console.log(` scenario                               | n=148 (W/L/S)        | staked      | pnl         | ROI`);
console.log(` ${"-".repeat(40)}-+----------------------+-------------+-------------+-------`);
summarize("A. ACTUAL jackson (10% of bankroll)", actualStakes);
summarize("B. combo path ($1-5 Kelly clamp)",    comboStakes);
summarize("C. flat $5 (strip Kelly, cap)",       flat5Stakes);
summarize("D. flat $1 (paper-style tiny)",       flat1Stakes);
summarize("E. jackson sizing capped at $5",      jacksonCapped5);
summarize("F. jackson sizing capped at $10",     jacksonCapped10);

// --- Sell-loop drag: how much would jackson have gained if SOLD bets had ridden? ---
console.log("\n=== SOLD-bet audit (sell-loop drag estimate) ===");
const sold = bets.filter(b => b.outcome === "SOLD");
console.log(`SOLD bets: ${sold.length}`);
for (const b of sold) {
  // marketResult: "yes" → YES side wins, "no" → NO side wins
  const wouldWin = b.marketResult && b.side && (b.marketResult.toLowerCase() === b.side.toLowerCase());
  const heldPnl = wouldWin
    ? b.stake_dollars * (1 - b.price) / b.price - (b.fees_paid || 0)
    : -b.stake_dollars;
  const drag = heldPnl - b.realized_pnl;
  console.log(`  ${b.ticker} ${b.side} stake=$${b.stake_dollars} sold_pnl=$${b.realized_pnl} would-hold-pnl=$${heldPnl.toFixed(2)}  Δ=$${drag.toFixed(2)}  finalSide=${b.marketResult}`);
}
const sellDrag = sold.reduce((a, b) => {
  const wouldWin = b.marketResult && b.side && (b.marketResult.toLowerCase() === b.side.toLowerCase());
  const heldPnl = wouldWin
    ? b.stake_dollars * (1 - b.price) / b.price - (b.fees_paid || 0)
    : -b.stake_dollars;
  return a + (heldPnl - b.realized_pnl);
}, 0);
console.log(`Net drag from sell loop (positive = sells cost us): $${sellDrag.toFixed(2)}`);

// --- Win-rate sanity by outcome at each stake regime is identical (same bets, same outcomes) ---
// What changes is variance & dollar magnitude. Compute Sharpe-ish: pnl / std(pnl)
function sharpe(stakes) {
  const pnls = bets.map((b, i) => pnlAtStake(b, stakes[i]));
  const mean = pnls.reduce((a, x) => a + x, 0) / pnls.length;
  const std = Math.sqrt(pnls.reduce((a, x) => a + (x - mean) ** 2, 0) / pnls.length);
  return std > 0 ? mean / std : 0;
}
console.log(`\n=== Per-bet PnL Sharpe (mean / stdev) — higher = less variance per $ ===`);
console.log(`A. actual:        ${sharpe(actualStakes).toFixed(3)}`);
console.log(`B. combo path:    ${sharpe(comboStakes).toFixed(3)}`);
console.log(`C. flat $5:       ${sharpe(flat5Stakes).toFixed(3)}`);
console.log(`E. capped $5:     ${sharpe(jacksonCapped5).toFixed(3)}`);
