// Thin residual logger + regime-corrections updater. Runs every 5 minutes.
// Replaces the May 1 paper-trading logger — combo_trader.js and jackson_trader.js
// own all betting/settlement now. This file is responsible ONLY for keeping
// weather.js's regime_corrections blob fresh.
//
// Two responsibilities per tick:
//
//   (A) CAPTURE — once per city per local day, between local 14:00-15:59:
//       Snapshot the current HIGH prediction from /api/weather and write it
//       to the `predictions` blob keyed by `{cli}/{localDate}`. The 12 ticks
//       per hour all check key-existence first so we write exactly once per
//       city per day.
//
//   (B) SETTLE — once per city per local day, between local 06:00-12:59:
//       Fetch yesterday's CLI; if it covers yesterday's date and is final
//       (not partial) and has a valid max, look up our snapshot from (A)
//       and compute residual = predicted - actual. Append to per-city
//       history in `regime_corrections/global`, recompute the 7-day mean,
//       trim history to 30 entries. weather.js (line 1134) reads this blob
//       and prefers per_city_residual_mean_7d[city.name] over
//       REGIME_RESIDUAL_SEED whenever it's defined.

import { getStore } from "@netlify/blobs";
import { kalmanInit, kalmanStep, kalmanGlobalInit, kalmanGlobalStep } from "./lib/regime.js";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const UA = "weatherbot-logger";
const INTERNAL_AUTH = "Basic " + btoa("internal:hydro");

const CAPTURE_HOURS = new Set([14, 15]);
const SETTLE_HOURS  = new Set([6, 7, 8, 9, 10, 11, 12]);
const HISTORY_TRIM   = 30;   // entries kept per city
const ROLLING_WINDOW = 7;    // size of the rolling mean weather.js consumes
const SHORT_WINDOW   = 3;    // size of the regime-change window (adaptive damping)

// σ_revision instrumentation (added 2026-05-15): multi-snapshot capture into a
// SEPARATE `prediction_snapshots` blob so the canonical `predictions` blob (which
// drives Kalman + 7d residuals) keeps its once-per-day semantics. Snapshots are
// keyed `{cli}/{date}/{HHMM}` in local time, captured once per 30-min slot at any
// hour of the day. After CLI settles, snapshots get backfilled with actual+
// residual so analyze_sigma_revision.js can fit σ_revision(forecastAgeMin)
// empirically across the full forecast-age distribution.
const SNAPSHOT_SLOT_MIN = 30;     // one snapshot per 30-min slot per city

const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };

function localDateAndHour(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) };
}

function previousLocalDate(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Same CLI fetcher/parser as weather.js fetchLatestCLI. Returns both maxF and
// minF (HIGH and LOW); either can be null independently when the report lists
// the value as 'M' or '---'.
async function fetchLatestCLI(cli) {
  try {
    const url = `https://forecast.weather.gov/product.php?site=NWS&product=CLI&issuedby=${cli}&format=txt&version=1&glossary=0`;
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const html = await r.text();
    const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (!pre) return null;
    const text = pre[1];

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

    const maxObservedMissing = /^\s*MAXIMUM\s+(?:M+|-+)(?:\s|$)/im.test(text);
    let maxF = null;
    let m = text.match(/^\s*MAXIMUM\s+(-?\d+)/im);
    if (m) maxF = parseInt(m[1], 10);
    if (maxF == null && !maxObservedMissing) {
      m = text.match(/HIGH(?:EST)?\s+TEMP[A-Z\s\(\)]*\s+(-?\d+)/i);
      if (m) maxF = parseInt(m[1], 10);
    }
    if (maxF == null && !maxObservedMissing) {
      const tempBlock = text.split(/PRECIPITATION|SNOW|WIND|SKY/)[0] || text;
      m = tempBlock.match(/MAXIMUM[^\n]*?(-?\d{2,3})/i);
      if (m) maxF = parseInt(m[1], 10);
    }

    // Same parsing pattern for MINIMUM (the second extreme in CLI's TEMPERATURE block).
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
      isPartial
    };
  } catch (e) { return null; }
}

