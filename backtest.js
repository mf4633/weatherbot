// Backtest the weatherbot prediction model against historical data.
//
// For each (city, day, hour) tuple in the lookback window:
//   1. "Forecast issued at start-of-day" = open-meteo historical forecast run.
//   2. Obs-up-to-hour-H = open-meteo ERA5 reanalysis hourly temps.
//   3. Run the model -> predicted day's max + σ.
//   4. Compare to actual day's max.
//
// Iterate over model parameters; report RMSE, MAE, bias, 68%/95% CI coverage.

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

const LOOKBACK_DAYS = 30;
const PREDICTION_HOURS = [6, 9, 12, 15]; // local hours at which we predict

function cToF(c) { return c * 9 / 5 + 32; }

function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(d.getTime() + n * 24 * 3600 * 1000); }

// Find the local hour-of-day (0-23) corresponding to a UTC ISO timestamp,
// for the given IANA timezone. Returns hour (numeric).
function localHour(isoUtc, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
  return parseInt(fmt.format(new Date(isoUtc)), 10);
}

function localDateStr(isoUtc, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  });
  return fmt.format(new Date(isoUtc)); // YYYY-MM-DD
}

async function fetchObservations(city, startDate, endDate) {
  // ERA5 reanalysis hourly temperature.
  const url = `https://archive-api.open-meteo.com/v1/archive`
    + `?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${isoDate(startDate)}&end_date=${isoDate(endDate)}`
    + `&hourly=temperature_2m`
    + `&temperature_unit=fahrenheit`
    + `&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`obs fetch failed ${r.status}: ${await r.text()}`);
  const j = await r.json();
  // Returns { hourly: { time: [iso], temperature_2m: [f] } }
  const times = j.hourly.time;       // "2026-04-01T00:00"
  const temps = j.hourly.temperature_2m;
  return times.map((t, i) => ({ ts: t + "Z", tempF: temps[i] }));
}

async function fetchHistoricalForecasts(city, startDate, endDate) {
  // Historical Forecast API: archived forecast runs (we get hourly forecast values
  // valid at each hour; "the forecast" returned was issued at the start of each forecast window).
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast`
    + `?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${isoDate(startDate)}&end_date=${isoDate(endDate)}`
    + `&hourly=temperature_2m`
    + `&temperature_unit=fahrenheit`
    + `&timezone=UTC`
    + `&models=gfs_seamless`;  // GFS is closest analog to NWS forecast
  const r = await fetch(url);
  if (!r.ok) throw new Error(`forecast fetch failed ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const times = j.hourly.time;
  const temps = j.hourly.temperature_2m;
  return times.map((t, i) => ({ ts: t + "Z", tempF: temps[i] }));
}

// Group observations by local date.
function groupByLocalDate(obs, tz) {
  const groups = {};
  for (const o of obs) {
    const d = localDateStr(o.ts, tz);
    if (!groups[d]) groups[d] = [];
    groups[d].push({ ...o, localHr: localHour(o.ts, tz) });
  }
  return groups;
}

// The MODEL UNDER TEST. Same logic as the deployed function but parameterized.
// Returns { mean, std }.
function modelPredict(params, ctx) {
  const { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow } = ctx;
  if (forecastHigh == null && maxSoFar == null) return null;

  if (hrsToPeak <= 0.25) {
    return { mean: maxSoFar ?? forecastHigh, std: params.stdRealized };
  }
  if (forecastHigh == null) {
    const mean = (maxSoFar ?? currentTemp) + Math.min(hrsToPeak, 6) * params.warmRate;
    return { mean, std: params.stdPersistence };
  }
  if (maxSoFar == null) {
    return { mean: forecastHigh, std: params.stdForecastOnly };
  }
  const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
  const corrected = forecastHigh + params.biasWeight * bias;
  const mean = Math.max(maxSoFar, corrected);
  const biasMag = Math.abs(bias);
  const std = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToPeak + params.stdBiasCoef * biasMag);
  return { mean, std };
}

// For one city × day, simulate predictions at each PREDICTION_HOURS step and score.
function backTestDay(params, dayObs, dayForecast, tz) {
  // dayObs: hourly obs for this local day, sorted by ts
  // dayForecast: hourly forecast values for this local day
  if (dayObs.length < 12) return [];
  const actualMax = Math.max(...dayObs.map(o => o.tempF));
  const forecastHigh = dayForecast.length ? Math.max(...dayForecast.map(o => o.tempF)) : null;
  const peakHour = dayObs.find(o => o.tempF === actualMax)?.localHr ?? 15;

  const results = [];
  for (const predHr of PREDICTION_HOURS) {
    const obsThusFar = dayObs.filter(o => o.localHr <= predHr);
    if (!obsThusFar.length) continue;
    const maxSoFar = Math.max(...obsThusFar.map(o => o.tempF));
    const currentTemp = obsThusFar[obsThusFar.length - 1].tempF;
    // Forecast value at the current local hour: align local hour, not UTC.
    const fcAtNow = dayForecast.find(f => localHour(f.ts, tz) === predHr);
    const forecastNow = fcAtNow ? fcAtNow.tempF : null;
    const hrsToPeak = Math.max(0, peakHour - predHr);

    const pred = modelPredict(params, { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow });
    if (!pred) continue;
    results.push({
      predHr,
      hrsToPeak,
      pred: pred.mean,
      std: pred.std,
      actual: actualMax,
      err: pred.mean - actualMax,
      in68: Math.abs(pred.mean - actualMax) <= pred.std,
      in95: Math.abs(pred.mean - actualMax) <= 1.96 * pred.std
    });
  }
  return results;
}

function summarize(results, label) {
  if (!results.length) return { label, n: 0 };
  const errs = results.map(r => r.err);
  const sqErrs = errs.map(e => e * e);
  const rmse = Math.sqrt(sqErrs.reduce((a, b) => a + b, 0) / results.length);
  const mae = errs.map(Math.abs).reduce((a, b) => a + b, 0) / results.length;
  const bias = errs.reduce((a, b) => a + b, 0) / results.length;
  const cov68 = results.filter(r => r.in68).length / results.length;
  const cov95 = results.filter(r => r.in95).length / results.length;
  const meanStd = results.reduce((a, r) => a + r.std, 0) / results.length;
  return { label, n: results.length, rmse, mae, bias, cov68, cov95, meanStd };
}

function summarizeByLead(results) {
  const byHr = {};
  for (const r of results) {
    const k = `${r.predHr}h_local`;
    if (!byHr[k]) byHr[k] = [];
    byHr[k].push(r);
  }
  return Object.entries(byHr).map(([k, rs]) => summarize(rs, k));
}

function summarizeByCity(results) {
  const byCity = {};
  for (const r of results) {
    if (!byCity[r.city]) byCity[r.city] = [];
    byCity[r.city].push(r);
  }
  return Object.entries(byCity).map(([k, rs]) => summarize(rs, k));
}

async function main() {
  const today = new Date();
  const start = addDays(today, -LOOKBACK_DAYS);
  const end = addDays(today, -1);

  console.log(`Backtest window: ${isoDate(start)} → ${isoDate(end)}`);
  console.log(`Cities: ${CITIES.map(c => c.name).join(", ")}\n`);

  // Fetch all data first.
  const cityData = [];
  for (const city of CITIES) {
    process.stdout.write(`Fetching ${city.name}... `);
    const [obs, fc] = await Promise.all([
      fetchObservations(city, start, end),
      fetchHistoricalForecasts(city, start, end)
    ]);
    const obsByDay = groupByLocalDate(obs, city.tz);
    const fcByDay = groupByLocalDate(fc, city.tz);
    cityData.push({ city, obsByDay, fcByDay });
    console.log(`${Object.keys(obsByDay).length} days obs, ${Object.keys(fcByDay).length} days fc`);
  }

  // Re-validate tuned params on full 20-city set; sweep biasW around the prior optimum.
  const tunedSigma = { stdMin: 0.4, stdBase: 0.6, stdLeadCoef: 0.15, stdBiasCoef: 0.10,
                       stdRealized: 0.5, stdPersistence: 4.5, stdForecastOnly: 3.0 };
  const paramSets = [
    { label: "deployed (biasW=0.4)", biasWeight: 0.4, warmRate: 1.0, ...tunedSigma },
    { label: "biasW=0.3",            biasWeight: 0.3, warmRate: 1.0, ...tunedSigma },
    { label: "biasW=0.5",            biasWeight: 0.5, warmRate: 1.0, ...tunedSigma },
    { label: "biasW=0.0 (forecast)", biasWeight: 0.0, warmRate: 1.0, ...tunedSigma },
  ];

  for (const params of paramSets) {
    const allResults = [];
    for (const { city, obsByDay, fcByDay } of cityData) {
      for (const [date, dayObs] of Object.entries(obsByDay)) {
        const dayFc = fcByDay[date] || [];
        const r = backTestDay(params, dayObs, dayFc, city.tz);
        for (const x of r) x.city = city.name;
        allResults.push(...r);
      }
    }
    const s = summarize(allResults, params.label);
    console.log(`\n=== ${params.label} (biasWeight=${params.biasWeight}) ===`);
    console.log(`  n=${s.n}  RMSE=${s.rmse.toFixed(2)}°F  MAE=${s.mae.toFixed(2)}°F  bias=${s.bias.toFixed(2)}°F`);
    console.log(`  σ̄=${s.meanStd.toFixed(2)}°F  68%CI cov=${(s.cov68*100).toFixed(1)}%  95%CI cov=${(s.cov95*100).toFixed(1)}%`);
    console.log(`  by lead time:`);
    for (const sub of summarizeByLead(allResults)) {
      console.log(`    ${sub.label.padEnd(12)} n=${sub.n}  RMSE=${sub.rmse.toFixed(2)}  MAE=${sub.mae.toFixed(2)}  68%=${(sub.cov68*100).toFixed(0)}%  95%=${(sub.cov95*100).toFixed(0)}%`);
    }
    if (params.label.includes("deployed")) {
      console.log(`  by city:`);
      const cityResults = summarizeByCity(allResults).sort((a, b) => b.rmse - a.rmse);
      for (const sub of cityResults) {
        console.log(`    ${sub.label.padEnd(6)} n=${sub.n}  RMSE=${sub.rmse.toFixed(2)}  MAE=${sub.mae.toFixed(2)}  bias=${sub.bias.toFixed(2)}  68%=${(sub.cov68*100).toFixed(0)}%`);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
