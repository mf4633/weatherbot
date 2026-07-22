// /api/floorsweep — "check all the boards" in one call (2026-07-22). For every city
// with a Kalshi daily-high market it fetches the board (Kalshi) + the official trace
// (aviationweather METAR), runs the high predictor and the floor-scan, and returns the
// low-tail NO candidates RANKED across all cities, plus the cold-pool tailwind cities.
//
// Two fetch legs, both isolated per city (one city's failure never sinks the sweep):
//   • Kalshi markets  → lib/kalshi.js → board { label: {loInt,hiInt,no_ask,yes_bid} }
//   • METAR trace     → lib/highpredict.js predictHigh → peak distribution
// then lib/floorscan.js applies the monotonic-lock + return gates.
//
// NOTE: some series tickers below are best-guesses (only DEN/HOU/NYC/LAX/SFO/SEA are
// confirmed from live URLs). A city returning error:"kalshi … HTTP 404" just needs its
// ticker corrected here — the parsing + scan are unit-tested (test_kalshi.js).

import { getStore } from "@netlify/blobs";
import { parseMetar } from "./lib/metar.js";
import { stationLines } from "./lib/claude_engine.js";
import { predictHigh } from "./lib/highpredict.js";
import { scanFloors } from "./lib/floorscan.js";
import { booksFromMarkets, eventDateCode, marketsForDay } from "./lib/kalshi.js";
import { normalizePick, dedupePicks, scoreFloorLog } from "./lib/floorlog.js";

const STORE = "claude_scoreboard";
const LOG_KEY = "floorlog/picks.json";
const localYmd = (tz, ms) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const KALSHI = process.env.KALSHI_API_BASE || "https://api.elections.kalshi.com/trade-api/v2";

const CITIES = {
  DEN:  { series: "KXHIGHDEN",  official: "KDEN", tz: "America/Denver" },       // confirmed
  HOU:  { series: "KXHIGHTHOU", official: "KHOU", tz: "America/Chicago" },      // confirmed
  NYC:  { series: "KXHIGHNY",   official: "KNYC", tz: "America/New_York" },     // confirmed
  LAX:  { series: "KXHIGHLAX",  official: "KLAX", tz: "America/Los_Angeles" },  // confirmed
  SFO:  { series: "KXHIGHTSFO", official: "KSFO", tz: "America/Los_Angeles" },  // confirmed
  SEA:  { series: "KXHIGHTSEA", official: "KSEA", tz: "America/Los_Angeles" },  // confirmed
  PHX:  { series: "KXHIGHTPHX", official: "KPHX", tz: "America/Phoenix" },      // confirmed (kxhightphx)
  MIA:  { series: "KXHIGHMIA",  official: "KMIA", tz: "America/New_York" },     // verify ticker
  CHI:  { series: "KXHIGHCHI",  official: "KMDW", tz: "America/Chicago" },      // verify ticker
  AUS:  { series: "KXHIGHAUS",  official: "KAUS", tz: "America/Chicago" },      // verify ticker
  PHIL: { series: "KXHIGHPHIL", official: "KPHL", tz: "America/New_York" },     // verify ticker
};

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, accept: "application/json", ...headers }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchOfficialObs(station, hours, refNow) {
  const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${station}&hours=${hours}&format=raw`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`METAR ${station} HTTP ${r.status}`);
  return stationLines(await r.text(), station).map((l) => parseMetar(l, refNow)).filter(Boolean)
    .map((o) => ({ tsMs: o.ts.getTime(), tempF: o.temp_f }))
    .filter((o) => Number.isFinite(o.tempF)).sort((a, b) => a.tsMs - b.tsMs);
}

async function fetchBoard(series, tz, nowMs) {
  const j = await getJson(`${KALSHI}/markets?series_ticker=${series}&status=open&limit=200`).catch((e) => {
    throw new Error(`kalshi ${series} ${e.message}`);
  });
  const markets = j.markets || j.market_list || [];
  const today = marketsForDay(markets, eventDateCode(tz, nowMs));
  return booksFromMarkets(today.length ? today : markets);
}

async function sweepCity(key, cfg, opts) {
  try {
    const [obs, books] = await Promise.all([
      fetchOfficialObs(cfg.official, 10 * 24, opts.now),
      fetchBoard(cfg.series, cfg.tz, opts.nowMs),
    ]);
    if (obs.length < 24) throw new Error(`only ${obs.length} obs`);
    if (!Object.keys(books).length) throw new Error("no open board for today");
    const prediction = predictHigh(obs, cfg.tz, {});
    const { candidates, context } = scanFloors(prediction, books, prediction.max_so_far, opts.gates);
    return {
      city: key, ok: true, official: cfg.official,
      predicted: prediction.predicted, range: prediction.range, max_so_far: prediction.max_so_far,
      low_confidence: prediction.low_confidence, anchor_anomaly_f: prediction.anchor_anomaly_f,
      floor_tailwind: context.floor_tailwind, tailwind_note: context.floor_tailwind ? context.note : undefined,
      candidates: candidates.map((c) => ({
        label: c.label, ceiling: c.ceiling, lock_temp: c.lock_temp, no_ask: c.no_ask,
        return_pct: c.return_pct, p_lock: c.p_lock, deg_to_lock: c.deg_to_lock, already_locked: c.already_locked,
      })),
    };
  } catch (e) {
    return { city: key, ok: false, error: String(e?.message || e) };
  }
}

const num = (url, k) => { const v = url.searchParams.get(k); return v == null ? undefined : parseFloat(v); };
const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2),
  { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Settled CLI highs for the logged stations (IEM archive — the Kalshi settlement source).
async function fetchCliHighs(stations, years) {
  const cli = {};
  await Promise.all(stations.map(async (st) => {
    for (const y of years) {
      try {
        const j = await getJson(`https://mesonet.agron.iastate.edu/json/cli.py?station=${st}&year=${y}`);
        for (const r of j.results || []) if (r.high != null && r.valid) cli[`${st}|${r.valid}`] = r.high;
      } catch { /* year/station gap is fine */ }
    }
  }));
  return cli;
}