async function fetchPredictions() {
  const r = await fetch(`${SITE_BASE}/api/weather`, {
    headers: { authorization: INTERNAL_AUTH, "User-Agent": UA }
  });
  if (!r.ok) throw new Error(`weather API ${r.status}`);
  return await r.json();
}

// Market-implied μ/σ per city (name → {impliedHigh, impliedLow}) from /api/kalshi.
// Best-effort: any failure returns {} so snapshot capture still proceeds with the
// model/NWS/forecast baselines (market-implied just stays null those slots).
async function fetchKalshiImplied() {
  try {
    const r = await fetch(`${SITE_BASE}/api/kalshi`, {
      headers: { authorization: INTERNAL_AUTH, "User-Agent": UA }
    });
    if (!r.ok) return {};
    const j = await r.json();
    const map = {};
    for (const c of j.cities || []) {
      if (!c || typeof c.kalshi === "string") continue;
      map[c.name] = { impliedHigh: c.impliedHigh ?? null, impliedLow: c.impliedLow ?? null };
    }
    return map;
  } catch (e) { return {}; }
}

// σ_revision snapshot capture. Separate from runCapture above — writes to the
// `prediction_snapshots` blob, one snapshot per 30-min slot per city, all hours.
// Each snapshot carries forecastAgeMin so analyze_sigma_revision.js can fit α
// from pairwise (Δprediction, Δage) AND from (modelMean - actual) residuals.
async function runSnapshot(snapshotsStore, predData, now, impliedByName = {}) {
  const writes = [];
  for (const c of predData.cities || []) {
    if (c.error || c.mean == null || !c.cli || !c.tz || !c.name) continue;
    const imp = impliedByName[c.name] || {};
    // Slot = local hour + minute floored to SNAPSHOT_SLOT_MIN. Logger ticks every
    // 5 min so each 30-min slot gets 6 attempts; first wins via if-exists guard.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: c.tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(now)).map(x => [x.type, x.value]));
    const date = `${p.year}-${p.month}-${p.day}`;
    const hh = p.hour;
    const mm = String(Math.floor(parseInt(p.minute, 10) / SNAPSHOT_SLOT_MIN) * SNAPSHOT_SLOT_MIN).padStart(2, "0");
    const key = `${c.cli}/${date}/${hh}${mm}`;
    const existing = await snapshotsStore.get(key, { type: "json" });
    if (existing) continue;
    const record = {
      name: c.name,
      cli: c.cli,
      date,
      localHHMM: `${hh}${mm}`,
      predHigh: c.mean,
      predLow: c.lowMean ?? null,
      stdHigh: c.std,
      stdLow: c.lowStd ?? null,
      forecastAgeMin: c.forecastAgeMin ?? null,
      dataAgeMin: c.dataAgeMin ?? null,
      lastMetarAgeMin: c.lastMetarAgeMin ?? null,
      ensembleSourceCount: Array.isArray(c.ensembleSources) ? c.ensembleSources.length : null,
      ensembleSources: Array.isArray(c.ensembleSources)
        ? c.ensembleSources.map(s => ({ model: s.model, peak: s.peak, trough: s.trough ?? null }))
        : null,
      hrsToPeak: c.hrsToPeak ?? null,
      hrsToTrough: c.hrsToTrough ?? null,
      biasF: c.biasF ?? null,   // obs−forecast gap at capture; x-var for rolling β refit
      // Edge-measurement baselines (2026-05-26): the corrected model (predHigh/predLow)
      // must beat ALL of these to have edge. nws* = NWS-only forecast; forecast* =
      // raw ensemble (pre bias-correction); implied* = market-implied μ from Kalshi
      // bucket prices (what we must beat to be "underpriced on Kalshi"). Backfilled
      // with residuals vs actual at settle.
      nwsHigh: c.nwsHighF ?? null,
      nwsLow: c.nwsLowF ?? null,
      forecastHigh: c.forecastHighF ?? null,
      forecastLow: c.forecastLowF ?? null,
      impliedHigh: imp.impliedHigh?.mean ?? null,
      impliedStdHigh: imp.impliedHigh?.std ?? null,
      impliedLow: imp.impliedLow?.mean ?? null,
      impliedStdLow: imp.impliedLow?.std ?? null,
      capturedAtUTC: new Date(now).toISOString()
    };
    await snapshotsStore.setJSON(key, record);
    writes.push({ city: c.name, slot: `${date}/${hh}${mm}` });
  }
  return writes;
}

