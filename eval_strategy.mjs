#!/usr/bin/env node
// Strategy evaluation harness. Replays recorded market snapshots (from market_logger.js)
// through a candidate strategy with REALISTIC fills (cross the spread, pay the confirmed
// per-contract fee, optional latency slippage), settles against the recorded CLI extremum,
// and reports the numbers that actually decide whether to risk money:
//   - n bets, and the strategy's realized win rate vs its CLAIMED probability
//     (for obs-lock-in the realized win rate MUST be ~100%; below that the physical
//      bounds are too tight and need widening — this is the strategy's safety check),
//   - net ROI after real fills, overall and split train/test,
//   - abstention rate (how often the edge simply isn't there).
//
// Usage:
//   node eval_strategy.mjs --synthetic         # self-test on generated snapshots (no network)
//   SNAPSHOTS=./snaps.json node eval_strategy.mjs   # real shadow-logged snapshots
//
// Snapshot record schema (one per city/variable/cycle), produced by market_logger.js:
//   { ts, dateLocal, city, variable, localHour, currentTemp, maxSoFar, minSoFar,
//     buckets:[{ticker,loInt,hiInt,yes_ask,yes_bid,no_ask,no_bid,last,volume}],
//     settle:{ extremumF } }   // extremumF = final CLI high (variable=high) or low (=low)

import { readFileSync } from "node:fs";
import { lockinBets, feePerContract } from "./netlify/functions/lib/strategy_lockin.js";

const LATENCY_SLIP = Number(process.env.LATENCY_SLIP ?? 0.0); // extra cents paid vs quoted ask

// Does side/bucket win at final integer CLI extremum x?
function betWins(side, loInt, hiInt, x) {
  const loF = loInt != null && loInt !== -Infinity;
  const hiF = hiInt != null && hiInt !== Infinity;
  const inRange = (!loF || x >= loInt) && (!hiF || x <= hiInt);
  return side.toLowerCase() === "yes" ? inRange : !inRange;
}

