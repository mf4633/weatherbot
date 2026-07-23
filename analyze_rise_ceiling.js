// SAFETY TEST for wiring lib/diurnal.js's extremumBounds ceiling into kalshi.js as
// bucketProb's upperFloor on HIGH.
//
// Truncating at a ceiling asserts P(high > ceil) = 0. If reality exceeds the ceiling
// even occasionally, the model assigns ZERO to the bucket that actually settles and
// will happily buy NO against it at "certainty" — strictly worse than the bug being
// fixed. So the question is not "does it help" (it does: mean mass-above-market-favorite
// 35.3% -> 26.1% on the 2026-07-23 board) but "how often is the ceiling wrong".
//
// ceil(h) = maxSoFar(h) + RISE(h) + SETTLE_MARGIN_F, from diurnal_bounds.js.
// RISE is explicitly a CONSERVATIVE PLACEHOLDER, already loosened once (2026-07-13)
// after real ledger violations (KCMH +9F after 14h local). This measures the rate on
// 5y x 20 cities.
//
// CAVEAT: obs here are Open-Meteo/ERA5 reanalysis, not ASOS. ERA5 grid temp diverges
// 1-3F from the sensor on convective/sea-breeze days, so this is indicative of the
// diurnal envelope, not an exact ASOS violation rate. Directionally it is the best
// large sample available.
import { readFileSync } from "node:fs";
import { RISE } from "./netlify/functions/lib/diurnal_bounds.js";
import { SETTLE_MARGIN_F } from "./netlify/functions/lib/diurnal.js";

// data.json (41MB, GFS-only) carries the same hourly obs as data_models.json (125MB).
// This test needs observations only, so use the light file.
const data = JSON.parse(readFileSync("data.json", "utf-8"));
const lookup = (table, h) => (table.find(e => (h == null ? Infinity : h) < e.ltHour) || table[table.length - 1]).val;
const maxRemainingRise = h => lookup(RISE, h);

const localHour = (iso, tz) => parseInt(new Intl.DateTimeFormat("en-US",
  { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(iso)), 10);
const localDateStr = (iso, tz) => new Intl.DateTimeFormat("en-CA",
  { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

console.log("Pre-processing...");
const cities = {};
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const byDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    const t = c.obs.temps[i];
    if (t == null || !isFinite(t)) continue;
    (byDay[localDateStr(ts, tz)] ??= []).push({ tempF: t, h: localHour(ts, tz) });
  }
  cities[name] = byDay;
}

// For each city-day and each local hour 8..21, compute maxSoFar and test the ceiling.
const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const byHour = {}, byCity = {};
let n = 0, viol = 0;
const worst = [];
for (const [city, byDay] of Object.entries(cities)) {
  for (const [date, obs] of Object.entries(byDay)) {
    if (obs.length < 20) continue;              // need a near-complete day
    const finalMax = Math.max(...obs.map(o => o.tempF));
    for (const h of HOURS) {
      const upto = obs.filter(o => o.h <= h);
      if (!upto.length) continue;
      const maxSoFar = Math.max(...upto.map(o => o.tempF));
      const ceil = maxSoFar + maxRemainingRise(h) + SETTLE_MARGIN_F;
      const over = finalMax - ceil;
      const isViol = over > 0;
      (byHour[h] ??= { n: 0, viol: 0, sumOver: 0, maxOver: 0 });
      byHour[h].n++; if (isViol) { byHour[h].viol++; byHour[h].sumOver += over; byHour[h].maxOver = Math.max(byHour[h].maxOver, over); }
      (byCity[city] ??= { n: 0, viol: 0, maxOver: 0 });
      byCity[city].n++; if (isViol) { byCity[city].viol++; byCity[city].maxOver = Math.max(byCity[city].maxOver, over); }
      n++; if (isViol) { viol++; worst.push({ city, date, h, maxSoFar, finalMax, ceil, over }); }
    }
  }
}

console.log(`\nsamples: ${n}   ceiling violations: ${viol}  (${(viol / n * 100).toFixed(3)}%)\n`);

console.log("=== Violation rate by local hour ===");
console.log("hour  RISE(h)   n        viol     rate      mean over   max over");
for (const h of HOURS) {
  const s = byHour[h]; if (!s) continue;
  console.log(`${String(h).padStart(4)}  ${String(maxRemainingRise(h)).padStart(6)}   ${String(s.n).padEnd(8)} ${String(s.viol).padEnd(8)} `
    + `${(s.viol / s.n * 100).toFixed(3)}%`.padEnd(10)
    + `${s.viol ? (s.sumOver / s.viol).toFixed(2) : "-"}`.padStart(9) + `   ${s.maxOver.toFixed(2)}`);
}

console.log("\n=== Worst cities by violation rate ===");
for (const [c, s] of Object.entries(byCity).sort((a, b) => b[1].viol / b[1].n - a[1].viol / a[1].n).slice(0, 8))
  console.log(`  ${c.padEnd(16)} ${(s.viol / s.n * 100).toFixed(3)}%   max over ${s.maxOver.toFixed(2)}F  (n=${s.n})`);

console.log("\n=== Worst individual violations ===");
for (const w of worst.sort((a, b) => b.over - a.over).slice(0, 12))
  console.log(`  ${w.city.padEnd(14)} ${w.date}  h=${String(w.h).padStart(2)}  maxSoFar=${w.maxSoFar.toFixed(1)}  ceil=${w.ceil.toFixed(1)}  final=${w.finalMax.toFixed(1)}  over=+${w.over.toFixed(2)}F`);

// What headroom would drive violations to ~0 at each hour?
console.log("\n=== RISE(h) needed for a 99.9% / 99.99% safe ceiling (excl. SETTLE_MARGIN) ===");
console.log("hour  current   p99.9   p99.99   max");
for (const h of HOURS) {
  const gaps = [];
  for (const [, byDay] of Object.entries(cities)) {
    for (const [, obs] of Object.entries(byDay)) {
      if (obs.length < 20) continue;
      const finalMax = Math.max(...obs.map(o => o.tempF));
      const upto = obs.filter(o => o.h <= h);
      if (!upto.length) continue;
      gaps.push(finalMax - Math.max(...upto.map(o => o.tempF)));
    }
  }
  gaps.sort((a, b) => a - b);
  const q = p => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))];
  console.log(`${String(h).padStart(4)}  ${String(maxRemainingRise(h)).padStart(7)}   `
    + `${q(0.999).toFixed(1)}`.padStart(5) + `   ${q(0.9999).toFixed(1)}`.padStart(6) + `   ${gaps[gaps.length - 1].toFixed(1)}`.padStart(5));
}
