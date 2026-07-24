// THE STACKED BEST CASE: does "better model + better timing + better exit" reach profit?
//
// Every positive or suggestive finding from the 2026-07-23/24 investigation, applied at
// once to the same real books and real CLI settlements, then split out-of-sample:
//
//   1. BETTER MODEL. kalshi.js:582 prices HIGH buckets on (bayesian + claudeHigh)/2.
//      The stack fit (research/analyze_stack.js) put the Bayesian leg at weight 0.94-1.00
//      and measured claudeHigh at RMSE 3.25 / bias -1.44F against the Bayesian's 1.58.
//      So: re-price every bucket on the BAYESIAN POINT ALONE and see what changes.
//   2. PRICE FLOOR. Contracts under ~30c lose 13-74% on both sides in both datasets
//      (favourite-longshot bias) — the single largest effect found, larger than any
//      clock effect.
//   3. TIMING. Afternoon entries cost 0.027 round-trip vs 0.018 overnight and returned
//      -10.7% vs -2.9%; it was the only entry-hour cell whose sign survived a 7/7 split.
//   4. EXIT. Cutting when the MARKET implies >=95% chance of loss returned +11.4pp
//      [+8.97, +13.85] vs hold, and cut maxDD 201 -> 157. Model-free by construction.
//
// Honest framing: choosing the best-performing cells after seeing the data is exactly how
// TRADING_POSTMORTEM.md's eight hypotheses each produced an in-sample winner that flipped
// sign out-of-sample. So the split is not decoration — the TEST half is the only number
// that means anything, and it is reported even when it disagrees with the TRAIN half.
//
// Usage: SNAPSHOTS=snaps.json SCOREBOARD=sb_full.json node analyze_best_case.js
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(process.env.SNAPSHOTS || "./snaps.json", "utf-8"))
  .filter(r => r.settle && r.settle.extremumF != null && r.variable === "high");
const sbRaw = JSON.parse(readFileSync(process.env.SCOREBOARD || "./sb_full.json", "utf-8"));
const sb = (Array.isArray(sbRaw) ? sbRaw : sbRaw.records || [])
  .filter(r => r?.bayes?.point != null && r.city && r.contract_date && r.asof);

// city|date -> [{ts, bayes}] sorted, so a snapshot can take the nearest-in-time estimate.
const sbIdx = new Map();
for (const r of sb) {
  const k = `${r.city}|${r.contract_date}`;
  if (!sbIdx.has(k)) sbIdx.set(k, []);
  sbIdx.get(k).push({ ts: Date.parse(r.asof), bayes: r.bayes.point });
}
for (const v of sbIdx.values()) v.sort((a, b) => a.ts - b.ts);
function nearestBayes(city, date, tsIso) {
  const arr = sbIdx.get(`${city}|${date}`);
  if (!arr?.length) return null;
  const t = Date.parse(tsIso);
  let best = arr[0];
  for (const e of arr) if (Math.abs(e.ts - t) < Math.abs(best.ts - t)) best = e;
  // Only trust an estimate within 6h of the snapshot.
  return Math.abs(best.ts - t) <= 6 * 3600_000 ? best.bayes : null;
}

const MIN_EDGE = 0.28, MIN_HALF_KELLY = 0.20, SIGMA = 2.131;
const fee = p => 0.07 * (1 - p);
function normCdf(z) {
  const s = z < 0 ? -1 : 1, a = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * a);
  return 0.5 * (1 + s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)));
}
function bucketProb(mean, std, lo, hi, floor) {
  let l = (lo == null || lo === -Infinity) ? -Infinity : lo - 0.5;
  let h = (hi == null || hi === Infinity) ? Infinity : hi + 0.5;
  if (floor != null) { if (h < floor) return 0; if (l < floor) l = floor; }
  return Math.max(0, (h === Infinity ? 1 : normCdf((h - mean) / std)) - (l === -Infinity ? 0 : normCdf((l - mean) / std)));
}
const halfKelly = (p, c) => (c <= 0 || c >= 1) ? 0 : Math.max(0, (p * ((1 - c) / c) - (1 - p)) / ((1 - c) / c)) / 2;
const wins = (e, lo, hi) => e >= ((lo == null || lo === -Infinity) ? -Infinity : lo)
                         && e <= ((hi == null || hi === Infinity) ? Infinity : hi);

// Contract hour: these markets close 00:59 local the NEXT day, so raw local hour mixes
// two different information states. 24 - hoursToClose puts entries on one axis.
const contractHour = (localHour) => (localHour + 1) % 24;