// Run one strategy over records; dedupe to the FIRST signal per (city,variable,date,ticker,side).
function runStrategy(records, strategy) {
  const seen = new Set();
  const bets = [];
  for (const r of records) {
    if (r.settle?.extremumF == null) continue;         // unsettled → can't score
    const cands = strategy({ variable: r.variable,
      obs: { maxSoFar: r.maxSoFar, minSoFar: r.minSoFar, currentTemp: r.currentTemp, localHour: r.localHour },
      buckets: r.buckets });
    for (const c of cands) {
      const key = `${r.city}|${r.variable}|${r.dateLocal}|${c.ticker}|${c.side}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fillPrice = Math.min(0.99, c.price + LATENCY_SLIP);
      const win = betWins(c.side, bucketLo(r, c.ticker), bucketHi(r, c.ticker), Math.round(r.settle.extremumF));
      const fee = feePerContract(fillPrice);
      const pnl = (win ? 1 : 0) - fillPrice - fee;      // per contract
      bets.push({ ...c, city: r.city, variable: r.variable, date: r.dateLocal,
                  fillPrice, win: win ? 1 : 0, pnl, month: (r.dateLocal || "").slice(0, 7) });
    }
  }
  return bets;
}
const bucketLo = (r, tk) => (r.buckets.find(b => b.ticker === tk) || {}).loInt ?? null;
const bucketHi = (r, tk) => (r.buckets.find(b => b.ticker === tk) || {}).hiInt ?? null;

function report(label, bets) {
  if (!bets.length) { console.log(`\n[${label}] 0 bets (strategy never fired / always abstained).`); return; }
  const n = bets.length, w = bets.filter(b => b.win).length;
  const cost = bets.reduce((a, b) => a + b.fillPrice + feePerContract(b.fillPrice), 0);
  const pnl = bets.reduce((a, b) => a + b.pnl, 0);
  console.log(`\n[${label}] n=${n}  realized win rate=${(100*w/n).toFixed(1)}%  net PnL/contract-stack=$${pnl.toFixed(2)}  ROI=${(100*pnl/cost).toFixed(1)}%  avg claimed edge=${(bets.reduce((a,b)=>a+b.edge,0)/n).toFixed(3)}`);
  if (w < n) {
    console.log(`  ⚠️  ${n-w} "certain-win" lock-in(s) LOST — physical bounds too tight. Offenders:`);
    for (const b of bets.filter(x => !x.win).slice(0, 8))
      console.log(`     ${b.date} ${b.city} ${b.ticker.split("-").pop()} ${b.side} @${b.fillPrice} (${b.reason})`);
  } else {
    console.log(`  ✓ all ${n} lock-ins won — bounds held (safety check passed).`);
  }
}

// ---- synthetic snapshot generator (deterministic; no Math.random) ----
function synthetic() {
  const recs = [];
  // 40 genuine locked winners across days: 5pm high already past the threshold, market underpays.
  for (let i = 0; i < 40; i++) {
    const day = `2026-0${i < 20 ? 6 : 7}-${String((i % 20) + 1).padStart(2, "0")}`;
    const maxSoFar = 90 + (i % 8);                  // 90..97
    const strike = maxSoFar - 2;                    // ">= strike" already satisfied
    const finalHigh = maxSoFar + (i % 2);           // rises 0-1 more, stays >= strike
    recs.push({ ts: `${day}T22:00Z`, dateLocal: day, city: `C${i%13}`, variable: "high",
      localHour: 17, currentTemp: maxSoFar - 1, maxSoFar, minSoFar: null,
      buckets: [{ ticker: `KXHIGHC${i%13}-${day}-T${strike-1}`, loInt: strike, hiInt: null,
                  yes_ask: 0.82 + (i % 5) * 0.02, no_ask: 0.15 }],
      settle: { extremumF: finalHigh } });
  }
  // 15 locked-but-fairly-priced (ask 0.99) → strategy must ABSTAIN.
  for (let i = 0; i < 15; i++) {
    const day = `2026-06-${String(i + 1).padStart(2, "0")}`;
    recs.push({ ts: `${day}T22:00Z`, dateLocal: day, city: `F${i}`, variable: "high",
      localHour: 18, currentTemp: 95, maxSoFar: 96, minSoFar: null,
      buckets: [{ ticker: `KXHIGHF${i}-${day}-T90`, loInt: 91, hiInt: null, yes_ask: 0.99, no_ask: 0.02 }],
      settle: { extremumF: 96 } });
  }
  // 15 morning/uncertain snapshots → strategy must ABSTAIN (no lock yet).
  for (let i = 0; i < 15; i++) {
    const day = `2026-06-${String(i + 1).padStart(2, "0")}`;
    recs.push({ ts: `${day}T15:00Z`, dateLocal: day, city: `U${i}`, variable: "high",
      localHour: 9, currentTemp: 70, maxSoFar: 71, minSoFar: null,
      buckets: [{ ticker: `KXHIGHU${i}-${day}-B85`, loInt: 85, hiInt: 85, yes_ask: 0.30, no_ask: 0.68 }],
      settle: { extremumF: 88 } });
  }
  // 2 INJECTED failures: bounds asserted certain-win but a settlement fluke lost it
  // (simulates bounds set too tight — the harness MUST flag these).
  for (let i = 0; i < 2; i++) {
    const day = `2026-07-2${i}`;
    recs.push({ ts: `${day}T23:30Z`, dateLocal: day, city: `X${i}`, variable: "high",
      localHour: 19, currentTemp: 88, maxSoFar: 90, minSoFar: null,
      buckets: [{ ticker: `KXHIGHX${i}-${day}-T89`, loInt: 90, hiInt: null, yes_ask: 0.80, no_ask: 0.17 }],
      settle: { extremumF: 89 } });   // CLI came in 89 < 90 → "≥90" YES loses despite maxSoFar 90
  }
  return recs;
}

// ---- main ----
const useSynthetic = process.argv.includes("--synthetic") || !process.env.SNAPSHOTS;
const records = useSynthetic
  ? synthetic()
  : JSON.parse(readFileSync(process.env.SNAPSHOTS, "utf8"));
console.log(`Evaluating obs-lock-in over ${records.length} snapshot records` +
            (useSynthetic ? " (SYNTHETIC self-test)" : ` from ${process.env.SNAPSHOTS}`) +
            `  [latency slip ${LATENCY_SLIP}]`);

const bets = runStrategy(records, (s) => lockinBets(s));
report("obs-lock-in ALL", bets);
report("  train (2026-05/06)", bets.filter(b => b.month <= "2026-06"));
report("  test (2026-07+)", bets.filter(b => b.month >= "2026-07"));
console.log(`\nAbstention: strategy fired on ${new Set(bets.map(b=>b.date+b.city)).size} of ${new Set(records.map(r=>r.dateLocal+r.city)).size} (city,day) snapshots.`);
console.log(`\nDECISION RULE: promote to a real-money pilot only if realized win rate ≈ 100% AND net ROI > 0 after real fills, in BOTH splits, at n large enough to matter (≥ ~30/side). Otherwise widen bounds or abstain.`);
