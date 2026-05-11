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

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const UA = "weatherbot-logger";
const INTERNAL_AUTH = "Basic " + btoa("internal:hydro");

const CAPTURE_HOURS = new Set([14, 15]);
const SETTLE_HOURS  = new Set([6, 7, 8, 9, 10, 11, 12]);
const HISTORY_TRIM   = 30;   // entries kept per city
const ROLLING_WINDOW = 7;    // size of the rolling mean weather.js consumes

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

// Same CLI fetcher/parser as weather.js fetchLatestCLI, slimmed to high-only.
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

    const observedMissing = /^\s*MAXIMUM\s+(?:M+|-+)(?:\s|$)/im.test(text);
    let maxF = null;
    let m = text.match(/^\s*MAXIMUM\s+(-?\d+)/im);
    if (m) maxF = parseInt(m[1], 10);
    if (maxF == null && !observedMissing) {
      m = text.match(/HIGH(?:EST)?\s+TEMP[A-Z\s\(\)]*\s+(-?\d+)/i);
      if (m) maxF = parseInt(m[1], 10);
    }
    if (maxF == null && !observedMissing) {
      const tempBlock = text.split(/PRECIPITATION|SNOW|WIND|SKY/)[0] || text;
      m = tempBlock.match(/MAXIMUM[^\n]*?(-?\d{2,3})/i);
      if (m) maxF = parseInt(m[1], 10);
    }

    return {
      maxF,
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
  const hist = regimeBlob.per_city_history || {};
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

    pred.settled = true;
    pred.actualHigh = cliData.maxF;
    pred.residual = residual;
    await predictionsStore.setJSON(key, pred);

    settledNow.push({
      city: c.name, date: yesterday,
      predicted: pred.predHigh, actual: cliData.maxF,
      residual, rolling7: dyn[c.name]
    });
    dirty = true;
  }

  if (dirty) {
    regimeBlob.per_city_residual_mean_7d = dyn;
    regimeBlob.per_city_history = hist;
    regimeBlob.updated_at = new Date(now).toISOString();
    await regimeStore.setJSON("global", regimeBlob);
  }
  return settledNow;
}

export default async () => {
  const now = Date.now();
  try {
    const predData = await fetchPredictions();
    const predictionsStore = getStore("predictions");
    const regimeStore = getStore("regime_corrections");
    const captures = await runCapture(predictionsStore, predData, now);
    const settled  = await runSettle(predictionsStore, regimeStore, predData, now);
    return new Response(JSON.stringify({
      ok: true, ranAtUTC: new Date(now).toISOString(),
      captureCount: captures.length, captures,
      settleCount: settled.length, settled
    }, null, 2), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false, error: String(e?.message || e),
      ranAtUTC: new Date(now).toISOString()
    }), { status: 500, headers: { "content-type": "application/json" } });
  }
};

export const config = { schedule: "*/5 * * * *" };