// σ_revision snapshot settle. When yesterday's CLI lands, iterate every snapshot
// key under {cli}/{yesterday}/* and backfill actual + residuals. Cheap (≤48 puts
// per city per day on the settlement tick that wins the race).
async function runSnapshotSettle(snapshotsStore, predData, now) {
  const settled = [];
  for (const c of predData.cities || []) {
    if (!c.name || !c.cli || !c.tz) continue;
    const { date: todayLocal, hour } = localDateAndHour(c.tz, now);
    if (!SETTLE_HOURS.has(hour)) continue;
    const yesterday = previousLocalDate(todayLocal);
    const cliData = await fetchLatestCLI(c.cli);
    if (!cliData || cliData.coversDate !== yesterday || cliData.isPartial) continue;
    if (cliData.maxF == null && cliData.minF == null) continue;
    const prefix = `${c.cli}/${yesterday}/`;
    const list = await snapshotsStore.list({ prefix });
    const keys = (list.blobs || []).map(b => b.key);
    for (const key of keys) {
      const snap = await snapshotsStore.get(key, { type: "json" });
      if (!snap || snap.settled) continue;
      snap.actualHigh = cliData.maxF;
      snap.actualLow = cliData.minF;
      snap.residualHigh = (cliData.maxF != null && snap.predHigh != null)
        ? snap.predHigh - cliData.maxF : null;
      snap.residualLow = (cliData.minF != null && snap.predLow != null)
        ? snap.predLow - cliData.minF : null;
      // Baseline residuals (2026-05-26) — same sign convention (prediction − actual).
      // Lets /api analysis compare model vs NWS vs raw-forecast vs market: which has
      // lower |residual|, and is (model − market) predictive of (actual − market)?
      const rH = v => (cliData.maxF != null && v != null) ? v - cliData.maxF : null;
      const rL = v => (cliData.minF != null && v != null) ? v - cliData.minF : null;
      snap.residualNwsHigh = rH(snap.nwsHigh);
      snap.residualForecastHigh = rH(snap.forecastHigh);
      snap.residualImpliedHigh = rH(snap.impliedHigh);
      snap.residualNwsLow = rL(snap.nwsLow);
      snap.residualForecastLow = rL(snap.forecastLow);
      snap.residualImpliedLow = rL(snap.impliedLow);
      snap.settled = true;
      snap.settledAtUTC = new Date(now).toISOString();
      await snapshotsStore.setJSON(key, snap);
    }
    settled.push({ city: c.name, date: yesterday, keys: keys.length });
  }
  return settled;
}

// σ_revision auto-fit. Pulls the last N days of `prediction_snapshots`, groups
// by (cli, date), and forms pairwise (Δpred, Δage) samples within each group.
// Bins by |Δage|. Per bin: sample std of Δpred. Fits α by weighted OLS through
// origin: σ_bin = α × max(0, midHr − 1). Writes to regimeBlob.sigma_revision_state.
// Validation: ≥ MIN_PAIRS pairs total per variable; α clamped to [0.1, 1.5].
// Outside the clamp, write null (weather.js falls back to seed).
//
// Why pairwise instead of residual-vs-age (settled snapshots only):
//   pairs are dense (every same-day pair contributes), don't need CLI settlement,
//   and measure forecast-revision noise directly — independent of model bias.
//   The residual-vs-age estimator is the ground-truth cross-check once n_settled
//   per bin > 30; that lives in analyze_sigma_revision.js for offline runs.
const SIGMA_REVISION_AGE_BINS_HR = [
  [0, 1], [1, 2], [2, 4], [4, 6], [6, 8], [8, 12], [12, 16], [16, 20], [20, 30]
];
const SIGMA_REVISION_FIT_LOOKBACK_DAYS = 14;
const SIGMA_REVISION_MIN_PAIRS = 30;            // total pairs needed to attempt a fit
const SIGMA_REVISION_MIN_PAIRS_PER_BIN = 5;     // bin counted in fit only if it has this many
const SIGMA_REVISION_ALPHA_CLAMP = [0.1, 1.5];

