// Netlify Function: predicts what tomorrow's CLI<station> will list as today's high.
// For top-20 US cities. Uses NWS hourly forecast + METAR observations + bias correction.

import { getStore } from "@netlify/blobs";

const CITIES = [
  { name: "New York",       cli: "NYC", station: "KNYC", lat: 40.7789, lon: -73.9692, tz: "America/New_York" },
  { name: "Los Angeles",    cli: "LAX", station: "KLAX", lat: 33.9425, lon: -118.4081, tz: "America/Los_Angeles" },
  { name: "Chicago",        cli: "MDW", station: "KMDW", lat: 41.7860, lon: -87.7524, tz: "America/Chicago" },
  { name: "Houston",        cli: "HOU", station: "KHOU", lat: 29.6454, lon: -95.2769, tz: "America/Chicago" },
  { name: "Phoenix",        cli: "PHX", station: "KPHX", lat: 33.4342, lon: -112.0116, tz: "America/Phoenix" },
  { name: "Philadelphia",   cli: "PHL", station: "KPHL", lat: 39.8729, lon: -75.2437, tz: "America/New_York" },
  { name: "San Antonio",    cli: "SAT", station: "KSAT", lat: 29.5337, lon: -98.4698, tz: "America/Chicago" },
  { name: "San Diego",      cli: "SAN", station: "KSAN", lat: 32.7336, lon: -117.1897, tz: "America/Los_Angeles" },
  { name: "Dallas-Fort Worth", cli: "DFW", station: "KDFW", lat: 32.8998, lon: -97.0403, tz: "America/Chicago" },
  { name: "Jacksonville",   cli: "JAX", station: "KJAX", lat: 30.4941, lon: -81.6879, tz: "America/New_York" },
  { name: "Austin",         cli: "AUS", station: "KAUS", lat: 30.1945, lon: -97.6699, tz: "America/Chicago" },
  { name: "Tampa",          cli: "TPA", station: "KTPA", lat: 27.9755, lon: -82.5332, tz: "America/New_York" },
  { name: "San Jose",       cli: "SJC", station: "KSJC", lat: 37.3639, lon: -121.9289, tz: "America/Los_Angeles" },
  { name: "Columbus",       cli: "CMH", station: "KCMH", lat: 39.9980, lon: -82.8919, tz: "America/New_York" },
  { name: "Charlotte",      cli: "CLT", station: "KCLT", lat: 35.2140, lon: -80.9431, tz: "America/New_York" },
  { name: "Indianapolis",   cli: "IND", station: "KIND", lat: 39.7173, lon: -86.2944, tz: "America/Indiana/Indianapolis" },
  { name: "Seattle",        cli: "SEA", station: "KSEA", lat: 47.4502, lon: -122.3088, tz: "America/Los_Angeles" },
  { name: "Denver",         cli: "DEN", station: "KDEN", lat: 39.8617, lon: -104.6731, tz: "America/Denver" },
  { name: "Washington DC",  cli: "DCA", station: "KDCA", lat: 38.8512, lon: -77.0402, tz: "America/New_York" },
  { name: "Boston",         cli: "BOS", station: "KBOS", lat: 42.3656, lon: -71.0096, tz: "America/New_York" }
];

const UA = "weatherbot.netlify.app (contact: github.com/mf4633)";
let CACHE = { ts: 0, data: null };
// Cache 3 min: balances API politeness against forecast staleness. NWS forecast revisions
// (which can shift Kalshi edges by 30%+) need to propagate quickly.
const CACHE_MS = 3 * 60 * 1000;

// Per-city mean-bias offsets — fit on GFS-vs-ERA5 5-year backtest, then HALVED for production
// because deployed model uses NWS forecasts (forecaster-corrected) not raw GFS.
// Treat as interim until ≥30 days of NWS-vs-CLI residuals are logged via /api/logger.
const OFFSET_SCALE = 0.5;
const CITY_OFFSETS_RAW = {
  "New York":             0.39, "Los Angeles":          0.24, "Chicago":              0.10,
  "Houston":              1.20, "Phoenix":              0.15, "Philadelphia":         0.00,
  "San Antonio":          1.10, "San Diego":            0.21, "Dallas-Fort Worth":    0.39,
  "Jacksonville":         0.27, "Austin":               0.80, "Tampa":                0.64,
  "San Jose":            -0.98, "Columbus":             0.88, "Charlotte":            0.09,
  "Indianapolis":         0.29, "Seattle":              0.02, "Denver":               0.01,
  "Washington DC":        0.53, "Boston":               0.64
};
const CITY_OFFSETS = Object.fromEntries(
  Object.entries(CITY_OFFSETS_RAW).map(([k, v]) => [k, v * OFFSET_SCALE])
);

