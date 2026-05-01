// Fetch 1 year of historical forecasts from multiple NWP models for ensemble testing.
// Open-Meteo supports gfs_seamless, ecmwf_ifs025, icon_seamless, gem_seamless, etc.
// We pull each model's forecast hourly temp + obs (ERA5) for the same period.

import { writeFileSync } from "node:fs";

const CITIES = [
  { name: "NYC",  lat: 40.7789, lon: -73.9692, tz: "America/New_York" },
  { name: "LAX",  lat: 33.9425, lon: -118.4081, tz: "America/Los_Angeles" },
  { name: "ORD",  lat: 41.9742, lon: -87.9073, tz: "America/Chicago" },
  { name: "IAH",  lat: 29.9844, lon: -95.3414, tz: "America/Chicago" },
  { name: "PHX",  lat: 33.4342, lon: -112.0116, tz: "America/Phoenix" },
  { name: "PHL",  lat: 39.8729, lon: -75.2437, tz: "America/New_York" },
  { name: "SAT",  lat: 29.5337, lon: -98.4698, tz: "America/Chicago" },
  { name: "SAN",  lat: 32.7336, lon: -117.1897, tz: "America/Los_Angeles" },
  { name: "DFW",  lat: 32.8998, lon: -97.0403, tz: "America/Chicago" },
  { name: "JAX",  lat: 30.4941, lon: -81.6879, tz: "America/New_York" },
  { name: "AUS",  lat: 30.1945, lon: -97.6699, tz: "America/Chicago" },
  { name: "TPA",  lat: 27.9755, lon: -82.5332, tz: "America/New_York" },
  { name: "SJC",  lat: 37.3639, lon: -121.9289, tz: "America/Los_Angeles" },
  { name: "CMH",  lat: 39.9980, lon: -82.8919, tz: "America/New_York" },
  { name: "CLT",  lat: 35.2140, lon: -80.9431, tz: "America/New_York" },
  { name: "IND",  lat: 39.7173, lon: -86.2944, tz: "America/Indiana/Indianapolis" },
  { name: "SEA",  lat: 47.4502, lon: -122.3088, tz: "America/Los_Angeles" },
  { name: "DEN",  lat: 39.8617, lon: -104.6731, tz: "America/Denver" },
  { name: "DCA",  lat: 38.8512, lon: -77.0402, tz: "America/New_York" },
  { name: "BOS",  lat: 42.3656, lon: -71.0096, tz: "America/New_York" }
];

const MODELS = [
  "gfs_seamless", "ecmwf_ifs025", "icon_seamless", "gem_seamless",
  "jma_seamless", "ukmo_seamless", "meteofrance_seamless"
];
const LOOKBACK_DAYS = 365;

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

async function fetchModel(city, start, end, model) {
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${isoDate(start)}&end_date=${isoDate(end)}`
    + `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=UTC&models=${model}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return await r.json();
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
