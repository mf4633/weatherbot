#!/usr/bin/env node
// 60-second Kalshi book poller — the measurement instrument for the latency-edge question.
//
// WHY THIS EXISTS
// market_logger declares */15 in netlify.toml, but Netlify throttles scheduled functions:
// the observed cadence over 195 city-days was 107 min MEDIAN (56 min minimum, 11 snapshots
// per city-day). A latency edge lives in the 5-45 minute band, so that instrument samples
// ~20x too slowly to detect, validate, or trade one. measure_reprice_timing.js cannot run
// at all on it — every bin is empty.
//
// This polls the book directly at 60s so the question becomes answerable:
//   does the market reprice on the hourly METAR (:51-:53), or continuously?
// Concentrated post-:53 => METAR-driven, and a sub-hourly observation (PWS) has a window
// to lead it. Flat => the market is already continuous and a PWS proxy would be inferring
// what it observes directly.
//
// SAFETY: Kalshi market data is PUBLIC. This process holds no credentials, imports no
// trader, and has no code path that can place an order. It only reads and appends.
//
// USAGE
//   node tools/book_poller.js                       # default series, ./data/ticks
//   SERIES=KXHIGHNY,KXHIGHLAX node tools/book_poller.js
//   OUT_DIR=/data/ticks INTERVAL_MS=60000 node tools/book_poller.js
//
// Output: newline-delimited JSON, one file per UTC day, one row per market per tick.
// JSONL (not one blob per tick) so it appends in O(1), survives a mid-write crash with
// at most one truncated line, and streams cheaply into the analysis scripts.

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
// Cities with a PWS interpolator already built (interpolatornyc + run_denver / run_houston
// / run_boston / run_lax) — those are the only ones where a lead could be acted on, and a
// narrow set keeps well clear of Kalshi's rate limits.
const DEFAULT_SERIES = ["KXHIGHNY", "KXHIGHLAX", "KXHIGHDEN", "KXHIGHTBOS", "KXHIGHTHOU"];
const SERIES = (process.env.SERIES || DEFAULT_SERIES.join(",")).split(",").map(s => s.trim()).filter(Boolean);
const OUT_DIR = process.env.OUT_DIR || join(process.cwd(), "data", "ticks");
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 60_000);
const SERIES_DELAY_MS = Number(process.env.SERIES_DELAY_MS || 250);   // stay under rate limits
const UA = "weatherbot-book-poller (github.com/mf4633/weatherbot)";

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Kalshi's 2026-07 schema serves prices as dollar strings in *_dollars / *_fp fields and
// still emits legacy integer cents. Accept both; return dollars or null. A 0 ask means
// "no offers", which is NOT the same as a price of zero — see kalshi.js.
function px(market, field) {
  const d = market[`${field}_dollars`];
  if (d != null && d !== "") { const v = Number(d); if (isFinite(v)) return v > 0 ? v : null; }
  const fp = market[`${field}_fp`];
  if (fp != null && fp !== "") { const v = Number(fp); if (isFinite(v)) return v > 0 ? v : null; }
  const c = market[field];
  if (typeof c === "number" && isFinite(c)) return c > 0 ? c / 100 : null;
  return null;
}

// Plain numeric passthrough for the *_fp / *_dollars decimal-string fields. Unlike px()
// this keeps 0 as 0 — a zero volume or zero size is real information, not "absent".
function num(market, field) {
  const v = market[field];
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

async function fetchSeries(series) {
  const url = `${KALSHI_API}/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=200`;
  const r = await fetch(url, { headers: { "User-Agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error(`${series} → HTTP ${r.status}`);
  const j = await r.json();
  return j.markets || [];
}

let ticks = 0, rows = 0, errors = 0, consecutiveErrors = 0;

async function tick() {
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  const file = join(OUT_DIR, `ticks-${day}.jsonl`);
  const lines = [];
  for (const series of SERIES) {
    try {
      const markets = await fetchSeries(series);
      for (const m of markets) {
        lines.push(JSON.stringify({
          ts, series, ticker: m.ticker,
          // Strike bounds: what identifies the bucket. Names vary across Kalshi schema
          // revisions, so keep the raw subtitle as a fallback for the parser.
          floor: m.floor_strike ?? null, cap: m.cap_strike ?? null, subtitle: m.subtitle ?? null,
          yes_bid: px(m, "yes_bid"), yes_ask: px(m, "yes_ask"),
          no_bid: px(m, "no_bid"), no_ask: px(m, "no_ask"),
          last: px(m, "last_price"),
          // Volume / OI / liquidity are *_fp decimal strings in the 2026-07 schema
          // (plain `volume` and `open_interest` are absent, which silently logged nulls
          // in the first version of this file).
          volume: num(m, "volume_fp"), volume24h: num(m, "volume_24h_fp"),
          open_interest: num(m, "open_interest_fp"), liquidity: num(m, "liquidity_dollars"),
          // Top-of-book depth. A repricing study needs to know whether a quote was
          // actually fillable — a 1-lot ask moving is noise, not the market repricing.
          yes_bid_size: num(m, "yes_bid_size_fp"), yes_ask_size: num(m, "yes_ask_size_fp"),
        }));
      }
      consecutiveErrors = 0;
    } catch (e) {
      errors++; consecutiveErrors++;
      log(`ERR ${series}: ${e.message}`);
      // Back off hard if Kalshi is rate-limiting, rather than hammering it every 60s.
      if (consecutiveErrors >= 3) { log("backing off 30s after 3 consecutive errors"); await sleep(30_000); }
    }
    await sleep(SERIES_DELAY_MS);
  }
  if (lines.length) {
    appendFileSync(file, lines.join("\n") + "\n");
    rows += lines.length;
  }
  ticks++;
  if (ticks % 15 === 0) log(`tick ${ticks}: ${rows} rows written, ${errors} errors → ${file}`);
}

// Fixed-rate scheduling that does not drift: each tick is scheduled relative to the
// wall clock, so a slow fetch shortens the next wait instead of pushing every later
// sample. Sample times staying near-uniform is the whole point of the instrument.
let stopping = false;
async function loop() {
  log(`polling ${SERIES.length} series every ${INTERVAL_MS / 1000}s → ${OUT_DIR}`);
  log(`series: ${SERIES.join(", ")}`);
  while (!stopping) {
    const started = Date.now();
    try { await tick(); } catch (e) { log("tick failed:", e.message); }
    const wait = Math.max(1000, INTERVAL_MS - (Date.now() - started));
    await sleep(wait);
  }
  log(`stopped after ${ticks} ticks, ${rows} rows, ${errors} errors`);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { log(`${sig} — finishing current tick`); stopping = true; });

loop();
