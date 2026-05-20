// Targeted σ-margin gate sweep over historical settled bets.
// Reuses backtest_gates.js logic (lines 300-367) but skips the slow
// Open-Meteo reconstruction needed for tail-obs/bucket-obs gates.
// Run: node analyze_sigma_margin_only.js _all_settled.ndjson

import { readFileSync } from "node:fs";

const NDJSON_PATH = process.argv[2] || "_all_settled.ndjson";

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

function sigmaBucketMargin(bet, sigmaIrred) {
  const code = bet.ticker?.split("-").pop();
  if (!code || !code.startsWith("B")) return null;
  const bb = parseBucketStr(bet.bucket);
  if (!bb) return null;
  if (!Number.isFinite(bb.loInt) || !Number.isFinite(bb.hiInt)) return null;
  if (bet.modelMean == null || bet.modelStd == null) return null;
  const sigmaEff = Math.sqrt(bet.modelStd ** 2 + sigmaIrred ** 2);
  const contLo = bb.loInt - 0.5;
  const contHi = bb.hiInt + 0.5;
  return Math.min(
    Math.abs(bet.modelMean - contLo) / sigmaEff,
    Math.abs(bet.modelMean - contHi) / sigmaEff
  );
}

const SIGMA_IRREDUCIBLE_PROD = 1.3;
const SIGMA_IRRED_PRE_BUMP   = 1.0;
const Z_VARIANTS = [0.0, 0.3, 0.4, 0.5, 0.6, 0.7];

const lines = readFileSync(NDJSON_PATH, "utf-8").trim().split(/\r?\n/);
const bets = lines.map(l => JSON.parse(l));
const candidates = bets.filter(b => b.outcome !== "SOLD" && b.outcome !== "UNKNOWN");
console.log(`Loaded ${bets.length} settled bets, ${candidates.length} eligible (excl SOLD/UNKNOWN)`);

// Restrict to B-bucket bets since the σ-margin gate only applies to those
const bBucket = candidates.filter(b => b.ticker?.split("-").pop()?.startsWith("B"));
console.log(`B-bucket bets (gate applies): ${bBucket.length}`);
const totalBPnl = bBucket.reduce((s, b) => s + (b.realized_pnl ?? 0), 0);
console.log(`B-bucket total realized P&L: $${totalBPnl.toFixed(2)}\n`);

function runSweep(sigmaIrred, label) {
  console.log(`=== σ-BUCKET-MARGIN at σ_irred=${sigmaIrred} ${label} ===`);
  console.log(`Z      | gate-bites | TP (loss) | FP (win) | $loss recouped | $win forgone | net`);
  console.log(`-------+------------+-----------+----------+----------------+--------------+------`);
  for (const Z of Z_VARIANTS) {
    let tp = 0, fp = 0, lossRec = 0, winForgone = 0;
    for (const bet of bBucket) {
      const m = sigmaBucketMargin(bet, sigmaIrred);
      if (m == null) continue;
      if (m >= Z) continue;
      if (bet.outcome === "LOSS") { tp++; lossRec += -(bet.realized_pnl || 0); }
      else if (bet.outcome === "WIN") { fp++; winForgone += (bet.realized_pnl || 0); }
    }
    const net = lossRec - winForgone;
    const flag = Z === 0.5 ? " <-PROD" : "";
    console.log(` ${Z.toFixed(1)}   |    ${String(tp+fp).padStart(3)}     |    ${String(tp).padStart(2)}    |    ${String(fp).padStart(2)}    |    $${lossRec.toFixed(2).padStart(7)}   |   $${winForgone.toFixed(2).padStart(6)}  | $${net.toFixed(2)}${flag}`);
  }
  console.log("");
}

runSweep(SIGMA_IRREDUCIBLE_PROD, "(production)");
runSweep(SIGMA_IRRED_PRE_BUMP, "(pre-bump baseline)");

// Per-bet detail at production Z=0.5 to see exactly which bets the current gate kills
console.log(`=== Z=0.5 PROD GATE — per-bet bites (σ_irred=${SIGMA_IRREDUCIBLE_PROD}) ===`);
const bites = [];
for (const b of bBucket) {
  const m = sigmaBucketMargin(b, SIGMA_IRREDUCIBLE_PROD);
  if (m != null && m < 0.5) bites.push({ bet: b, m });
}
bites.sort((a, b) => a.m - b.m);
const wins = bites.filter(x => x.bet.outcome === "WIN");
const losses = bites.filter(x => x.bet.outcome === "LOSS");
console.log(`${bites.length} bites = ${wins.length}W / ${losses.length}L`);
console.log(`win-rate of gated bets: ${(wins.length / Math.max(1, bites.length) * 100).toFixed(1)}%  (compare to overall ${(candidates.filter(b => b.outcome === "WIN").length / candidates.filter(b => ["WIN", "LOSS"].includes(b.outcome)).length * 100).toFixed(1)}%)`);
console.log(`\nrecent bites (last 30):`);
const recent = bites.slice().sort((a, b) => (b.bet.settledAtUTC || "").localeCompare(a.bet.settledAtUTC || "")).slice(0, 30);
for (const { bet, m } of recent) {
  const out = bet.outcome === "LOSS" ? "L" : bet.outcome === "WIN" ? "W" : "?";
  const date = (bet.settledAtUTC || "").slice(0, 10);
  console.log(`  ${date} ${out} ${bet.city.padEnd(18)} ${bet.ticker} ${bet.variable}/${bet.side}  μ=${bet.modelMean}±${bet.modelStd}  z=${m.toFixed(3)}  pnl=$${(bet.realized_pnl ?? 0).toFixed(2)}`);
}
