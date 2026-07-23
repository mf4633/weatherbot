#!/usr/bin/env node
// Upward-only gate sweeps against historical settled bets. Honest scope:
//   - Settled bets reflect only what the OLD gates ADMITTED. We cannot directly
//     measure the upside of LOOSENING any threshold (those bets weren't placed).
//   - We CAN measure: "if we tighten threshold from X to Y, which currently-
//     admitted bets would we have rejected, and what was their net P&L?"
//
// Loss function for each gate variant: net P&L delta on the existing bet
// population = sum(realized_pnl of rejected LOSSES) - sum(realized_pnl of
// rejected WINS). Positive = tightening would have improved P&L. Negative =
// tightening would have hurt.
//
// Run: AUTH="x:hydro" node analyze_gate_sweeps.js
//
// Stratifications: ALL / HIGH / LOW / by-price-band (cheap-tail / mid / favorite).
// Constants under sweep: MIN_EDGE, MIN_HALF_KELLY, MIN_PRICE.

const BASE = "https://weatherbot-mf.netlify.app";
const auth = process.env.AUTH || "x:hydro";

async function fetchBets() {
  const r = await fetch(`${BASE}/.netlify/functions/jackson_audit`, {
    headers: { authorization: `Basic ${Buffer.from(auth).toString("base64")}` }
  });
  if (!r.ok) throw new Error(`audit ${r.status}`);
  const j = await r.json();
  return j.temp || [];
}

function priceBand(price) {
  if (price == null) return "unknown";
  if (price <= 0.10) return "cheap-tail";
  if (price < 0.45)  return "mid-low";
  if (price < 0.65)  return "mid-high";
  return "favorite";
}

function sweepGate(bets, variantName, variants, predicate) {
  // For each variant value v, mark bets where the OLD-side check passed but the
  // NEW-side check (predicate(bet, v)) rejects. Tally realized P&L on those.
  console.log(`\n=== ${variantName} sweep (n=${bets.length}) ===`);
  console.log(`var      | n_reject | wins_rej | loss_rej | $win_forgone | $loss_recouped | net_delta`);
  console.log(`---------+----------+----------+----------+--------------+----------------+----------`);
  for (const v of variants) {
    let nRej = 0, winsRej = 0, lossRej = 0, winForgone = 0, lossRec = 0;
    for (const b of bets) {
      if (!predicate(b, v)) continue;
      nRej++;
      const pnl = b.realized_pnl ?? 0;
      if (b.outcome === "WIN")  { winsRej++; winForgone += pnl; }
      if (b.outcome === "LOSS") { lossRej++; lossRec   += -pnl; }
    }
    const net = lossRec - winForgone;
    const fmt = n => n >= 0 ? `+$${n.toFixed(2)}` : `-$${(-n).toFixed(2)}`;
    console.log(` ${String(v).padEnd(7)} |   ${String(nRej).padStart(3)}    |    ${String(winsRej).padStart(2)}    |    ${String(lossRej).padStart(2)}    |    $${winForgone.toFixed(2).padStart(6)}    |     $${lossRec.toFixed(2).padStart(6)}     | ${fmt(net)}`);
  }
}

function summarize(bets, label) {
  const wins = bets.filter(b => b.outcome === "WIN");
  const losses = bets.filter(b => b.outcome === "LOSS");
  const stake = bets.reduce((a, b) => a + (b.stake_dollars ?? 0), 0);
  const pnl = bets.reduce((a, b) => a + (b.realized_pnl ?? 0), 0);
  const hitRate = wins.length / (wins.length + losses.length || 1);
  console.log(`[${label}] n=${bets.length} W=${wins.length} L=${losses.length} hit=${(hitRate*100).toFixed(1)}% stake=$${stake.toFixed(2)} pnl=$${pnl.toFixed(2)}`);
}

async function main() {
  const all = (await fetchBets()).filter(b => b.outcome === "WIN" || b.outcome === "LOSS");
  console.log(`Loaded ${all.length} settled WIN/LOSS bets.`);
  summarize(all, "POPULATION");

  // Strata.
  const high = all.filter(b => b.variable === "high");
  const low  = all.filter(b => b.variable === "low");
  summarize(high, "HIGH");
  summarize(low,  "LOW");

  // ---- MIN_EDGE sweep ----
  const edgeVariants = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
  const edgePred = (b, v) => (b.ev ?? 0) < v;  // would be rejected if ev < v
  sweepGate(all,  "MIN_EDGE (ALL)",  edgeVariants, edgePred);
  sweepGate(high, "MIN_EDGE (HIGH)", edgeVariants, edgePred);
  sweepGate(low,  "MIN_EDGE (LOW)",  edgeVariants, edgePred);

  // ---- MIN_HALF_KELLY sweep ----
  const kellyVariants = [0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25];
  const kellyPred = (b, v) => (b.halfKelly ?? 0) < v;
  sweepGate(all,  "MIN_HALF_KELLY (ALL)",  kellyVariants, kellyPred);
  sweepGate(high, "MIN_HALF_KELLY (HIGH)", kellyVariants, kellyPred);
  sweepGate(low,  "MIN_HALF_KELLY (LOW)",  kellyVariants, kellyPred);

  // ---- MIN_PRICE sweep (cheap-tail filter) ----
  const priceVariants = [0.02, 0.04, 0.06, 0.08, 0.10, 0.15];
  const pricePred = (b, v) => (b.price ?? 0) < v;
  sweepGate(all,  "MIN_PRICE (ALL)",  priceVariants, pricePred);

  // ---- Price band breakdown ----
  console.log(`\n=== By price band ===`);
  const bands = {};
  for (const b of all) {
    const k = priceBand(b.price);
    (bands[k] ??= []).push(b);
  }
  for (const k of ["cheap-tail", "mid-low", "mid-high", "favorite"]) {
    if (bands[k]) summarize(bands[k], k);
  }

  // ---- Joint MIN_EDGE × MIN_HALF_KELLY recommendation ----
  console.log(`\n=== Joint MIN_EDGE × MIN_HALF_KELLY net delta (ALL bets) ===`);
  console.log(`edge\\hk  ` + kellyVariants.map(k => k.toFixed(2).padStart(7)).join("  "));
  for (const e of edgeVariants) {
    const row = [];
    for (const k of kellyVariants) {
      let lossRec = 0, winForgone = 0;
      for (const b of all) {
        if ((b.ev ?? 0) >= e && (b.halfKelly ?? 0) >= k) continue;  // would still pass new joint gate
        const pnl = b.realized_pnl ?? 0;
        if (b.outcome === "WIN")  winForgone += pnl;
        if (b.outcome === "LOSS") lossRec += -pnl;
      }
      const net = lossRec - winForgone;
      row.push((net >= 0 ? `+${net.toFixed(1)}` : `${net.toFixed(1)}`).padStart(7));
    }
    console.log(`${e.toFixed(2)}    ` + row.join("  "));
  }
  console.log(`\nReading: cell = $ net delta vs production gates if we tightened BOTH thresholds.`);
  console.log(`Positive = tightening would have improved P&L on existing bets.`);
  console.log(`Production currently at edge=0.20, hk=0.10 — find the highest positive cell relative to (0.20, 0.10).`);
}

main().catch(e => { console.error(e); process.exit(1); });
