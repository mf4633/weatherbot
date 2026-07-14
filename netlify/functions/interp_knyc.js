// /api/interp_knyc (alias /api/interp) — live interpolated official-sensor temp
// from nearby Weather.com PWS, calibrated against the last 48h of official METARs.
// JS port of the user's interpolatornyc pipeline (see lib/interp_knyc.js).
// ?city=NYC (default) | DEN | LAX.
//
// NYC uses the user's hand-validated 6 stations (pinned). DEN/LAX discover
// candidates via weather.com's location-near API, then let the calibration pick:
// stations are kept only if they track the official sensor (r^2>=0.5, rmse<=4F)
// and the top 6 by r^2/(rmse^2+0.01) survive — same weighting as the estimate
// itself. Discovered lists are cached 24h; estimates cached 5 min.

import { getStore } from "@netlify/blobs";
import { parseMetar } from "./lib/metar.js";
import { stationLines } from "./lib/claude_engine.js";
import {
  PWS_STATIONS, mergeKnycPws, stationStats, stationWeights, fitPeakBias,
  pwsRegressionEstimate, deltaNowcast, blendNowEstimate, selectStations,
} from "./lib/interp_knyc.js";

// Weather.com's public frontend key (shipped in the user's upload). Override via env.
const WC_KEY = process.env.WEATHERCOM_API_KEY || "e1f10a1e78da46f5b10a1e78da96f525";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const CACHE_MS = 5 * 60e3;
const STATIONS_TTL_MS = 24 * 3600e3;
const HOUR_MS = 3600e3;

const CITIES = {
  NYC: { official: "KNYC", tz: "America/New_York", pinned: PWS_STATIONS },
  DEN: { official: "KDEN", tz: "America/Denver", geocode: "39.8561,-104.6737" },
  LAX: { official: "KLAX", tz: "America/Los_Angeles", geocode: "33.9382,-118.3866" },
};

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

// Nearby PWS candidates for a geocode (discovery for cities without a pinned list).
async function discoverCandidates(geocode) {
  const j = await getJson(`https://api.weather.com/v3/location/near?geocode=${geocode}` +
    `&product=pws&format=json&apiKey=${WC_KEY}`);
  const ids = j?.location?.stationId || [];
  const qc = j?.location?.qcStatus || [];
  // qcStatus >= 1 = passing weather.com's own quality control when provided.
  return ids.filter((id, i) => id && (qc[i] == null || qc[i] >= 1)).slice(0, 12);
}