export default async (req) => {
  const url = new URL(req.url);

  // ?mode=report — score the logged picks against the CLI settlement (the proof the
  // "near-guaranteed 20%" claim rests on).
  if (url.searchParams.get("mode") === "report") {
    try {
      const store = getStore(STORE);
      const log = (await store.get(LOG_KEY, { type: "json" }).catch(() => null)) || { picks: [] };
      const picks = log.picks || [];
      const stations = [...new Set(picks.map((p) => p.station).filter(Boolean))];
      const years = [...new Set(picks.map((p) => String(p.contract_date || "").slice(0, 4)).filter(Boolean))];
      const cli = await fetchCliHighs(stations, years);
      const score = scoreFloorLog(picks, cli);
      return json({
        ok: true, mode: "report", logged_picks: picks.length, settled: score.n, score,
        note: "hit_rate + mean_return_pct over settled logged floor picks, overall and by_city. " +
          "Picks are the top low-tail NO per city per day, captured at first sight (the morning window).",
      });
    } catch (e) {
      return json({ ok: false, mode: "report", error: String(e?.message || e) }, 500);
    }
  }

  const only = url.searchParams.get("city");
  const gates = {};
  if (num(url, "min_return") !== undefined) gates.minReturn = num(url, "min_return");
  if (num(url, "min_win") !== undefined) gates.minWinProb = num(url, "min_win");

  const now = new Date(), nowMs = now.getTime();
  const keys = (only ? [only.toUpperCase()] : Object.keys(CITIES)).filter((k) => CITIES[k]);
  const results = await Promise.all(keys.map((k) => sweepCity(k, CITIES[k], { now, nowMs, gates })));

  const best = results.filter((r) => r.ok)
    .flatMap((r) => r.candidates.map((c) => ({ city: r.city, ...c })))
    .sort((a, b) => (b.return_pct ?? -1) - (a.return_pct ?? -1));

  // Log the top candidate per city (first-per-day wins → the morning capture). Best-
  // effort: never let a store hiccup break the sweep. ?nolog=1 skips (for manual checks).
  let logged = 0;
  if (url.searchParams.get("nolog") !== "1") {
    try {
      const store = getStore(STORE);
      const prev = (await store.get(LOG_KEY, { type: "json" }).catch(() => null)) || { picks: [] };
      const incoming = results.filter((r) => r.ok && r.candidates.length).map((r) =>
        normalizePick({
          city: r.city, station: r.official, contractDate: localYmd(CITIES[r.city].tz, nowMs),
          candidate: r.candidates[0], predicted: r.predicted, loggedAtMs: nowMs,
        })).filter(Boolean);
      if (incoming.length) {
        const merged = dedupePicks(prev.picks || [], incoming);
        await store.setJSON(LOG_KEY, { picks: merged, updated: now.toISOString() });
        logged = incoming.length;
      }
    } catch { /* logging is best-effort */ }
  }

  return json({
    logged,
    ok: true, asof: now.toISOString(),
    best_low_tail_no: best,
    tailwind_cities: results.filter((r) => r.ok && r.floor_tailwind).map((r) => r.city),
    failed: results.filter((r) => !r.ok).map((r) => ({ city: r.city, error: r.error })),
    cities: results,
    note: "best_low_tail_no = bottom-bucket NOs clearing p_lock>=0.93 AND return>=20%, ranked by payout " +
      "across all cities — the low-tail NOs to actually take. tailwind_cities = cold-pool mornings where " +
      "cheap floors are safer than the raw gate shows (lean in even below the gate). Pass ?min_return= / " +
      "?min_win= to loosen the gates, ?city=DEN for one. Some series tickers are best-guesses; a 404 in " +
      "failed[] just needs its ticker fixed in CITIES.",
  });
};

export const config = { path: "/api/floorsweep" };
