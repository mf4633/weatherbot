// STEP 2: does the bot's observation actually LEAD the market?
//
// The only edge available to this bot is latency: knowing the day's realized max before
// the market has repriced. Forecast skill is ruled out -- diagnose_edge.js showed the
// market is calibrated (Brier 0.064) where the model is not (0.105), with no mispriced
// slice. So the question is narrow and checkable:
//
//   At snapshot time t, does the market still price a bucket that the bot's own
//   observation has ALREADY ruled out?
//
// A bucket lying entirely below floor(maxSoFar) cannot settle -- the day's high is
// already above it. If the market prices such a bucket above ~0, either (a) the bot is
// genuinely ahead of the tape, or (b) the bot's maxSoFar is wrong. Realized outcomes
// separate those two: if the ruled-out buckets never win, the bot was right and the
// mispricing was real; if they sometimes win, the bot's floor is unsound and trading it
// would be catastrophic (it is a claimed CERTAINTY).
//
// Note these snapshots predate the IEM fold, so maxSoFar here is the old hourly-METAR
// value -- a LOWER floor, which rules out FEWER buckets. Any edge found is therefore a
// lower bound on what the folded floor would see.
//
// Usage: SNAPSHOTS=path node measure_lead.js
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(process.env.SNAPSHOTS || "./snaps.json", "utf-8"))
  .filter(r => r.settle && r.settle.extremumF != null && r.variable === "high");

const feePerDollar = p => 0.07 * (1 - p);
const wins = (e, lo, hi) => e >= ((lo == null || lo === -Infinity) ? -Infinity : lo)
                         && e <= ((hi == null || hi === Infinity) ? Infinity : hi);

// A bucket is RULED OUT when its whole range sits below the observed floor.
// CLI can settle up to ~1F below a raw METAR reading (degrees-C rounding path), so
// require the bucket to be clear of the floor by a margin before claiming certainty.
const MARGIN = 1.0;

let opportunities = 0, priced = 0, violations = 0;
const trades = [];
const byHour = {};
for (const r of rows) {
  if (r.maxSoFar == null) continue;
  const floor = Math.floor(r.maxSoFar) - MARGIN;
  for (const b of r.buckets) {
    const hi = (b.hiInt == null || b.hiInt === Infinity) ? Infinity : b.hiInt;
    if (hi >= floor) continue;              // not ruled out
    opportunities++;
    const won = wins(r.settle.extremumF, b.loInt, b.hiInt);
    if (won) violations++;                  // the "certainty" was wrong -- fatal if traded
    // To trade it you BUY NO, paying no_ask, and collect $1 if it does not settle here.
    const noAsk = b.no_ask;
    if (noAsk != null && noAsk > 0 && noAsk < 1) {
      const yesMid = ((b.yes_bid ?? 0) + (b.yes_ask ?? 0)) / 2;
      if (yesMid >= 0.02) {                 // market still assigns real probability
        priced++;
        const pnl = (won ? -noAsk : 1 - noAsk) - feePerDollar(noAsk) * noAsk;
        trades.push({ date: r.dateLocal, city: r.city, hour: r.localHour, ticker: b.ticker,
                      noAsk, yesMid, won, pnl });
        (byHour[r.localHour] ??= { n: 0, pnl: 0, staked: 0, viol: 0 });
        byHour[r.localHour].n++; byHour[r.localHour].pnl += pnl;
        byHour[r.localHour].staked += noAsk; if (won) byHour[r.localHour].viol++;
      }
    }
  }
}

console.log(`settled HIGH snapshots: ${rows.length}`);
console.log(`bucket-instants ruled out by the bot's floor: ${opportunities}`);
console.log(`  of those, market still priced YES >= 2c: ${priced}`);
console.log(`  FLOOR VIOLATIONS (ruled-out bucket actually settled): ${violations}`
  + `  (${opportunities ? (violations / opportunities * 100).toFixed(3) : "0"}%)\n`);

if (!trades.length) {
  console.log("No tradeable instants: the market never left real probability on a bucket");
  console.log("the bot had already ruled out. That is the signature of NO latency edge.");
} else {
  const staked = trades.reduce((a, t) => a + t.noAsk, 0);
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);
  const w = trades.filter(t => !t.won).length;
  console.log("=== trading every such instant (buy NO, hold to settle) ===");
  console.log(`n=${trades.length}  win ${(w / trades.length * 100).toFixed(1)}%  `
    + `staked $${staked.toFixed(2)}  pnl $${pnl.toFixed(2)}  ROI ${(pnl / staked * 100).toFixed(2)}%`);
  console.log("\nby local hour:");
  console.log("hour   n     staked     pnl      ROI      violations");
  for (const h of Object.keys(byHour).map(Number).sort((a, b) => a - b)) {
    const s = byHour[h];
    console.log(`${String(h).padStart(4)}  ${String(s.n).padEnd(5)} $${s.staked.toFixed(2).padStart(8)} `
      + `$${s.pnl.toFixed(2).padStart(7)}  ${(s.pnl / s.staked * 100).toFixed(2).padStart(7)}%  ${s.viol}`);
  }
  console.log("\nmost-mispriced instants (market YES mid on a ruled-out bucket):");
  for (const t of trades.sort((a, b) => b.yesMid - a.yesMid).slice(0, 10))
    console.log(`  ${t.date} ${t.city.padEnd(16)} h${String(t.hour).padStart(2)} ${t.ticker.padEnd(26)} `
      + `yesMid ${(t.yesMid * 100).toFixed(0).padStart(3)}c  noAsk ${t.noAsk.toFixed(2)}  ${t.won ? "LOST(settled here!)" : "won"}`);
}
