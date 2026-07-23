// Residual audit on the May 5-7 loss window: for each losing bet, fetch the
// actual observed daily max + min in the target city and compute residual =
// observed - modelMean. Decompose by city × variable.
//
// Per feedback_weatherbot_diurnal_bias_audit:
//   - opposite-sign HIGH vs LOW means => diurnal-range underestimation
//   - same-sign means                  => global drift (Kalman)
//
// Usage: node audit_carnage_window.js [jackson_settled.ndjson]

import { readFileSync } from "node:fs";

const NDJSON = process.argv[2] || "jackson_settled.ndjson";
const bets = readFileSync(NDJSON, "utf-8").trim().split(/\r?\n/).map(JSON.parse);

const CITY_LATLON = {
  "New York": [40.7789, -73.9692], "Los Angeles": [33.9425, -118.4081],
  "Chicago": [41.7860, -87.7524], "Houston": [29.6454, -95.2769],
  "Phoenix": [33.4342, -112.0116], "Philadelphia": [39.8729, -75.2437],
  "San Antonio": [29.5337, -98.4698], "Dallas-Fort Worth": [32.8998, -97.0403],
  "Austin": [30.1945, -97.6699], "Seattle": [47.4502, -122.3088],
  "Denver": [39.8617, -104.6731], "Miami": [25.7917, -80.2906],
  "Boston": [42.3656, -71.0096]
};

// Map ticker city code → memory city name (jackson uses memory names already)
// Some bets have alt forms; use bet.city directly.

// Extract target date from ticker: "KXHIGHPHIL-26MAY05-B85.5" → "2026-05-05"
function targetDate(ticker) {
  const m = ticker?.match(/-(\d{2})([A-Z]{3})(\d{2})-/);
  if (!m) return null;
  const months = { JAN:"01", FEB:"02", MAR:"03", APR:"04", MAY:"05", JUN:"06",
                   JUL:"07", AUG:"08", SEP:"09", OCT:"10", NOV:"11", DEC:"12" };
  return `20${m[1]}-${months[m[2]]}-${m[3]}`;
}