// LOW-temp per-city offsets — fit on 1y backtest with hrs-to-trough σ formula.
// Held-out TEST RMSE 0.91°F. Subtract from prediction (positive = model warm-biased on low).
const CITY_OFFSETS_LOW_RAW = {
  "New York":             0.24,
  "Los Angeles":          0.03,
  "Chicago":              0.24,
  "Houston":              0.28,
  "Phoenix":              0.46,
  "Philadelphia":         0.24,
  "San Antonio":          0.06,
  "San Diego":            0.46,
  "Dallas-Fort Worth":    0.08,
  "Jacksonville":        -0.21,
  "Austin":               0.05,
  "Tampa":               -0.06,
  "San Jose":             0.21,
  "Columbus":            -0.19,
  "Charlotte":           -0.11,
  "Indianapolis":         0.08,
  "Seattle":              0.29,
  "Denver":              -0.10,
  "Washington DC":        0.24,
  "Boston":              -0.29
};
const CITY_OFFSETS_LOW = Object.fromEntries(
  Object.entries(CITY_OFFSETS_LOW_RAW).map(([k, v]) => [k, v * OFFSET_SCALE])
);

// Regime correction (recent forecast-bias): added on top of CITY_OFFSETS to track
// short-window drift the long-run offset can't see. Damping 0.3 over a Bayesian-ish
// blend with the 5-y prior (effective n_prior ≈ 30 days). Floor at 0.5°F to avoid
// fitting noise. Audit on 2026-05-04 of bot's first 28 settled bets showed the model
// running 1.5-2.3°F COLD across NYC/CHI/LAX/AUS/PHL/SAT/DFW/DC over 2 days — that
// regime drift caused most of the loss. Negative values = model under-predicted
// (priorMean -= residual_mean × damping → positive correction). These hardcoded values
// are seed-only; logger.js updates them dynamically into the regime_corrections blob
// after each daily CLI capture, replaced by 7-day rolling mean once data accumulates.
const REGIME_DAMPING = 0.3;
const REGIME_FLOOR_F = 0.5;
const REGIME_RESIDUAL_SEED = {
  "New York":            -1.5, "Los Angeles":         -1.6, "Chicago":             -2.0,
  "Houston":             -1.7, "Phoenix":             -1.0, "Philadelphia":        -2.0,
  "San Antonio":         -2.0, "San Diego":           -1.0, "Dallas-Fort Worth":   -1.7,
  "Jacksonville":        -1.0, "Austin":              -1.5, "Tampa":               -1.0,
  "San Jose":            -1.0, "Columbus":            -1.0, "Charlotte":           -1.0,
  "Indianapolis":        -1.0, "Seattle":             -1.0, "Denver":              -1.0,
  "Washington DC":       -1.3, "Boston":              -1.0
};

const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };

// Standard normal PDF and CDF (Abramowitz & Stegun 26.2.17).
function _phi(x) { return Math.exp(-x*x/2) / Math.sqrt(2 * Math.PI); }
function _Phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x*x/2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
// Truncated normal mean: E[X | X >= a] where X ~ N(mu, sigma^2).
function truncNormalMean(mu, sigma, a) {
  const alpha = (a - mu) / sigma;
  if (alpha < -4) return mu;
  if (alpha > 8) return a;
  const oneMinusPhiA = 1 - _Phi(alpha);
  if (oneMinusPhiA < 1e-9) return a;
  return mu + sigma * (_phi(alpha) / oneMinusPhiA);
}

function parseTGroup(metar) {
  const m = metar.match(/\bT([01])(\d{3})([01])(\d{3})\b/);
  if (!m) return null;
  return { tempC: (m[1]==="1"?-1:1)*parseInt(m[2],10)/10, dewC: (m[3]==="1"?-1:1)*parseInt(m[4],10)/10 };
}

// Parse synoptic temperature extreme groups from a METAR's RMK section:
//   1sTTT     = 6-hour max (s=sign, TTT=tenths °C). Window: (reportTime − 6h, reportTime].
//   2sTTT     = 6-hour min, same format.
//   4sTTTsTTT = 24-hour max+min, both signed-tenths °C. Window: prior climate day.
// These capture between-cycle extremes that the hourly :54 T-group misses. On 2026-05-05
// KBOS the 12Z report carried `20100` → 10.0°C/50°F as the true 06–12Z minimum, while the
// hourly samples never went below 52°F. Without this group, minSoFar over-floors the LOW
// truncation and the model concentrates probability on already-impossible buckets.
function parseRmkExtremes(metar) {
  const rmkIdx = metar.indexOf(" RMK ");
  const scope = rmkIdx >= 0 ? metar.slice(rmkIdx) : metar;
  const decode = (sign, tenths) => (sign === "1" ? -1 : 1) * parseInt(tenths, 10) / 10;
  const out = {};
  const m6max = scope.match(/\b1([01])(\d{3})\b/);
  if (m6max) out.sixHrMaxC = decode(m6max[1], m6max[2]);
  const m6min = scope.match(/\b2([01])(\d{3})\b/);
  if (m6min) out.sixHrMinC = decode(m6min[1], m6min[2]);
  const m24 = scope.match(/\b4([01])(\d{3})([01])(\d{3})\b/);
  if (m24) {
    out.dailyMaxC = decode(m24[1], m24[2]);
    out.dailyMinC = decode(m24[3], m24[4]);
  }
  return out;
}

