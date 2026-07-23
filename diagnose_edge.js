// Where exactly does the strategy bleed, and is there ANY exploitable edge in this
// information set? Runs on market_logger snapshots joined with CLI settlement.
//
// Three questions, in increasing order of importance:
//   1. Is the MODEL calibrated? (reliability curve: claimed p vs realized frequency)
//   2. Is the MARKET calibrated? (market price vs realized frequency) -- if the market
//      is efficient on these books, no model built on this same information set can
//      beat it, and "fix the model" is the wrong project.
//   3. If the market IS mispriced somewhere, WHERE? (by hour, side, price, distance
//      of the bucket from maxSoFar) -- that is the only place a fix could live.
//
// Usage: SNAPSHOTS=path node diagnose_edge.js
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(process.env.SNAPSHOTS || "./snaps.json", "utf-8"))
  .filter(r => r.settle && r.settle.extremumF != null);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function normCdf(z) {
  const s = z < 0 ? -1 : 1; const a = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return 0.5 * (1 + s * y);
}
function bucketProb(mean, std, loInt, hiInt, lowerFloor, upperFloor) {
  let lo = (loInt == null || loInt === -Infinity) ? -Infinity : loInt - 0.5;
  let hi = (hiInt == null || hiInt === Infinity) ? Infinity : hiInt + 0.5;
  if (lowerFloor != null) { if (hi < lowerFloor) return 0; if (lo < lowerFloor) lo = lowerFloor; }
  if (upperFloor != null) { if (lo > upperFloor) return 0; if (hi > upperFloor) hi = upperFloor; }
  const pH = hi === Infinity ? 1 : normCdf((hi - mean) / std);
  const pL = lo === -Infinity ? 0 : normCdf((lo - mean) / std);
  return Math.max(0, pH - pL);
}
const wins = (e, lo, hi) => e >= ((lo == null || lo === -Infinity) ? -Infinity : lo)
                         && e <= ((hi == null || hi === Infinity) ? Infinity : hi);

// Build every YES opportunity (one row per bucket per snapshot), with model p, market
// mid, and realized outcome. NO is the mirror, so YES alone characterises both sides.
const obs = [];
for (const r of rows) {
  const std = r.variable === "high" ? clamp(2.131, 1.5, 2.5) : clamp(1.5, 1.5, 2.5);
  const lowerFloor = r.variable === "high" && r.maxSoFar != null ? Math.floor(r.maxSoFar) : null;
  const upperFloor = r.variable === "low" && r.minSoFar != null ? Math.ceil(r.minSoFar) : null;
  const raw = r.buckets.map(b => bucketProb(r.modelMean, std, b.loInt, b.hiInt, lowerFloor, upperFloor));
  const sum = raw.reduce((a, x) => a + x, 0);
  if (sum <= 0) continue;
  for (let i = 0; i < r.buckets.length; i++) {
    const b = r.buckets[i];
    if (b.yes_bid == null || b.yes_ask == null) continue;
    const mid = (b.yes_bid + b.yes_ask) / 2;
    obs.push({
      variable: r.variable, localHour: r.localHour, city: r.city, date: r.dateLocal,
      pModel: raw[i] / sum, mid, yes_ask: b.yes_ask, no_ask: b.no_ask,
      won: wins(r.settle.extremumF, b.loInt, b.hiInt) ? 1 : 0,
      // how far above maxSoFar the bucket sits (HIGH only)
      dist: (r.variable === "high" && r.maxSoFar != null && b.loInt != null && b.loInt !== -Infinity)
        ? b.loInt - r.maxSoFar : null
    });
  }
}
console.log(`opportunities: ${obs.length}  (from ${rows.length} settled snapshots)\n`);

function reliability(list, keyFn, label) {
  const BINS = [[0, .02], [.02, .05], [.05, .10], [.10, .20], [.20, .35], [.35, .50],
                [.50, .65], [.65, .80], [.80, .90], [.90, .95], [.95, .98], [.98, 1.01]];
  console.log(`=== ${label} ===`);
  console.log("bin           n       predicted   realized   diff");
  let brier = 0;
  for (const [lo, hi] of BINS) {
    const s = list.filter(o => keyFn(o) >= lo && keyFn(o) < hi);
    if (s.length < 15) continue;
    const pred = s.reduce((a, o) => a + keyFn(o), 0) / s.length;
    const real = s.reduce((a, o) => a + o.won, 0) / s.length;
    const flag = Math.abs(pred - real) > 0.15 ? "  <<<" : "";
    console.log(`[${lo.toFixed(2)},${hi.toFixed(2)})  ${String(s.length).padEnd(7)} ${(pred * 100).toFixed(1).padStart(7)}%   ${(real * 100).toFixed(1).padStart(7)}%  ${((real - pred) * 100).toFixed(1).padStart(6)}${flag}`);
  }
  brier = list.reduce((a, o) => a + (keyFn(o) - o.won) ** 2, 0) / list.length;
  console.log(`Brier: ${brier.toFixed(4)}\n`);
  return brier;
}

for (const v of ["high", "low"]) {
  const s = obs.filter(o => o.variable === v);
  const bm = reliability(s, o => o.pModel, `MODEL reliability — ${v} (n=${s.length})`);
  const bk = reliability(s, o => o.mid, `MARKET reliability — ${v} (n=${s.length})`);
  console.log(`>>> ${v}: model Brier ${bm.toFixed(4)}  vs  market Brier ${bk.toFixed(4)}  `
    + `→ ${bm < bk ? "MODEL better" : "MARKET better"} by ${Math.abs(bm - bk).toFixed(4)}\n`);
}

// Where, if anywhere, is the market itself mispriced? Realized minus market mid, by
// slice. A persistently non-zero column is the only place an edge could live.
console.log("=== market mispricing by slice (realized − market mid), HIGH ===");
console.log("slice                    n       mkt mid   realized   edge");
const hi = obs.filter(o => o.variable === "high");
const slices = [
  ["hour <= 11", o => o.localHour <= 11],
  ["hour 12-14", o => o.localHour >= 12 && o.localHour <= 14],
  ["hour 15-17", o => o.localHour >= 15 && o.localHour <= 17],
  ["hour >= 18", o => o.localHour >= 18],
  ["cheap (mid<0.05)", o => o.mid < 0.05],
  ["mid 0.05-0.20", o => o.mid >= 0.05 && o.mid < 0.20],
  ["mid 0.20-0.80", o => o.mid >= 0.20 && o.mid < 0.80],
  ["rich (mid>0.80)", o => o.mid > 0.80],
  ["bucket at maxSoFar (d=0..1)", o => o.dist != null && o.dist >= 0 && o.dist <= 1],
  ["bucket +2..3 above", o => o.dist != null && o.dist >= 2 && o.dist <= 3],
  ["bucket +4 or more", o => o.dist != null && o.dist >= 4],
];
for (const [name, f] of slices) {
  const s = hi.filter(f);
  if (s.length < 25) continue;
  const mid = s.reduce((a, o) => a + o.mid, 0) / s.length;
  const real = s.reduce((a, o) => a + o.won, 0) / s.length;
  const se = Math.sqrt(real * (1 - real) / s.length);
  const z = se > 0 ? (real - mid) / se : 0;
  console.log(`${name.padEnd(26)} ${String(s.length).padEnd(7)} ${(mid * 100).toFixed(1).padStart(7)}%  ${(real * 100).toFixed(1).padStart(8)}%  `
    + `${((real - mid) * 100).toFixed(1).padStart(6)}pp  (z=${z.toFixed(1)})`);
}
