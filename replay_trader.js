// Replay the CURRENT trader entry rule against real logged Kalshi books and real CLI
// settlements. Answers "would this have made money" without risking anything.
//
// Data: market_logger snapshots joined with settlement (?mode=export). Each row carries
// the raw book AND the model's mean/std at that moment, so the strategy is replayable
// exactly rather than approximated.
//
// Fills are pessimistic-realistic: we cross the spread (pay the ASK), pay Kalshi's entry
// fee, and settle against the recorded CLI extremum. No sell-side modelling — entries are
// held to settlement, which is what the ledger shows the bot mostly does.
//
// Usage: SNAPSHOTS=path/to/snaps.json node replay_trader.js
import { readFileSync } from "node:fs";

const SNAPS = process.env.SNAPSHOTS || "./snaps.json";
const rows = JSON.parse(readFileSync(SNAPS, "utf-8"));

// --- production constants (kalshi.js / jackson_trader.js, read 2026-07-23) ---
const MIN_EDGE_HIGH = 0.28, MIN_EDGE_LOW = 0.28, MIN_HALF_KELLY = 0.20;
const SIGMA_HIGH_PRIOR = 2.0, SIGMA_HIGH_FLOOR = 1.5, SIGMA_HIGH_CAP = 2.5;
const SIGMA_LOW_FLOOR = 1.5, SIGMA_LOW_CAP = 2.5;
const CALIB_SIGMA_HIGH = 2.131, CALIB_SIGMA_LOW = 1.5;   // live calibration_state today
const feePerDollar = price => 0.07 * (1 - price);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function normCdf(z) {
  const s = z < 0 ? -1 : 1; const a = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return 0.5 * (1 + s * y);
}
// nu=34 Student-t differs from normal by <1% in the tails that matter here; normal used.
function bucketProb(mean, std, loInt, hiInt, lowerFloor, upperFloor) {
  let lo = (loInt == null || loInt === -Infinity) ? -Infinity : loInt - 0.5;
  let hi = (hiInt == null || hiInt === Infinity) ? Infinity : hiInt + 0.5;
  if (lowerFloor != null) { if (hi < lowerFloor) return 0; if (lo < lowerFloor) lo = lowerFloor; }
  if (upperFloor != null) { if (lo > upperFloor) return 0; if (hi > upperFloor) hi = upperFloor; }
  const pH = hi === Infinity ? 1 : normCdf((hi - mean) / std);
  const pL = lo === -Infinity ? 0 : normCdf((lo - mean) / std);
  return Math.max(0, pH - pL);
}
// Kelly fraction for a contract costing c that pays 1 with prob p.
function halfKelly(p, c) {
  if (c <= 0 || c >= 1) return 0;
  const b = (1 - c) / c;
  return Math.max(0, (p * b - (1 - p)) / b) / 2;
}
const wins = (extremum, loInt, hiInt) => {
  const lo = (loInt == null || loInt === -Infinity) ? -Infinity : loInt;
  const hi = (hiInt == null || hiInt === Infinity) ? Infinity : hiInt;
  return extremum >= lo && extremum <= hi;
};

// --- strategy variants ---
const VARIANTS = {
  "A production (flat sigma)": r => {
    const s = r.variable === "high"
      ? clamp(CALIB_SIGMA_HIGH, SIGMA_HIGH_FLOOR, SIGMA_HIGH_CAP)
      : clamp(CALIB_SIGMA_LOW, SIGMA_LOW_FLOOR, SIGMA_LOW_CAP);
    return { mean: r.modelMean, std: s };
  },
  "B per-city sigma (weather.js)": r => ({ mean: r.modelMean, std: r.modelStd ?? 2.0 }),
  "C measured post-peak dist": r => {
    // Post-peak HIGH: the day's heating is done, so the only remaining uncertainty is
    // CLI settlement mechanics. Measured over 13 stations x 565 days (analyze_cli_gap.js):
    // gap = CLI - METAR_maxSoFar ~ N(+0.78, 0.77) from hour 18 on.
    if (r.variable === "high" && r.localHour >= 18 && r.maxSoFar != null)
      return { mean: r.maxSoFar + 0.78, std: 0.77 };
    return VARIANTS["A production (flat sigma)"](r);
  },
};

