#!/usr/bin/env node
// Does the Kalshi market reprice on the hourly METAR, or continuously?
//
// This is the latency question, and at 1-minute resolution it can be asked sharply.
// The earlier attempt (measure_reprice_timing.js) ran on market_logger snapshots whose
// real cadence is 107 min median — it could not populate a single bin. Candlestick
// backfill and the 60s poller both give per-minute books, so we can bin by EXACT
// minute-of-hour and look for the METAR signature directly.
//
// US ASOS routine METARs are taken at :53 and disseminate over the following few minutes.
// If the market is METAR-driven, |Δ market-implied high| should spike in roughly :53-:05
// and be quiet mid-hour. If it is flat, the market is already watching a continuous feed
// (1-minute ASOS or equivalent) and a PWS proxy would be inferring what it observes
// directly — no window to lead, and restoring Synoptic buys parity rather than edge.
//
// Reads the flat JSONL emitted by tools/book_poller.js and tools/backfill_candles.js.
//
// USAGE
//   node tools/analyze_reprice_ticks.js data/backfill/*.jsonl
//   node tools/analyze_reprice_ticks.js --dir data/backfill

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
let files = argv.filter(a => a.endsWith(".jsonl"));
const dirIdx = argv.indexOf("--dir");
if (dirIdx >= 0 && argv[dirIdx + 1]) {
  const d = argv[dirIdx + 1];
  if (existsSync(d)) files = readdirSync(d).filter(f => f.endsWith(".jsonl")).map(f => join(d, f));
}
if (!files.length) { console.error("no .jsonl inputs (pass files or --dir)"); process.exit(1); }

// Series -> IANA tz, for local-hour gating (the high is only in play during the day).
const TZ = {
  KXHIGHNY: "America/New_York", KXHIGHLAX: "America/Los_Angeles",
  KXHIGHDEN: "America/Denver", KXHIGHTBOS: "America/New_York",
  KXHIGHTHOU: "America/Chicago", KXHIGHCHI: "America/Chicago",
  KXHIGHPHIL: "America/New_York", KXHIGHTDC: "America/New_York",
  KXHIGHTSEA: "America/Los_Angeles", KXHIGHTPHX: "America/Phoenix",
  KXHIGHTDAL: "America/Chicago", KXHIGHTSATX: "America/Chicago", KXHIGHAUS: "America/Chicago",
};
const localHour = (tz, d) => parseInt(new Intl.DateTimeFormat("en-US",
  { timeZone: tz, hour: "2-digit", hour12: false }).format(d), 10) % 24;

// Bucket midpoint. Open-ended tails get a ±1F nominal centre, matching bucketCenter()
// in kalshi.js so the implied mean is computed the same way production does.
function centre(r) {
  const lo = r.floor, hi = r.cap;
  const loFin = lo != null, hiFin = hi != null;
  if (loFin && hiFin) return (lo + hi) / 2;
  if (!loFin && hiFin) return hi - 1;
  if (loFin && !hiFin) return lo + 1;
  return null;
}

// Group rows: series|contract-day -> minute-ISO -> [rows]
const events = new Map();
let read = 0;
for (const f of files) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r.ts || !r.ticker) continue;
    read++;
    const day = (/-(\d{2}[A-Z]{3}\d{2})-/.exec(r.ticker) || [])[1] || "?";
    const key = `${r.series}|${day}`;
    const minute = r.ts.slice(0, 16);            // YYYY-MM-DDTHH:MM
    if (!events.has(key)) events.set(key, new Map());
    const byMin = events.get(key);
    if (!byMin.has(minute)) byMin.set(minute, []);
    byMin.get(minute).push(r);
  }
}
console.log(`rows read: ${read}   event-days: ${events.size}\n`);

// Market-implied expected high from bucket mid-prices.
function impliedMean(rows) {
  let w = 0, acc = 0;
  for (const r of rows) {
    const c = centre(r);
    if (c == null) continue;
    const bid = r.yes_bid ?? 0, ask = r.yes_ask ?? 0;
    const p = (bid + ask) / 2;
    if (p <= 0) continue;
    w += p; acc += p * c;
  }
  return w > 0 ? acc / w : null;
}

