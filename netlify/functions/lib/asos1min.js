// 1-minute ASOS observations via Synoptic Data API.
//
// Why: weatherbot's existing pipeline computes maxSoFar/minSoFar from hourly
// METAR T-groups (rounded to whole °F at IEM, 0.1°C in raw RMK) plus the 6-hour
// RMK extremes that arrive at 00/06/12/18 UTC. Backtest (5 cities × 30 days)
// shows the synoptic RMK group lags the actual peak by median 211 min / mean
// 197 min, and the bot's maxSoFar at 12 PM and 4 PM local runs ~1°F lower than
// 1-min ASOS would on ~70% of city-days. Synoptic Data API gives free 1-min
// real-time data with sub-degree precision.
//
// Fallback: if SYNOPTIC_API_TOKEN env var is missing, this module returns null
// and the caller falls back to existing hourly+RMK logic. Cost: zero.
//
// To enable: register at https://synopticdata.com/, get a free API token,
// set SYNOPTIC_API_TOKEN on Netlify (Site settings → Environment variables).

const STATIONS = [
  "KNYC", "KLAX", "KMDW", "KHOU", "KPHX", "KPHL", "KSAT", "KSAN", "KDFW", "KJAX",
  "KAUS", "KTPA", "KSJC", "KCMH", "KCLT", "KIND", "KSEA", "KDEN", "KDCA", "KBOS",
];

const UA = "weatherbot.netlify.app (contact: github.com/mf4633)";

let CACHE = { ts: 0, byStation: null };
// 60s matches 1-min ASOS cadence; the bot's outer cache is 3 min, so this
// inner cache resets at most ~3 times per outer fetch but typically once.
const CACHE_MS = 60 * 1000;

// Returns map of { station -> [{ts, tempF}, ...] } sorted by ts asc.
// Returns null if no API token configured or fetch failed (caller falls back).
export async function fetch1MinObs() {
  const now = Date.now();
  if (CACHE.byStation && now - CACHE.ts < CACHE_MS) return CACHE.byStation;

  const token = process.env.SYNOPTIC_API_TOKEN;
  if (!token) return null;

  // Last 720 minutes = 12 hours covers the day's heating and cooling cycle
  // for any local timezone. Sufficient for maxSoFar/minSoFar today.
  const stids = STATIONS.join(",");
  const url = `https://api.synopticdata.com/v2/stations/timeseries`
    + `?stid=${stids}`
    + `&recent=720`
    + `&token=${encodeURIComponent(token)}`
    + `&vars=air_temp`
    + `&units=temp|F`
    + `&output=json`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.STATION) return null;

    const byStation = {};
    for (const s of j.STATION) {
      const sid = s.STID;
      const obs = s.OBSERVATIONS || {};
      const dates = obs.date_time || [];
      // Synoptic uses the convention {var}_set_1, {var}_set_2 where set_1 is
      // typically the primary/QC'd sensor.
      const temps = obs.air_temp_set_1 || obs.air_temp_set_1d || [];
      const series = [];
      for (let i = 0; i < dates.length; i++) {
        const t = parseFloat(temps[i]);
        if (!isFinite(t)) continue;
        const ts = new Date(dates[i]);
        if (isNaN(ts)) continue;
        series.push({ ts, tempF: t });
      }
      series.sort((a, b) => a.ts - b.ts);
      byStation[sid] = series;
    }

    CACHE = { ts: now, byStation };
    return byStation;
  } catch (e) {
    return null;
  }
}

// Compute today's max/min so far for a station.
// Returns { maxSoFar, minSoFar, latestF, latestTs, n } or null if no data.
export function getTodayMaxMin(byStation, station, tzName, now = new Date()) {
  if (!byStation) return null;
  const series = byStation[station];
  if (!series || !series.length) return null;

  // Local midnight (in UTC) for the station's timezone, valid for `now`.
  const localDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tzName, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [Y, M, D] = localDateStr.split("-").map(Number);
  // Pick noon local on this date and derive UTC offset.
  const noonProbe = new Date(Date.UTC(Y, M - 1, D, 12, 0, 0));
  const localHour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tzName, hour: "2-digit", hour12: false,
    }).format(noonProbe), 10
  );
  const offsetHrs = 12 - localHour;
  const localMidnightUTC = new Date(Date.UTC(Y, M - 1, D, offsetHrs, 0, 0));

  const todayObs = series.filter(o => o.ts >= localMidnightUTC && o.ts <= now);
  if (!todayObs.length) return null;

  const temps = todayObs.map(o => o.tempF);
  const last = todayObs[todayObs.length - 1];

  // 5-min weighted bucketing: NWS CLI (which Kalshi settles on) extracts daily
  // max/min from ASOS's 5-min weighted observations, NOT raw 1-min. A 1-min
  // spike that doesn't sustain over 5 minutes never becomes the settlement
  // value. Approximation: bucket the 1-min obs into clock-aligned 5-min windows
  // (e.g., 12:00-12:04, 12:05-12:09), average each bucket, take max/min across
  // buckets. Closer to CLI than raw 1-min max/min, especially on volatile days.
  const buckets = new Map();
  for (const o of todayObs) {
    const ms = o.ts.getTime();
    const bucketStart = Math.floor(ms / (5 * 60 * 1000)) * (5 * 60 * 1000);
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, { sum: 0, n: 0 });
    const b = buckets.get(bucketStart);
    b.sum += o.tempF;
    b.n++;
  }
  let max5 = -Infinity, min5 = Infinity, max5Ts = null, min5Ts = null;
  for (const [bs, b] of buckets) {
    const avg = b.sum / b.n;
    if (avg > max5) { max5 = avg; max5Ts = bs; }
    if (avg < min5) { min5 = avg; min5Ts = bs; }
  }
  const latest5MinBucket = Math.floor(last.ts.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000);
  const latest5MinAvg = buckets.has(latest5MinBucket)
    ? buckets.get(latest5MinBucket).sum / buckets.get(latest5MinBucket).n : null;

  return {
    maxSoFar: Math.max(...temps),
    minSoFar: Math.min(...temps),
    latestF: last.tempF,
    latestTs: last.ts,
    n: todayObs.length,
    max5MinSoFar: isFinite(max5) ? max5 : null,
    min5MinSoFar: isFinite(min5) ? min5 : null,
    max5MinTs: max5Ts ? new Date(max5Ts) : null,
    min5MinTs: min5Ts ? new Date(min5Ts) : null,
    latest5MinAvg,
    nBuckets5Min: buckets.size,
  };
}
