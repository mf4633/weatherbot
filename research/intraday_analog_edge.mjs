#!/usr/bin/env node
// Intraday edge scan for the PURE Claude analog model.
//
// Question (from the desk): does the analog card produce a tradeable edge at some
// ENTRY hour of the day — and does an EXIT before settlement help — or is the market
// efficient at every hour?
//
// Data: market_logger `?mode=export` (one record per city/variable/cycle) carries the
// model's summary (modelMean, modelStd), the full book (yes_ask/yes_bid per bucket), and
// the settled CLI extremum. We reconstruct the analog's bucket probabilities from a
// Gaussian(modelMean, modelStd) with the model's own [lo-0.5, hi+0.5] bin convention
// (the logged summary is all we have; the live mixture's pTrunc/depth were not snapshotted,
// so this is the analog's first-moment approximation — good enough to screen for an edge).
//
// Two experiments, both crossing the REAL spread and paying the confirmed Kalshi fee:
//   1. ENTRY-HOLD  — buy at hour H, hold to settlement. Grouped by H:
//                    model Brier vs market Brier (the pre-registered bar), + PnL of a
//                    "trust the analog" bucket picker.
//   2. ENTRY-EXIT  — buy at hour H (analog's cheap bucket), sell at hour X>H at that
//                    snapshot's yes_bid. Tests an intraday repricing edge (no settlement risk).
//
// Usage: SNAPSHOTS=./mlex.json node research/intraday_analog_edge.mjs
//        [EDGE=0.03] [SIDE=both|yes] [VAR=high|low|both]

import { readFileSync } from "node:fs";
import { erf } from "../erf.js";

const SNAP = process.env.SNAPSHOTS;
if (!SNAP) { console.error("set SNAPSHOTS=<export.json>"); process.exit(1); }
const EDGE_MIN = Number(process.env.EDGE ?? 0.03);   // min model_p - price to fire (after fee is added separately)
const VAR = (process.env.VAR ?? "both").toLowerCase();
const recs = JSON.parse(readFileSync(SNAP, "utf8"))
  .filter(r => r.settle?.extremumF != null && r.modelMean != null && r.modelStd > 0)
  .filter(r => VAR === "both" ? true : r.variable === VAR);

const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const feePerContract = (p) => Math.ceil(0.07 * p * (1 - p) * 100) / 100;

// model P(bucket) from Gaussian(mean,std), model's [lo-0.5, hi+0.5] bins, normalized over the book.
function modelProbs(r) {
  const { modelMean: m, modelStd: s } = r;
  const raw = r.buckets.map(b => {
    const lo = b.loInt == null ? -Infinity : b.loInt;
    const hi = b.hiInt == null ? Infinity : b.hiInt;
    const a = lo === -Infinity ? 0 : phi((lo - 0.5 - m) / s);
    const bb = hi === Infinity ? 1 : phi((hi + 0.5 - m) / s);
    return Math.max(0, bb - a);
  });
  const sum = raw.reduce((x, y) => x + y, 0) || 1;
  return raw.map(x => x / sum);
}
const wins = (b, x) => {
  const lo = b.loInt == null ? -Infinity : b.loInt;
  const hi = b.hiInt == null ? Infinity : b.hiInt;
  return x >= lo && x <= hi;
};

// ---------- Experiment 1: ENTRY-HOLD, grouped by entry hour ----------
// Per snapshot: model & market Brier over the whole book; and a "trust-analog" trade:
// buy YES on the bucket with the largest positive (model_p - yes_ask), if it clears EDGE_MIN.
const byHour = new Map(); // hour -> {mBrier, kBrier, nBins, bets:[]}
for (const r of recs) {
  const P = modelProbs(r);
  const x = Math.round(r.settle.extremumF);
  const h = r.localHour;
  if (!byHour.has(h)) byHour.set(h, { mSE: 0, kSE: 0, nBins: 0, bets: [] });
  const g = byHour.get(h);
  let best = null;
  r.buckets.forEach((b, i) => {
    if (b.yes_ask == null || b.yes_ask <= 0 || b.yes_ask >= 1) return;
    const o = wins(b, x) ? 1 : 0;
    g.mSE += (P[i] - o) ** 2;              // model Brier (its prob)
    g.kSE += (b.yes_ask - o) ** 2;         // market Brier (raw yes-ask = the price we'd pay)
    g.nBins++;
    const edge = P[i] - b.yes_ask;
    if (edge >= EDGE_MIN && (!best || edge > best.edge)) best = { b, i, o, edge, price: b.yes_ask };
  });
  if (best) {
    const fee = feePerContract(best.price);
    g.bets.push({ pnl: (best.o ? 1 : 0) - best.price - fee, win: best.o, price: best.price,
                  cost: best.price + fee, date: r.dateLocal, city: r.city, var: r.variable,
                  edge: best.edge, mp: P[best.i] });
  }
}