function sigmaRevisionBinIndex(ageHr) {
  for (let i = 0; i < SIGMA_REVISION_AGE_BINS_HR.length; i++) {
    const [lo, hi] = SIGMA_REVISION_AGE_BINS_HR[i];
    if (ageHr >= lo && ageHr < hi) return i;
  }
  return null;
}
function sampleStd(xs) {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
function fitAlphaThroughOrigin(rows) {
  // σ = α × (midHr − 1) on the rows where midHr > 1 and we have ≥ MIN_PAIRS_PER_BIN.
  // Weighted by n_pairs in the bin.
  const pts = rows.filter(r => r.sigma != null && r.midHr > 1 && r.n >= SIGMA_REVISION_MIN_PAIRS_PER_BIN)
                  .map(r => ({ x: r.midHr - 1, y: r.sigma, w: r.n }));
  if (pts.length < 2) return null;
  const sumWxx = pts.reduce((a, p) => a + p.w * p.x * p.x, 0);
  const sumWxy = pts.reduce((a, p) => a + p.w * p.x * p.y, 0);
  return sumWxx > 0 ? sumWxy / sumWxx : null;
}
function fitVariableAlpha(snaps, predKey) {
  const byGroup = new Map();
  for (const s of snaps) {
    if (s[predKey] == null || s.forecastAgeMin == null) continue;
    const k = `${s.cli}|${s.date}`;
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(s);
  }
  const binDeltas = SIGMA_REVISION_AGE_BINS_HR.map(() => []);
  let totalPairs = 0;
  for (const arr of byGroup.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        if (a[predKey] == null || b[predKey] == null) continue;
        const dPred = b[predKey] - a[predKey];
        const dAgeHr = Math.abs(b.forecastAgeMin - a.forecastAgeMin) / 60;
        const idx = sigmaRevisionBinIndex(dAgeHr);
        if (idx == null) continue;
        binDeltas[idx].push(dPred);
        totalPairs++;
      }
    }
  }
  const bins = SIGMA_REVISION_AGE_BINS_HR.map(([lo, hi], i) => ({
    bin: `${lo}-${hi}h`, midHr: (lo + hi) / 2, n: binDeltas[i].length,
    sigma: sampleStd(binDeltas[i])
  }));
  return { totalPairs, bins, alphaRaw: fitAlphaThroughOrigin(bins) };
}
async function runRefitSigmaRevision(snapshotsStore, regimeStore, now) {
  const cutoffUTC = now - SIGMA_REVISION_FIT_LOOKBACK_DAYS * 86_400_000;
  const cutoffDate = new Date(cutoffUTC).toISOString().slice(0, 10);  // "YYYY-MM-DD"
  const { blobs } = await snapshotsStore.list();
  // Key shape: "<cli>/<YYYY-MM-DD>/<HHMM>" (see runSnapshot line 149). Filter on the
  // date segment of the key BEFORE issuing GETs, so refit cost stays bounded as the
  // snapshot store grows. Was N GETs for N total snapshots (~1500+ today, ~9000 at
  // 30d × 14 cities × 48 slots) → now N GETs only for the lookback window.
  // The capturedAtUTC filter on the records below is kept as a precise second pass
  // (covers TZ-vs-UTC date-edge cases where the local-date key sits across a UTC day).
  const recentKeys = (blobs || [])
    .map(b => b.key)
    .filter(k => {
      const parts = k.split("/");
      return parts.length === 3 && parts[1] >= cutoffDate;
    })
    // Cap GETs to bound runtime (2026-05-26): the store holds ~600+/day, so the 14d window
    // is thousands of blobs and Promise.all of all those GETs was timing the logger out
    // (>36s, 500). Most-recent ~1200 (date desc) is far more pairs than a stable α-fit needs.
    .sort((a, b) => (a.split("/")[1] < b.split("/")[1] ? 1 : -1))
    .slice(0, 600);
  const records = (await Promise.all(
    recentKeys.map(k => snapshotsStore.get(k, { type: "json" }).catch(() => null))
  )).filter(r => r && r.capturedAtUTC && new Date(r.capturedAtUTC).getTime() >= cutoffUTC);
  if (records.length === 0) return { fit: false, reason: "no-recent-snapshots" };
  const high = fitVariableAlpha(records, "predHigh");
  const low  = fitVariableAlpha(records, "predLow");
  const clamp = (raw) => {
    if (!Number.isFinite(raw)) return null;
    if (raw < SIGMA_REVISION_ALPHA_CLAMP[0] || raw > SIGMA_REVISION_ALPHA_CLAMP[1]) return null;
    return raw;
  };
  const α_high = high.totalPairs >= SIGMA_REVISION_MIN_PAIRS ? clamp(high.alphaRaw) : null;
  const α_low  = low.totalPairs  >= SIGMA_REVISION_MIN_PAIRS ? clamp(low.alphaRaw)  : null;
  const regimeBlob = (await regimeStore.get("global", { type: "json" })) || {};
  regimeBlob.sigma_revision_state = {
    α_high, α_low,
    α_high_raw: high.alphaRaw, α_low_raw: low.alphaRaw,
    n_pairs_high: high.totalPairs, n_pairs_low: low.totalPairs,
    bins_high: high.bins, bins_low: low.bins,
    lookbackDays: SIGMA_REVISION_FIT_LOOKBACK_DAYS,
    clamp: SIGMA_REVISION_ALPHA_CLAMP,
    fitAtUTC: new Date(now).toISOString()
  };
  regimeBlob.updated_at = new Date(now).toISOString();
  await regimeStore.setJSON("global", regimeBlob);
  return { fit: true, α_high, α_low, n_pairs_high: high.totalPairs, n_pairs_low: low.totalPairs };
}