// Per minute-of-hour: mean |Δ implied| and how often it moved at all.
const bins = Array.from({ length: 60 }, () => ({ n: 0, abs: 0, moved: 0 }));
let pairs = 0;
for (const [key, byMin] of events) {
  const series = key.split("|")[0];
  const tz = TZ[series] || "America/New_York";
  const minutes = [...byMin.keys()].sort();
  let prev = null, prevTs = null;
  for (const m of minutes) {
    const mean = impliedMean(byMin.get(m));
    if (mean == null) { continue; }
    const ts = new Date(m + ":00Z");
    if (prev != null && prevTs != null) {
      const gap = (ts - prevTs) / 60000;
      if (gap >= 0.5 && gap <= 2.5) {            // adjacent minutes only
        const lh = localHour(tz, ts);
        if (lh >= 9 && lh <= 20) {               // daytime, high in play
          const d = Math.abs(mean - prev);
          const mo = ts.getUTCMinutes();
          bins[mo].n++; bins[mo].abs += d; if (d >= 0.05) bins[mo].moved++;
          pairs++;
        }
      }
    }
    prev = mean; prevTs = ts;
  }
}

console.log(`adjacent-minute pairs (daytime): ${pairs}`);
const MIN_N = 30;
const usable = bins.filter(b => b.n >= MIN_N).length;
if (pairs === 0 || usable < 40) {
  console.log(`INSUFFICIENT DATA — only ${usable}/60 minute-bins have >= ${MIN_N} pairs.`);
  console.log("Not evidence either way. Collect more before reading anything into it.");
  process.exit(0);
}

// METARs are taken at :53 and disseminate over the next several minutes.
const inWindow = m => (m >= 53 || m <= 5);
let winAbs = 0, winN = 0, offAbs = 0, offN = 0;
for (let m = 0; m < 60; m++) {
  const b = bins[m]; if (!b.n) continue;
  if (inWindow(m)) { winAbs += b.abs; winN += b.n; } else { offAbs += b.abs; offN += b.n; }
}
const winMean = winAbs / winN, offMean = offAbs / offN, ratio = winMean / offMean;

console.log("\nminute-of-hour profile (mean |Δ implied high|, °F):");
for (let row = 0; row < 6; row++) {
  let line = "";
  for (let c = 0; c < 10; c++) {
    const m = row * 10 + c;
    const b = bins[m];
    const v = b.n ? (b.abs / b.n) : null;
    line += `${String(m).padStart(2, "0")}:${v == null ? "  --  " : v.toFixed(4)}  `;
  }
  console.log("  " + line);
}

console.log(`\n:53-:05 window   mean |Δ| = ${winMean.toFixed(4)}°F  (n=${winN})`);
console.log(`mid-hour         mean |Δ| = ${offMean.toFixed(4)}°F  (n=${offN})`);
console.log(`ratio            ${ratio.toFixed(2)}x\n`);

if (ratio > 1.5) {
  console.log("→ METAR-DRIVEN. Repricing concentrates right after the :53 observation, so the");
  console.log("  market is reacting to the hourly report rather than a continuous feed. A");
  console.log("  sub-hourly observation (PWS via interpolatornyc) has a real window to lead it,");
  console.log("  and fixing the Synoptic account is worth doing.");
} else if (ratio < 1.2) {
  console.log("→ CONTINUOUS. Repricing is spread evenly across the hour, so the market already");
  console.log("  tracks something finer than the hourly METAR. A PWS proxy would be INFERRING");
  console.log("  what the market OBSERVES directly — no latency window. Restoring Synoptic buys");
  console.log("  parity, not edge. This closes the last untested hypothesis.");
} else {
  console.log("→ AMBIGUOUS. Some concentration but not decisive; collect more days before acting.");
}