function parseMetarTime(metar) {
  const m = metar.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  if (!m) return null;
  const [, dd, hh, mm] = m;
  const now = new Date();
  let yr = now.getUTCFullYear(), mo = now.getUTCMonth();
  if (parseInt(dd,10) > now.getUTCDate() + 2) {
    mo -= 1;
    if (mo < 0) { mo = 11; yr -= 1; }
  }
  return new Date(Date.UTC(yr, mo, parseInt(dd,10), parseInt(hh,10), parseInt(mm,10)));
}

function parseBodyTemp(metar) {
  const m = metar.match(/\s(M?\d{2})\/(M?\d{2})\s/);
  if (!m) return null;
  return m[1].startsWith("M") ? -parseInt(m[1].slice(1),10) : parseInt(m[1],10);
}

const cToF = c => c * 9 / 5 + 32;

function localDateParts(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return {
    year: parseInt(p.year, 10),
    month: parseInt(p.month, 10),
    day: parseInt(p.day, 10),
    hour: parseInt(p.hour === "24" ? "0" : p.hour, 10),
    minute: parseInt(p.minute, 10)
  };
}

function localMidnightUTC(tz, now = new Date()) {
  const p = localDateParts(tz, now);
  const offsetMs = (p.hour * 60 + p.minute) * 60 * 1000;
  return new Date(now.getTime() - offsetMs);
}

function hoursToPeak(tz, now = new Date()) {
  const p = localDateParts(tz, now);
  const decimalHr = p.hour + p.minute / 60;
  if (decimalHr >= 15) return 0;
  return Math.max(0, 15 - decimalHr);
}
// For LOW prediction: hours until typical morning trough (~6 AM local).
// After 7 AM local, trough is essentially realized — return 0.
function hoursToTrough(tz, now = new Date()) {
  const p = localDateParts(tz, now);
  const decimalHr = p.hour + p.minute / 60;
  if (decimalHr >= 7) return 0;
  return Math.max(0, 6 - decimalHr);
}

async function fetchMetars() {
  const ids = CITIES.map(c => c.station).join(",");
  const url = `https://aviationweather.gov/api/data/metar?ids=${ids}&hours=24&format=raw`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`METAR fetch failed: ${r.status}`);
  return await r.text();
}

// Returns { dailyHigh, hourly: [{ts, tempF}, ...] } from NWS API.
async function fetchNWSForecast(lat, lon) {
  try {
    const pr = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
      headers: { "User-Agent": UA, "Accept": "application/geo+json" }
    });
    if (!pr.ok) return { dailyHigh: null, hourly: [] };
    const pj = await pr.json();
    const fcUrl = pj.properties?.forecast;
    const hrUrl = pj.properties?.forecastHourly;
    const out = { dailyHigh: null, hourly: [], updateTime: null };
    if (fcUrl) {
      try {
        const fr = await fetch(fcUrl, { headers: { "User-Agent": UA, "Accept": "application/geo+json" } });
        if (fr.ok) {
          const fj = await fr.json();
          const today = fj.properties?.periods?.find(p => p.isDaytime);
          if (today) out.dailyHigh = today.temperature;
          if (fj.properties?.updateTime) out.updateTime = fj.properties.updateTime;
        }
      } catch (e) {}
    }
    if (hrUrl) {
      try {
        const hr = await fetch(hrUrl, { headers: { "User-Agent": UA, "Accept": "application/geo+json" } });
        if (hr.ok) {
          const hj = await hr.json();
          out.hourly = (hj.properties?.periods || []).slice(0, 36).map(p => ({
            ts: new Date(p.startTime),
            tempF: p.temperature
          }));
          // Prefer hourly updateTime if available — it's typically more recent.
          if (hj.properties?.updateTime) out.updateTime = hj.properties.updateTime;
        }
      } catch (e) {}
    }
    return out;
  } catch (e) { return { dailyHigh: null, hourly: [] }; }
}

