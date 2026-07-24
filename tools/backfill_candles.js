#!/usr/bin/env node
// Backfill minute-resolution Kalshi books from the PUBLIC candlesticks endpoint.
//
// The forward poller (book_poller.js) needs 3-5 days before it can answer anything.
// Kalshi exposes /series/{series}/markets/{ticker}/candlesticks at period_interval=1
// (one minute), unauthenticated, for markets already settled — so the same question can
// be answered from history, right now, at the same resolution.
//
// Emits the SAME JSONL row shape as book_poller.js so one analysis path handles both.
// Candlesticks carry no top-of-book size, so yes_bid_size/yes_ask_size are null here;
// everything the repricing test needs (bid, ask, volume, OI, minute timestamp) is present.
//
// SAFETY: public market data only. No credentials, no trader import, no order path.
//
// USAGE
//   node tools/backfill_candles.js --days 14
//   SERIES=KXHIGHNY,KXHIGHLAX node tools/backfill_candles.js --days 7 --out ./data/backfill

import { appendFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
const DEFAULT_SERIES = ["KXHIGHNY", "KXHIGHLAX", "KXHIGHDEN", "KXHIGHTBOS", "KXHIGHTHOU"];
const SERIES = (process.env.SERIES || DEFAULT_SERIES.join(",")).split(",").map(s => s.trim()).filter(Boolean);
const argv = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const DAYS = Number(argVal("--days", 14));
const OUT_DIR = argVal("--out", process.env.OUT_DIR || join(process.cwd(), "data", "backfill"));
const REQ_DELAY_MS = Number(process.env.REQ_DELAY_MS || 300);
const UA = "weatherbot-backfill (github.com/mf4633/weatherbot)";

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function get(url, tries = 5) {
  let delay = 1000;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, accept: "application/json" } });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) { await sleep(delay); delay = Math.min(20000, delay * 2); continue; }
    throw new Error(`HTTP ${r.status} ${url.slice(0, 110)}`);
  }
  throw new Error(`gave up after ${tries}: ${url.slice(0, 110)}`);
}

// Ticker date code, e.g. KXHIGHNY-26JUL22-T91 -> 2026-07-22.
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function tickerDate(ticker) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})-/.exec(ticker);
  if (!m) return null;
  const [, yy, mon, dd] = m;
  if (!(mon in MON)) return null;
  return new Date(Date.UTC(2000 + Number(yy), MON[mon], Number(dd)));
}

const num = v => (v == null || v === "" ? null : (isFinite(Number(v)) ? Number(v) : null));
// Candlestick prices are dollar strings. A 0 ask means "no offers", not a price of zero —
// same convention as book_poller.px().
const px = v => { const n = num(v); return n != null && n > 0 ? n : null; };

async function listMarkets(series) {
  const out = [];
  for (const status of ["settled", "closed"]) {
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const url = `${KALSHI_API}/markets?series_ticker=${encodeURIComponent(series)}`
        + `&status=${status}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const j = await get(url);
      for (const m of j.markets || []) out.push(m);
      cursor = j.cursor || "";
      await sleep(REQ_DELAY_MS);
      if (!cursor) break;
    }
  }
  return out;
}

const cutoff = new Date(Date.now() - DAYS * 86400_000);
let totalRows = 0, totalMarkets = 0, skipped = 0;

for (const series of SERIES) {
  let markets;
  try { markets = await listMarkets(series); }
  catch (e) { log(`SKIP ${series}: ${e.message}`); continue; }

  const recent = markets.filter(m => { const d = tickerDate(m.ticker); return d && d >= cutoff; });
  log(`${series}: ${markets.length} markets listed, ${recent.length} within ${DAYS}d`);

  for (const m of recent) {
    const day = tickerDate(m.ticker);
    // Contract day runs local-evening to local-evening; pull a generous 40h window ending
    // at close so the whole trading session is covered regardless of timezone.
    const endTs = Math.floor(new Date(m.close_time || (day.getTime() + 30 * 3600_000)).getTime() / 1000);
    const startTs = endTs - 40 * 3600;
    const url = `${KALSHI_API}/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(m.ticker)}`
      + `/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;
    let j;
    try { j = await get(url); }
    catch (e) { skipped++; log(`  skip ${m.ticker}: ${e.message}`); await sleep(REQ_DELAY_MS); continue; }

    const lines = [];
    for (const c of j.candlesticks || []) {
      const ts = new Date((c.end_period_ts ?? 0) * 1000).toISOString();
      const yb = px(c.yes_bid?.close_dollars), ya = px(c.yes_ask?.close_dollars);
      // Nothing quoted on either side in this minute — no book to record.
      if (yb == null && ya == null) continue;
      lines.push(JSON.stringify({
        ts, series, ticker: m.ticker,
        floor: m.floor_strike ?? null, cap: m.cap_strike ?? null, subtitle: m.subtitle ?? null,
        yes_bid: yb, yes_ask: ya,
        // NO side is the complement of the YES book: no_bid = 1 - yes_ask, no_ask = 1 - yes_bid.
        no_bid: ya != null ? Number((1 - ya).toFixed(4)) : null,
        no_ask: yb != null ? Number((1 - yb).toFixed(4)) : null,
        last: px(c.price?.close_dollars) ?? px(c.price?.previous_dollars),
        volume: num(c.volume_fp), volume24h: null,
        open_interest: num(c.open_interest_fp), liquidity: null,
        yes_bid_size: null, yes_ask_size: null,   // not exposed by candlesticks
        src: "candles",
      }));
    }
    if (lines.length) {
      const dayStr = day.toISOString().slice(0, 10);
      appendFileSync(join(OUT_DIR, `backfill-${dayStr}.jsonl`), lines.join("\n") + "\n");
      totalRows += lines.length;
    }
    totalMarkets++;
    if (totalMarkets % 20 === 0) log(`  ${totalMarkets} markets, ${totalRows} rows`);
    await sleep(REQ_DELAY_MS);
  }
}
writeFileSync(join(OUT_DIR, "_manifest.json"), JSON.stringify(
  { generatedAt: new Date().toISOString(), series: SERIES, days: DAYS, markets: totalMarkets, rows: totalRows, skipped }, null, 2));
log(`DONE: ${totalMarkets} markets, ${totalRows} rows, ${skipped} skipped → ${OUT_DIR}`);
