#!/usr/bin/env node
// Re-sweep MIN_EDGE under the CORRECTED per-contract fee (EDGE_AUDIT.md finding E).
//
// Why: kalshi.js currently subtracts a per-$1-STAKED fee (0.07·(1−P)) from a
// per-CONTRACT gross edge (p_model−P). The corrected fee is per contract:
// ceil(7·P·(1−P))/100. Switching the fee (FEE_PER_CONTRACT=true) raises every
// bet's net edge, so MIN_EDGE_* must be re-tuned or the bot over-admits. This
// script recomputes each SETTLED bet's net edge under both fee models and re-runs
// the upward-only MIN_EDGE tightening sweep, so you can pick the new floor.
//
// Honest scope (same as analyze_gate_sweeps.js): settled bets are only what the OLD
// gate ADMITTED, so we can measure the P&L of TIGHTENING but NOT of loosening /
// over-admission. What this DOES give you:
//   1. The ev_old → ev_new shift (how much looser the corrected metric reads), overall
//      and by price band — so you know how far to bump MIN_EDGE to hold selectivity.
//   2. The MIN_EDGE tightening sweep under the NEW fee (ALL/HIGH/LOW).
//   3. A "hold-selectivity" floor: the MIN_EDGE_new that still admits every bet the
//      old 0.28 gate admitted (safe migration starting point).
//
// Data: settled temp bets. Either
//   BETS_FILE=./audit.json node resweep_fee.js        (offline: a saved /api/jackson_audit dump)
//   AUTH="x:hydro" node resweep_fee.js                (live fetch of /jackson_audit)
// The JSON may be either the raw audit object ({temp:[...]}) or a bare array of bets.

import { readFileSync } from "node:fs";

const OLD_MIN_EDGE = 0.28;   // current production MIN_EDGE_HIGH/LOW (jackson_trader.js)

const feePerDollar   = (p) => 0.07 * (1 - p);
const feePerContract = (p) => Math.ceil(0.07 * p * (1 - p) * 100) / 100;

// Reconstruct gross edge from the recorded net edge + the OLD fee it was computed with,
// then re-net under the new fee. (gross = ev_old + feeOld; ev_new = gross − feeNew.)
function reprice(bet) {
  const price = bet.price;
  const evOld = bet.ev;
  if (price == null || evOld == null) return null;
  const gross = evOld + feePerDollar(price);
  const evNew = gross - feePerContract(price);
  return { ...bet, evOld, evNew, gross, feeDelta: feePerDollar(price) - feePerContract(price) };
}

async function loadBets() {
  const file = process.env.BETS_FILE;
  if (file) {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw : (raw.temp || raw.bets || []);
  }
  const BASE = process.env.BASE || "https://weatherbot-mf.netlify.app";
  const auth = process.env.AUTH || "x:hydro";
  const r = await fetch(`${BASE}/.netlify/functions/jackson_audit`, {
    headers: { authorization: `Basic ${Buffer.from(auth).toString("base64")}` },
  });
  if (!r.ok) throw new Error(`audit fetch ${r.status} (set BETS_FILE=<dump.json> to run offline)`);
  const j = await r.json();
  return j.temp || j.bets || [];
}

function priceBand(p) {
  if (p == null) return "unknown";
  if (p <= 0.10) return "cheap-tail";
  if (p < 0.45)  return "mid-low";
  if (p < 0.65)  return "mid-high";
  return "favorite";
}