// Fetch GFS / ECMWF / ICON forecasts via Open-Meteo for ensemble blending.
// Backtest showed equal-weighted 4-model ensemble (NWS+GFS+ECMWF+ICON) gives RMSE 1.30°F vs
// 2.02°F for any single model — roughly 35% reduction. Skip GEM (worst single-model RMSE).
// 5-model ensemble. Backtest (1y, 20 cities, n_test=7200): TEST RMSE 1.313°F vs
// 4-model GFS+ECMWF+ICON+GEM at 1.446 (-9.2%). JMA and GEM hurt more than help on US cities;
// dropped them and added UKMO + MeteoFrance for international diversity.
const ENSEMBLE_MODELS = [
  "gfs_seamless", "ecmwf_ifs025", "icon_seamless", "ukmo_seamless", "meteofrance_seamless"
];
async function fetchOpenMeteoEnsemble(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&hourly=temperature_2m&models=${ENSEMBLE_MODELS.join(",")}`
      + `&temperature_unit=fahrenheit&timezone=UTC&forecast_days=2`;
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const j = await r.json();
    const times = j.hourly?.time;
    if (!times?.length) return null;
    const out = {};
    for (const m of ENSEMBLE_MODELS) {
      const key = `temperature_2m_${m}`;
      if (j.hourly[key]) {
        out[m] = times.map((t, i) => ({ ts: new Date(t + "Z"), tempF: j.hourly[key][i] }))
                       .filter(x => x.tempF != null && !isNaN(x.tempF));
      }
    }
    return out;
  } catch (e) { return null; }
}

// Parse the latest CLI<station> product. CLI text has fixed-column rows; "MAXIMUM" sometimes is on its own
// section header line ("TEMPERATURE (F)") and sometimes only appears in tabular form.
async function fetchLatestCLI(cli) {
  try {
    const url = `https://forecast.weather.gov/product.php?site=NWS&product=CLI&issuedby=${cli}&format=txt&version=1&glossary=0`;
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const html = await r.text();
    const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (!pre) return null;
    const text = pre[1];

    // Detect what date the CLI covers and whether it's a partial mid-day report.
    // Look for "FOR <MONTH> <DAY> <YEAR>" or "AS OF <TIME>".
    const forMatch = text.match(/CLIMATE\s+SUMMARY\s+FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})/i)
                  || text.match(/SUMMARY\s+FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})/i);
    let coversDate = null;
    if (forMatch) {
      const mo = MONTHS[forMatch[1].toUpperCase().slice(0,3)];
      const day = parseInt(forMatch[2], 10);
      const yr = parseInt(forMatch[3], 10);
      coversDate = new Date(Date.UTC(yr, mo, day));
    }
    const isPartial = /VALID\s+(AS\s+OF|TODAY|THROUGH)/i.test(text);

    // Find the MAXIMUM row. Try multiple patterns to handle station-specific formatting.
    let maxF = null;
    // Pattern 1: "MAXIMUM" followed by an integer in the OBSERVED column.
    let m = text.match(/^\s*MAXIMUM\s+(-?\d+)/im);
    if (m) maxF = parseInt(m[1], 10);
    // Pattern 2: "MAXIMUM TEMPERATURE" or "HIGH TEMP" header followed by value on same/next line.
    if (maxF == null) {
      m = text.match(/HIGH(?:EST)?\s+TEMP[A-Z\s\(\)]*\s+(-?\d+)/i);
      if (m) maxF = parseInt(m[1], 10);
    }
    // Pattern 3: scrape "TEMPERATURE" section — find a line with MAXIMUM token followed by 2- or 3-digit number anywhere.
    if (maxF == null) {
      const tempBlock = text.split(/PRECIPITATION|SNOW|WIND|SKY/)[0] || text;
      m = tempBlock.match(/MAXIMUM[^\n]*?(-?\d{2,3})/i);
      if (m) maxF = parseInt(m[1], 10);
    }

    // Mirror the maxF parser for MINIMUM. Partial CLIs may not have a minimum yet.
    let minF = null;
    m = text.match(/^\s*MINIMUM\s+(-?\d+)/im);
    if (m) minF = parseInt(m[1], 10);
    if (minF == null) {
      m = text.match(/LOW(?:EST)?\s+TEMP[A-Z\s\(\)]*\s+(-?\d+)/i);
      if (m) minF = parseInt(m[1], 10);
    }
    if (minF == null) {
      const tempBlock = text.split(/PRECIPITATION|SNOW|WIND|SKY/)[0] || text;
      m = tempBlock.match(/MINIMUM[^\n]*?(-?\d{2,3})/i);
      if (m) minF = parseInt(m[1], 10);
    }

    return {
      maxF, minF,
      coversDate: coversDate ? coversDate.toISOString().slice(0, 10) : null,
      isPartial,
      dateLabel: forMatch ? `${forMatch[1]} ${forMatch[2]} ${forMatch[3]}` : null
    };
  } catch (e) { return null; }
}

function parseStationMetars(allText, station) {
  const lines = allText.split(/\r?\n/).filter(l =>
    l.includes(`METAR ${station} `) || l.includes(`SPECI ${station} `));
  return lines.map(line => {
    const t = parseTGroup(line);
    const ts = parseMetarTime(line);
    const tempC = t ? t.tempC : (parseBodyTemp(line) ?? null);
    const ext = parseRmkExtremes(line);
    return { line, ts, tempC, ...ext };
  }).filter(o => o.ts && o.tempC !== null).sort((a, b) => a.ts - b.ts);
}

