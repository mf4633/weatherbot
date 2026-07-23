// Post-deploy RMSE comparison for the 1-min ASOS integration.
//
// Compares production residuals before vs after the deploy date (2026-05-06)
// to measure whether the Synoptic 1-min ASOS integration moved the all-up
// prediction RMSE.
//
// Usage:
//   node analyze_post_asos1min.js
//
// Optional: set WEATHERBOT_AUTH=<password> if /api/residuals is auth-gated.
// Default password is 'hydro' per README.

import https from "https";

const DEPLOY_DATE = new Date("2026-05-06T00:00:00Z"); // commit 6359cc5
const PASSWORD = process.env.WEATHERBOT_AUTH || "hydro";
const RESIDUALS_URL = "https://weatherbot-mf.netlify.app/api/residuals";

function fetchUrl(url, auth) {
  return new Promise((resolve, reject) => {
    const opts = auth ? { headers: { Authorization: `Basic ${Buffer.from(":" + auth).toString("base64")}` } } : {};
    https.get(url, opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function rmse(arr) {
  if (!arr.length) return null;
  const ss = arr.reduce((a, x) => a + x * x, 0);
  return Math.sqrt(ss / arr.length);
}

function mae(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, x) => a + Math.abs(x), 0) / arr.length;
}

function bias(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, x) => a + x, 0) / arr.length;
}

async function main() {
  console.log(`Fetching residuals from ${RESIDUALS_URL} ...`);
  const text = await fetchUrl(RESIDUALS_URL, PASSWORD);
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.error("Could not parse JSON. Response was:");
    console.error(text.slice(0, 500));
    process.exit(1);
  }

  // weatherbot residuals shape:  { global: {...}, byCity: [...], records: [...] }
  // Each record: { cli, name, localDate, predicted, actual, residual, capturedAtUTC, ... }
  const records = Array.isArray(json.records) ? json.records : [];

  if (!records.length) {
    console.error("Could not extract residuals from JSON. Top-level keys:", Object.keys(json));
    console.error("First 1000 chars:", text.slice(0, 1000));
    process.exit(1);
  }

  console.log(`Found ${records.length} residual records.`);

  // Each record should have a date and a residual (predicted - actual or actual - predicted).
  // Try common field names.
  // Use localDate (the climate date the residual is for) — that's what
  // determines which side of the deploy boundary it falls on.
  function getDate(r) {
    if (r.localDate) return new Date(r.localDate + "T12:00:00Z"); // noon to avoid TZ edge cases
    return new Date(r.capturedAtUTC || r.reconciledAtUTC || 0);
  }
  function getResidual(r) {
    if (r.residual != null) return r.residual;
    if (r.predicted != null && r.actual != null) return r.predicted - r.actual;
    return null;
  }

  const before = [];
  const after = [];
  const byCity = new Map(); // cityName -> { before: [], after: [] }

  for (const r of records) {
    const d = getDate(r);
    const res = getResidual(r);
    const city = r.name || r.cli || "unknown";
    if (isNaN(d) || res == null || !isFinite(res)) continue;
    const bucket = d < DEPLOY_DATE ? "before" : "after";
    (bucket === "before" ? before : after).push(res);
    if (!byCity.has(city)) byCity.set(city, { before: [], after: [] });
    byCity.get(city)[bucket].push(res);
  }

  console.log("");
  console.log(`Deploy date threshold: ${DEPLOY_DATE.toISOString().slice(0, 10)}`);
  console.log("");
  console.log("=== ALL CITIES ===");
  console.log(`Before n=${before.length}:  RMSE=${rmse(before)?.toFixed(2) ?? "—"}°F  MAE=${mae(before)?.toFixed(2) ?? "—"}°F  bias=${bias(before)?.toFixed(2) ?? "—"}°F`);
  console.log(` After n=${after.length}:   RMSE=${rmse(after)?.toFixed(2) ?? "—"}°F  MAE=${mae(after)?.toFixed(2) ?? "—"}°F  bias=${bias(after)?.toFixed(2) ?? "—"}°F`);
  if (rmse(before) != null && rmse(after) != null) {
    const delta = rmse(after) - rmse(before);
    console.log(` Δ RMSE = ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}°F  (${delta < 0 ? "improvement" : "regression"})`);
  }

  if (after.length < 50) {
    console.log("");
    console.log(`⚠️  Only ${after.length} post-deploy residuals. Wait until n ≥ 100 for a meaningful comparison.`);
  }

  console.log("");
  console.log("=== PER-CITY (cities with both before AND after data) ===");
  console.log("city               | before n | after n | RMSE before | RMSE after | Δ");
  console.log("-------------------|----------|---------|-------------|------------|--------");
  const rows = [];
  for (const [c, { before: b, after: a }] of byCity) {
    if (!b.length || !a.length) continue;
    const rb = rmse(b), ra = rmse(a);
    if (rb == null || ra == null) continue;
    rows.push({ city: c, bn: b.length, an: a.length, rb, ra, delta: ra - rb });
  }
  rows.sort((x, y) => x.delta - y.delta);  // best improvers first
  for (const r of rows) {
    console.log(`  ${r.city.padEnd(18)}| ${String(r.bn).padStart(8)} | ${String(r.an).padStart(7)} | ${r.rb.toFixed(2).padStart(11)} | ${r.ra.toFixed(2).padStart(10)} | ${(r.delta >= 0 ? "+" : "") + r.delta.toFixed(2)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