// Upward-only tightening sweep on ev field `key`: for each candidate floor v, tally
// realized P&L of bets that would be REJECTED (ev < v). net = lossRecouped − winForgone.
function sweep(bets, key, variants, label) {
  console.log(`\n=== ${label} (n=${bets.length}) ===`);
  console.log(`floor  | n_rej | W_rej | L_rej | $win_forgone | $loss_recoup | net_delta`);
  console.log(`-------+-------+-------+-------+--------------+--------------+----------`);
  let best = { v: null, net: -Infinity };
  for (const v of variants) {
    let nRej = 0, wRej = 0, lRej = 0, winForgone = 0, lossRec = 0;
    for (const b of bets) {
      if ((b[key] ?? 0) >= v) continue;
      nRej++;
      const pnl = b.realized_pnl ?? 0;
      if (b.outcome === "WIN")  { wRej++; winForgone += pnl; }
      if (b.outcome === "LOSS") { lRej++; lossRec += -pnl; }
    }
    const net = lossRec - winForgone;
    if (net > best.net) best = { v, net };
    const f = (n) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${(-n).toFixed(2)}`);
    console.log(` ${v.toFixed(2)}  |  ${String(nRej).padStart(3)}  |  ${String(wRej).padStart(3)}  |  ${String(lRej).padStart(3)}  |  ${("$"+winForgone.toFixed(2)).padStart(10)}  |  ${("$"+lossRec.toFixed(2)).padStart(10)}  | ${f(net)}`);
  }
  console.log(`  best tightening floor: ${best.v} (net ${best.net >= 0 ? "+" : ""}$${best.net.toFixed(2)} vs no-tighten)`);
  return best;
}

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { min: s[0], p25: q(0.25), med: q(0.5), p75: q(0.75), max: s[s.length - 1] };
}

async function main() {
  const raw = await loadBets();
  const bets = raw
    .filter(b => b && (b.outcome === "WIN" || b.outcome === "LOSS"))
    .map(reprice)
    .filter(Boolean);
  if (!bets.length) { console.error("No settled WIN/LOSS bets with ev+price found."); process.exit(1); }

  console.log(`Loaded ${bets.length} settled bets (WIN/LOSS, with recorded ev + price).`);

  // 1) ev_old → ev_new shift.
  const deltas = bets.map(b => b.feeDelta);
  const d = stats(deltas);
  console.log(`\n=== Fee-model shift (ev_new − ev_old = feeOld − feePerContract) ===`);
  console.log(`overall Δedge:  min ${d.min.toFixed(3)}  p25 ${d.p25.toFixed(3)}  median ${d.med.toFixed(3)}  p75 ${d.p75.toFixed(3)}  max ${d.max.toFixed(3)}`);
  console.log(`(every bet's net edge rises by Δ under the corrected fee — largest on cheap bets.)`);
  const byBand = {};
  for (const b of bets) (byBand[priceBand(b.price)] ??= []).push(b.feeDelta);
  for (const k of ["cheap-tail", "mid-low", "mid-high", "favorite"]) {
    if (byBand[k]) { const s = stats(byBand[k]); console.log(`  ${k.padEnd(10)} n=${String(byBand[k].length).padStart(3)}  median Δ ${s.med.toFixed(3)}`); }
  }

  // 2) hold-selectivity floor: smallest ev_new among bets the old 0.28 gate admitted.
  const admitted = bets.filter(b => b.evOld >= OLD_MIN_EDGE);
  if (admitted.length) {
    const minNew = Math.min(...admitted.map(b => b.evNew));
    console.log(`\n=== Hold-selectivity floor ===`);
    console.log(`Old gate MIN_EDGE=${OLD_MIN_EDGE} admitted ${admitted.length} of these bets.`);
    console.log(`To admit that SAME set under the corrected fee, MIN_EDGE_new ≈ ${minNew.toFixed(3)}`);
    console.log(`(median admitted Δedge ${stats(admitted.map(b=>b.feeDelta)).med.toFixed(3)} → a selectivity-preserving`);
    console.log(` bump of roughly +${(minNew - OLD_MIN_EDGE).toFixed(3)} over the current 0.28. Start here, then sweep up.)`);
  }

  // 3) MIN_EDGE tightening sweep under the NEW fee, old fee shown for reference.
  const variants = [0.20, 0.25, 0.28, 0.30, 0.32, 0.35, 0.40, 0.45, 0.50];
  const high = bets.filter(b => b.variable === "high");
  const low  = bets.filter(b => b.variable === "low");
  console.log(`\n########## CORRECTED per-contract fee (ev_new) ##########`);
  sweep(bets, "evNew", variants, "MIN_EDGE (ALL) — corrected fee");
  sweep(high, "evNew", variants, "MIN_EDGE (HIGH) — corrected fee");
  sweep(low,  "evNew", variants, "MIN_EDGE (LOW) — corrected fee");
  console.log(`\n########## LEGACY per-$ fee (ev_old) — reference ##########`);
  sweep(bets, "evOld", variants, "MIN_EDGE (ALL) — legacy fee");

  console.log(`\nHow to read: pick the corrected-fee MIN_EDGE_new at/above the hold-selectivity`);
  console.log(`floor, then tighten toward the 'best tightening floor' if its net_delta is`);
  console.log(`meaningfully positive. Set jackson_trader.js MIN_EDGE_HIGH/LOW to the chosen`);
  console.log(`values, deploy with FEE_PER_CONTRACT=true, and watch realized ROI for drift.`);
  console.log(`\nCAVEAT: settled bets can't measure OVER-admission (bets the old gate rejected`);
  console.log(`aren't here). The hold-selectivity floor is the conservative migration target.`);
}

main().catch(e => { console.error(e); process.exit(1); });
