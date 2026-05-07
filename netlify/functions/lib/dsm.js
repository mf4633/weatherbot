// Daily Summary Message (DSM) — NWS automatic ASOS daily-extremes report.
// Issued by each NWS forecast office shortly after each synoptic time, the DSM
// reports daily max/min temp + times derived from ASOS DI-1 internal continuous
// data — the same data source the CLI Daily Climate Report draws from, and
// therefore what Kalshi NHIGH/NLOW markets settle on.
//
// 2026-05-07 KNYC incident: a brief sensor spike to ≥17.5°C between two hourly
// METARs (each at 17.2°C) was invisible to METAR/Synoptic/IEM polling but
// captured in the DSM as max=64°F. The market repriced ≤63 YES from $0.26
// → $0.05 hours before any visible-to-us source confirmed the change. Polling
// DSM closes that window — we get the same data the market does.
//
// DSM format (one block per station):
//   KNYC DS 1500 07/05 641434/ 490625// 64/ 49//9751459/...
//   ^^^^ ^^ ^^^^ ^^^^^ ^^^^^^^ ^^^^^^^^ ^^ ^^
//   STID DS HHMM MM/DD MAXTTTT MINTTTT  MAX MIN
// where MAXTTTT is e.g. 641434 = 64°F at 14:34 local time. Sentinels "M"/"-"
// indicate missing. Temperatures are integer °F.

const STATION_CODE = (kstid) => kstid.replace(/^K/, "");

const UA = "weatherbot.netlify.app (contact: github.com/mf4633)";

let CACHE = { ts: 0, byStation: null };
const CACHE_MS = 5 * 60 * 1000;

// Parse a single station's DSM data line. Returns { dailyMaxF, dailyMinF,
// maxTimeLocal, minTimeLocal } or null if unparseable.
function parseDsmLine(line) {
  // Anchor on "STID DS " then look for two consecutive groups of digits +
  // 4-digit time, separated by space and "/". Tolerant of leading whitespace
  // around values.
  const m = line.match(/DS\s+\d{4}\s+\d{2}\/\d{2}\s+(\d{2,3})(\d{4})\/\s+(\d{2,3})(\d{4})\/\//);
  if (!m) return null;
  return {
    dailyMaxF: parseInt(m[1], 10),
    maxTimeLocal: m[2],  // "1434" = 14:34 local
    dailyMinF: parseInt(m[3], 10),
    minTimeLocal: m[4],
  };
}

async function fetchLatestDsmForStation(stid) {
  const code = STATION_CODE(stid);
  // 1. Get latest DSM product ID for this location
  const listUrl = `https://api.weather.gov/products/types/DSM/locations/${code}`;
  let productId, issuanceTime;
  try {
    const r = await fetch(listUrl, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const j = await r.json();
    const products = j["@graph"] || [];
    if (!products.length) return null;
    // @graph appears to be sorted desc by issuanceTime; take first.
    const p = products[0];
    productId = p["@id"] || p.id;
    issuanceTime = p.issuanceTime;
    if (!productId) return null;
  } catch (e) {
    return null;
  }

  // 2. Fetch the actual product text
  let text;
  try {
    const r2 = await fetch(productId, { headers: { "User-Agent": UA } });
    if (!r2.ok) return null;
    const j2 = await r2.json();
    text = j2.productText || "";
  } catch (e) {
    return null;
  }

  // 3. Find the line beginning with this station's identifier
  const lineRe = new RegExp(`^${stid}\\s+DS\\s+.*$`, "m");
  const lineMatch = text.match(lineRe);
  if (!lineMatch) return null;
  const parsed = parseDsmLine(lineMatch[0]);
  if (!parsed) return null;

  return {
    ...parsed,
    issuedAt: issuanceTime,  // ISO 8601 UTC
  };
}

// Returns { [stid]: { dailyMaxF, dailyMinF, maxTimeLocal, minTimeLocal, issuedAt } }
// Per-station failures dropped silently; total failure returns {}.
export async function fetchDsmExtremes(stids) {
  const now = Date.now();
  if (CACHE.byStation && now - CACHE.ts < CACHE_MS) return CACHE.byStation;

  const results = await Promise.all(stids.map(fetchLatestDsmForStation));
  const byStation = {};
  for (let i = 0; i < stids.length; i++) {
    if (results[i]) byStation[stids[i]] = results[i];
  }
  CACHE = { ts: now, byStation };
  return byStation;
}
