// One-time fetch of 1-year obs + GFS historical forecasts for all 20 cities.
// Saves to data.json for fast re-analysis.

import { writeFileSync } from "node:fs";

import { CITIES } from "./cities.js";

const LOOKBACK_DAYS = 5 * 365 + 1;  // 5 years (Open-Meteo historical-forecast archive starts 2021-01)

function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(d.getTime() + n * 24 * 3600 * 1000); }

async function fetchObs(city, start, end) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${isoDate(start)}&end_date=${isoDate(end)}`
    + `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`obs ${r.status}`);
  return await r.json();
}

async function fetchFc(city, start, end) {
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${isoDate(start)}&end_date=${isoDate(end)}`
    + `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=UTC&models=gfs_seamless`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fc ${r.status}`);
  return await r.json();
}

const today = new Date();
const start = addDays(today, -LOOKBACK_DAYS);
const end = addDays(today, -1);
const data = { window: { start: isoDate(start), end: isoDate(end) }, cities: {} };

console.log(`Fetching ${isoDate(start)} → ${isoDate(end)}, ${CITIES.length} cities...`);
for (const city of CITIES) {
  process.stdout.write(`  ${city.name}... `);
  const [obs, fc] = await Promise.all([fetchObs(city, start, end), fetchFc(city, start, end)]);
  // Compact: store as parallel arrays of times+temps
  data.cities[city.name] = {
    meta: city,
    obs: { times: obs.hourly.time, temps: obs.hourly.temperature_2m },
    fc:  { times: fc.hourly.time,  temps: fc.hourly.temperature_2m }
  };
  console.log(`${obs.hourly.time.length} obs, ${fc.hourly.time.length} fc`);
}

writeFileSync("data.json", JSON.stringify(data));
console.log(`\nSaved data.json (${(JSON.stringify(data).length / 1024 / 1024).toFixed(1)} MB)`);
