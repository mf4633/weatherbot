// Is there a WINDOW for a PWS lead to exist at all?
//
// A PWS nowcaster can only beat the market if the market is repricing off HOURLY METARs
// (posted :51-:53). If the marginal price-setter watches 1-minute ASOS, they see the
// station directly at higher resolution than any PWS proxy can infer, and there is no
// gap to trade -- restoring Synoptic would buy parity, not a lead.
//
// Test: bucket consecutive book snapshots by the minute-of-hour of the LATER snapshot,
// and measure how much the market-implied expected high MOVED. If repricing concentrates
// in the window just after :53, the market is METAR-driven and a sub-hourly observation
// leads it. If movement is flat across the hour, the market is already continuous.
//
// Usage: SNAPSHOTS=path node measure_reprice_timing.js
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(process.env.SNAPSHOTS || "./snaps.json", "utf-8"))
  .filter(r => r.variable === "high" && r.buckets?.length);

// Market-implied expected value from bucket mid-prices (mirrors marketImplied in kalshi.js).
function impliedMean(buckets) {
  let sum = 0, acc = 0;
  for (const b of buckets) {
    const lo = b.loInt, hi = b.hiInt;
    const loFin = lo != null && lo !== -Infinity, hiFin = hi != null && hi !== Infinity;
    const c = loFin && hiFin ? (lo + hi) / 2 : (!loFin && hiFin ? hi - 1 : (loFin ? lo + 1 : null));
    if (c == null) continue;
    const p = ((b.yes_bid ?? 0) + (b.yes_ask ?? 0)) / 2;
    if (p <= 0) continue;
    sum += p; acc += p * c;
  }
  return sum > 0 ? acc / sum : null;
}

// Group snapshots into per-city-per-day time series.
const series = {};
for (const r of rows) {
  const key = `${r.dateLocal}|${r.city}`;
  (series[key] ??= []).push({ ts: new Date(r.ts), localHour: r.localHour, mean: impliedMean(r.buckets) });
}

// Bin by minute-of-hour of the later snapshot. METAR lands :51-:53 and propagates to
// IEM/feeds over the following few minutes, so a METAR-driven market should show its
// largest moves in the :53-:15 band.
const BINS = [[0, 15], [15, 30], [30, 45], [45, 60]];
const stats = BINS.map(() => ({ n: 0, absSum: 0, moved: 0 }));
let total = 0;
for (const arr of Object.values(series)) {
  arr.sort((a, b) => a.ts - b.ts);
  for (let i = 1; i < arr.length; i++) {
    const a = arr[i - 1], b = arr[i];
    if (a.mean == null || b.mean == null) continue;
    const gapMin = (b.ts - a.ts) / 60000;
    if (gapMin > 25) continue;                 // only consecutive ~15-min pairs
    // Only daytime, when the high is actually in play.
    if (b.localHour < 9 || b.localHour > 20) continue;
    const minute = b.ts.getUTCMinutes();
    const d = Math.abs(b.mean - a.mean);
    const bi = BINS.findIndex(([lo, hi]) => minute >= lo && minute < hi);
    if (bi < 0) continue;
    stats[bi].n++; stats[bi].absSum += d; if (d >= 0.25) stats[bi].moved++;
    total++;
  }
}

console.log(`consecutive snapshot pairs (daytime, <=25 min apart): ${total}\n`);
console.log("minute-of-hour   n      mean |Δ implied high|   % pairs moving >= 0.25F");
for (let i = 0; i < BINS.length; i++) {
  const s = stats[i];
  if (!s.n) continue;
  const tag = `:${String(BINS[i][0]).padStart(2, "0")}-:${String(BINS[i][1]).padStart(2, "0")}`;
  console.log(`${tag.padEnd(16)} ${String(s.n).padEnd(6)} ${(s.absSum / s.n).toFixed(3).padStart(10)}F`
    + `            ${(s.moved / s.n * 100).toFixed(1).padStart(6)}%`);
}

// A verdict needs data. Bins must be populated AND each reasonably sampled, or the
// only honest output is "cannot tell" — an unpopulated run must never read as evidence
// of flatness.
const MIN_PER_BIN = 30;
const populated = stats.filter(s => s.n >= MIN_PER_BIN);
if (total === 0 || populated.length < BINS.length) {
  console.log(`\nINSUFFICIENT DATA — need >= ${MIN_PER_BIN} pairs in each of the ${BINS.length} bins, `
    + `have [${stats.map(s => s.n).join(", ")}].`);
  console.log("This is NOT evidence either way. The book logger declares */15 in netlify.toml but");
  console.log("Netlify throttles scheduled functions: observed cadence is ~107 min median (min 56),");
  console.log("so consecutive same-hour pairs essentially never occur. A latency edge lives in the");
  console.log("5-45 min band — this instrument samples ~20x too slowly to see it. Fix the cadence");
  console.log("(a 60s poller on always-on infra, not Netlify/GH-Actions cron) before re-running.");
  process.exit(0);
}
const means = populated.map(s => s.absSum / s.n);
const spread = Math.max(...means) / Math.min(...means);
console.log(`\nmax/min ratio across the hour: ${spread.toFixed(2)}x`);
console.log(spread > 1.6
  ? "→ Repricing is CONCENTRATED. The market is METAR-driven; a sub-hourly observation\n"
    + "  has a window to lead it."
  : "→ Repricing is FLAT across the hour. The market is already continuous (1-min ASOS or\n"
    + "  equivalent). A PWS proxy would be inferring what the market already observes\n"
    + "  directly — no window to lead.");