// Find the forecast hourly temperature at a given timestamp (linear interp between bracketing periods).
function forecastTempAt(hourly, ts) {
  if (!hourly?.length) return null;
  if (ts <= hourly[0].ts) return hourly[0].tempF;
  if (ts >= hourly[hourly.length - 1].ts) return hourly[hourly.length - 1].tempF;
  for (let i = 0; i < hourly.length - 1; i++) {
    if (ts >= hourly[i].ts && ts <= hourly[i + 1].ts) {
      const f = (ts - hourly[i].ts) / (hourly[i + 1].ts - hourly[i].ts);
      return hourly[i].tempF + f * (hourly[i + 1].tempF - hourly[i].tempF);
    }
  }
  return null;
}

// Find the forecast peak temperature for today (within local midnight → tomorrow midnight).
function forecastPeakToday(hourly, tzMidnight) {
  if (!hourly?.length) return null;
  const tomorrowMidnight = new Date(tzMidnight.getTime() + 24 * 3600 * 1000);
  const todayPeriods = hourly.filter(p => p.ts >= tzMidnight && p.ts < tomorrowMidnight);
  if (!todayPeriods.length) return null;
  return Math.max(...todayPeriods.map(p => p.tempF));
}
function forecastTroughToday(hourly, tzMidnight) {
  if (!hourly?.length) return null;
  const tomorrowMidnight = new Date(tzMidnight.getTime() + 24 * 3600 * 1000);
  const todayPeriods = hourly.filter(p => p.ts >= tzMidnight && p.ts < tomorrowMidnight);
  if (!todayPeriods.length) return null;
  return Math.min(...todayPeriods.map(p => p.tempF));
}
// Truncated normal mean for X | X <= a (upper-bound truncation; mirror of truncNormalMean).
function truncNormalMeanUpper(mu, sigma, a) {
  // Mirror around 0 and reuse the lower-bound function.
  return -truncNormalMean(-mu, sigma, -a);
}

// Compute warming rate (°F/hr) from last ~4 hourly METARs via linear regression.
// Returns null if insufficient data. Clips extreme slopes that won't extrapolate
// (e.g., front-passage spikes capped at +5°F/hr, cooling ramps at −3°F/hr).
function computeWarmingRate(todayObs) {
  if (!todayObs || todayObs.length < 3) return null;
  const recent = todayObs.slice(-4);
  const n = recent.length;
  const t0 = recent[0].ts.getTime();
  const xs = recent.map(o => (o.ts.getTime() - t0) / 3600000);
  const ys = recent.map(o => cToF(o.tempC));
  const xMean = xs.reduce((a, x) => a + x, 0) / n;
  const yMean = ys.reduce((a, y) => a + y, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - xMean) * (ys[i] - yMean), 0);
  const den = xs.reduce((a, x) => a + (x - xMean) ** 2, 0);
  if (den < 0.01) return null;
  return Math.max(-3, Math.min(5, num / den));
}

// Resolve the regime correction (recent 7-day rolling residual mean) for a city.
// Prefers the dynamic blob written by logger.js (under per_city_residual_mean_7d);
// falls back to seed constants when the dynamic blob is missing or unset for the city.
function resolveRegimeResidual(city, regimeBlob) {
  const dyn = regimeBlob?.per_city_residual_mean_7d;
  if (dyn && typeof dyn === "object" && dyn[city.name] != null) {
    return dyn[city.name];
  }
  return REGIME_RESIDUAL_SEED[city.name] ?? 0;
}