console.log(`\n=== EXPERIMENT 1: ENTRY-HOLD  (${recs.length} snapshots, ${new Set(recs.map(r=>r.city+r.dateLocal+r.variable)).size} settled city-day-var, EDGE>=${EDGE_MIN}) ===`);
console.log("hr | binN  mBrier kBrier  Δ(m-k) | bets  win%   ROI%    net$");
let allBets = [];
for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
  const g = byHour.get(h);
  const mB = g.mSE / g.nBins, kB = g.kSE / g.nBins;
  const n = g.bets.length, w = g.bets.filter(x => x.win).length;
  const net = g.bets.reduce((a, x) => a + x.pnl, 0), cost = g.bets.reduce((a, x) => a + x.cost, 0);
  allBets = allBets.concat(g.bets);
  const roi = cost ? (100 * net / cost) : 0;
  console.log(`${String(h).padStart(2)} | ${String(g.nBins).padStart(4)}  ${mB.toFixed(4)} ${kB.toFixed(4)}  ${(mB-kB>=0?"+":"")}${(mB-kB).toFixed(4)} | ${String(n).padStart(4)}  ${n?(100*w/n).toFixed(0):"--"}%  ${n?roi.toFixed(1):"--"}   ${net.toFixed(2)}`);
}
{
  const mSE = [...byHour.values()].reduce((a, g) => a + g.mSE, 0);
  const kSE = [...byHour.values()].reduce((a, g) => a + g.kSE, 0);
  const nB = [...byHour.values()].reduce((a, g) => a + g.nBins, 0);
  const n = allBets.length, w = allBets.filter(x => x.win).length;
  const net = allBets.reduce((a, x) => a + x.pnl, 0), cost = allBets.reduce((a, x) => a + x.cost, 0);
  console.log("-".repeat(60));
  console.log(`ALL| ${String(nB).padStart(4)}  ${(mSE/nB).toFixed(4)} ${(kSE/nB).toFixed(4)}  ${(mSE/nB-kSE/nB>=0?"+":"")}${(mSE/nB-kSE/nB).toFixed(4)} | ${String(n).padStart(4)}  ${n?(100*w/n).toFixed(0):"--"}%  ${cost?(100*net/cost).toFixed(1):"--"}   ${net.toFixed(2)}`);
  console.log(`\nmBrier<kBrier means the analog beats the price it pays. Bar: beat market Brier ~0.19 out-of-sample AND ROI>0 at n>=~30/side.`);
}

// ---------- Experiment 2: ENTRY-EXIT intraday (no settlement) ----------
// For each city-day-var: at entry hour H, the analog picks its cheapest-vs-fair YES bucket
// (edge>=EDGE_MIN). We then look for the best later hour X to sell at that snapshot's yes_bid.
// PnL = sell_bid - buy_ask - 2 fees. Reports whether an intraday repricing edge exists.
const groups = new Map();
for (const r of recs) {
  const k = `${r.city}|${r.dateLocal}|${r.variable}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const exitRows = []; // {hHold, roundtrip pnl}
let n2 = 0, netHoldBest = 0, netFixedExit = 0, nFixed = 0;
const holdBuckets = new Map(); // hoursHeld -> {n, net, cost}
for (const [, arr] of groups) {
  arr.sort((a, b) => a.localHour - b.localHour);
  for (let ei = 0; ei < arr.length; ei++) {
    const r = arr[ei];
    const P = modelProbs(r);
    let best = null;
    r.buckets.forEach((b, i) => {
      if (b.yes_ask == null || b.yes_ask <= 0 || b.yes_ask >= 1) return;
      const edge = P[i] - b.yes_ask;
      if (edge >= EDGE_MIN && (!best || edge > best.edge)) best = { ticker: b.ticker, i, edge, ask: b.yes_ask };
    });
    if (!best) continue;
    n2++;
    // find each later snapshot's bid for the same ticker
    for (let xi = ei + 1; xi < arr.length; xi++) {
      const later = arr[xi];
      const lb = later.buckets.find(b => b.ticker === best.ticker);
      if (!lb || lb.yes_bid == null) continue;
      const held = later.localHour - r.localHour;
      const pnl = lb.yes_bid - best.ask - feePerContract(best.ask) - feePerContract(lb.yes_bid);
      if (!holdBuckets.has(held)) holdBuckets.set(held, { n: 0, net: 0, cost: 0 });
      const hb = holdBuckets.get(held);
      hb.n++; hb.net += pnl; hb.cost += best.ask + feePerContract(best.ask);
    }
  }
}
console.log(`\n=== EXPERIMENT 2: ENTRY->EXIT intraday repricing (${n2} analog entries, sell at later yes_bid) ===`);
console.log("held(h) | n   net$    ROI%   (sell the analog's cheap bucket back to the market before settlement)");
for (const h of [...holdBuckets.keys()].sort((a, b) => a - b)) {
  const hb = holdBuckets.get(h);
  console.log(`${String(h).padStart(6)}  | ${String(hb.n).padStart(3)}  ${hb.net.toFixed(2).padStart(7)}  ${hb.cost?(100*hb.net/hb.cost).toFixed(1):"--"}`);
}