async function runCapture(predictionsStore, predData, now) {
  const writes = [];
  for (const c of predData.cities || []) {
    if (c.error || c.mean == null || !c.cli || !c.tz || !c.name) continue;
    const { date, hour } = localDateAndHour(c.tz, now);
    if (!CAPTURE_HOURS.has(hour)) continue;
    const key = `${c.cli}/${date}`;
    const existing = await predictionsStore.get(key, { type: "json" });
    if (existing) continue;
    const record = {
      name: c.name,
      cli: c.cli,
      date,
      predHigh: c.mean,
      predLow: c.lowMean ?? null,
      stdHigh: c.std,
      stdLow: c.lowStd ?? null,
      capturedAtUTC: new Date(now).toISOString()
    };
    await predictionsStore.setJSON(key, record);
    writes.push({ city: c.name, date, predHigh: c.mean });
  }
  return writes;
}

async function runSettle(predictionsStore, regimeStore, predData, now) {
  const regimeBlob = (await regimeStore.get("global", { type: "json" })) || {};
  const dyn  = regimeBlob.per_city_residual_mean_7d || {};
  const dyn3 = regimeBlob.per_city_residual_mean_3d || {};
  const hist = regimeBlob.per_city_history || {};
  // Kalman state per city: { mu, P, last_update }. weather.js reads this and
  // applies μ as priorMean shift, (P + σ_walk²) as additional priorStd² in
  // quadrature. Replaces the 7d/3d rolling-mean heuristic where Kalman params
  // exist for the city (all 20 currently in lib/regime.js KALMAN_PARAMS).
  const kalmanState = regimeBlob.per_city_kalman_state || {};
  const kalmanStateLow = regimeBlob.per_city_kalman_state_low || {};
  // Global (hierarchical) Kalman state: one μ across all cities, captures
  // network-wide forecast bias that the per-city floor blocks individually.
  let kalmanGlobalState = regimeBlob.kalman_state_global || kalmanGlobalInit("high");
  let kalmanGlobalStateLow = regimeBlob.kalman_state_global_low || kalmanGlobalInit("low");
  const highResiduals = [];
  const lowResiduals  = [];
  const settledNow = [];
  let dirty = false;

  for (const c of predData.cities || []) {
    if (!c.name || !c.cli || !c.tz) continue;
    const { date: todayLocal, hour } = localDateAndHour(c.tz, now);
    if (!SETTLE_HOURS.has(hour)) continue;
    const yesterday = previousLocalDate(todayLocal);
    const key = `${c.cli}/${yesterday}`;
    const pred = await predictionsStore.get(key, { type: "json" });
    if (!pred || pred.settled || pred.predHigh == null) continue;
    const cliData = await fetchLatestCLI(c.cli);
    if (!cliData || cliData.coversDate !== yesterday || cliData.isPartial || cliData.maxF == null) continue;

    // predicted - actual matches the REGIME_RESIDUAL_SEED sign convention
    // (negative = model under-predicted, see weather.js:117).
    const residual = pred.predHigh - cliData.maxF;
    const entry = { date: yesterday, predicted: pred.predHigh, actual: cliData.maxF, residual };

    const cityHist = (hist[c.name] || []).concat(entry).slice(-HISTORY_TRIM);
    hist[c.name] = cityHist;
    const last7 = cityHist.slice(-ROLLING_WINDOW);
    dyn[c.name] = last7.reduce((a, e) => a + e.residual, 0) / last7.length;
    // 3-day window for regime-change detection. When |dyn3| > 1.5°F AND sign matches
    // dyn (7d), weather.js raises REGIME_DAMPING to override the prior faster. Without
    // this, a 3-4 day systematic bias (e.g., PHX 2026-05-07→05-10) barely moves the
    // 7d mean because 4 new entries are diluted by 3 older entries with opposite sign.
    // Retained alongside Kalman for cities without fitted Kalman params (and as a
    // backstop if the Kalman state ever drifts pathologically).
    const last3 = cityHist.slice(-SHORT_WINDOW);
    dyn3[c.name] = last3.length >= SHORT_WINDOW
      ? last3.reduce((a, e) => a + e.residual, 0) / last3.length
      : null;
    // Kalman regime update (HIGH): one forward-filter step using fitted per-city
    // params. Indexed by city.cli code. Initializes from seed if no blob entry
    // exists yet.
    const cliCode = c.cli;
    if (cliCode) {
      const prior = kalmanState[cliCode] && Number.isFinite(kalmanState[cliCode].mu)
        ? kalmanState[cliCode]
        : kalmanInit(cliCode, "high");
      if (prior) {
        const posterior = kalmanStep(prior, residual, cliCode, "high");
        if (posterior) kalmanState[cliCode] = posterior;
      }
    }
    highResiduals.push(residual);
    // Kalman regime update (LOW): only fires when CLI report includes minF.
    // Symmetric to HIGH; separate blob key per_city_kalman_state_low to keep
    // schema migrations local. lowResidual = pred.predLow − cliData.minF.
    if (cliCode && cliData.minF != null && pred.predLow != null) {
      const lowResidual = pred.predLow - cliData.minF;
      const priorLow = kalmanStateLow[cliCode] && Number.isFinite(kalmanStateLow[cliCode].mu)
        ? kalmanStateLow[cliCode]
        : kalmanInit(cliCode, "low");
      if (priorLow) {
        const posteriorLow = kalmanStep(priorLow, lowResidual, cliCode, "low");
        if (posteriorLow) kalmanStateLow[cliCode] = posteriorLow;
      }
      lowResiduals.push(lowResidual);
    }

    pred.settled = true;
    pred.actualHigh = cliData.maxF;
    pred.residual = residual;
    await predictionsStore.setJSON(key, pred);

    settledNow.push({
      city: c.name, date: yesterday,
      predicted: pred.predHigh, actual: cliData.maxF,
      residual, rolling7: dyn[c.name], rolling3: dyn3[c.name],
      kalman: c.cli ? kalmanState[c.cli] : null,
      kalman_low: c.cli ? kalmanStateLow[c.cli] : null,
      low_actual: cliData.minF, low_predicted: pred.predLow
    });
    dirty = true;
  }

  // Global Kalman update: one step on the mean residual across all settled
  // cities this cycle. Requires ≥3 cities to keep observation noise sane
  // (σ_obs scales as 1/√n; with n=1-2 the global is just noisy per-city).
  if (highResiduals.length >= 3) {
    const meanResid = highResiduals.reduce((a, b) => a + b, 0) / highResiduals.length;
    kalmanGlobalState = kalmanGlobalStep(kalmanGlobalState, meanResid, "high");
  }
  if (lowResiduals.length >= 3) {
    const meanResid = lowResiduals.reduce((a, b) => a + b, 0) / lowResiduals.length;
    kalmanGlobalStateLow = kalmanGlobalStep(kalmanGlobalStateLow, meanResid, "low");
  }

  if (dirty) {
    regimeBlob.per_city_residual_mean_7d = dyn;
    regimeBlob.per_city_residual_mean_3d = dyn3;
    regimeBlob.per_city_kalman_state = kalmanState;
    regimeBlob.per_city_kalman_state_low = kalmanStateLow;
    regimeBlob.kalman_state_global = kalmanGlobalState;
    regimeBlob.kalman_state_global_low = kalmanGlobalStateLow;
    regimeBlob.per_city_history = hist;
    regimeBlob.updated_at = new Date(now).toISOString();
    await regimeStore.setJSON("global", regimeBlob);
  }
  return settledNow;
}

