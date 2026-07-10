// Netlify Function: predicts what tomorrow's CLI<station> will list as today's high.
// For top-20 US cities. Uses NWS hourly forecast + METAR observations + bias correction.

import { getStore } from "@netlify/blobs";
import { fetch1MinObs, getTodayMaxMin, coverageCrossCheck } from "./lib/asos1min.js";
import { fetchIemDailyExtremes } from "./lib/iem.js";
import { fetchDsmExtremes } from "./lib/dsm.js";
import { normCdf as _Phi } from "./lib/stats.js";
import { buildSnapshotV2 } from "./lib/metar.js";
import { predict as claudePredict } from "./lib/claude_analog_v3.js";
import { kalmanCorrection, KALMAN_FLOOR_F, KALMAN_PARAMS,
         kalmanGlobalCorrection, KALMAN_GLOBAL_FLOOR_F } from "./lib/regime.js";

const CITIES = [
  { name: "Asheville",      cli: "AVL", station: "KAVL", lat: 35.4362, lon: -82.5414, tz: "America/New_York" },
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
  { name: "Boston",         cli: "BOS", station: "KBOS", lat: 42.3656, lon: -71.0096, tz: "America/New_York" },
  // Added 2026-07-09 to complete the requested 20-city set. New cities have no tuned
  // per-city Kalman params (regime.js) or regime seeds → they fall back to the neutral
  // global correction, so predictions are valid but untuned until backfilled.
  { name: "Miami",          cli: "MIA", station: "KMIA", lat: 25.7906, lon: -80.2869, tz: "America/New_York" },
  { name: "San Francisco",  cli: "SFO", station: "KSFO", lat: 37.6197, lon: -122.3647, tz: "America/Los_Angeles" },
  { name: "New Orleans",    cli: "MSY", station: "KMSY", lat: 29.9934, lon: -90.2581, tz: "America/Chicago" },
  { name: "Las Vegas",      cli: "LAS", station: "KLAS", lat: 36.0840, lon: -115.1537, tz: "America/Los_Angeles" },
  { name: "Oklahoma City",  cli: "OKC", station: "KOKC", lat: 35.3931, lon: -97.6007, tz: "America/Chicago" },
  { name: "Minneapolis",    cli: "MSP", station: "KMSP", lat: 44.8848, lon: -93.2223, tz: "America/Chicago" },
  { name: "Atlanta",        cli: "ATL", station: "KATL", lat: 33.6367, lon: -84.4281, tz: "America/New_York" }
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
// 2026-05-11: LA HIGH bumped 0.24 → 2.0 after audit showed +2.4°F warm bias
// (n=3 bounded, std 0.4°F) during persistent marine-layer regime — model leans
// toward stratus burn-off → 71-72°F highs, actuals stayed 68-70°F. After
// OFFSET_SCALE=0.5 → applied +1.0°F (half-shrinkage from the bounded mean
// because n=3 is thin). Watch logger.js dynamic regime correction; revert when
// the dynamic blob catches up.
const CITY_OFFSETS_RAW = {
  "New York":             0.39, "Los Angeles":          2.0,  "Chicago":              0.10,
  "Houston":              1.20, "Phoenix":              0.15, "Philadelphia":         0.00,
  "San Antonio":          1.10, "San Diego":            0.21, "Dallas-Fort Worth":    0.39,
  "Jacksonville":         0.27, "Austin":               0.80, "Tampa":                0.64,
  "San Jose":            -0.98, "Columbus":             0.88, "Charlotte":            0.09,
  "Indianapolis":         0.29, "Seattle":              0.02, "Denver":               0.01,
  // Boston bumped 0.64 → 2.5 on 2026-05-07: 3 settled-bet days showed consistent
  // +2-3°F warm bias (May 5 high model 81.3 vs actual ~78-79; May 6 high model
  // 81.3 vs actual 78-79 per Kalshi resolution). 5y backtest offset doesn't match
  // recent regime. After 0.5 scale: +1.25°F correction. Conservative; regime seed
  // adds another ~0.45°F. Re-evaluate after 7+ days of data.
  "Washington DC":        0.53, "Boston":               2.5
};
const CITY_OFFSETS = Object.fromEntries(
  Object.entries(CITY_OFFSETS_RAW).map(([k, v]) => [k, v * OFFSET_SCALE])
);

// σ_revision (added 2026-05-15 after staleness audit on Chicago LOW T51 NO):
// when the NWS grid forecast is hours stale, ensemble models agree because they
// all carry the same upper-air analysis — σ_ensemble collapses and σ_post under-
// estimates true uncertainty. Add σ_revision in quadrature so stale forecasts
// widen σ_post organically. Seed α values used until logger.js fits them
// empirically via pairwise Δpred/Δage on the prediction_snapshots blob and
// writes regimeBlob.sigma_revision_state. resolveSigmaRevisionAlphas() picks
// fit values when valid (clamped, n≥MIN_PAIRS), seeds otherwise.
const SIGMA_REVISION_ALPHA_HIGH_SEED = 0.4;   // °F per stale-hour
const SIGMA_REVISION_ALPHA_LOW_SEED  = 0.3;   // °F per stale-hour
const SIGMA_REVISION_AGE_FREE_HR = 1.0;       // first hour free (operational latency)
const SIGMA_REVISION_ALPHA_MIN = 0.1;
const SIGMA_REVISION_ALPHA_MAX = 1.5;
function resolveSigmaRevisionAlphas(regimeBlob) {
  const fit = regimeBlob?.sigma_revision_state;
  const pick = (fitVal, seed) => {
    if (!Number.isFinite(fitVal)) return { value: seed, source: "seed" };
    if (fitVal < SIGMA_REVISION_ALPHA_MIN || fitVal > SIGMA_REVISION_ALPHA_MAX) {
      return { value: seed, source: "seed-clamped" };
    }
    return { value: fitVal, source: "fit" };
  };
  return {
    high: pick(fit?.α_high, SIGMA_REVISION_ALPHA_HIGH_SEED),
    low:  pick(fit?.α_low,  SIGMA_REVISION_ALPHA_LOW_SEED),
    fitAtUTC: fit?.fitAtUTC || null,
    nPairsHigh: fit?.n_pairs_high ?? 0,
    nPairsLow:  fit?.n_pairs_low  ?? 0
  };
}
function sigmaRevisionF(forecastAgeMin, alpha) {
  if (forecastAgeMin == null) return 0;
  const ageHr = forecastAgeMin / 60;
  return alpha * Math.max(0, ageHr - SIGMA_REVISION_AGE_FREE_HR);
}

// LOW-temp per-city offsets — fit on 1y backtest with hrs-to-trough σ formula.
// Held-out TEST RMSE 0.91°F. Subtract from prediction (positive = model warm-biased on low).
// NOTE: 2026-05-11 May regime override for PHX and DFW. Settled LOW-bet audit
// (10 bounded bets in 4 paused cities) showed:
//   Phoenix:           n=3 T-bucket NO LOSSes with bounded residual mean -2.92°F
//                      (model 3°F cold; std 0.12 — exceptionally tight cluster).
//   Dallas-Fort Worth: n=2 T-bucket bounded residual mean -1.67°F.
// 5y prior says these should be near zero. Shrink residual half toward 0 →
// offset_raw -3.0 (PHX) and -2.0 (DFW). After OFFSET_SCALE=0.5 the applied μ shift
// is +1.5°F (PHX) and +1.0°F (DFW), bringing the model into the recent regime.
// Houston and San Antonio show bidirectional residuals in the same window
// (Gulf/coastal moisture flips sign) — kept at long-run priors; cities stay
// paused until residuals stabilize. Revisit after ≥5 more bounded LOW bets
// per city, or when logger.js's dynamic regime_corrections blob takes over.
const CITY_OFFSETS_LOW_RAW = {
  "New York":             0.24,
  "Los Angeles":          0.03,
  "Chicago":              0.24,
  "Houston":              0.28,
  "Phoenix":              -3.0,   // 2026-05-11: model cold-biased by ~3°F on PHX overnight (n=3, std 0.12)
  "Philadelphia":         0.24,
  "San Antonio":          0.06,
  "San Diego":            0.46,
  "Dallas-Fort Worth":    -2.0,   // 2026-05-11: model cold-biased ~1.7°F on DFW overnight (n=2)
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
  // Boston LOW: SIGN FLIP on 2026-05-07. Old value -0.29 (negative = model
  // cold-biased on low). Settled data shows Boston low is WARM-biased: model 51.8
  // vs actual 49-50 on May 6 (+2°F warm). Updated to +0.7 raw → +0.35 after scale.
  // Sample is 1 day; conservative correction. Watch for confirmation.
  "Boston":               0.7
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
// Adaptive damping (added 2026-05-11 after PHX 5/7–5/10 series): when the 3-day
// residual mean exceeds REGIME_CHANGE_THRESHOLD_F AND has the same sign as the
// 7-day mean, the city is in a sustained regime shift, not noise. Double the
// damping to override the prior faster. PHX 2026-05-08→05-10 series had
// resid_7d ≈ -1.2°F (model 1.2°F too cold) but resid_3d was -2.4°F because the
// shift only began on 5/7; the 7d window was diluted by 4 prior calm days.
const REGIME_DAMPING_ADAPTIVE = 0.6;
const REGIME_CHANGE_THRESHOLD_F = 1.5;
const REGIME_RESIDUAL_SEED = {
  "New York":            -1.5, "Los Angeles":         -1.6, "Chicago":             -2.0,
  "Houston":             -1.7, "Phoenix":             -1.0, "Philadelphia":        -2.0,
  "San Antonio":         -2.0, "San Diego":           -1.0, "Dallas-Fort Worth":   -1.7,
  "Jacksonville":        -1.0, "Austin":              -1.5, "Tampa":               -1.0,
  "San Jose":            -1.0, "Columbus":            -1.0, "Charlotte":           -1.0,
  "Indianapolis":        -1.0, "Seattle":             -1.0, "Denver":              -1.0,
  // Boston regime: SIGN FLIP on 2026-05-07. Other cities show MODEL-COLD bias
  // (cold-mean-tail on May 2-3); Boston's recent settled bets show MODEL-WARM
  // bias instead. Seed +1.5 reflects this opposite regime; logger.js will refine
  // as more daily CLI captures land.
  "Washington DC":       -1.3, "Boston":               1.5
};

const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };

// Standard normal PDF here; CDF `_Phi` is imported from lib/stats.js (A&S 26.2.17).
function _phi(x) { return Math.exp(-x*x/2) / Math.sqrt(2 * Math.PI); }
// Truncated normal mean: E[X | X >= a] where X ~ N(mu, sigma^2).
function truncNormalMean(mu, sigma, a) {
  const alpha = (a - mu) / sigma;
  if (alpha < -4) return mu;
  if (alpha > 8) return a;
  const oneMinusPhiA = 1 - _Phi(alpha);
  if (oneMinusPhiA < 1e-9) return a;
  return mu + sigma * (_phi(alpha) / oneMinusPhiA);
}

// Expected daily max with floor: E[max(X, a)] where X ~ N(mu, sigma^2).
// This is the right object for predicting CLI's reported daily MAX given an
// already-observed today-so-far max of `a` — the daily max is literally
// max(future_peak, a), a mixture: mass below `a` collapses to `a`, mass above
// `a` stays. Distinct from truncNormalMean which returns E[X | X >= a] (the
// conditional mean given the bound). truncNormalMean overshoots when mu < a
// because it lifts the mean to the conditional centroid above the floor;
// expectedMaxNormal correctly returns ≈ a in that regime.
//   E[max(X, a)] = mu + (a - mu)·Φ((a-mu)/σ) + σ·φ((a-mu)/σ)
function expectedMaxNormal(mu, sigma, a) {
  const z = (a - mu) / sigma;
  if (z > 6) return a;       // mu << a: daily max essentially locked at a
  if (z < -6) return mu;     // mu >> a: floor irrelevant
  return mu + (a - mu) * _Phi(z) + sigma * _phi(z);
}

// Expected daily min with ceiling: E[min(X, b)] where X ~ N(mu, sigma^2).
// Mirror of expectedMaxNormal — used for LOW prediction where minSoFar is an
// upper bound on the day's eventual minimum (today's low can't be > what's
// already been observed). Mass above `b` collapses to `b`; mass below stays.
//   E[min(X, b)] = mu + (b - mu)·(1 - Φ((b-mu)/σ)) - σ·φ((b-mu)/σ)
function expectedMinNormal(mu, sigma, b) {
  const z = (b - mu) / sigma;
  if (z < -6) return b;      // mu >> b: daily min essentially locked at b
  if (z > 6) return mu;      // mu << b: ceiling irrelevant
  return mu + (b - mu) * (1 - _Phi(z)) - sigma * _phi(z);
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
  let scope = rmkIdx >= 0 ? metar.slice(rmkIdx) : metar;
  // Anchor to the position right after the precise T-group (T<sign><temp><sign><dewp>).
  // NWS RMK ordering puts synoptic 6h/24h extreme groups (1sTTT, 2sTTT, 4sTTTsTTT)
  // strictly after the T-group, while PK WND tokens precede it. Without this anchor,
  // a PK WND payload like "21026/1530" (wind 210° at 26 kt) false-matches the 6h-min
  // regex \b2[01]\d{3}\b and decodes as -2.6°C → 27.3°F, which then floors minSoFar.
  // Same hazard for 6h-max when wind direction is 100-119°. Verified bug 2026-05-05
  // on KDFW 1553Z (PK WND 21026/1530) and KCMH 1651Z (PK WND 21026/1610).
  const tMatch = scope.match(/\bT[01]\d{3}[01]\d{3}\b/);
  if (tMatch) scope = scope.slice(tMatch.index + tMatch[0].length);
  else return {};  // no T-group → no synoptic extremes follow
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
  // 48h (was 24h) so the inline Claude analog has a prior-day analog to ramp from.
  const url = `https://aviationweather.gov/api/data/metar?ids=${ids}&hours=48&format=raw`;
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

// Batched multi-location variant. Open-Meteo accepts comma-separated lat/lon and
// returns a JSON ARRAY (one element per location, in request order), so all cities'
// ensembles come back in ONE ~57KB request. This replaces the previous 21-wide
// concurrent burst (Promise.all over fetchOpenMeteoEnsemble), which routinely drew
// 429s on a subset of cities → that city's ensemble null → sources.length<3 →
// dataAgeMin degrades to NWS-grid age (hours old) → trader skips the city. One request
// removes the burst entirely (~21x fewer Open-Meteo calls per cache-miss).
// Returns an array aligned to `cities` order (each entry the same {model:[{ts,tempF}]}
// shape as fetchOpenMeteoEnsemble, or null for an unusable element), or null for the
// WHOLE batch on hard failure so the caller falls back to the per-city path.
async function fetchOpenMeteoEnsembleBatch(cities) {
  const lat = cities.map(c => c.lat).join(",");
  const lon = cities.map(c => c.lon).join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&hourly=temperature_2m&models=${ENSEMBLE_MODELS.join(",")}`
    + `&temperature_unit=fahrenheit&timezone=UTC&forecast_days=2`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) { if (attempt === 0) continue; return null; }   // one retry, then bail to fallback
      const j = await r.json();
      const arr = Array.isArray(j) ? j : [j];
      // Length guard: Open-Meteo preserves request order, but if the array doesn't line
      // up 1:1 with cities we refuse to risk attributing one city's models to another.
      if (arr.length !== cities.length) return null;
      return arr.map(loc => {
        const times = loc?.hourly?.time;
        if (!times?.length) return null;
        const out = {};
        for (const m of ENSEMBLE_MODELS) {
          const key = `temperature_2m_${m}`;
          if (loc.hourly[key]) {
            out[m] = times.map((t, i) => ({ ts: new Date(t + "Z"), tempF: loc.hourly[key][i] }))
                          .filter(x => x.tempF != null && !isNaN(x.tempF));
          }
        }
        return Object.keys(out).length ? out : null;
      });
    } catch (e) { if (attempt === 0) continue; return null; }
  }
  return null;
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
    // CRITICAL: when the OBSERVED column is "M" / "MM" / "-" (no obs yet on a partial CLI),
    // patterns 1 + 2 must NOT silently fall through to pattern 3 — that would scan further
    // along the line and grab the next integer, which is the NORMAL (climatology) column.
    // Verified bug 2026-05-05 on CLISAT/CLIAUS partial CLIs both reading 71/70 (the
    // climatological max/min) while live obs was 80°F+. Detect the placeholder and treat
    // the whole row as no-data.
    const observedMissing = /^\s*MAXIMUM\s+(?:M+|-+)(?:\s|$)/im.test(text);
    let maxF = null;
    // Pattern 1: "MAXIMUM" followed by an integer in the OBSERVED column.
    let m = text.match(/^\s*MAXIMUM\s+(-?\d+)/im);
    if (m) maxF = parseInt(m[1], 10);
    // Pattern 2: "MAXIMUM TEMPERATURE" or "HIGH TEMP" header followed by value on same/next line.
    if (maxF == null && !observedMissing) {
      m = text.match(/HIGH(?:EST)?\s+TEMP[A-Z\s\(\)]*\s+(-?\d+)/i);
      if (m) maxF = parseInt(m[1], 10);
    }
    // Pattern 3: scrape "TEMPERATURE" section — find a line with MAXIMUM token followed by 2- or 3-digit number anywhere.
    if (maxF == null && !observedMissing) {
      const tempBlock = text.split(/PRECIPITATION|SNOW|WIND|SKY/)[0] || text;
      m = tempBlock.match(/MAXIMUM[^\n]*?(-?\d{2,3})/i);
      if (m) maxF = parseInt(m[1], 10);
    }

    // Mirror the maxF parser for MINIMUM. Partial CLIs may not have a minimum yet.
    const minObservedMissing = /^\s*MINIMUM\s+(?:M+|-+)(?:\s|$)/im.test(text);
    let minF = null;
    m = text.match(/^\s*MINIMUM\s+(-?\d+)/im);
    if (m) minF = parseInt(m[1], 10);
    if (minF == null && !minObservedMissing) {
      m = text.match(/LOW(?:EST)?\s+TEMP[A-Z\s\(\)]*\s+(-?\d+)/i);
      if (m) minF = parseInt(m[1], 10);
    }
    if (minF == null && !minObservedMissing) {
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
// Remaining-day trough: lowest forecast temp from `now` through end-of-today-local.
// Captures evening cold fronts that can drive the calendar-day min below the
// already-observed minSoFar (which usually reflects the morning trough only).
// Distinct from forecastTroughToday which scans the full day including past hours.
function forecastRemainingTroughToday(hourly, tzMidnight, now) {
  if (!hourly?.length) return null;
  const tomorrowMidnight = new Date(tzMidnight.getTime() + 24 * 3600 * 1000);
  const remaining = hourly.filter(p => p.ts >= now && p.ts < tomorrowMidnight);
  if (!remaining.length) return null;
  return Math.min(...remaining.map(p => p.tempF));
}
// Remaining-day peak: highest forecast temp from `now` through end-of-today-local.
// Mirror of forecastRemainingTroughToday for HIGH markets. Catches late-day warm
// pushes (warm fronts, foehn/downsloping, marine inversion break, late convective
// peak) that drive the calendar-day max above an already-observed maxSoFar — the
// peak-realized branch anchors mean ≈ maxSoFar in this regime and misses them.
function forecastRemainingPeakToday(hourly, tzMidnight, now) {
  if (!hourly?.length) return null;
  const tomorrowMidnight = new Date(tzMidnight.getTime() + 24 * 3600 * 1000);
  const remaining = hourly.filter(p => p.ts >= now && p.ts < tomorrowMidnight);
  if (!remaining.length) return null;
  return Math.max(...remaining.map(p => p.tempF));
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

// Frontal-volatility σ contribution. Returns °F to be quadratically combined with
// σ_ensemble and σ_resolution. Captures uncertainty that the existing decomposition
// underestimates during synoptic transitions:
//
//   1. UPCOMING front — forecast.hourly predicts a sharp temp shift in the next 3h.
//      Ensemble disagreement σ alone undersamples this case: all 5 models can agree
//      on the existence of a drop while still being off on its timing or magnitude
//      by 1-2°F. Diurnal range over 3h on a calm day is typically <2°F, so wider
//      ranges in the forward window indicate frontal forcing.
//
//   2. RECENT front — todayObs show a sharp temp shift in the last 90min. The
//      trough-realized / peak-realized branches collapse σ to ~σ_resolution at this
//      point on the assumption that the day's extremum is locked in, but a passing
//      front leaves residual aleatoric uncertainty for hours afterward (the day's
//      actual extremum may be the just-realized minSoFar OR a further drop as the
//      front continues advecting cold air). Calm-air variation in this window is
//      typically <0.5°F; >1°F implies recent frontal activity.
//
// Regimes are correlated (both indicate front-driven instability) — take max not
// sum. Returns 0 on calm conditions.
//
// Calibrated against SATX 2026-05-07: forecast hourly window predicted ~3-4°F range
// (front + post-front warming) → σ_forecast ≈ 0.5-1.0°F. Obs at 12:40+ showed 1.8°F
// range over <30min → σ_obs ≈ 1.3°F. Combined with σ_res=0.7°F gives σ_post ≈ 1.5°F
// vs the 0.7°F that drove the dual-loss trade.
function computeFrontalSigma(todayObs, hourlyForecast, now) {
  let sigmaForecast = 0;
  let sigmaObs = 0;
  if (hourlyForecast?.length) {
    const horizon = new Date(now.getTime() + 3 * 3600 * 1000);
    const fwd = hourlyForecast.filter(p => p.ts >= now && p.ts <= horizon
                                            && Number.isFinite(p.tempF));
    if (fwd.length >= 2) {
      const temps = fwd.map(p => p.tempF);
      const range = Math.max(...temps) - Math.min(...temps);
      if (range > 2.0) sigmaForecast = Math.min(1.5, (range - 2.0) * 0.5);
    }
  }
  if (todayObs?.length >= 2) {
    const cutoff = now.getTime() - 90 * 60 * 1000;
    const recent = todayObs.filter(o => o.ts.getTime() >= cutoff);
    if (recent.length >= 2) {
      const tempsF = recent.map(o => cToF(o.tempC));
      const range = Math.max(...tempsF) - Math.min(...tempsF);
      if (range > 1.0) sigmaObs = Math.min(1.5, range - 0.5);
    }
  }
  return Math.max(sigmaForecast, sigmaObs);
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

// Adaptive damping: returns REGIME_DAMPING_ADAPTIVE when the 3d residual mean
// indicates a sustained regime shift in the same direction as the 7d mean,
// REGIME_DAMPING otherwise. Both 7d and 3d come from logger.js per_city_residual_*.
function resolveRegimeDamping(city, regimeBlob, residual7d) {
  const dyn3 = regimeBlob?.per_city_residual_mean_3d;
  if (!dyn3 || typeof dyn3 !== "object") return REGIME_DAMPING;
  const r3 = dyn3[city.name];
  if (r3 == null) return REGIME_DAMPING;
  // Same sign as 7d (both negative = sustained cold model, both positive = sustained warm)
  // AND |3d| materially larger than the change threshold.
  if (residual7d != null && Math.sign(r3) === Math.sign(residual7d)
      && Math.abs(r3) > REGIME_CHANGE_THRESHOLD_F) {
    return REGIME_DAMPING_ADAPTIVE;
  }
  return REGIME_DAMPING;
}

// Intraday-residual weight β(hrsToPeak) for the HIGH bias-correction term. EMPIRICAL,
// replaces the old exponential "bias burns off" decay (2026-05-26). Regression of the
// end-of-day high residual (high_obs − high_fc) on the live obs-vs-forecast gap
// (obs_now − fc_now) at fixed local hours over 5y × 20 cities (n=36,520/hr) found β
// RISES toward peak — the OPPOSITE of the old decay:
//   hrsToPeak:  9    8    7    6    5    4    3    2    1
//   β_opt:     .09  .10  .16  .36  .51  .61  .68  .73  .73   (corr .09→.80)
//   β_old:     .33  .32  .30  .28  .25  .22  .18  .13  .07   (= 0.4·(1−e^(−h/5)))
// The old curve under-weighted the strong midday/afternoon signal by 3-10× and decayed
// it toward peak; optimal-β cuts the bias-branch RMSE 2.29→1.84 at hrsToPeak=3 (−20%)
// and 2.41→1.50 at hrsToPeak=1 (−38%). Early-morning β is genuinely tiny (morning gap
// is noise), so the curve correctly down-weights there. Piecewise-linear over measured
// points. NOTE: calibrated on GFS_seamless historical fc; the live ensemble (NWS+GFS+
// ECMWF+ICON) is more accurate, so refit on logged ensemble residuals when available —
// the shape (rising toward peak) is robust, the magnitude may shift slightly.
// SEED curves (the 5y×20-city fit). These are the fallback / cold-start values; the live
// β is refit on a rolling window by logger.runRefitIntradayBeta (regression of
// (actual−forecast) on biasF, binned by hrsToPeak/Trough, written to
// regimeBlob.intraday_beta_state) and resolved per-bin below — same self-updating pattern
// as σ_revision. LOW seed: β rises toward the dawn trough (0.52 at 6h → 0.69 at 1h);
// no near-zero region (overnight gap already predictive, corr 0.56→0.76).
const HIGH_BIAS_BETA_SEED = [[1,0.73],[2,0.73],[3,0.68],[4,0.61],[5,0.51],[6,0.36],[7,0.16],[8,0.10],[9,0.09]];
const LOW_BIAS_BETA_SEED  = [[1,0.69],[2,0.67],[3,0.64],[4,0.61],[5,0.57],[6,0.52]];
function interpBeta(T, x) {
  if (x <= T[0][0]) return T[0][1];
  if (x >= T[T.length - 1][0]) return T[T.length - 1][1];
  for (let i = 1; i < T.length; i++) {
    const [h0, b0] = T[i - 1], [h1, b1] = T[i];
    if (x <= h1) return b0 + (b1 - b0) * (x - h0) / (h1 - h0);
  }
  return T[T.length - 1][1];
}
// Merge rolling-fit β (per integer-hr bin, where it had enough samples) over the seed.
// Until enough settled snapshots accumulate, this == the seed curve exactly.
function resolveIntradayBeta(regimeBlob) {
  const st = regimeBlob?.intraday_beta_state;
  const merge = (seed, fitted) => {
    if (!Array.isArray(fitted) || !fitted.length) return seed;
    const fmap = new Map(fitted.map(p => [p[0], p[1]]));
    return seed.map(([h, b]) => [h, fmap.has(h) ? fmap.get(h) : b]);
  };
  return { high: merge(HIGH_BIAS_BETA_SEED, st?.high), low: merge(LOW_BIAS_BETA_SEED, st?.low) };
}

function computePrediction(city, metars, forecast, ensemble, lastCLI, regimeBlob, oneMin, iem, dsm, oneMinByStation) {
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
  // Fold in 1-min ASOS observations (real-time, sub-hourly precision via Synoptic API).
  // RMK extremes only refresh at 00/06/12/18 UTC and in backtest lag the actual peak
  // by median 211 min; 1-min closes the gap. No-op when API token absent.
  const maxSoFarBefore1Min = maxSoFar;
  const minSoFarBefore1Min = minSoFar;
  // synopticCoverage classifies whether this station is being meaningfully monitored
  // by Synoptic 1-min/5-min ASOS, or has fallen back to hourly-only / stalled / blind.
  // Drives downstream gating in jackson_trader.js — degraded coverage means the
  // model's maxSoFar can miss between-METAR spikes that still affect CLI settlement,
  // so position sizing should be reduced. KNYC 2026-05-07 incident: station ran with
  // a `$` maintenance flag → Synoptic returned 4 obs in 240 min (hourly snapshots),
  // but the dashboard surfaced no warning. Trader could have sized full Kelly into
  // a bucket bet whose monitor was effectively offline.
  let synopticCoverage = "none";
  if (oneMin) {
    const ageMin = oneMin.latestTs ? (Date.now() - new Date(oneMin.latestTs).getTime()) / 60000 : null;
    const n = oneMin.n ?? 0;
    if (n < 30) synopticCoverage = "hourly-only";
    else if (ageMin == null || ageMin > 30) synopticCoverage = "stalled";
    else if (ageMin > 10) synopticCoverage = "5min";
    else synopticCoverage = "1min";

    if (oneMin.maxSoFar != null && (maxSoFar == null || oneMin.maxSoFar > maxSoFar)) {
      maxSoFar = oneMin.maxSoFar;
    }
    if (oneMin.minSoFar != null && (minSoFar == null || oneMin.minSoFar < minSoFar)) {
      minSoFar = oneMin.minSoFar;
    }
    // Observability: log every invocation so we can grep `[asos1min] <station>: n=0`
    // to find silent failures (vs `n=N agree` for working-but-quiet, vs gain detail
    // for working-and-material). Previous gain-only filter masked the KNYC degraded
    // case — couldn't distinguish working-with-no-gain from broken-no-data.
    const maxGain = (maxSoFarBefore1Min != null) ? maxSoFar - maxSoFarBefore1Min : 0;
    const minGain = (minSoFarBefore1Min != null) ? minSoFarBefore1Min - minSoFar : 0;
    const detail = (maxGain >= 0.5 || minGain >= 0.5)
      ? `max ${(maxSoFarBefore1Min ?? 0).toFixed(1)}->${maxSoFar.toFixed(1)} (+${maxGain.toFixed(1)}F) min ${(minSoFarBefore1Min ?? 0).toFixed(1)}->${minSoFar.toFixed(1)} (-${minGain.toFixed(1)}F)`
      : `agree`;
    console.log(`[asos1min] ${city.station}: n=${oneMin.n} cov=${synopticCoverage} ${detail}`);
  } else {
    console.log(`[asos1min] ${city.station}: n=0 cov=none no-data`);
  }
  // Airmass cross-check for a degraded settlement monitor (SETTLEMENT-SAFE — never
  // touches maxSoFar/maxSoFarCli). When the primary is on hourly-only/stalled/no
  // 5-min coverage AND a well-sited neighbor still shows the airmass climbing, the
  // flat maxSoFar is probably stale-low; flag it so the trader cuts size / waits.
  let coverageWarn = null;
  if (synopticCoverage !== "1min" && synopticCoverage !== "5min") {
    const xc = coverageCrossCheck(oneMinByStation, city.station, city.tz, now);
    if (xc) {
      const warn = xc.rise30F != null && xc.rise30F >= 1.0;
      coverageWarn = { primaryCov: synopticCoverage, ...xc, warn };
      if (warn) console.log(`[coverage-xcheck] ${city.station}: primary=${synopticCoverage} but ${xc.neighbor} +${xc.rise30F.toFixed(1)}F/30min — maxSoFar likely stale-low, cut size`);
    }
  }
  // IEM divergence alarm: if our maxSoFar (METAR + Synoptic-derived) disagrees with
  // IEM's preliminary daily max by more than 1°F, one of the two has stale or missing
  // data. Logs only on divergence to keep volume low.
  if (iem?.dailyMaxF != null && maxSoFar != null) {
    const delta = iem.dailyMaxF - maxSoFar;
    if (Math.abs(delta) > 1.0) {
      console.log(`[iem-divergence] ${city.station}: bot_max=${maxSoFar.toFixed(1)} iem_max=${iem.dailyMaxF.toFixed(1)} delta=${delta.toFixed(1)}F`);
    }
  }
  // DSM fold-in: the NWS Daily Summary Message reports max/min from ASOS DI-1
  // internal continuous data — the same source the official CLI is generated from.
  // When DSM exceeds maxSoFar (or undershoots minSoFar), it has captured a
  // between-METAR sensor extreme that all other sources missed. Authoritative
  // for settlement; fold into maxSoFar/minSoFar so the prediction model and the
  // trader's bucket-margin checks use it directly. KNYC 2026-05-07 incident: DSM
  // showed max=64°F at 14:34 EDT while every METAR/SPECI/Synoptic/IEM ob said 63°F.
  if (dsm) {
    if (dsm.dailyMaxF != null && (maxSoFar == null || dsm.dailyMaxF > maxSoFar)) {
      const dsmGain = maxSoFar != null ? dsm.dailyMaxF - maxSoFar : 0;
      console.log(`[dsm-fold] ${city.station}: maxSoFar ${maxSoFar?.toFixed(1) ?? "null"} -> ${dsm.dailyMaxF} (+${dsmGain.toFixed(1)}F at ${dsm.maxTimeLocal} local, issued ${dsm.issuedAt})`);
      maxSoFar = dsm.dailyMaxF;
    }
    if (dsm.dailyMinF != null && (minSoFar == null || dsm.dailyMinF < minSoFar)) {
      const dsmDrop = minSoFar != null ? minSoFar - dsm.dailyMinF : 0;
      console.log(`[dsm-fold] ${city.station}: minSoFar ${minSoFar?.toFixed(1) ?? "null"} -> ${dsm.dailyMinF} (-${dsmDrop.toFixed(1)}F at ${dsm.minTimeLocal} local)`);
      minSoFar = dsm.dailyMinF;
    }
  }
  // currentTemp: prefer 1-min ASOS latest when its timestamp is newer than the latest
  // METAR. METAR is 5 mins to hourly with integer-°C quantization; 1-min ASOS lands
  // every ~1 min in tenths of °F. When both are healthy, the 1-min reading is fresher
  // and higher-precision. lastMetarTime / lastMetarAgeMin still anchor on METAR for
  // the staleness diagnostics — they describe the obs *source*, not the displayed
  // current value.
  let currentTemp = todayObs.length ? cToF(todayObs[todayObs.length - 1].tempC) : null;
  let currentTempSource = currentTemp != null ? "metar" : null;
  let currentTempTime = todayObs.length ? todayObs[todayObs.length - 1].ts.toISOString() : null;
  if (oneMin?.latestF != null && oneMin?.latestTs) {
    const metarMs = todayObs.length ? todayObs[todayObs.length - 1].ts.getTime() : 0;
    const oneMinMs = new Date(oneMin.latestTs).getTime();
    if (oneMinMs > metarMs) {
      currentTemp = oneMin.latestF;
      currentTempSource = "asos1min";
      currentTempTime = new Date(oneMin.latestTs).toISOString();
    }
  }
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
    const remainingTrough = forecastRemainingTroughToday(forecast.hourly, localMidnight, now);
    const remainingPeak = forecastRemainingPeakToday(forecast.hourly, localMidnight, now);
    const at = (currentTemp != null && forecast.hourly?.length && todayObs.length)
      ? forecastTempAt(forecast.hourly, todayObs[todayObs.length - 1].ts) : null;
    if (peak != null) {
      sources.push({ model: "nws", peak, trough, remainingTrough, remainingPeak, at });
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
      const remainingTrough = forecastRemainingTroughToday(hourly, localMidnight, now);
      const remainingPeak = forecastRemainingPeakToday(hourly, localMidnight, now);
      const at = (currentTemp != null && todayObs.length)
        ? forecastTempAt(hourly, todayObs[todayObs.length - 1].ts) : null;
      if (peak != null) sources.push({ model: m, peak, trough, remainingTrough, remainingPeak, at });
    }
  }
  const ensemblePeak = sources.length
    ? sources.reduce((a, s) => a + s.peak, 0) / sources.length : null;
  const troughs = sources.map(s => s.trough).filter(t => t != null);
  const ensembleTrough = troughs.length ? troughs.reduce((a, t) => a + t, 0) / troughs.length : null;
  // Remaining-day trough across the ensemble — for evening cold-front detection.
  const remainingTroughs = sources.map(s => s.remainingTrough).filter(t => t != null);
  const ensembleRemainingTrough = remainingTroughs.length
    ? remainingTroughs.reduce((a, t) => a + t, 0) / remainingTroughs.length : null;
  // Remaining-day peak — for late-day warm-push detection (mirror of remainingTrough).
  const remainingPeaks = sources.map(s => s.remainingPeak).filter(t => t != null);
  const ensembleRemainingPeak = remainingPeaks.length
    ? remainingPeaks.reduce((a, t) => a + t, 0) / remainingPeaks.length : null;
  // Ensemble disagreement σ — std across the 5 model forecasts. Captures *forecast
  // uncertainty* in a Bayesian decomposition: combined with σ_resolution below to
  // give the posterior σ. Sample std (n-1) so we don't underestimate when n is small.
  const sigmaEnsemblePeak = sources.length > 1
    ? Math.sqrt(sources.reduce((a, s) => a + (s.peak - ensemblePeak) ** 2, 0) / (sources.length - 1))
    : null;
  const sigmaEnsembleTrough = troughs.length > 1
    ? Math.sqrt(troughs.reduce((a, t) => a + (t - ensembleTrough) ** 2, 0) / (troughs.length - 1))
    : null;
  const sourcesWithAt = sources.filter(s => s.at != null);
  const ensembleAt = sourcesWithAt.length
    ? sourcesWithAt.reduce((a, s) => a + s.at, 0) / sourcesWithAt.length : null;

  // forecastHighF: prefer the ensemble; fall back to NWS-only if ensemble is empty.
  const forecastHighF = ensemblePeak != null ? Math.round(ensemblePeak) : (forecast.dailyHigh ?? null);
  const forecastLowF = ensembleTrough != null ? Math.round(ensembleTrough) : null;

  // NWS grid age — proxy for forecast staleness. Hoisted here so HIGH and LOW
  // priorStd branches can add σ_revision (see sigmaRevisionF at top of file).
  // The dataAgeMin computation downstream still uses this same value.
  const forecastAgeMin = forecast?.updateTime
    ? Math.round((Date.now() - new Date(forecast.updateTime).getTime()) / 60000)
    : null;
  const sigmaRevisionAlphas = resolveSigmaRevisionAlphas(regimeBlob);
  const { high: highBetaTbl, low: lowBetaTbl } = resolveIntradayBeta(regimeBlob);

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

  // Frontal-volatility σ — added 2026-05-07 after SATX dual-loss on cold-front day.
  // Quadratically combined with σ_ens and σ_res in every branch below. See
  // computeFrontalSigma() header for regime descriptions and calibration.
  const sigmaFrontal = computeFrontalSigma(todayObs, forecast?.hourly, now);

  // Posterior: forecast prior + bias-correction, then truncated at maxSoFar.
  // σ shrinks smoothly as hrsToPeak → 0; no special "realized" mode (was creating a
  // discontinuous jump and over-tight CIs at peak).
  let mean, std, method;
  if (forecastHighF == null) {
    // No forecast: persistence + warming residual.
    mean = (maxSoFar ?? currentTemp) + Math.min(hrsToPeak, 6) * 1.2;
    std = 4.5;  // σ_frontal applied below conditionally
    method = "persistence";
  } else if (maxSoFar == null) {
    // No obs yet (overnight or station gap): trust forecast.
    mean = forecastHighF;
    std = 3.0;  // σ_frontal applied below conditionally
    method = "forecast-only";
  } else if (hrsToPeak < 1.0) {
    // Peak-collapse: at <1h to peak, the day's max is essentially realized — anchoring on
    // a stale NWS forecast that's already been falsified by maxSoFar mispriced 1°F clusters
    // (CHI/NYC NO positions on 2026-05-02). Small upside budget for late-afternoon warming.
    mean = maxSoFar + 0.2 + 0.3 * hrsToPeak;
    // Past-peak σ: only σ_resolution remains (the forecast horizon collapsed). This is
    // the irreducible MetAR-vs-CLI residual — see σ_resolution comment in bias-corrected
    // branch. Adds tiny lead-time term for the residual minutes before peak. σ_frontal
    // applied below as fallback when late-warming branch doesn't fire.
    std = Math.sqrt(1.0 * 1.0 + Math.max(0, 0.3 * hrsToPeak) ** 2);
    method = "peak-realized";
  } else {
    // Bias-corrected forecast prior. Validated on 5y×20cities held-out (n_test=14400).
    // Bias DECAY (added 2026-05-07): the obs-vs-forecast bias measured at this hour
    // is informative but its persistence to peak is uncertain. Boundary-layer mixing
    // and solar forcing tend to "burn off" morning cool/warm bias by afternoon, so
    // the bias should be applied with full weight far from peak (when it's the only
    // signal we have) and with diminishing weight as we approach peak (when maxSoFar
    // becomes the dominant evidence). Exponential decay with τ=5h: at hrsToPeak=12,
    // weight ≈ 0.91; at 5h ≈ 0.63; at 1h ≈ 0.18; at 0 = 0. Pre-decay base 0.4 retained.
    // Intraday-residual weight: empirical β(hrsToPeak) — see intradayBiasBeta() header.
    // Replaces the old `0.4·(1−e^(−hrsToPeak/5))` decay, which under-weighted the midday
    // signal 3-10× and sloped the wrong way (weakening β toward peak when it should grow).
    const biasWeight = interpBeta(highBetaTbl, hrsToPeak);
    const biasMag = biasF != null ? Math.abs(biasF) : 2.0;
    let priorMean = forecastHighF + (biasF != null ? biasWeight * biasF : 0);
    if (CITY_OFFSETS[city.name] != null) priorMean -= CITY_OFFSETS[city.name];
    // Regime correction: Kalman filter (primary) with heuristic 7d fallback. The
    // Kalman path (lib/regime.js) replaces the prior 7d-rolling × damping heuristic
    // for the 20 cities with fitted params. State-space model has σ_walk/σ_obs fit
    // offline from 5y per-city history; logger.js updates μ_t daily; this function
    // reads μ_t|t-1 and P_t|t-1 advanced one day. Backtest A/B (n=15894): overall
    // ΔRMSE −0.024°F, regime-day ΔRMSE −0.20°F, sustained-regime ΔRMSE −0.60°F vs
    // heuristic. Kalman applies 2.2× the heuristic's correction on regime days.
    // Quiet-day gate (|μ|<0.5°F) skips small corrections that would otherwise
    // regress quiet-day RMSE by +0.39°F. Heuristic path retained for AVL (no fit
    // yet) and as a backstop if KALMAN_PARAMS lookup ever fails.
    let kalmanBiasSigma2 = 0;  // P + σ_walk² contribution to priorStd²
    const kalman = kalmanCorrection(city.cli, "high", regimeBlob);
    if (kalman && Math.abs(kalman.mu) >= KALMAN_FLOOR_F) {
      priorMean -= kalman.mu;
      kalmanBiasSigma2 = kalman.P;
    } else if (!kalman) {
      // Fallback: cities without Kalman params (e.g., Asheville) use the legacy
      // heuristic. Same logic as before the Kalman wiring landed.
      const regimeResidual = resolveRegimeResidual(city, regimeBlob);
      if (regimeResidual != null && Math.abs(regimeResidual) > REGIME_FLOOR_F) {
        const damping = resolveRegimeDamping(city, regimeBlob, regimeResidual);
        priorMean -= damping * regimeResidual;
      }
    }
    // Hierarchical global Kalman correction: applied on top of per-city.
    // Captures network-wide forecast bias (e.g., NWS running cool everywhere)
    // that individual per-city corrections miss because they're zeroed under
    // KALMAN_FLOOR_F. No floor on global — observation noise is √n smaller.
    const kalmanG = kalmanGlobalCorrection("high", regimeBlob);
    if (kalmanG && Math.abs(kalmanG.mu) >= KALMAN_GLOBAL_FLOOR_F) {
      priorMean -= kalmanG.mu;
      kalmanBiasSigma2 += kalmanG.P;
    }
    // (If kalman is non-null but |μ|<floor, we skip the correction entirely —
    // matches the heuristic REGIME_FLOOR_F=0.5°F gate.)
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
    // Obs-disagreement σ-widening (added 2026-05-11 after PHX 5/5–5/10 series: 1W
    // 10L −$66 net on HIGH bets where model under-predicted by 2–4°F). Failure mode:
    // bias-corrected branch decays biasWeight toward zero near peak via BIAS_TAU_HR=5,
    // on the assumption morning bias burns off. For *regime* bias (not noise), that
    // decay points confidence at a falsified prior. PHX 2026-05-05 12:54 PM AZ exemplar:
    // model μ=76, currentTemp ≈ 78+, σ collapsed to 0.96 by hrsToPeak≈3, bot saw
    // apparent edge on NO B80.5, paid for it. When obs has materially exceeded the
    // current forecast (biasF > 2°F) and we still have hours to peak, floor priorStd
    // at |biasF| (capped 3°F). σ-only intervention: backtest (n=65976, 5y×20 cities)
    // showed priorMean shifts (persistent-bias, obs-projection) both overshoot on
    // false-alarms (~27% of fires); σ widening alone is RMSE-neutral overall (−0.005°F),
    // RMSE-improving on the fix target (−0.08°F), and lifts PHX-like cov95 94.5→99.2%.
    // Trader benefit: wider σ → bucket probs spread → less edge vs market → smaller
    // stake (half-Kelly shrinks) or skip (fails 10¢/5% gate). σ widening is applied
    // below after priorStd is computed. Symmetric cold-side regime is handled by the
    // existing cold-front branch (line ~990).
    const obsDisagreementFired = biasF != null && biasF > 2.0
        && hrsToPeak > 0 && hrsToPeak < 6
        && currentTemp != null && maxSoFar != null;
    // Bayesian posterior σ: σ_post² = σ_ensemble² + σ_resolution².
    //   σ_ensemble = std across the 5 forecast models — captures forecast disagreement
    //                day-by-day (data-driven, varies as models agree or diverge).
    //   σ_resolution = irreducible noise between any forecast and actual CLI value
    //                  (METAR sampling vs CLI continuous, late-day surprises, station
    //                  rounding). Empirically derived from 5y backtest: total RMSE
    //                  1.31°F = √(σ_ens_avg² + σ_res²) with σ_ens_avg ≈ 0.8°F →
    //                  σ_res ≈ 1.0°F. This is the *physically meaningful* floor —
    //                  it replaces the prior arbitrary 0.4°F floor that produced
    //                  cluster losses on σ-collapse near-arbs (Chicago/Boston/Dallas
    //                  on 2026-05-06 lost ~$78 because σ=0.4 stake-piled adjacent
    //                  buckets that all lost together).
    // Prior fallback: when n<2 models (sigmaEnsemblePeak null), use 0.8°F as the
    // typical-case ensemble disagreement so σ_post still reflects realistic spread.
    const SIGMA_RESOLUTION_F = 1.0;
    const sigmaEnsembleEffective = sigmaEnsemblePeak ?? 0.8;
    // σ_frontal applied below as fallback after late-warming check, not here —
    // avoids double-inflating when the warm-front branch already widens σ to 1.5°F.
    // Kalman bias uncertainty propagates into σ in quadrature. P_t|t-1 from the
    // forward-filter predict step is the posterior variance of the bias estimate
    // ADVANCED ONE DAY (state walks by σ_walk² overnight). On settled regimes P
    // is small (~0.2-0.7°F², σ contribution 0.4-0.8°F); during regime changes P
    // expands. This replaces the Change #1 heuristic σ floor at |biasF| for the
    // cross-day component while keeping that floor for the intraday signal.
    // σ_revision: forecast-staleness uncertainty. Only the bias-corrected branch
    // gets this — peak-realized has the extremum observed, no revision risk left.
    const sigmaRevHigh = sigmaRevisionF(forecastAgeMin, sigmaRevisionAlphas.high.value);
    let priorStd = Math.sqrt(sigmaEnsembleEffective * sigmaEnsembleEffective
                              + SIGMA_RESOLUTION_F * SIGMA_RESOLUTION_F
                              + kalmanBiasSigma2
                              + sigmaRevHigh * sigmaRevHigh);
    if (obsDisagreementFired) {
      // σ floor: |biasF| as the magnitude of forecast error already realized.
      // Capped at 3°F to avoid pathologically wide CIs when bias is extreme.
      // This is the INTRADAY signal — orthogonal to Kalman's cross-day state.
      priorStd = Math.max(priorStd, Math.min(3.0, Math.abs(biasF)));
    }
    // Predict the daily MAX (not the afternoon-peak conditional mean). Daily max =
    // max(future_peak, maxSoFar), so the right object is E[max(X, maxSoFar)] —
    // a mixture with mass below maxSoFar collapsed to maxSoFar. Previously used
    // truncNormalMean (= E[X | X ≥ maxSoFar]) which overshoots when priorMean is
    // below maxSoFar. Example: Denver 2026-05-05 had bias=−5.3°F → priorMean=44.88
    // vs maxSoFar=46 (early-morning residual from yesterday's warm cycle). Old
    // formula → 47.2°F. New formula → 46.30°F (matches Kalshi consensus T48 YES
    // at 99% = "high ≤ 47"). Empirically-calibrated σ retained — the new formula
    // is uniformly less aggressive than the old, so existing σ stays valid.
    mean = expectedMaxNormal(priorMean, priorStd, maxSoFar);
    std = priorStd;
    method = obsDisagreementFired ? "bias-corrected+obs-disagreement" : "bias-corrected";
  }

  // Late-warming check (added 2026-05-07 follow-up): mirror of the LOW cold-front
  // branch. Calendar-day high is max over the entire day, not just morning peak. If
  // ensemble forecast predicts a remaining-day peak materially above maxSoFar — warm
  // front, foehn/downsloping, marine inversion break, late-afternoon convective
  // peak — the day's actual max will likely be that future value, not what's been
  // observed. Peak-realized branch anchors mean ≈ maxSoFar and misses this.
  //
  // σ_frontal dedup policy on HIGH: STACK (HIGH_DEDUP_ALPHA=1). Backtest showed
  // warm-front-fired days are intrinsically noisy (RMSE 1.64°F vs 0.95°F on calm
  // days) and pure dedup costs 26pp tail-risk regression on the strong-frontal
  // subset — much worse than LOW's 5pp regression with cold-front. The σ_frontal
  // contribution is genuinely informative even when warm-front fires, so we keep
  // it (α=1.0). Compare LOW_DEDUP_ALPHA=0 below — asymmetric by design, calibrated
  // per side from the backtest's tail-risk impact.
  const HIGH_DEDUP_ALPHA = 1.0;
  let warmFrontFired = false;
  if (ensembleRemainingPeak != null && maxSoFar != null && mean != null
      && ensembleRemainingPeak > maxSoFar + 0.5) {
    const warmFrontHigh = ensembleRemainingPeak;
    if (warmFrontHigh > mean) {
      mean = warmFrontHigh;
      std = Math.max(std ?? 1.0, 1.5);
      method = (method || "") + "+warm-front";
      warmFrontFired = true;
    }
  }
  if (std != null && sigmaFrontal > 0) {
    const alpha = warmFrontFired ? HIGH_DEDUP_ALPHA : 1.0;
    if (alpha > 0) {
      std = Math.sqrt(std * std + alpha * sigmaFrontal * sigmaFrontal);
      method = (method || "") + (warmFrontFired ? "+frontal-stack" : "+frontal");
    }
  }

  // Defensive maxSoFar floor on HIGH prediction. The day's max can NEVER be below
  // what's already been observed today. expectedMaxNormal correctly enforces this
  // in the bias-corrected branch, but the peak-realized branch's `maxSoFar + 0.2 +
  // 0.3 * hrsToPeak` formula goes negative-relative-to-maxSoFar when hrsToPeak < -0.67
  // (e.g., 3 hours past peak → mean = maxSoFar - 0.7°F). That under-prediction is
  // logically impossible. Clamp here regardless of which branch produced the value.
  if (maxSoFar != null && mean != null && mean < maxSoFar) {
    mean = maxSoFar;
  }

  // CLI-relevant floor: Kalshi settles on NWS Daily Climate Report (CLI), which is
  // generated from the 5-min weighted ASOS readings (DI-1 internal continuous data).
  // The raw 1-min spike that drives maxSoFar can be a sub-minute artifact CLI never
  // sees. Float the floor on max(5-min weighted, DSM) when either exists — both are
  // CLI-settlement-grade. Fall back to maxSoFar (METAR + 1-min + DSM merged) only
  // when neither is available. Then Math.floor handles the °C-boundary case: KSAT
  // 2026-05-06 raw 87.8°F → CLI 87°F → floor(87.8)=87 lets the 86-87 bucket keep
  // probability mass instead of being zeroed out. The bigger win is the 1-min-spike
  // case: raw 88.2°F + 5-min weighted 87.4°F → old floor 88, new floor 87, matches
  // CLI's actual settlement basis.
  const cliMaxCandidates = [
    oneMin?.max5MinSoFar,
    dsm?.dailyMaxF
  ].filter(v => v != null);
  const cliMaxObs = cliMaxCandidates.length ? Math.max(...cliMaxCandidates) : maxSoFar;
  const maxSoFarCli = cliMaxObs != null ? Math.floor(cliMaxObs) : null;
  const lowerFloor = maxSoFarCli != null ? maxSoFarCli : -Infinity;
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
    // Same Bayesian σ_resolution treatment as HIGH peak-realized branch. LOW backtest
    // RMSE was 0.91°F (LOW is easier than HIGH), so σ_res ≈ 0.7°F is appropriate here.
    // σ_frontal applied below as fallback when cold-front branch doesn't fire — see
    // the cold-front block for the dedup logic.
    lowStd = Math.sqrt(0.7 * 0.7 + Math.max(0, 0.3 * hrsToTrough_) ** 2);
    lowMethod = "trough-realized";
  } else if (forecastLowF != null && minSoFar != null) {
    // Intraday-residual weight: empirical β(hrsToTrough) — see intradayBiasBetaLow().
    // Replaces the old `0.5·(1−e^(−hrsToTrough/5))` decay, which (like HIGH) under-
    // weighted the signal and sloped the wrong way (weakening β toward the trough when
    // it should grow). β rises 0.52→0.69 from 6h out to 1h before the dawn trough.
    const biasWeight = interpBeta(lowBetaTbl, hrsToTrough_);
    const biasMag = biasF != null ? Math.abs(biasF) : 2.0;
    let priorLowMean = forecastLowF + (biasF != null ? biasWeight * biasF : 0);
    if (CITY_OFFSETS_LOW[city.name] != null) priorLowMean -= CITY_OFFSETS_LOW[city.name];
    // LOW Kalman regime correction (added 2026-05-12, mirror of HIGH wiring).
    // Replaces no-correction previously — the LOW branch had only bias-correction
    // and CITY_OFFSETS_LOW. With Kalman, applies cross-day bias state μ_low and
    // propagates P_low + σ_walk² into priorLowStd² via quadrature. Quiet-day gate
    // (|μ|<KALMAN_FLOOR_F) preserved. Same fallback path for cities without LOW
    // params (currently none — all 20 fit cities have HIGH and LOW).
    let kalmanLowBiasSigma2 = 0;
    const kalmanLow = kalmanCorrection(city.cli, "low", regimeBlob);
    if (kalmanLow && Math.abs(kalmanLow.mu) >= KALMAN_FLOOR_F) {
      priorLowMean -= kalmanLow.mu;
      kalmanLowBiasSigma2 = kalmanLow.P;
    }
    // Hierarchical global Kalman correction for LOW (mirror of HIGH path).
    const kalmanGLow = kalmanGlobalCorrection("low", regimeBlob);
    if (kalmanGLow && Math.abs(kalmanGLow.mu) >= KALMAN_GLOBAL_FLOOR_F) {
      priorLowMean -= kalmanGLow.mu;
      kalmanLowBiasSigma2 += kalmanGLow.P;
    }
    // Bayesian σ for LOW: σ_post² = σ_ensemble_trough² + σ_resolution_low².
    // 5y backtest TEST RMSE 0.91°F = √(σ_ens_avg² + σ_res²) with σ_ens_avg ≈ 0.5°F →
    // σ_res ≈ 0.76°F. Use 0.7°F as σ_resolution. Lower than HIGH because nighttime
    // troughs are more predictable (less convective noise, calmer atmosphere).
    const SIGMA_LOW_RESOLUTION_F = 0.7;
    const sigmaEnsembleLowEffective = sigmaEnsembleTrough ?? 0.5;
    // σ_frontal applied below as fallback after cold-front check, not here — avoids
    // double-inflating when cold-front branch already widens σ to 1.5°F floor.
    // Kalman P_low + σ_walk² added in quadrature (cross-day bias uncertainty).
    // σ_revision: forecast-staleness uncertainty (same shape as HIGH; α_LOW < α_HIGH).
    const sigmaRevLow = sigmaRevisionF(forecastAgeMin, sigmaRevisionAlphas.low.value);
    const priorLowStd = Math.sqrt(sigmaEnsembleLowEffective * sigmaEnsembleLowEffective
                                 + SIGMA_LOW_RESOLUTION_F * SIGMA_LOW_RESOLUTION_F
                                 + kalmanLowBiasSigma2
                                 + sigmaRevLow * sigmaRevLow);
    // Daily MIN object: E[min(X, minSoFar)], symmetric to HIGH expectedMaxNormal.
    // Replaces truncNormalMeanUpper (= E[X | X ≤ minSoFar]) which undershoots
    // when priorLowMean is above minSoFar. The trough-realized branch above
    // already handles the post-trough case explicitly; this is the residual
    // pre-trough path where priorLowMean and minSoFar are both informative.
    lowMean = expectedMinNormal(priorLowMean, priorLowStd, minSoFar);
    lowStd = priorLowStd;
    lowMethod = "bias-corrected";
  } else if (forecastLowF != null) {
    lowMean = forecastLowF;
    lowStd = 3.0;  // σ_frontal applied below conditionally
    lowMethod = "forecast-only";
  } else if (minSoFar != null) {
    lowMean = minSoFar;
    lowStd = 4.5;  // σ_frontal applied below conditionally
    lowMethod = "obs-only";
  }

  // Late-day cold-front check (added 2026-05-07): the calendar-day min reported
  // in CLI is min over the entire day, including any post-morning-trough cold air
  // arriving with a frontal passage or marine push. The trough-realized branch
  // anchors lowMean ≈ minSoFar after morning trough, missing this case. If the
  // ensemble forecast predicts a remaining-day trough materially below minSoFar,
  // the day's actual min will likely be that evening value, not morning's.
  // Threshold: 0.5°F to filter forecast noise. Widen σ because front timing/
  // magnitude is uncertain.
  //
  // σ_frontal dedup policy on LOW: FULL DEDUP (LOW_DEDUP_ALPHA=0). Backtest
  // showed cold-front-fired days are well-calibrated by the 1.5°F floor alone
  // (σ̄/RMSE = 1.43 baseline), and stacking σ_frontal pushes to 1.54 — wasted
  // conservatism with only 5pp tail-risk regression on dedup. Cheap to dedup.
  // Compare HIGH_DEDUP_ALPHA=1.0 above — asymmetric by design, calibrated per
  // side from the backtest's tail-risk impact (LOW 5pp vs HIGH 26pp regression).
  const LOW_DEDUP_ALPHA = 0.0;
  let coldFrontFired = false;
  if (ensembleRemainingTrough != null && minSoFar != null && lowMean != null
      && ensembleRemainingTrough < minSoFar - 0.5) {
    const coldFrontLow = ensembleRemainingTrough;
    if (coldFrontLow < lowMean) {
      lowMean = coldFrontLow;
      lowStd = Math.max(lowStd ?? 1.0, 1.5);
      lowMethod = (lowMethod || "") + "+cold-front";
      coldFrontFired = true;
    }
  }
  if (lowStd != null && sigmaFrontal > 0) {
    const alpha = coldFrontFired ? LOW_DEDUP_ALPHA : 1.0;
    if (alpha > 0) {
      lowStd = Math.sqrt(lowStd * lowStd + alpha * sigmaFrontal * sigmaFrontal);
      lowMethod = (lowMethod || "") + (coldFrontFired ? "+frontal-stack" : "+frontal");
    }
  }

  // Defensive minSoFar ceiling on LOW prediction (symmetric to HIGH maxSoFar
  // floor above). Trough-realized branch can produce lowMean > minSoFar when
  // hrsToTrough_ is negative (past trough), which is logically impossible —
  // the day's min cannot be higher than what's already been observed.
  if (minSoFar != null && lowMean != null && lowMean > minSoFar) {
    lowMean = minSoFar;
  }

  // CLI-relevant ceiling for LOW (symmetric to HIGH lowerFloor — see comment above).
  // Prefer min(5-min weighted, DSM) — both CLI-settlement-grade — over minSoFar
  // (which can dip below CLI's actual min on a sub-minute 1-min ASOS undershoot).
  const cliMinCandidates = [
    oneMin?.min5MinSoFar,
    dsm?.dailyMinF
  ].filter(v => v != null);
  const cliMinObs = cliMinCandidates.length ? Math.min(...cliMinCandidates) : minSoFar;
  const minSoFarCli = cliMinObs != null ? Math.ceil(cliMinObs) : null;
  const upperFloor = minSoFarCli != null ? minSoFarCli : Infinity;
  const lowCi68 = lowMean != null
    ? [lowMean - lowStd, Math.min(upperFloor, lowMean + lowStd)] : null;
  const lowCi95 = lowMean != null
    ? [lowMean - 1.96 * lowStd, Math.min(upperFloor, lowMean + 1.96 * lowStd)] : null;

  // Last METAR observation time for staleness diagnostics.
  const lastMetarTime = todayObs.length ? todayObs[todayObs.length - 1].ts.toISOString() : null;
  const lastMetarAgeMin = lastMetarTime ? Math.round((Date.now() - new Date(lastMetarTime).getTime()) / 60000) : null;

  // dataAgeMin: freshness of the model's binding inputs, not just the NWS grid
  // forecast issue time. Ensemble (Open-Meteo) is fetched live each /api/weather
  // call, so when it has ≥3 source models and a recent METAR is also in hand,
  // the prediction is current even if NWS hasn't reissued the grid forecast
  // (Seattle/Denver/LA grid often goes 4-6h between issuances).
  // Trader (jackson_trader.js:43 PER_CITY_FRESHNESS_MAX_MIN) gates on this.
  // forecastAgeMin already computed above (hoisted for σ_revision wiring).
  const ensembleHealthy = sources.length >= 3;
  const metarFreshEnough = lastMetarAgeMin != null && lastMetarAgeMin < 90;
  let dataAgeMin;
  if (ensembleHealthy && metarFreshEnough) {
    // Ensemble just fetched (age ≈ 0) + recent obs → METAR age is the binding constraint.
    dataAgeMin = lastMetarAgeMin;
  } else if (ensembleHealthy) {
    // Ensemble fresh but METAR stalled — fall back to whichever of NWS grid or METAR
    // we actually have, taking the younger.
    dataAgeMin = [forecastAgeMin, lastMetarAgeMin].filter(v => v != null).reduce((a, b) => Math.min(a, b), Infinity);
    if (!Number.isFinite(dataAgeMin)) dataAgeMin = null;
  } else {
    // Degraded path (ensemble fetch failed) — must lean on NWS grid age, which is
    // the most-pessimistic indicator. Trader will skip if this exceeds the gate.
    dataAgeMin = forecastAgeMin;
  }

  return {
    name: city.name,
    cli: city.cli,
    station: city.station,
    tz: city.tz,
    currentTemp: currentTemp != null ? round(currentTemp) : null,
    currentTempSource,
    currentTempTime,
    currentTempAgeMin: currentTempTime
      ? Math.round((Date.now() - new Date(currentTempTime).getTime()) / 60000) : null,
    lastMetarTime,
    lastMetarAgeMin,
    // Synoptic ASOS coverage classifier — drives trader sizing de-rate. See
    // computePrediction for definitions. Values: "1min" / "5min" / "hourly-only" /
    // "stalled" / "none".
    synopticCoverage,
    // IEM (Iowa Environmental Mesonet) preliminary daily extremes — independent
    // corroboration source for what tomorrow's CLI will report. Polls the same
    // NWS LDM feed that generates the official CLI. When iemDailyMaxF diverges
    // from maxSoFar by more than ~0.5°F, one of the two sources has data the
    // other missed (silent failure tell).
    iemDailyMaxF: iem?.dailyMaxF != null ? round(iem.dailyMaxF) : null,
    iemDailyMinF: iem?.dailyMinF != null ? round(iem.dailyMinF) : null,
    iemAgeMin: iem?.latestTs ? Math.round((Date.now() - iem.latestTs.getTime()) / 60000) : null,
    // DSM (NWS Daily Summary Message) — closest public source to actual CLI settlement.
    // Polled per-office; reports max/min from ASOS DI-1 internal continuous data
    // (the same source the official CLI is generated from). When dsmDailyMaxF
    // diverges from maxSoFar, the DSM is the authoritative number — our maxSoFar
    // missed a between-METAR spike. KNYC 2026-05-07 incident: market repriced
    // hours before any non-DSM source caught it.
    dsmDailyMaxF: dsm?.dailyMaxF ?? null,
    dsmDailyMinF: dsm?.dailyMinF ?? null,
    dsmMaxTimeLocal: dsm?.maxTimeLocal ?? null,
    dsmMinTimeLocal: dsm?.minTimeLocal ?? null,
    dsmIssuedAt: dsm?.issuedAt ?? null,
    // 1-min ASOS (Synoptic) — separate from METAR-derived currentTemp/maxSoFar/minSoFar.
    // Surfaced for card display so we can see precision the integer-Celsius METAR loses
    // (e.g., METAR 17°C ≡ 16.5–17.4°C ≡ 61.7–63.3°F; 1-min ASOS gives the actual tenth).
    // Also shows when 1-min ASOS catches a peak/trough between METAR cycles. The bot's
    // maxSoFar/minSoFar already fold these in — these fields just expose the raw signal.
    oneMinAsos: oneMin ? {
      maxSoFar: oneMin.maxSoFar != null ? round(oneMin.maxSoFar) : null,
      minSoFar: oneMin.minSoFar != null ? round(oneMin.minSoFar) : null,
      maxTs: oneMin.maxTs ? new Date(oneMin.maxTs).toISOString() : null,
      minTs: oneMin.minTs ? new Date(oneMin.minTs).toISOString() : null,
      latestF: oneMin.latestF != null ? round(oneMin.latestF) : null,
      latestTs: oneMin.latestTs ? new Date(oneMin.latestTs).toISOString() : null,
      ageMin: oneMin.latestTs ? Math.round((Date.now() - new Date(oneMin.latestTs).getTime()) / 60000) : null,
      n: oneMin.n,
      // 5-min weighted (Kalshi/CLI settlement basis — see asos1min.js header).
      max5MinSoFar: oneMin.max5MinSoFar != null ? round(oneMin.max5MinSoFar) : null,
      min5MinSoFar: oneMin.min5MinSoFar != null ? round(oneMin.min5MinSoFar) : null,
      max5MinTs: oneMin.max5MinTs ? oneMin.max5MinTs.toISOString() : null,
      min5MinTs: oneMin.min5MinTs ? oneMin.min5MinTs.toISOString() : null,
      latest5MinAvg: oneMin.latest5MinAvg != null ? round(oneMin.latest5MinAvg) : null,
      nBuckets5Min: oneMin.nBuckets5Min,
    } : null,
    // Airmass cross-check when the settlement monitor's own 5-min feed is degraded
    // (null unless a neighbor witness exists; see asos1min.js coverageCrossCheck).
    coverageWarn: coverageWarn ? {
      ...coverageWarn,
      rise30F: coverageWarn.rise30F != null ? round(coverageWarn.rise30F) : null,
      neighborLatestF: coverageWarn.neighborLatestF != null ? round(coverageWarn.neighborLatestF) : null,
    } : null,
    // HIGH (today's max).
    maxSoFar: maxSoFar != null ? round(maxSoFar) : null,
    maxSoFarCli,
    forecastHighF,
    nwsHighF,
    forecastPeakHourly: ensemblePeak != null ? Math.round(ensemblePeak) : null,
    biasF: biasF != null ? round(biasF) : null,
    hrsToPeak: Math.round(hrsToPeak * 10) / 10,
    method,
    sigmaFrontal: Math.round(sigmaFrontal * 100) / 100,
    mean: round(mean),
    median: round(mean),
    mode: round(mean),
    std: Math.round(std * 100) / 100,
    ci68: [round(ci68[0]), round(ci68[1])],
    ci95: [round(ci95[0]), round(ci95[1])],
    // LOW (today's min).
    minSoFar: minSoFar != null ? round(minSoFar) : null,
    minSoFarCli,
    forecastLowF,
    nwsLowF,
    lowMethod,
    hrsToTrough: Math.round(hrsToTrough_ * 10) / 10,
    lowMean: lowMean != null ? round(lowMean) : null,
    lowStd: lowStd != null ? Math.round(lowStd * 100) / 100 : null,
    lowCi68: lowCi68 ? [round(lowCi68[0]), round(lowCi68[1])] : null,
    lowCi95: lowCi95 ? [round(lowCi95[0]), round(lowCi95[1])] : null,
    forecastUpdateTime: forecast?.updateTime || null,
    forecastAgeMin,
    sigmaRevisionAlphas: {
      high: sigmaRevisionAlphas.high.value,
      low:  sigmaRevisionAlphas.low.value,
      highSource: sigmaRevisionAlphas.high.source,
      lowSource:  sigmaRevisionAlphas.low.source,
      fitAtUTC:   sigmaRevisionAlphas.fitAtUTC
    },
    dataAgeMin,
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

  const [forecasts, ensembles, clis, oneMinByStation, iemByStation, dsmByStation] = await Promise.all([
    Promise.all(CITIES.map(c => fetchNWSForecast(c.lat, c.lon))),
    // One batched multi-location call; only if it hard-fails do we fall back to the
    // old per-city concurrent burst (degraded, but better than no ensemble at all).
    fetchOpenMeteoEnsembleBatch(CITIES)
      .then(batch => batch || Promise.all(CITIES.map(c => fetchOpenMeteoEnsemble(c.lat, c.lon)))),
    Promise.all(CITIES.map(c => fetchLatestCLI(c.cli))),
    fetch1MinObs(),
    fetchIemDailyExtremes(),
    fetchDsmExtremes(CITIES.map(c => c.station))
  ]);

  const cities = CITIES.map((c, i) => {
    const metars = parseStationMetars(metarText, c.station);
    const oneMin = getTodayMaxMin(oneMinByStation, c.station, c.tz);
    const iem = iemByStation?.[c.station] ?? null;
    const dsm = dsmByStation?.[c.station] ?? null;
    const result = computePrediction(c, metars, forecasts[i], ensembles[i], clis[i], regimeBlob, oneMin, iem, dsm, oneMinByStation);
    // Inline Claude analog high for the dashboard card. Computed right here off the
    // METARs we already fetched — no separate /api/claude call, no blob store, no cron,
    // so it can't be blocked by the logging pipeline. This is the core v3 model (analog
    // ramp + Bowen/trajectory/airmass/sky + regime guard); the full logged decision
    // (upstream L1 / market L2 / peak-lock) still lives in claude_log-background.js.
    try {
      // aviationweather format=raw prefixes lines with "METAR "/"SPECI " — match the
      // station code immediately before the ddHHMMZ group, prefix or not. (The old
      // startsWith(station+" ") matched ZERO lines → claudeHigh was always null.)
      const stRe = new RegExp(`\\b${c.station}\\s+\\d{6}Z`);
      const lines = metarText.split("\n").map(l => l.trim()).filter(l => stRe.test(l));
      const snap = buildSnapshotV2({ station: c.station, tz: c.tz, metarLines: lines, maxSoFarF: result.maxSoFarCli ?? result.maxSoFar });
      if (snap) {
        const card = claudePredict(snap);
        result.claudeHigh = Math.round(card.dist.mean() * 10) / 10;
        result.claudePeakLocked = !!card.peak_locked;
      } else {
        result.claudeHigh = null;
      }
    } catch (e) {
      result.claudeHigh = null;
      console.log(`[claude-inline] ${c.station}: ${String(e?.message || e)}`);
    }
    return result;
  });

  CACHE = { ts: now, data: cities };
  return new Response(JSON.stringify({
    cached: false, ts: new Date(now).toISOString(),
    logger_heartbeat_utc: regimeBlob?.logger_heartbeat_utc ?? null,
    cities
  }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
  });
};

export const config = { path: "/api/weather" };
