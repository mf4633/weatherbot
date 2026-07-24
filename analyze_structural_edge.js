// Is the favourite-longshot bias a PROVABLE, tradeable edge — model-free, at scale?
//
// The stacked best-case test (analyze_best_case.js) went from -12.9% to +14.2% out of
// sample, but every profitable step was the PRICE FLOOR, not the model: bayes-only alone
// stayed -8.5%, and the winning subset had win 50% vs claimed 81% — the model was still
// miscalibrated where it "won". So the effect is structural, not skill: buckets priced
// cheap settle even cheaper (longshot overpricing), buckets priced rich settle even
// richer (favourite underpricing). No forecast required.
//
// This tests that directly on 2106 settled markets x 28 days x 13 cities of 1-minute
// candlestick books — no model, no snapshot, just "what did a contract at price P
// actually settle to". Bootstrap CIs clustered on event-days, and a 14/14-day split,
// because the whole point is whether it survives out of sample where model edge didn't.
//
// A tradeable claim requires ALL of: TEST-half CI excluding zero, effect present net of
// the real half-spread and fee, and enough fillable volume to matter.
//
// Usage: node analyze_structural_edge.js --dir <candledir> --settle <settle.json>
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const dir = arg("--dir", "./data/backfill");
const settle = JSON.parse(readFileSync(arg("--settle", join(dir, "_settle.json")), "utf-8"));
// settle.json: { ticker: {result:"yes"|"no", close_time} } or an array — normalize.
const outcome = {};
const settleRows = Array.isArray(settle) ? settle : (settle.settlements || Object.entries(settle).map(([ticker, v]) => ({ ticker, ...v })));
for (const s of settleRows) if (s.ticker && (s.result === "yes" || s.result === "no")) outcome[s.ticker] = s.result;

const fee = p => 0.07 * (1 - p);
const eventDay = t => (t.match(/-(\d{2}[A-Z]{3}\d{2})-/) || [])[1] || "?";

// Take LAST quoted book per ticker before a cutoff fraction of its life — we want the
// price a real entry would have paid, not the settled-to-0/1 endpoint. Simplest robust
// proxy: the median-time quote for each ticker.
const perTicker = new Map();
for (const f of readdirSync(dir).filter(f => f.endsWith(".jsonl"))) {
  for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r.ticker || outcome[r.ticker] == null) continue;
    if (r.yes_bid == null && r.yes_ask == null) continue;
    if (!perTicker.has(r.ticker)) perTicker.set(r.ticker, []);
    perTicker.get(r.ticker).push(r);
  }
}

// One observation per ticker, priced at the MIDPOINT OF ITS TRADING LIFE using the last
// genuinely two-sided quote at or before that point. Requiring both bid and ask at a
// single fixed index discarded ~93% of tickers (illiquid buckets are one-sided much of
// the time); walking back to the last two-sided book keeps a realistic entry price while
// covering the whole ladder.
const obs = [];
for (const [ticker, arr] of perTicker) {
  arr.sort((a, b) => a.ts.localeCompare(b.ts));
  const midIdx = Math.floor(arr.length / 2);
  let m = null;
  for (let i = midIdx; i >= 0; i--) {
    if (arr[i].yes_bid != null && arr[i].yes_ask != null) { m = arr[i]; break; }
  }
  if (!m) for (let i = midIdx + 1; i < arr.length; i++) {   // else nearest forward
    if (arr[i].yes_bid != null && arr[i].yes_ask != null) { m = arr[i]; break; }
  }
  if (!m) continue;
  const bid = m.yes_bid, ask = m.yes_ask;
  const mid = (bid + ask) / 2, spread = ask - bid;
  if (mid <= 0 || mid >= 1) continue;
  obs.push({ ticker, day: eventDay(ticker), yesWon: outcome[ticker] === "yes" ? 1 : 0,
             mid, bid, ask, spread, series: m.series });
}
console.log(`settled markets ${Object.keys(outcome).length}, usable priced obs ${obs.length}\n`);

