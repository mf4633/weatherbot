// interp_backtest-background.js — walk-forward backtest of the PWS interpolator
// against held-out official obs (2026-07-15, built after the KDEN feed-outage day).
// For each :53 official in the last N days (after a 24h calibration warmup), the
// estimate is recomputed exactly as the live pipeline would have — using only prior
// officials and proxy rows — and scored against the held-out truth. Two pipelines
// run on identical data:
//   live — PWS only, weighted mean, peak bias (current production behavior)
//   new  — + neighbor-airport pseudo-stations (KCFO beat every PWS on 7/15),
//          + climb-conditional ramp bias (regression trailed 1.5-3°F mid-ramp),
//          + weighted-median center when the network splits (±6°F sun/shade day)
// Results → blob interp/backtest_<CITY>.json (read via this function w/ ?results=1).
// The live endpoint only adopts the upgrades once this scoreboard says they win.
// Caveat logged in-band: azimuthal station diversity matters — on 7/15 every DEN
// proxy sat WEST of the airport and the DCVZ put the official in different air.

import { getStore } from "@netlify/blobs";
import { parseMetar } from "./lib/metar.js";
import { stationLines } from "./lib/claude_engine.js";
import { PWS_STATIONS, replayInterp, scoreReplay } from "./lib/interp_knyc.js";

const WC_KEY = process.env.WEATHERCOM_API_KEY || "e1f10a1e78da46f5b10a1e78da96f525";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const HOUR_MS = 3600e3;

const CITIES = {
  NYC: { official: "KNYC", tz: "America/New_York", pinned: Object.keys(PWS_STATIONS), airports: ["KLGA", "KTEB"] },
  DEN: { official: "KDEN", tz: "America/Denver", airports: ["KCFO", "KAPA", "KBJC"] },
  LAX: { official: "KLAX", tz: "America/Los_Angeles", airports: ["KHHR", "KSMO"] },
  PHX: { official: "KPHX", tz: "America/Phoenix", airports: ["KDVT", "KCHD"] },
};

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchPwsDay(stationId, ymd) {
  const j = await getJson(`https://api.weather.com/v2/pws/history/hourly?stationId=${stationId}` +
    `&format=json&units=e&date=${ymd}&apiKey=${WC_KEY}&numericPrecision=decimal`);
  return (j.observations || []).map(o => ({
    tsMs: new Date(o.obsTimeUtc || o.obsTimeLocal).getTime(),
    station: stationId, tempF: o.imperial?.tempHigh ?? null,
  })).filter(o => Number.isFinite(o.tempF) && Number.isFinite(o.tsMs));
}

// Official + airport METARs in one call each; rows shaped like PWS history rows.
async function fetchMetarSeries(station, hours, refNow) {
  const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${station}&hours=${hours}&format=raw`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`METAR ${station} HTTP ${r.status}`);
  return stationLines(await r.text(), station).map(l => parseMetar(l, refNow)).filter(Boolean)
    .map(o => ({ tsMs: o.ts.getTime(), station, tempF: o.temp_f }))
    .filter(o => Number.isFinite(o.tempF)).sort((a, b) => a.tsMs - b.tsMs);
}

const localYmd = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d).replace(/-/g, "");

export default async (req) => {
  const url = new URL(req.url);
  const cityKey = (url.searchParams.get("city") || "DEN").toUpperCase();
  const days = Math.min(10, Math.max(2, parseInt(url.searchParams.get("days") || "7", 10)));
  const store = getStore("claude_scoreboard");
  const key = `interp/backtest_${cityKey}.json`;
  if (url.searchParams.get("results") === "1") {
    const j = await store.get(key, { type: "json" }).catch(() => null);
    return new Response(JSON.stringify(j || { ok: false, error: "no results yet" }, null, 2),
      { headers: { "content-type": "application/json" } });
  }
  const cfg = CITIES[cityKey];
  if (!cfg) return new Response(JSON.stringify({ ok: false, error: `unknown city ${cityKey}` }), { status: 400 });
  try {
    const now = new Date(), nowMs = now.getTime(), hours = days * 24;
    const officialObs = (await fetchMetarSeries(cfg.official, hours, now))
      .map(o => ({ tsMs: o.tsMs, tempF: o.tempF }));
    if (officialObs.length < 48) throw new Error(`only ${officialObs.length} official obs`);

    // PWS set: pinned list, else the discovery cache written by /api/interp_knyc.
    let pwsStations = cfg.pinned;
    if (!pwsStations) {
      const cached = await store.get(`interp/stations_${cityKey}.json`, { type: "json" }).catch(() => null);
      if (!cached?.stations?.length) throw new Error("no discovered station cache — hit /api/interp_knyc first");
      pwsStations = cached.stations;
    }
    const pwsRows = [];
    for (const s of pwsStations) {
      for (let d = 0; d <= days; d++) {
        const ymd = localYmd(new Date(nowMs - d * 24 * HOUR_MS), cfg.tz);
        try { pwsRows.push(...await fetchPwsDay(s, ymd)); } catch { /* day gap is fine */ }
      }
    }
    const airportRows = [];
    for (const a of cfg.airports) {
      try { airportRows.push(...await fetchMetarSeries(a, hours, now)); } catch { /* neighbor optional */ }
    }
    const airportsWithData = [...new Set(airportRows.map(r => r.station))];

    const live = replayInterp({ officialObs, rows: pwsRows, stations: pwsStations });
    const nu = replayInterp({ officialObs, rows: [...pwsRows, ...airportRows],
      stations: [...pwsStations, ...airportsWithData], ramp: true, robust: true });
    const out = {
      ok: true, city: cityKey, official: cfg.official, days, generated: now.toISOString(),
      stations: { pws: pwsStations, airports: airportsWithData },
      samples: { live: live.length, new: nu.length },
      score: { live: scoreReplay(live), new: scoreReplay(nu) },
      note: "walk-forward, target ob held out, anchor a full hour stale (hardest live case). " +
            "Adopt the new pipeline in the live endpoint only if score.new.rising.mae beats live.",
    };
    await store.setJSON(key, out);
    return new Response(JSON.stringify(out.score, null, 2), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, city: cityKey, error: String(e?.message || e) }), { status: 500 });
  }
};

export const config = { path: "/api/interp_backtest" };