// Rolling intraday-β refit (2026-05-26) — same self-updating pattern as σ_revision.
// Regress (actual − raw ensemble forecast) on biasF over recent SETTLED snapshots, binned
// by integer hrsToPeak (HIGH) / hrsToTrough (LOW). Through-origin slope per bin is β (the
// model is μ = forecast + β·biasF, no intercept). Writes regimeBlob.intraday_beta_state;
// weather.js resolveIntradayBeta merges per-bin over the seed — bins below the sample floor
// keep the seed, so this is a no-op until enough settled snapshots (carrying biasF +
// forecast* + actual*, all present post-2026-05-26) accumulate.
const BETA_FIT_LOOKBACK_DAYS = 21;
const BETA_FIT_MIN_PER_BIN = 20;
const BETA_CLAMP = [-0.2, 1.2];
function fitBetaBins(rows, hrKey, fcKey, actKey, maxHr) {
  const acc = {};
  for (const s of rows) {
    const x = s.biasF, fc = s[fcKey], act = s[actKey], hr = s[hrKey];
    if (x == null || fc == null || act == null || hr == null) continue;
    const b = Math.max(1, Math.min(maxHr, Math.round(hr)));
    (acc[b] ??= { sxy: 0, sxx: 0, n: 0 });
    acc[b].sxy += x * (act - fc); acc[b].sxx += x * x; acc[b].n++;
  }
  const out = [];
  for (let b = 1; b <= maxHr; b++) {
    const a = acc[b];
    if (!a || a.n < BETA_FIT_MIN_PER_BIN || a.sxx <= 0) continue;
    const beta = Math.max(BETA_CLAMP[0], Math.min(BETA_CLAMP[1], a.sxy / a.sxx));
    out.push([b, Math.round(beta * 1000) / 1000]);
  }
  return out;
}
async function runRefitIntradayBeta(snapshotsStore, regimeStore, now) {
  const { blobs } = await snapshotsStore.list();
  const cutoff = new Date(now - BETA_FIT_LOOKBACK_DAYS * 86400e3).toISOString().slice(0, 10);
  const keys = (blobs || []).map(b => b.key).filter(k => { const d = k.split("/")[1]; return d && d >= cutoff; })
    .sort((a, b) => (a.split("/")[1] < b.split("/")[1] ? 1 : -1)).slice(0, 600);  // cap GETs (timeout guard, 2026-05-26)
  const snaps = (await Promise.all(keys.map(k => snapshotsStore.get(k, { type: "json" }).catch(() => null))))
    .filter(s => s && s.settled);
  if (snaps.length < BETA_FIT_MIN_PER_BIN) return { fit: false, reason: "insufficient-settled", n: snaps.length };
  const high = fitBetaBins(snaps, "hrsToPeak", "forecastHigh", "actualHigh", 9);
  const low  = fitBetaBins(snaps, "hrsToTrough", "forecastLow", "actualLow", 6);
  if (!high.length && !low.length) return { fit: false, reason: "no-bin-met-min", n: snaps.length };
  const regimeBlob = (await regimeStore.get("global", { type: "json" }).catch(() => null)) || {};
  regimeBlob.intraday_beta_state = { high, low, nSnaps: snaps.length,
    lookbackDays: BETA_FIT_LOOKBACK_DAYS, fitAtUTC: new Date(now).toISOString() };
  await regimeStore.setJSON("global", regimeBlob);
  return { fit: true, n: snaps.length, highBins: high.length, lowBins: low.length, high, low };
}

