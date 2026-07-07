// Fetch 1 year of historical forecasts from multiple NWP models for ensemble testing.
// Open-Meteo supports gfs_seamless, ecmwf_ifs025, icon_seamless, gem_seamless, etc.
// We pull each model's forecast hourly temp + obs (ERA5) for the same period.

import { writeFileSync } from "node:fs";

import { CITIES } from "./cities.js";

// Production 5 (drop JMA, GEM — they hurt the ensemble in earlier tests).
const MODELS = [
  "gfs_seamless", "ecmwf_ifs025", "icon_seamless", "ukmo_seamless", "meteofrance_seamless"
];
const LOOKBACK_DAYS = 5 * 365;  // 5 years for per-city weight tuning

function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(d.getTime() + n * 24 * 3600 * 1000); }

async function fetchWithRetry(url, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(url);
    if (r.ok) return r;
    if (r.status === 429 || r.status >= 500) {
      const wait = 5000 * (i + 1);  // 5s, 10s, 15s, 20s, 25s
      process.stdout.write(`(${r.status} retry ${i+1}/${attempts}) `);
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    return r;
  }
  throw new Error(`fetch failed after ${attempts} retries: ${url.slice(0, 100)}`);
}

async function fetchObs(city, start, end) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${isoDate(start)}&end_date=${isoDate(end)}`
    + `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=UTC`;
  const r = await fetchWithRetry(url);
  if (!r.ok) throw new Error(`obs ${r.status}`);
  return await r.json();
}

async function fetchModel(city, start, end, model) {
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${isoDate(start)}&end_date=${isoDate(end)}`
    + `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=UTC&models=${model}`;
  try {
    const r = await fetchWithRetry(url);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

const today = new Date();
const start = addDays(today, -LOOKBACK_DAYS);
const end = addDays(today, -1);
const data = { window: { start: isoDate(start), end: isoDate(end) }, models: MODELS, cities: {} };

console.log(`Fetching ${MODELS.length} models + obs, ${isoDate(start)} → ${isoDate(end)}, ${CITIES.length} cities...`);
for (const city of CITIES) {
  process.stdout.write(`  ${city.name}: obs `);
  const obs = await fetchObs(city, start, end);
  process.stdout.write(`${obs.hourly.time.length} `);
  const modelData = {};
  for (const model of MODELS) {
    process.stdout.write(`${model.split("_")[0]} `);
    const fc = await fetchModel(city, start, end, model);
    if (fc?.hourly?.time) {
      modelData[model] = { times: fc.hourly.time, temps: fc.hourly.temperature_2m };
    } else {
      modelData[model] = null;
      process.stdout.write("(failed) ");
    }
  }
  data.cities[city.name] = {
    meta: city,
    obs: { times: obs.hourly.time, temps: obs.hourly.temperature_2m },
    models: modelData
  };
  console.log("done");
}

writeFileSync("data_models.json", JSON.stringify(data));
console.log(`\nSaved data_models.json (${(JSON.stringify(data).length / 1024 / 1024).toFixed(1)} MB)`);