function computePrediction(city, metars, forecast, ensemble, lastCLI, regimeBlob) {
  const now = new Date();
  const localMidnight = localMidnightUTC(city.tz, now);
  const todayObs = metars.filter(o => o.ts >= localMidnight);
  const tempsF = todayObs.map(o => cToF(o.tempC));
  let maxSoFar = tempsF.length ? Math.max(...tempsF) : null;
  let minSoFar = tempsF.length ? Math.min(...tempsF) : null;
  // Fold in METAR RMK 6-hour extreme groups (1xxxx / 2xxxx) whose 6h window is
  // entirely inside today's local climate day. Hourly :54 obs miss between-cycle
  // dips; the 12Z synoptic report carries the actual 06–12Z min that CLI uses.
  const SIX_HR_MS = 6 * 3600 * 1000;
  for (const o of todayObs) {
    if (o.ts.getTime() - SIX_HR_MS < localMidnight.getTime()) continue;
    if (o.sixHrMinC != null) {
      const f = cToF(o.sixHrMinC);
      if (minSoFar == null || f < minSoFar) minSoFar = f;
    }
    if (o.sixHrMaxC != null) {
      const f = cToF(o.sixHrMaxC);
      if (maxSoFar == null || f > maxSoFar) maxSoFar = f;
    }
  }
  const currentTemp = todayObs.length ? cToF(todayObs[todayObs.length - 1].tempC) : null;
  const hrsToPeak = hoursToPeak(city.tz, now);

  // === Multi-model ensemble forecast ===
  // Build per-source { peak today, value at current obs time }. Equal-weight available models.
  // Backtest (1y, 20 cities, n_test=7200): equal blend of NWS+GFS+ECMWF+ICON gave RMSE 1.30 vs
  // GFS-only 2.02 (-36%). Production gain expected ≈ 20–30% since NWS may already partially
  // overlap with GFS.
  const sources = [];
  // NWS source.
  let nwsHighF = null, nwsLowF = null;
  {
    const peak = forecastPeakToday(forecast.hourly, localMidnight) ?? forecast.dailyHigh ?? null;
    const trough = forecastTroughToday(forecast.hourly, localMidnight);
    const at = (currentTemp != null && forecast.hourly?.length && todayObs.length)
      ? forecastTempAt(forecast.hourly, todayObs[todayObs.length - 1].ts) : null;
    if (peak != null) {
      sources.push({ model: "nws", peak, trough, at });
      nwsHighF = Math.round(peak);
      nwsLowF = trough != null ? Math.round(trough) : null;
    }
  }
  // Open-Meteo ensemble sources.
  if (ensemble) {
    for (const [m, hourly] of Object.entries(ensemble)) {
      if (!hourly?.length) continue;
      const peak = forecastPeakToday(hourly, localMidnight);
      const trough = forecastTroughToday(hourly, localMidnight);
      const at = (currentTemp != null && todayObs.length)
        ? forecastTempAt(hourly, todayObs[todayObs.length - 1].ts) : null;
      if (peak != null) sources.push({ model: m, peak, trough, at });
    }
  }
  const ensemblePeak = sources.length
    ? sources.reduce((a, s) => a + s.peak, 0) / sources.length : null;
  const troughs = sources.map(s => s.trough).filter(t => t != null);
  const ensembleTrough = troughs.length ? troughs.reduce((a, t) => a + t, 0) / troughs.length : null;
  const sourcesWithAt = sources.filter(s => s.at != null);
  const ensembleAt = sourcesWithAt.length
    ? sourcesWithAt.reduce((a, s) => a + s.at, 0) / sourcesWithAt.length : null;

  // forecastHighF: prefer the ensemble; fall back to NWS-only if ensemble is empty.
  const forecastHighF = ensemblePeak != null ? Math.round(ensemblePeak) : (forecast.dailyHigh ?? null);
  const forecastLowF = ensembleTrough != null ? Math.round(ensembleTrough) : null;

  // Bias correction uses ensembleAt (or ensemble-of-NWS-only if no Open-Meteo response).
  let biasF = null;
  if (currentTemp != null && ensembleAt != null) {
    biasF = currentTemp - ensembleAt;
  }

  if (forecastHighF == null && maxSoFar == null) {
    return {
      name: city.name, cli: city.cli, station: city.station, tz: city.tz,
      error: "no data", currentTemp, maxSoFar, forecastHighF, hrsToPeak, biasF, lastCLI
    };
  }

  // Posterior: forecast prior + bias-correction, then truncated at maxSoFar.
  // σ shrinks smoothly as hrsToPeak → 0; no special "realized" mode (was creating a
  // discontinuous jump and over-tight CIs at peak).
  let mean, std, method;
  if (forecastHighF == null) {
    // No forecast: persistence + warming residual.
    mean = (maxSoFar ?? currentTemp) + Math.min(hrsToPeak, 6) * 1.2;
    std = 4.5;
    method = "persistence";
  } else if (maxSoFar == null) {
    // No obs yet (overnight or station gap): trust forecast.
    mean = forecastHighF;
    std = 3.0;
    method = "forecast-only";
  } else if (hrsToPeak < 1.0) {
    // Peak-collapse: at <1h to peak, the day's max is essentially realized — anchoring on
    // a stale NWS forecast that's already been falsified by maxSoFar mispriced 1°F clusters
    // (CHI/NYC NO positions on 2026-05-02). Small upside budget for late-afternoon warming.
    mean = maxSoFar + 0.2 + 0.3 * hrsToPeak;
    std = Math.max(0.4, 0.4 + 0.3 * hrsToPeak);
    method = "peak-realized";
  } else {
    // Bias-corrected forecast prior. Validated on 5y×20cities held-out (n_test=14400).
    const biasWeight = 0.4;
    const biasMag = biasF != null ? Math.abs(biasF) : 2.0;
    let priorMean = forecastHighF + (biasF != null ? biasWeight * biasF : 0);
    if (CITY_OFFSETS[city.name] != null) priorMean -= CITY_OFFSETS[city.name];
    // Regime correction: damped 7-day forecast bias on top of the long-run offset.
    const regimeResidual = resolveRegimeResidual(city, regimeBlob);
    if (regimeResidual != null && Math.abs(regimeResidual) > REGIME_FLOOR_F) {
      priorMean -= REGIME_DAMPING * regimeResidual;
    }
    // Warming-rate observation term (V3): project current obs trajectory forward and
    // blend with forecast-prior, ONLY in the afternoon window (hrsToPeak ≤ 3). 5y backtest
    // (n_test=14400): all-hours linear extrapolation degrades RMSE 9.3% (early-morning
    // ramps don't sustain to peak); afternoon-only gate improves RMSE 2.1% with bias
    // tightening +0.11 → +0.03. Sinusoidal cot variants tested and discarded (radiative
    // model overstates morning warming, degraded RMSE 19-20%).
    const warmingRate = computeWarmingRate(todayObs);
    if (warmingRate != null && currentTemp != null && hrsToPeak > 0.5 && hrsToPeak <= 3) {
      const projectedMax = currentTemp + 0.4 * warmingRate * hrsToPeak;
      // w_obs caps at 0.4 (gate-driven gain is concentrated near peak).
      const w_obs = Math.max(0.1, Math.min(0.4, 0.5 - 0.1 * hrsToPeak));
      priorMean = (1 - w_obs) * priorMean + w_obs * projectedMax;
    }
    // σ formula re-tuned for the 5-model ensemble. Old: max(0.8, 1.0 + 0.12*lead + 0.10*|bias|)
    // gave σ̄=1.66 against actual RMSE=1.31 — over-covering 84% in 68% CI (target 68%).
    // New params from grid-search calibrated to min |cov68-0.68|+|cov95-0.95|:
    //   TEST: σ̄=1.18, cov68=70%, cov95=93%, RMSE unchanged at 1.31°F.
    const priorStd = Math.max(0.4, 0.7 + 0.08 * hrsToPeak + 0.10 * biasMag);
    // Bayesian truncation: posterior given X >= maxSoFar (max can't be below what's already observed).
    // Use truncated mean but keep empirically-calibrated σ — the σ formula was tuned to actual error
    // variance, not to the forecast prior's variance, so don't shrink it via truncation math.
    mean = truncNormalMean(priorMean, priorStd, maxSoFar);
    std = priorStd;
    method = "bias-corrected";
  }

  // Clip CI lower bound at maxSoFar — physical truncation: today's max can't be < what's already observed.
  const lowerFloor = maxSoFar != null ? maxSoFar : -Infinity;
  const ci68 = [Math.max(lowerFloor, mean - std), mean + std];
  const ci95 = [Math.max(lowerFloor, mean - 1.96 * std), mean + 1.96 * std];
  const round = x => Math.round(x * 10) / 10;

  // === LOW temperature prediction ===
  // Backtest-tuned (1y, 20 cities, n_test=10800): biasWeight=0.5, tighter σ formula,
  // separate per-city offsets. TEST RMSE 0.91°F (vs HIGH 1.31 — LOW is easier).
  // Uses hrsToTrough (~6 AM local) instead of hrsToPeak.
  const hrsToTrough_ = hoursToTrough(city.tz, now);
  let lowMean = null, lowStd = null, lowMethod = null;
  if (forecastLowF != null && minSoFar != null && hrsToTrough_ < 1.0) {
    // Trough-collapse: at <1h to (or past) the morning trough, the day's min is
    // essentially realized — symmetric to the HIGH peak-collapse branch above.
    // Without this, large negative biases drag priorLowMean several °F below
    // minSoFar; truncNormalMeanUpper barely shifts the result back up because the
    // prior is many σ below the truncation bound. Example: Denver 2026-05-05 had
    // bias=−6.3°F → priorLowMean=29.85°F vs minSoFar=35.1°F (6.4σ below), σ=0.82,
    // truncated mean stayed at 29.85°F → bot would fire YES on already-impossible
    // 28-31°F buckets if Kalshi listed them at penny prices.
    // Small downside budget for residual late-morning cooling that scales with
    // hrsToTrough_ (matches HIGH formula: maxSoFar + 0.2 + 0.3*hrsToPeak).
    lowMean = minSoFar - 0.2 - 0.3 * hrsToTrough_;
    lowStd = Math.max(0.4, 0.4 + 0.3 * hrsToTrough_);
    lowMethod = "trough-realized";
  } else if (forecastLowF != null && minSoFar != null) {
    const biasWeight = 0.5;
    const biasMag = biasF != null ? Math.abs(biasF) : 2.0;
    let priorLowMean = forecastLowF + (biasF != null ? biasWeight * biasF : 0);
    if (CITY_OFFSETS_LOW[city.name] != null) priorLowMean -= CITY_OFFSETS_LOW[city.name];
    const priorLowStd = Math.max(0.4, 0.5 + 0.05 * hrsToTrough_ + 0.05 * biasMag);
    // Truncate from above: low <= minSoFar.
    lowMean = truncNormalMeanUpper(priorLowMean, priorLowStd, minSoFar);
    lowStd = priorLowStd;
    lowMethod = "bias-corrected";
  } else if (forecastLowF != null) {
    lowMean = forecastLowF;
    lowStd = 3.0;
    lowMethod = "forecast-only";
  } else if (minSoFar != null) {
    lowMean = minSoFar;
    lowStd = 4.5;
    lowMethod = "obs-only";
  }
  // Clip CI upper bound at minSoFar.
  const upperFloor = minSoFar != null ? minSoFar : Infinity;
  const lowCi68 = lowMean != null
    ? [lowMean - lowStd, Math.min(upperFloor, lowMean + lowStd)] : null;
  const lowCi95 = lowMean != null
    ? [lowMean - 1.96 * lowStd, Math.min(upperFloor, lowMean + 1.96 * lowStd)] : null;

  // Last METAR observation time for staleness diagnostics.
  const lastMetarTime = todayObs.length ? todayObs[todayObs.length - 1].ts.toISOString() : null;
  const lastMetarAgeMin = lastMetarTime ? Math.round((Date.now() - new Date(lastMetarTime).getTime()) / 60000) : null;

  return {
    name: city.name,
    cli: city.cli,
    station: city.station,
    tz: city.tz,
    currentTemp: currentTemp != null ? round(currentTemp) : null,
    lastMetarTime,
    lastMetarAgeMin,
    // HIGH (today's max).
    maxSoFar: maxSoFar != null ? round(maxSoFar) : null,
    forecastHighF,
    nwsHighF,
    forecastPeakHourly: ensemblePeak != null ? Math.round(ensemblePeak) : null,
    biasF: biasF != null ? round(biasF) : null,
    hrsToPeak: Math.round(hrsToPeak * 10) / 10,
    method,
    mean: round(mean),
    median: round(mean),
    mode: round(mean),
    std: Math.round(std * 100) / 100,
    ci68: [round(ci68[0]), round(ci68[1])],
    ci95: [round(ci95[0]), round(ci95[1])],
    // LOW (today's min).
    minSoFar: minSoFar != null ? round(minSoFar) : null,
    forecastLowF,
    nwsLowF,
    lowMethod,
    hrsToTrough: Math.round(hrsToTrough_ * 10) / 10,
    lowMean: lowMean != null ? round(lowMean) : null,
    lowStd: lowStd != null ? Math.round(lowStd * 100) / 100 : null,
    lowCi68: lowCi68 ? [round(lowCi68[0]), round(lowCi68[1])] : null,
    lowCi95: lowCi95 ? [round(lowCi95[0]), round(lowCi95[1])] : null,
    forecastUpdateTime: forecast?.updateTime || null,
    ensembleSources: sources.map(s => ({
      model: s.model, peak: Math.round(s.peak * 10) / 10,
      trough: s.trough != null ? Math.round(s.trough * 10) / 10 : null
    })),
    lastCLI
  };
}

