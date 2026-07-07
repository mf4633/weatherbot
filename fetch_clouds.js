// Fetch cloud_cover for the last 365 days (obs + forecast) for all 20 cities.
// Saves to data_clouds.json. Pairs with the existing data.json for cloud-correction backtest.

import { writeFileSync } from "node:fs";

import { CITIES } from "./cities.js";

const LOOKBACK_DAYS = 365;
function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(d.getTime() + n * 24 * 3600 * 1000); }

async function fetchObs(city, start, end) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${isoDate(start)}&end_date=${isoDate(end)}`
    + `&hourly=temperature_2m,cloud_cover&temperature_unit=fahrenheit&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`obs ${r.status}`);
  return await r.json();
}

async function fetchFc(city, start, end) {
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${isoDate(start)}&end_date=${isoDate(end)}`
    + `&hourly=temperature_2m,cloud_cover&temperature_unit=fahrenheit&timezone=UTC&models=gfs_seamless`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fc ${r.status}`);
  return await r.json();
}

const today = new Date();
const start = addDays(today, -LOOKBACK_DAYS);
const end = addDays(today, -1);
const data = { window: { start: isoDate(start), end: isoDate(end) }, cities: {} };

console.log(`Fetching cloud + temp ${isoDate(start)} → ${isoDate(end)}, ${CITIES.length} cities...`);
for (const city of CITIES) {
  process.stdout.write(`  ${city.name}... `);
  const [obs, fc] = await Promise.all([fetchObs(city, start, end), fetchFc(city, start, end)]);
  data.cities[city.name] = {
    meta: city,
    obs: { times: obs.hourly.time, temps: obs.hourly.temperature_2m, clouds: obs.hourly.cloud_cover },
    fc:  { times: fc.hourly.time,  temps: fc.hourly.temperature_2m,  clouds: fc.hourly.cloud_cover }
  };
  console.log(`${obs.hourly.time.length} obs, ${fc.hourly.time.length} fc`);
}

writeFileSync("data_clouds.json", JSON.stringify(data));
console.log(`\nSaved data_clouds.json (${(JSON.stringify(data).length / 1024 / 1024).toFixed(1)} MB)`);