function run(opts, dateFilter) {
  const taken = new Map();
  for (const r of rows) {
    if (!dateFilter(r.dateLocal)) continue;
    const mean = opts.betterModel
      ? (nearestBayes(r.city, r.dateLocal, r.ts) ?? null)
      : r.modelMean;
    if (mean == null || !isFinite(mean)) continue;
    if (opts.avoidAfternoon) {
      const ch = contractHour(r.localHour);
      if (ch >= 11 && ch <= 16) continue;
    }
    const floor = r.maxSoFar != null ? Math.floor(r.maxSoFar) : null;
    const raw = r.buckets.map(b => bucketProb(mean, SIGMA, b.loInt, b.hiInt, floor));
    const sum = raw.reduce((a, x) => a + x, 0);
    if (sum <= 0) continue;
    for (let i = 0; i < r.buckets.length; i++) {
      const b = r.buckets[i], p = raw[i] / sum;
      for (const side of ["YES", "NO"]) {
        const price = side === "YES" ? b.yes_ask : b.no_ask;
        if (price == null || price <= 0 || price >= 1) continue;
        if (opts.priceFloor && price < opts.priceFloor) continue;
        const pw = side === "YES" ? p : 1 - p;
        if (pw - price - fee(price) < MIN_EDGE) continue;
        if (halfKelly(pw, price) < MIN_HALF_KELLY) continue;
        const key = `${r.dateLocal}|${r.city}|${b.ticker}|${side}`;
        if (taken.has(key)) continue;
        const won = side === "YES" ? wins(r.settle.extremumF, b.loInt, b.hiInt)
                                   : !wins(r.settle.extremumF, b.loInt, b.hiInt);
        taken.set(key, { key, date: r.dateLocal, city: r.city, ticker: b.ticker, side, price, pw, won,
                         ts: Date.parse(r.ts),
                         pnl: (won ? 1 - price : -price) - fee(price) * price });
      }
    }
  }
  let bets = [...taken.values()];

  // EXIT: cut when the market later implies >=95% chance our side loses. Uses the same
  // snapshots, so exits are priced at a real quote that existed. Cadence is ~107 min,
  // so this UNDERSTATES a live rule's responsiveness.
  if (opts.cutLoser) {
    const byTicker = new Map();
    for (const r of rows) {
      for (const b of r.buckets) {
        const k = `${r.dateLocal}|${r.city}|${b.ticker}`;
        if (!byTicker.has(k)) byTicker.set(k, []);
        byTicker.get(k).push({ ts: Date.parse(r.ts), b });
      }
    }
    for (const v of byTicker.values()) v.sort((a, b) => a.ts - b.ts);
    bets = bets.map(t => {
      const seq = byTicker.get(`${t.date}|${t.city}|${t.ticker}`) || [];
      for (const s of seq) {
        if (s.ts <= t.ts) continue;
        const ourBid = t.side === "YES" ? s.b.yes_bid : s.b.no_bid;
        if (ourBid == null) continue;
        if (ourBid <= 0.05) {   // market says we are ~certainly losing
          return { ...t, pnl: (ourBid - t.price) - fee(t.price) * t.price, exited: true };
        }
      }
      return t;
    });
  }
  return bets;
}

function stat(bets) {
  if (!bets.length) return { n: 0 };
  const staked = bets.reduce((a, b) => a + b.price, 0);
  const pnl = bets.reduce((a, b) => a + b.pnl, 0);
  const w = bets.filter(b => b.won).length;
  return { n: bets.length, staked, pnl, roi: pnl / staked, win: w / bets.length,
           claimed: bets.reduce((a, b) => a + b.pw, 0) / bets.length };
}
const fmt = (s) => s.n === 0 ? "n=0" :
  `n=${String(s.n).padEnd(4)} win ${(s.win * 100).toFixed(1).padStart(5)}% (claimed ${(s.claimed * 100).toFixed(0)}%)  `
  + `staked $${s.staked.toFixed(2).padStart(7)}  pnl $${s.pnl.toFixed(2).padStart(7)}  ROI ${(s.roi * 100).toFixed(1).padStart(7)}%`;

const dates = [...new Set(rows.map(r => r.dateLocal))].sort();
const mid = dates[Math.floor(dates.length / 2)];
console.log(`settled HIGH snapshots ${rows.length}, scoreboard bayes records ${sb.length}`);
console.log(`dates ${dates[0]}..${dates[dates.length - 1]}  split at ${mid}\n`);

const LADDER = [
  ["1 production baseline",            {}],
  ["2 + better model (bayes only)",    { betterModel: 1 }],
  ["3 + price floor >= 0.30",          { betterModel: 1, priceFloor: 0.30 }],
  ["4 + avoid afternoon",              { betterModel: 1, priceFloor: 0.30, avoidAfternoon: 1 }],
  ["5 + cut-loser exit  [FULL STACK]", { betterModel: 1, priceFloor: 0.30, avoidAfternoon: 1, cutLoser: 1 }],
];

console.log("=== ALL DATA (in-sample — every filter was chosen after seeing this) ===");
for (const [label, o] of LADDER) console.log(label.padEnd(36), fmt(stat(run(o, () => true))));

console.log("\n=== TRAIN (first half) ===");
for (const [label, o] of LADDER) console.log(label.padEnd(36), fmt(stat(run(o, d => d < mid))));

console.log("\n=== TEST (held out — the only number that means anything) ===");
for (const [label, o] of LADDER) console.log(label.padEnd(36), fmt(stat(run(o, d => d >= mid))));

const full = stat(run(LADDER[4][1], d => d >= mid));
console.log("\n" + "=".repeat(78));
if (full.n === 0) {
  console.log("FULL STACK PLACES NO BETS OUT OF SAMPLE — no edge, and nothing to trade.");
} else if (full.pnl > 0) {
  console.log(`FULL STACK OUT-OF-SAMPLE: +$${full.pnl.toFixed(2)} on $${full.staked.toFixed(2)} `
    + `(${(full.roi * 100).toFixed(1)}%, n=${full.n}).`);
  console.log("Positive — but n and the dollar amount decide whether it is real or noise.");
} else {
  console.log(`FULL STACK OUT-OF-SAMPLE: $${full.pnl.toFixed(2)} on $${full.staked.toFixed(2)} `
    + `(${(full.roi * 100).toFixed(1)}%, n=${full.n}). STILL NEGATIVE with every finding stacked.`);
}