export default async (req) => {
  const now = Date.now();
  if (CACHE.data && (now - CACHE.ts) < CACHE_MS) {
    return new Response(JSON.stringify({ cached: true, ageMs: now - CACHE.ts, cities: CACHE.data }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
    });
  }

  let metarText = "";
  try { metarText = await fetchMetars(); }
  catch (e) {
    return new Response(JSON.stringify({ error: "METAR fetch failed", detail: String(e) }), {
      status: 502, headers: { "content-type": "application/json" }
    });
  }

  // Regime corrections: optional blob written by logger.js (7-day rolling residual mean
  // per city). If missing, computePrediction falls back to REGIME_RESIDUAL_SEED constants.
  let regimeBlob = null;
  try {
    const regimeStore = getStore("regime_corrections");
    regimeBlob = await regimeStore.get("global", { type: "json" });
  } catch (e) { /* fall through to seed */ }

  const [forecasts, ensembles, clis] = await Promise.all([
    Promise.all(CITIES.map(c => fetchNWSForecast(c.lat, c.lon))),
    Promise.all(CITIES.map(c => fetchOpenMeteoEnsemble(c.lat, c.lon))),
    Promise.all(CITIES.map(c => fetchLatestCLI(c.cli)))
  ]);

  const cities = CITIES.map((c, i) => {
    const metars = parseStationMetars(metarText, c.station);
    return computePrediction(c, metars, forecasts[i], ensembles[i], clis[i], regimeBlob);
  });

  CACHE = { ts: now, data: cities };
  return new Response(JSON.stringify({ cached: false, ts: new Date(now).toISOString(), cities }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
  });
};

export const config = { path: "/api/weather" };