export default async () => {
  const now = Date.now();
  try {
    const predData = await fetchPredictions();
    const predictionsStore = getStore("predictions");
    const regimeStore = getStore("regime_corrections");
    const snapshotsStore = getStore("prediction_snapshots");
    const captures = await runCapture(predictionsStore, predData, now);
    const settled  = await runSettle(predictionsStore, regimeStore, predData, now);
    // Market-implied μ/σ for edge measurement — best-effort, never blocks snapshotting.
    const impliedByName = await fetchKalshiImplied();
    const snapshots = await runSnapshot(snapshotsStore, predData, now, impliedByName);
    const snapshotsSettled = await runSnapshotSettle(snapshotsStore, predData, now);
    // σ_revision auto-fit runs once per logger cycle (5 min cron) — cheap given
    // the bounded lookback (14 days) and pairwise compute. Falls back silently
    // when n_pairs < MIN_PAIRS; weather.js reads from regimeBlob.sigma_revision_state.
    // BOTH heavy refits gated to ~hourly (top-of-hour cycle) — 2026-05-26. Each scans ~1200
    // snapshots; running them every 5-min cycle kept the logger at 502 (18-36s / memory). The
    // every-5-min cycle now does ONLY the light, critical work (runCapture/runSettle/runSnapshot/
    // runSnapshotSettle → prediction_snapshots + per_city_residual flow); the slow-moving σ/β
    // refits run once/hour and read-modify-write the regime blob (σ first, then β).
    // STAGGER the two heavy refits onto different cycles — σ_revision on the :00 cycle, β on
    // the :05 cycle — so no single run does both. Each is capped to 600 snapshots, keeping
    // every run well under the function limit (no 502 → cron-job.org won't auto-disable the
    // job). The other ~10 cycles/hour do only the light data writes. 2026-05-26.
    const _m = new Date(now).getUTCMinutes();
    let sigmaRevisionFit = { fit: false, reason: "off-cycle" };
    let intradayBetaFit  = { fit: false, reason: "off-cycle" };
    if (_m < 5) {
      try { sigmaRevisionFit = await runRefitSigmaRevision(snapshotsStore, regimeStore, now); }
      catch (e) { sigmaRevisionFit = { fit: false, error: String(e) }; }
    } else if (_m < 10) {
      try { intradayBetaFit = await runRefitIntradayBeta(snapshotsStore, regimeStore, now); }
      catch (e) { intradayBetaFit = { fit: false, error: String(e) }; }
    }
    return new Response(JSON.stringify({
      ok: true, ranAtUTC: new Date(now).toISOString(),
      captureCount: captures.length, captures,
      settleCount: settled.length, settled,
      snapshotCount: snapshots.length, snapshots,
      snapshotsSettledCount: snapshotsSettled.length, snapshotsSettled,
      sigmaRevisionFit, intradayBetaFit
    }, null, 2), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false, error: String(e?.message || e),
      ranAtUTC: new Date(now).toISOString()
    }), { status: 500, headers: { "content-type": "application/json" } });
  }
};

export const config = { schedule: "*/5 * * * *" };
