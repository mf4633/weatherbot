// Shared 20-city list (name / lat / lon / tz) for the offline fetch + backtest
// scripts. Previously copy-pasted verbatim into fetch_data.js, fetch_clouds.js,
// fetch_neighbors.js, fetch_models.js, backtest.js and backtest_yr.js — a single
// source of truth so the list can't drift between them.
export const CITIES = [
  { name: "NYC",  lat: 40.7789, lon: -73.9692, tz: "America/New_York" },
  { name: "LAX",  lat: 33.9425, lon: -118.4081, tz: "America/Los_Angeles" },
  { name: "MDW",  lat: 41.7860, lon: -87.7524, tz: "America/Chicago" },
  { name: "HOU",  lat: 29.6454, lon: -95.2769, tz: "America/Chicago" },
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