// Official obs from the last 48h (precise T-group temps via parseMetar).
async function fetchOfficialObs(station) {
  const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${station}&hours=48&format=raw`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`METAR HTTP ${r.status}`);
  const refNow = new Date();
  return stationLines(await r.text(), station)
    .map(l => parseMetar(l, refNow)).filter(Boolean)
    .map(o => ({ tsMs: o.ts.getTime(), tempF: o.temp_f }))
    .filter(o => Number.isFinite(o.tempF))
    .sort((a, b) => a.tsMs - b.tsMs);
}

const localYmd = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d).replace(/-/g, "");

async function fetchPwsBundle(stations, tz, nowMs) {
  const today = localYmd(new Date(nowMs), tz), yesterday = localYmd(new Date(nowMs - 24 * HOUR_MS), tz);
  const per = await Promise.all(stations.map(async (s) => {
    const [d1, d2, cur] = await Promise.all([
      fetchPwsDay(s, yesterday).catch(() => []),
      fetchPwsDay(s, today).catch(() => []),
      fetchPwsCurrent(s).catch(() => null),
    ]);
    return { station: s, history: [...d1, ...d2], current: cur };
  }));
  return { rows: per.flatMap(p => p.history), currents: per.map(p => p.current).filter(Boolean) };
}

async function resolveStations(cityKey, cfg, officialObs, store, nowMs) {
  if (cfg.pinned) return { stations: Object.keys(cfg.pinned), names: cfg.pinned, discovered: false };
  const cacheKey = `interp/stations_${cityKey}.json`;
  const cached = await store.get(cacheKey, { type: "json" }).catch(() => null);
  if (cached && nowMs - new Date(cached.asof).getTime() < STATIONS_TTL_MS && cached.stations?.length)
    return { stations: cached.stations, names: cached.names || {}, discovered: true };
  // Discovery: evaluate every candidate against the official trace, keep the top 6.
  const candidates = await discoverCandidates(cfg.geocode);
  if (!candidates.length) throw new Error("no PWS candidates near geocode");
  const bundle = await fetchPwsBundle(candidates, cfg.tz, nowMs);
  const pairs = mergeKnycPws(officialObs, bundle.rows);
  const stats = candidates.map(s => stationStats(pairs, s, nowMs)).filter(Boolean);
  if (!stats.length) throw new Error(`0 of ${candidates.length} candidates calibrated (need >=6 paired hours)`);
  const stations = selectStations(stats, 6);
  const names = Object.fromEntries(stations.map(s => [s, s]));
  await store.setJSON(cacheKey, { asof: new Date(nowMs).toISOString(), stations, names,
    evaluated: candidates.length }).catch(() => {});
  return { stations, names, discovered: true, bundle };
}

async function compute(cityKey) {
  const cfg = CITIES[cityKey];
  const now = new Date(), nowMs = now.getTime();
  const store = getStore("claude_scoreboard");

  const officialObs = await fetchOfficialObs(cfg.official);
  if (!officialObs.length) throw new Error(`no ${cfg.official} obs`);

  const resolved = await resolveStations(cityKey, cfg, officialObs, store, nowMs);
  // Reuse the discovery fetch when it just happened; otherwise fetch the selected set.
  const bundle = resolved.bundle && resolved.stations.every(s => resolved.bundle.rows.some(r => r.station === s))
    ? resolved.bundle
    : await fetchPwsBundle(resolved.stations, cfg.tz, nowMs);

  const rows = bundle.rows.filter(r => resolved.stations.includes(r.station));
  const currents = bundle.currents.filter(c => resolved.stations.includes(c.station));
  const pairs = mergeKnycPws(officialObs, rows).filter(p => nowMs - p.hourMs <= 48 * HOUR_MS);

  const statsList = resolved.stations.map(s => stationStats(pairs, s, nowMs)).filter(Boolean);
  if (!statsList.length) throw new Error("no station calibrations (need >=6 paired hours each)");
  const weighted = stationWeights(statsList);
  const peakBias = fitPeakBias(pairs, statsList, nowMs);

  const reg = pwsRegressionEstimate(weighted, currents, peakBias);
  if (!reg) throw new Error("no current PWS readings");

  const anchor = officialObs[officialObs.length - 1];
  const anchors = {};
  for (const s of resolved.stations) {
    const inWin = rows.filter(p => p.station === s && p.tsMs > anchor.tsMs - HOUR_MS && p.tsMs <= anchor.tsMs);
    if (inWin.length) anchors[s] = Math.max(...inWin.map(p => p.tempF));
  }
  const delta = deltaNowcast(anchor.tempF, anchors, currents, statsList);
  // Ramp detection for the blend's anchor floor: the last two official obs rising.
  const prev = officialObs[officialObs.length - 2];
  const rising = prev != null && anchor.tempF > prev.tempF + 0.2;
  const estimate = blendNowEstimate(reg.estimate, { tempF: anchor.tempF, tsMs: anchor.tsMs }, delta, nowMs, rising);

  const round1 = (x) => x == null ? null : Math.round(x * 10) / 10;
  return {
    ok: true, city: cityKey, official: cfg.official, asof: now.toISOString(),
    discovered: resolved.discovered,
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
      station: s.station, name: resolved.names[s.station] || s.station,
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
  const url = new URL(req.url);
  const cityKey = (url.searchParams.get("city") || "NYC").toUpperCase();
  if (!CITIES[cityKey]) return json({ ok: false, error: `unknown city ${cityKey} (NYC|DEN|LAX)` }, 400);
  const force = url.searchParams.get("force") === "1";
  const store = getStore("claude_scoreboard");
  const cacheKey = `interp/cache_${cityKey}.json`;
  try {
    if (!force) {
      const cached = await store.get(cacheKey, { type: "json" }).catch(() => null);
      if (cached && Date.now() - new Date(cached.asof).getTime() < CACHE_MS) return json({ ...cached, cached: true });
    }
    const out = await compute(cityKey);
    await store.setJSON(cacheKey, out).catch(() => {});
    return json(out);
  } catch (e) {
    return json({ ok: false, city: cityKey, error: String(e?.message || e) }, 500);
  }
};
