// Shadow market-data logger (Strategy-testing infrastructure, Step 0 of STRATEGY.md).
// Records the FULL Kalshi order book + current observations + model, every cycle, for all
// cities — and places NO trades. This builds the market-wide quote+outcome dataset that
// every edge hypothesis needs (we can't test market inefficiencies on our selected bets).
//
// Modes (query ?mode=): "record" (default, also the scheduled action), "settle", "export".
//   record  — snapshot every city's book + obs → blob market_snapshots/<localDate>/<ISO>.json
//   settle  — for past local dates, fetch the CLI final high/low → market_settlements/<date>.json
//   export  — return snapshots JOINED with settlements, ready for eval_strategy.mjs (SNAPSHOTS=)
//
// Read-only w.r.t. money by construction — it imports no trader and submits no orders.

import { getStore } from "@netlify/blobs";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const INTERNAL_AUTH = "Basic " + btoa("internal:hydro");
const SNAP_STORE = "market_snapshots";
const SETTLE_STORE = "market_settlements";

const localDate = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/Chicago" }).format(new Date());
const localHour = (tz) => parseInt(new Intl.DateTimeFormat("en-US",
  { timeZone: tz || "America/Chicago", hour: "2-digit", hour12: false }).format(new Date()), 10) % 24;

async function getJSON(path) {
  const r = await fetch(`${SITE_BASE}${path}`, { headers: { authorization: INTERNAL_AUTH } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

// Keep only the quote/bound fields (drop model-derived EV so snapshots are model-agnostic raw book).
const slimBucket = (b) => ({ ticker: b.ticker, loInt: b.loInt ?? null, hiInt: b.hiInt ?? null,
  yes_ask: b.yes_ask ?? null, yes_bid: b.yes_bid ?? null, no_ask: b.no_ask ?? null,
  no_bid: b.no_bid ?? null, last: b.last ?? null, volume: b.volume ?? null, volume24h: b.volume24h ?? null });

async function record() {
  const [wx, ks] = await Promise.all([getJSON("/api/weather"), getJSON("/api/kalshi")]);
  const wxByName = Object.fromEntries((wx.cities || []).map(c => [c.name, c]));
  const now = new Date().toISOString();
  const records = [];
  for (const c of ks.cities || []) {
    const w = wxByName[c.name] || {};
    const tz = w.tz || c.tz;
    const base = { ts: now, city: c.name, cli: w.cli || w.station || null, tz,
      dateLocal: localDate(tz), localHour: localHour(tz),
      currentTemp: w.currentTemp ?? w.temp ?? null,
      maxSoFar: w.maxSoFarCli ?? w.maxSoFar ?? null,
      minSoFar: w.minSoFarCli ?? w.minSoFar ?? null,
      modelMean: c.mean ?? w.mean ?? null, modelStd: c.std ?? w.std ?? null };
    if (Array.isArray(c.highBuckets) && c.highBuckets.length)
      records.push({ ...base, variable: "high", buckets: c.highBuckets.map(slimBucket) });
    if (Array.isArray(c.lowBuckets) && c.lowBuckets.length)
      records.push({ ...base, variable: "low", buckets: c.lowBuckets.map(slimBucket) });
  }
  if (!records.length) return { ok: false, reason: "no city books available" };
  const day = records[0].dateLocal;
  const key = `${day}/${now}.json`;
  await getStore(SNAP_STORE).setJSON(key, records);
  return { ok: true, mode: "record", key, cities: records.length, ts: now };
}

// Compact CLI fetcher (mirrors logger.js fetchLatestCLI): final daily max/min °F.
async function fetchCLI(cli) {
  try {
    const url = `https://forecast.weather.gov/product.php?site=NWS&product=CLI&issuedby=${cli}&format=txt&version=1&glossary=0`;
    const r = await fetch(url); if (!r.ok) return null;
    const text = await r.text();
    const maxM = text.match(/MAXIMUM\s+(-?\d+)/i);
    const minM = text.match(/MINIMUM\s+(-?\d+)/i);
    return { maxF: maxM ? parseInt(maxM[1], 10) : null, minF: minM ? parseInt(minM[1], 10) : null };
  } catch { return null; }
}

async function settle() {
  const snapStore = getStore(SNAP_STORE), setStore = getStore(SETTLE_STORE);
  const { blobs } = await snapStore.list();
  const days = [...new Set((blobs || []).map(b => b.key.split("/")[0]))].sort();
  const today = localDate("America/New_York");                 // don't settle the current day anywhere
  const done = [];
  for (const day of days) {
    if (day >= today) continue;
    const existing = await setStore.get(`${day}.json`, { type: "json" }).catch(() => null);
    // one representative snapshot to learn which (city→cli) traded that day
    const anyKey = (blobs.find(b => b.key.startsWith(`${day}/`)) || {}).key;
    const recs = anyKey ? await snapStore.get(anyKey, { type: "json" }).catch(() => []) : [];
    const cliByCity = {}; for (const r of recs) if (r.cli) cliByCity[r.city] = r.cli;
    const out = existing || {};
    let wrote = false;
    for (const [city, cli] of Object.entries(cliByCity)) {
      if (out[city]?.high != null || out[city]?.low != null) continue;
      const cliData = await fetchCLI(cli);
      if (cliData && (cliData.maxF != null || cliData.minF != null)) {
        out[city] = { high: cliData.maxF, low: cliData.minF }; wrote = true;
      }
    }
    if (wrote) { await setStore.setJSON(`${day}.json`, out); done.push(day); }
  }
  return { ok: true, mode: "settle", settledDays: done };
}

async function exportJoined(limit = 4000) {
  const snapStore = getStore(SNAP_STORE), setStore = getStore(SETTLE_STORE);
  const { blobs } = await snapStore.list();
  const keys = (blobs || []).map(b => b.key).sort().slice(-limit);
  const settleCache = {};
  const out = [];
  for (const k of keys) {
    const recs = await snapStore.get(k, { type: "json" }).catch(() => null);
    if (!recs) continue;
    for (const r of recs) {
      if (!(r.dateLocal in settleCache))
        settleCache[r.dateLocal] = await setStore.get(`${r.dateLocal}.json`, { type: "json" }).catch(() => null);
      const s = settleCache[r.dateLocal]?.[r.city];
      const extremumF = s ? (r.variable === "high" ? s.high : s.low) : null;
      out.push({ ...r, settle: { extremumF } });
    }
  }
  return out;
}

export default async (req) => {
  const mode = new URL(req.url).searchParams.get("mode") || "record";
  try {
    if (mode === "settle") return json(await settle());
    if (mode === "export") return json(await exportJoined());
    return json(await record());
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2),
  { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Record every 15 min (obs move slowly; lock-ins persist). Settle/export are triggered
// out-of-band (external cron or manual) — see STRATEGY.md.
export const config = { schedule: "*/15 * * * *" };