// Cluster bootstrap over event-days.
function bootMean(vals, days, n = 2000) {
  const byDay = new Map();
  for (let i = 0; i < vals.length; i++) { if (!byDay.has(days[i])) byDay.set(days[i], []); byDay.get(days[i]).push(vals[i]); }
  const keys = [...byDay.keys()];
  const means = [];
  // deterministic LCG so the run is reproducible (Math.random is unavailable in some ctx)
  let seed = 123456789;
  const rnd = () => (seed = (1103515245 * seed + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let b = 0; b < n; b++) {
    let s = 0, c = 0;
    for (let k = 0; k < keys.length; k++) { const d = byDay.get(keys[Math.floor(rnd() * keys.length)]); for (const v of d) { s += v; c++; } }
    means.push(s / c);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * n)], hi: means[Math.floor(0.975 * n)] };
}

// For a price band, simulate BUYING the YES side at ask and holding to settlement, net of
// fee. (NO side is the mirror; we report both by band.) Bands span the ladder.
const BANDS = [[0.01, 0.05], [0.05, 0.15], [0.15, 0.30], [0.30, 0.50], [0.50, 0.70], [0.70, 0.85], [0.85, 0.95], [0.95, 0.99]];

function evalBand(list, [lo, hi]) {
  // YES buy at ask
  const yes = list.filter(o => o.ask >= lo && o.ask < hi);
  // NO buy at (1-yes_bid) i.e. no_ask; the NO contract wins when yesWon==0
  const no = list.filter(o => (1 - o.bid) >= lo && (1 - o.bid) < hi);
  const yesPnls = yes.map(o => (o.yesWon ? 1 - o.ask : -o.ask) - fee(o.ask) * o.ask);
  const noPnls = no.map(o => { const price = 1 - o.bid; return (o.yesWon ? -price : 1 - price) - fee(price) * price; });
  const roi = (pnls, list, priceOf) => { const st = list.reduce((a, o) => a + priceOf(o), 0); return st > 0 ? pnls.reduce((a, b) => a + b, 0) / st : 0; };
  return {
    yesN: yes.length, yesRoi: roi(yesPnls, yes, o => o.ask),
    yesCI: yes.length >= 20 ? bootMean(yesPnls.map((p, i) => p / yes[i].ask), yes.map(o => o.day)) : null,
    noN: no.length, noRoi: roi(noPnls, no, o => 1 - o.bid),
    noCI: no.length >= 20 ? bootMean(noPnls.map((p, i) => p / (1 - no[i].bid)), no.map(o => o.day)) : null,
  };
}

function table(list, label) {
  console.log(`=== ${label} (n=${list.length}) ===`);
  console.log("price band     YES: n    ROI      95% CI            NO:  n    ROI      95% CI");
  for (const band of BANDS) {
    const e = evalBand(list, band);
    const ci = c => c ? `[${(c.lo * 100).toFixed(1)},${(c.hi * 100).toFixed(1)}]`.padEnd(16) : "(n<20)".padEnd(16);
    const sig = c => c && (c.lo > 0 || c.hi < 0) ? " *" : "";
    console.log(`[${band[0].toFixed(2)},${band[1].toFixed(2)})   `
      + `${String(e.yesN).padStart(5)}  ${(e.yesRoi * 100).toFixed(1).padStart(6)}%  ${ci(e.yesCI)}${sig(e.yesCI)}`.padEnd(38)
      + `${String(e.noN).padStart(5)}  ${(e.noRoi * 100).toFixed(1).padStart(6)}%  ${ci(e.noCI)}${sig(e.noCI)}`);
  }
  console.log("");
}

const days = [...new Set(obs.map(o => o.day))].sort();
const mid = days[Math.floor(days.length / 2)];
table(obs, "ALL 28 DAYS (in-sample)");
table(obs.filter(o => o.day < mid), "TRAIN (first half)");
table(obs.filter(o => o.day >= mid), "TEST (held out)");
console.log("* = 95% CI excludes zero, clustered on event-days. Net of fee, priced at the");
console.log("  median-time quote. A tradeable claim needs the SAME cell starred in TEST, and");
console.log("  its effect to survive the half-spread you'd actually cross.");