function run(variantName, opts = {}) {
  const pick = VARIANTS[variantName];
  const taken = new Map();   // dedupe: one entry per day/city/variable/ticker/side
  for (const r of rows) {
    if (!r.settle || r.settle.extremumF == null) continue;
    if (opts.variable && r.variable !== opts.variable) continue;
    const { mean, std } = pick(r);
    if (mean == null || !isFinite(mean) || !std) continue;
    const lowerFloor = r.variable === "high" && r.maxSoFar != null ? Math.floor(r.maxSoFar) : null;
    const upperFloor = r.variable === "low" && r.minSoFar != null ? Math.ceil(r.minSoFar) : null;

    const raw = r.buckets.map(b => bucketProb(mean, std, b.loInt, b.hiInt, lowerFloor, upperFloor));
    const sum = raw.reduce((a, x) => a + x, 0);
    if (sum <= 0) continue;

    for (let i = 0; i < r.buckets.length; i++) {
      const b = r.buckets[i];
      const p = raw[i] / sum;
      const minEdge = opts.minEdge ?? (r.variable === "low" ? MIN_EDGE_LOW : MIN_EDGE_HIGH);
      for (const side of ["YES", "NO"]) {
        const price = side === "YES" ? b.yes_ask : b.no_ask;
        if (price == null || price <= 0 || price >= 1) continue;
        const pw = side === "YES" ? p : 1 - p;
        const netEv = pw - price - feePerDollar(price);
        if (netEv < minEdge) continue;
        const hk = halfKelly(pw, price);
        if (hk < MIN_HALF_KELLY) continue;
        const key = `${r.dateLocal}|${r.city}|${r.variable}|${b.ticker}|${side}`;
        if (taken.has(key)) continue;   // first qualifying cycle wins, like a real entry
        const won = side === "YES" ? wins(r.settle.extremumF, b.loInt, b.hiInt)
                                   : !wins(r.settle.extremumF, b.loInt, b.hiInt);
        taken.set(key, {
          date: r.dateLocal, city: r.city, variable: r.variable, ticker: b.ticker, side,
          price, pw, netEv, hk, won, localHour: r.localHour,
          pnl: (won ? 1 - price : -price) - feePerDollar(price) * price
        });
      }
    }
  }
  return [...taken.values()];
}

function summarize(bets, label) {
  const n = bets.length;
  if (!n) return `${label.padEnd(30)} n=0   (no bets cleared the gates)`;
  const staked = bets.reduce((a, b) => a + b.price, 0);
  const pnl = bets.reduce((a, b) => a + b.pnl, 0);
  const w = bets.filter(b => b.won).length;
  const claimed = bets.reduce((a, b) => a + b.pw, 0) / n;
  return `${label.padEnd(30)} n=${String(n).padEnd(5)} win ${(w / n * 100).toFixed(1).padStart(5)}% `
    + `(claimed ${(claimed * 100).toFixed(1)}%)  staked $${staked.toFixed(2).padStart(8)}  `
    + `pnl $${pnl.toFixed(2).padStart(8)}  ROI ${(pnl / staked * 100).toFixed(1).padStart(7)}%`;
}

const days = [...new Set(rows.filter(r => r.settle?.extremumF != null).map(r => r.dateLocal))].sort();
console.log(`snapshots: ${rows.length}   settled days: ${days.length}  (${days[0]} -> ${days[days.length - 1]})`);
console.log(`gates: MIN_EDGE=${MIN_EDGE_HIGH}  MIN_HALF_KELLY=${MIN_HALF_KELLY}  fee=0.07*(1-price) per $ staked\n`);

for (const v of Object.keys(VARIANTS)) {
  const all = run(v);
  console.log(summarize(all, v));
  for (const variable of ["high", "low"]) {
    const s = all.filter(b => b.variable === variable);
    if (s.length) console.log("   " + summarize(s, `  ${variable}`));
  }
}

// Sensitivity: does ANY edge threshold turn production profitable on HIGH?
console.log("\n=== production variant, HIGH only, MIN_EDGE sweep ===");
console.log("thr    n     win%    claimed%   staked      pnl       ROI");
for (const thr of [0.05, 0.10, 0.15, 0.20, 0.25, 0.28, 0.35, 0.45]) {
  const bets = run("A production (flat sigma)", { variable: "high", minEdge: thr });
  if (!bets.length) { console.log(`${thr.toFixed(2)}   0`); continue; }
  const staked = bets.reduce((a, b) => a + b.price, 0);
  const pnl = bets.reduce((a, b) => a + b.pnl, 0);
  const w = bets.filter(b => b.won).length;
  const cl = bets.reduce((a, b) => a + b.pw, 0) / bets.length;
  console.log(`${thr.toFixed(2)}   ${String(bets.length).padEnd(5)} ${(w / bets.length * 100).toFixed(1).padStart(5)}%  `
    + `${(cl * 100).toFixed(1).padStart(7)}%  $${staked.toFixed(2).padStart(8)}  $${pnl.toFixed(2).padStart(8)}  ${(pnl / staked * 100).toFixed(1).padStart(7)}%`);
}
