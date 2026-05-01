// Fetch ERA5 reanalysis at 8 directional neighbors (~30 km offset) per city, 1 year.
// 20 cities × (1 center + 8 neighbors) = 180 calls. ~3-5 min total.

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

// 8 compass-direction neighbors. ~0.3° offset ≈ 30 km at midlatitudes.
const NEIGHBORS = [
  { dir: "N",  dlat: +0.3,  dlon:  0    },
  { dir: "NE", dlat: +0.21, dlon: +0.21 },
  { dir: "E",  dlat:  0,    dlon: +0.3  },
  { dir: "SE", dlat: -0.21, dlon: +0.21 },
  { dir: "S",  dlat: -0.3,  dlon:  0    },
  { dir: "SW", dlat: -0.21, dlon: -0.21 },
  { dir: "W",  dlat:  0,    dlon: -0.3  },
  { dir: "NW", dlat: +0.21, dlon: -0.21 }
];

const LOOKBACK_DAYS = 365;
const isoDate = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 24 * 3600 * 1000);

async function fetchPoint(lat, lon, start, end) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}`
    + `&start_date=${isoDate(start)}&end_date=${isoDate(end)}`
    + `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  return await r.json();
}

const today = new Date();
const start = addDays(today, -LOOKBACK_DAYS);
const end = addDays(today, -1);
const data = { window: { start: isoDate(start), end: isoDate(end) }, cities: {} };

console.log(`Fetching ${CITIES.length} cities × 9 points (1 center + 8 neighbors), ${isoDate(start)} → ${isoDate(end)}`);
for (const city of CITIES) {
  process.stdout.write(`  ${city.name}: center `);
  const center = await fetchPoint(city.lat, city.lon, start, end);
  const neighbors = {};
  for (const n of NEIGHBORS) {
    process.stdout.write(`${n.dir} `);
    const nLat = Math.round((city.lat + n.dlat) * 10000) / 10000;
    const nLon = Math.round((city.lon + n.dlon) * 10000) / 10000;
    const data_n = await fetchPoint(nLat, nLon, start, end);
    neighbors[n.dir] = { lat: nLat, lon: nLon, temps: data_n.hourly.temperature_2m };
  }
  data.cities[city.name] = {
    meta: city,
    times: center.hourly.time,
    center: center.hourly.temperature_2m,
    neighbors
  };
  console.log("done");
}

writeFileSync("data_neighbors.json", JSON.stringify(data));
console.log(`\nSaved data_neighbors.json (${(JSON.stringify(data).length / 1024 / 1024).toFixed(1)} MB)`);