// Open-Meteo archive daily max/min
async function fetchDaily(lat, lon, date) {
  const url = `https://archive-api.open-meteo.com/v1/archive`
    + `?latitude=${lat}&longitude=${lon}`
    + `&start_date=${date}&end_date=${date}`
    + `&daily=temperature_2m_max,temperature_2m_min`
    + `&temperature_unit=fahrenheit&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const tmax = j.daily?.temperature_2m_max?.[0];
  const tmin = j.daily?.temperature_2m_min?.[0];
  if (tmax == null || tmin == null) return null;
  return { tmax, tmin };
}

// Cache (city, date) → daily
const cache = new Map();
async function getDaily(city, date) {
  const key = `${city}|${date}`;
  if (cache.has(key)) return cache.get(key);
  const ll = CITY_LATLON[city];
  if (!ll) return null;
  const d = await fetchDaily(ll[0], ll[1], date);
  cache.set(key, d);
  return d;
}

// Filter to May 5-7 placed
const window = bets.filter(b => {
  const d = b.placedAtUTC.slice(0,10);
  return d >= "2026-05-05" && d <= "2026-05-07";
});
console.log(`Bets placed 2026-05-05 to 2026-05-07: ${window.length}`);
const losses = window.filter(b => b.outcome === "LOSS");
const wins   = window.filter(b => b.outcome === "WIN");
console.log(`  losses: ${losses.length}, wins: ${wins.length}`);

// Enrich every bet (not just losses) with observed + residual
console.log(`\nFetching Open-Meteo daily obs ...`);
for (let i = 0; i < window.length; i++) {
  const b = window[i];
  const date = targetDate(b.ticker);
  b._date = date;
  const obs = date ? await getDaily(b.city, date) : null;
  if (!obs) { b._noObs = true; continue; }
  const observed = b.variable === "high" ? obs.tmax : obs.tmin;
  b._observed = observed;
  b._residual = observed - (b.modelMean ?? 0);   // + = warmer than model
}
console.log(`done. ${window.filter(b => b._noObs).length} bets had no obs.`);

// Decompose by city × variable
const groups = {};
for (const b of window) {
  if (b._noObs) continue;
  const k = `${b.city}|${b.variable}`;
  groups[k] ??= { city: b.city, variable: b.variable, n: 0, wins: 0, losses: 0,
                  residuals: [], pnl: 0 };
  groups[k].n++;
  if (b.outcome === "WIN")  groups[k].wins++;
  if (b.outcome === "LOSS") groups[k].losses++;
  groups[k].residuals.push(b._residual);
  groups[k].pnl += b.realized_pnl || 0;
}

console.log(`\n=== Residuals by city × variable (May 5-7 window) ===`);
console.log(`city            | var  | n  | W-L  | mean_resid | std_resid | pnl`);
console.log(`----------------+------+----+------+------------+-----------+--------`);
const cityList = [...new Set(Object.values(groups).map(g => g.city))].sort();
for (const c of cityList) {
  for (const v of ["high", "low"]) {
    const g = groups[`${c}|${v}`];
    if (!g) continue;
    const mean = g.residuals.reduce((a,x)=>a+x,0) / g.residuals.length;
    const std = Math.sqrt(g.residuals.reduce((a,x)=>a+(x-mean)**2,0) / g.residuals.length);
    const sign = mean > 0 ? "+" : "";
    console.log(` ${c.padEnd(15)}| ${v.padEnd(4)} | ${String(g.n).padStart(2)} | ${String(g.wins).padStart(2)}-${String(g.losses).padStart(2)} |   ${sign}${mean.toFixed(2).padStart(5)}°F  |   ${std.toFixed(2).padStart(4)}°F  | $${g.pnl.toFixed(2).padStart(7)}`);
  }
}

// Sign-pattern test per city: HIGH residual mean vs LOW residual mean
// Opposite signs → diurnal-range underestimate (warmer high + colder low both miss outward = expanded range)
// Same signs    → global drift (both pulled same direction)
console.log(`\n=== Sign-pattern test per city ===`);
console.log(`city            | high resid | low resid | pattern`);
console.log(`----------------+------------+-----------+-----------------------`);
let oppCount = 0, sameCount = 0, oppNet = 0, sameNet = 0;
for (const c of cityList) {
  const gh = groups[`${c}|high`];
  const gl = groups[`${c}|low`];
  if (!gh || !gl) continue;
  const mh = gh.residuals.reduce((a,x)=>a+x,0) / gh.residuals.length;
  const ml = gl.residuals.reduce((a,x)=>a+x,0) / gl.residuals.length;
  let pattern;
  if (mh > 0.3 && ml < -0.3) { pattern = "DIURNAL-EXPAND (hot hotter, cold colder)"; oppCount++; oppNet += gh.pnl + gl.pnl; }
  else if (mh < -0.3 && ml > 0.3) { pattern = "DIURNAL-COMPRESS"; oppCount++; oppNet += gh.pnl + gl.pnl; }
  else if (mh > 0.3 && ml > 0.3)  { pattern = "DRIFT WARM (both above model)"; sameCount++; sameNet += gh.pnl + gl.pnl; }
  else if (mh < -0.3 && ml < -0.3) { pattern = "DRIFT COOL (both below model)"; sameCount++; sameNet += gh.pnl + gl.pnl; }
  else                              { pattern = "in-bounds (|μ|<0.3°F)"; }
  console.log(` ${c.padEnd(15)}|  ${(mh>=0?"+":"")}${mh.toFixed(2).padStart(5)}°F |  ${(ml>=0?"+":"")}${ml.toFixed(2).padStart(5)}°F | ${pattern}`);
}
console.log(`\nCities w/ diurnal pattern: ${oppCount}, attributed PnL: $${oppNet.toFixed(2)}`);
console.log(`Cities w/ drift pattern:   ${sameCount}, attributed PnL: $${sameNet.toFixed(2)}`);

// Global summary — split losses by sign of (residual × side-direction-error)
// For HIGH YES (bet on high being in/above bucket), loss means observed < bucket → model overestimated → residual < 0
// For HIGH NO  (bet on high being below bucket), loss means observed >= bucket → model underestimated → residual > 0
// (mirror for LOW)
console.log(`\n=== Loss direction census (where did the model miss?) ===`);
let modelTooHot = 0, modelTooCold = 0;
for (const b of losses) {
  if (b._noObs) continue;
  const r = b._residual;  // observed - model
  // residual sign: + means observed > model (model was too cold)
  //                - means observed < model (model was too hot)
  if (r > 0) modelTooCold++;
  else if (r < 0) modelTooHot++;
}
console.log(`Losses where model was TOO COLD (obs > μ): ${modelTooCold}`);
console.log(`Losses where model was TOO HOT  (obs < μ): ${modelTooHot}`);

// Magnitude
const lossResiduals = losses.filter(b => !b._noObs).map(b => b._residual);
const meanLossResid = lossResiduals.reduce((a,x)=>a+x,0) / lossResiduals.length;
const meanAbsLossResid = lossResiduals.reduce((a,x)=>a+Math.abs(x),0) / lossResiduals.length;
console.log(`Mean residual on losses: ${meanLossResid.toFixed(2)}°F`);
console.log(`Mean |residual| on losses: ${meanAbsLossResid.toFixed(2)}°F`);
const meanModelStd = losses.reduce((a,b)=>a+(b.modelStd||0),0) / losses.length;
console.log(`Mean modelStd on losses:   ${meanModelStd.toFixed(2)}°F`);
console.log(`→ |residual| / modelStd ratio: ${(meanAbsLossResid / meanModelStd).toFixed(2)} (>1.5 = model underestimates its own uncertainty)`);
