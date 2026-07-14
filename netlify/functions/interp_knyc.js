// /api/interp_knyc — live interpolated KNYC (Central Park) temperature from 6
// nearby Weather.com PWS, calibrated against the last 48h of official METARs.
// JS port of the user's interpolatornyc pipeline (see lib/interp_knyc.js for the
// math and provenance). Serves the "live interp" line on the New York card.
// Results are cached in blobs for 5 min: ~18 upstream fetches per recompute, and
// the PWS API is rate-limited.

import { getStore } from "@netlify/blobs";
import { parseMetar } from "./lib/metar.js";
import { stationLines } from "./lib/claude_engine.js";
import {
  PWS_STATIONS, mergeKnycPws, stationStats, stationWeights, fitPeakBias,
  pwsRegressionEstimate, deltaNowcast, blendNowEstimate,
} from "./lib/interp_knyc.js";

// Weather.com's public frontend key (shipped in the user's upload). Override via env.
const WC_KEY = process.env.WEATHERCOM_API_KEY || "e1f10a1e78da46f5b10a1e78da96f525";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const CACHE_KEY = "interp_knyc/cache.json";
const CACHE_MS = 5 * 60e3;
const HOUR_MS = 3600e3;

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// PWS hourly history (tempHigh) for one local day. Rows: {tsMs, station, tempF}.
async function fetchPwsDay(stationId, ymd) {
  const j = await getJson(`https://api.weather.com/v2/pws/history/hourly?stationId=${stationId}` +
    `&format=json&units=e&date=${ymd}&apiKey=${WC_KEY}&numericPrecision=decimal`);
  return (j.observations || []).map(o => ({
    tsMs: new Date(o.obsTimeUtc || o.obsTimeLocal).getTime(),
    station: stationId,
    tempF: o.imperial?.tempHigh ?? null,
  })).filter(o => Number.isFinite(o.tempF) && Number.isFinite(o.tsMs));
}

async function fetchPwsCurrent(stationId) {
  const j = await getJson(`https://api.weather.com/v2/pws/observations/current?stationId=${stationId}` +
    `&format=json&units=e&apiKey=${WC_KEY}`);
  const o = (j.observations || [])[0];
  if (!o) return null;
  const tempF = o.imperial?.temp;
  return Number.isFinite(tempF)
    ? { station: stationId, tempF, tsMs: new Date(o.obsTimeUtc || o.obsTimeLocal).getTime() } : null;
}

// Official KNYC obs from the last 48h (precise T-group temps via parseMetar).
async function fetchKnycObs() {
  const r = await fetch("https://aviationweather.gov/api/data/metar?ids=KNYC&hours=48&format=raw",
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`METAR HTTP ${r.status}`);
  const refNow = new Date();
  return stationLines(await r.text(), "KNYC")
    .map(l => parseMetar(l, refNow)).filter(Boolean)
    .map(o => ({ tsMs: o.ts.getTime(), tempF: o.temp_f }))
    .filter(o => Number.isFinite(o.tempF))
    .sort((a, b) => a.tsMs - b.tsMs);
}

const nyYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d).replace(/-/g, "");

async function compute() {
  const now = new Date(), nowMs = now.getTime();
  const stations = Object.keys(PWS_STATIONS);
  const today = nyYmd(now), yesterday = nyYmd(new Date(nowMs - 24 * HOUR_MS));

  const [knycObs, ...pws] = await Promise.all([
    fetchKnycObs(),
    ...stations.map(async (s) => {
      const [d1, d2, cur] = await Promise.all([
        fetchPwsDay(s, yesterday).catch(() => []),
        fetchPwsDay(s, today).catch(() => []),
        fetchPwsCurrent(s).catch(() => null),
      ]);
      return { history: [...d1, ...d2], current: cur };
    }),
  ]);
  if (!knycObs.length) throw new Error("no KNYC obs");

  const pwsRows = pws.flatMap(p => p.history);
  const currents = pws.map(p => p.current).filter(Boolean);
  const pairs = mergeKnycPws(knycObs, pwsRows).filter(p => nowMs - p.hourMs <= 48 * HOUR_MS);

  const statsList = stations.map(s => stationStats(pairs, s, nowMs)).filter(Boolean);
  if (!statsList.length) throw new Error("no station calibrations (need >=6 paired hours each)");
  const weighted = stationWeights(statsList);
  const peakBias = fitPeakBias(pairs, statsList, nowMs);

  const reg = pwsRegressionEstimate(weighted, currents, peakBias);
  if (!reg) throw new Error("no current PWS readings");

  // Anchor = newest official ob; per-station PWS reading in the anchor's window.
  const anchor = knycObs[knycObs.length - 1];
  const anchors = {};
  for (const s of stations) {
    const inWin = pwsRows.filter(p => p.station === s && p.tsMs > anchor.tsMs - HOUR_MS && p.tsMs <= anchor.tsMs);
    if (inWin.length) anchors[s] = Math.max(...inWin.map(p => p.tempF));
  }
  const officialLatest = { tempF: anchor.tempF, tsMs: anchor.tsMs };
  const delta = deltaNowcast(anchor.tempF, anchors, currents, statsList);
  const estimate = blendNowEstimate(reg.estimate, officialLatest, delta, nowMs);

  const round1 = (x) => x == null ? null : Math.round(x * 10) / 10;
  return {
    ok: true, asof: now.toISOString(),
    estimate: round1(estimate),
    components: {
      pws_regression: round1(reg.estimate),
      delta_nowcast: round1(delta),
      official_anchor: round1(anchor.tempF),
      anchor_age_min: Math.round((nowMs - anchor.tsMs) / 60e3),
      peak_bias: round1(peakBias),
    },
    spread: [round1(Math.min(...reg.perStation.map(p => p.est))), round1(Math.max(...reg.perStation.map(p => p.est)))],
    stations: weighted.map(s => ({
      station: s.station, name: PWS_STATIONS[s.station],
      r: round1(s.r), rmse: round1(s.rmse), slope: Math.round(s.slope * 1000) / 1000,
      weight: Math.round(s.weight * 100) / 100, n: s.n,
      current: round1(currents.find(c => c.station === s.station)?.tempF ?? null),
      est: round1(reg.perStation.find(p => p.station === s.station)?.est ?? null),
    })),
  };
}

const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2),
  { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const store = getStore("claude_scoreboard");
  try {
    if (!force) {
      const cached = await store.get(CACHE_KEY, { type: "json" }).catch(() => null);
      if (cached && Date.now() - new Date(cached.asof).getTime() < CACHE_MS) return json({ ...cached, cached: true });
    }
    const out = await compute();
    await store.setJSON(CACHE_KEY, out).catch(() => {});
    return json(out);
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
};
