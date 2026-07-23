// Year-long backtest with chronological train/test split and per-city tuning.

import { CITIES } from "../cities.js";

const LOOKBACK_DAYS = 365;
const TEST_DAYS = 90;
const PREDICTION_HOURS = [6, 9, 12, 15];

function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(d.getTime() + n * 24 * 3600 * 1000); }

function localHour(isoUtc, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
  return parseInt(fmt.format(new Date(isoUtc)), 10);
}

function localDateStr(isoUtc, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  });
  return fmt.format(new Date(isoUtc));
}

async function fetchObs(city, start, end) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${isoDate(start)}&end_date=${isoDate(end)}`
    + `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`obs ${r.status}`);
  const j = await r.json();
  return j.hourly.time.map((t, i) => ({ ts: t + "Z", tempF: j.hourly.temperature_2m[i] }));
}

async function fetchFc(city, start, end) {
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${isoDate(start)}&end_date=${isoDate(end)}`
    + `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=UTC&models=gfs_seamless`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fc ${r.status}`);
  const j = await r.json();
  return j.hourly.time.map((t, i) => ({ ts: t + "Z", tempF: j.hourly.temperature_2m[i] }));
}

function groupByLocalDate(arr, tz) {
  const g = {};
  for (const x of arr) {
    const d = localDateStr(x.ts, tz);
    if (!g[d]) g[d] = [];
    g[d].push({ ...x, localHr: localHour(x.ts, tz) });
  }
  return g;
}

function modelPredict(params, ctx, cityOffsets = null, citySigmaScale = null) {
  const { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow, cityName } = ctx;
  if (forecastHigh == null && maxSoFar == null) return null;

  let mean, std;
  if (hrsToPeak <= 0.25) {
    mean = maxSoFar ?? forecastHigh;
    std = params.stdRealized;
  } else if (forecastHigh == null) {
    mean = (maxSoFar ?? currentTemp) + Math.min(hrsToPeak, 6) * params.warmRate;
    std = params.stdPersistence;
  } else if (maxSoFar == null) {
    mean = forecastHigh;
    std = params.stdForecastOnly;
  } else {
    const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
    const corrected = forecastHigh + params.biasWeight * bias;
    mean = Math.max(maxSoFar, corrected);
    const biasMag = Math.abs(bias);
    std = Math.max(params.stdMin, params.stdBase + params.stdLeadCoef * hrsToPeak + params.stdBiasCoef * biasMag);
  }

  // Per-city correction (trained on train set, applied to all predictions).
  if (cityOffsets && cityOffsets[cityName] != null) mean -= cityOffsets[cityName]; // subtract systematic bias
  if (citySigmaScale && citySigmaScale[cityName] != null) std *= citySigmaScale[cityName];

  return { mean, std };
}

function backTestDay(params, dayObs, dayFc, tz, cityName, cityOffsets, citySigmaScale) {
  if (dayObs.length < 12) return [];
  const actualMax = Math.max(...dayObs.map(o => o.tempF));
  const forecastHigh = dayFc.length ? Math.max(...dayFc.map(o => o.tempF)) : null;
  const peakHour = dayObs.find(o => o.tempF === actualMax)?.localHr ?? 15;

  const out = [];
  for (const predHr of PREDICTION_HOURS) {
    const obs = dayObs.filter(o => o.localHr <= predHr);
    if (!obs.length) continue;
    const maxSoFar = Math.max(...obs.map(o => o.tempF));
    const currentTemp = obs[obs.length - 1].tempF;
    const fc = dayFc.find(f => localHour(f.ts, tz) === predHr);
    const forecastNow = fc ? fc.tempF : null;
    const hrsToPeak = Math.max(0, peakHour - predHr);
    const pred = modelPredict(params, { hrsToPeak, maxSoFar, currentTemp, forecastHigh, forecastNow, cityName },
                              cityOffsets, citySigmaScale);
    if (!pred) continue;
    out.push({
      city: cityName, predHr, hrsToPeak,
      pred: pred.mean, std: pred.std, actual: actualMax,
      err: pred.mean - actualMax,
      in68: Math.abs(pred.mean - actualMax) <= pred.std,
      in95: Math.abs(pred.mean - actualMax) <= 1.96 * pred.std
    });
  }
  return out;
}

function summarize(results, label) {
  if (!results.length) return { label, n: 0 };
  const errs = results.map(r => r.err);
  const sq = errs.map(e => e * e);
  return {
    label, n: results.length,
    rmse: Math.sqrt(sq.reduce((a, b) => a + b, 0) / results.length),
    mae: errs.map(Math.abs).reduce((a, b) => a + b, 0) / results.length,
    bias: errs.reduce((a, b) => a + b, 0) / results.length,
    cov68: results.filter(r => r.in68).length / results.length,
    cov95: results.filter(r => r.in95).length / results.length,
    meanStd: results.reduce((a, r) => a + r.std, 0) / results.length
  };
}

function summarizeBy(results, key) {
  const groups = {};
  for (const r of results) {
    const k = r[key];
    if (!groups[k]) groups[k] = [];
    groups[k].push(r);
  }
  return Object.entries(groups).map(([k, rs]) => summarize(rs, k));
}

// Run full backtest with given params (and optional per-city corrections).
function runBacktest(cityData, params, dateFilter, cityOffsets, citySigmaScale) {
  const all = [];
  for (const { city, obsByDay, fcByDay } of cityData) {
    for (const [date, obs] of Object.entries(obsByDay)) {
      if (!dateFilter(date)) continue;
      const fc = fcByDay[date] || [];
      const r = backTestDay(params, obs, fc, city.tz, city.name, cityOffsets, citySigmaScale);
      all.push(...r);
    }
  }
  return all;
}

// Compute per-city offset (mean error) and σ-scale (RMSE/σ̄) from a results set.
function fitCityCorrections(results) {
  const offsets = {};
  const sigmaScale = {};
  for (const sub of summarizeBy(results, "city")) {
    offsets[sub.label] = sub.bias;
    sigmaScale[sub.label] = sub.rmse / sub.meanStd;
  }
  return { offsets, sigmaScale };
}

async function main() {
  const today = new Date();
  const start = addDays(today, -LOOKBACK_DAYS);
  const end = addDays(today, -1);
  const trainEnd = addDays(today, -TEST_DAYS - 1); // train = first (LOOKBACK - TEST) days

  console.log(`Window: ${isoDate(start)} → ${isoDate(end)}`);
  console.log(`Train:  ${isoDate(start)} → ${isoDate(trainEnd)}`);
  console.log(`Test:   ${isoDate(addDays(trainEnd, 1))} → ${isoDate(end)}\n`);

  const cityData = [];
  for (const city of CITIES) {
    process.stdout.write(`Fetching ${city.name}... `);
    let obs, fc;
    try {
      [obs, fc] = await Promise.all([fetchObs(city, start, end), fetchFc(city, start, end)]);
    } catch (e) {
      console.log(`SKIP (${e.message})`);
      continue;
    }
    cityData.push({ city, obsByDay: groupByLocalDate(obs, city.tz), fcByDay: groupByLocalDate(fc, city.tz) });
    console.log(`${Object.keys(groupByLocalDate(obs, city.tz)).length} days obs / ${Object.keys(groupByLocalDate(fc, city.tz)).length} days fc`);
  }

  const trainEndStr = isoDate(trainEnd);
  const inTrain = (d) => d <= trainEndStr;
  const inTest = (d) => d > trainEndStr;

  // Param grid (focused around prior optimum).
  const paramGrid = [];
  for (const bw of [0.0, 0.2, 0.3, 0.4, 0.5, 0.6]) {
    for (const sb of [0.5, 0.7, 0.9, 1.1]) {
      for (const sl of [0.10, 0.15, 0.20]) {
        paramGrid.push({
          biasWeight: bw, warmRate: 1.0,
          stdMin: 0.4, stdBase: sb, stdLeadCoef: sl, stdBiasCoef: 0.10,
          stdRealized: 0.5, stdPersistence: 4.5, stdForecastOnly: 3.0,
          label: `bw=${bw} σ:base=${sb} lead=${sl}`
        });
      }
    }
  }

  // Step 1: find global params with best train RMSE.
  let bestGlobal = null;
  for (const params of paramGrid) {
    const r = runBacktest(cityData, params, inTrain, null, null);
    const s = summarize(r, params.label);
    const score = s.rmse + 0.3 * Math.abs(s.cov68 - 0.68) * 10 + 0.3 * Math.abs(s.cov95 - 0.95) * 10;
    if (!bestGlobal || score < bestGlobal.score) bestGlobal = { params, score, summary: s };
  }
  console.log(`\n=== Best global params (train) ===`);
  console.log(`  ${bestGlobal.params.label}`);
  console.log(`  TRAIN: n=${bestGlobal.summary.n} RMSE=${bestGlobal.summary.rmse.toFixed(2)} MAE=${bestGlobal.summary.mae.toFixed(2)} bias=${bestGlobal.summary.bias.toFixed(2)} 68%=${(bestGlobal.summary.cov68*100).toFixed(0)}% 95%=${(bestGlobal.summary.cov95*100).toFixed(0)}%`);

  // Step 2: fit per-city offsets + σ scale on train set with best global params.
  const trainResults = runBacktest(cityData, bestGlobal.params, inTrain, null, null);
  const { offsets, sigmaScale } = fitCityCorrections(trainResults);

  // Step 3: evaluate on TEST set, three configurations.
  console.log(`\n=== Held-out TEST evaluation ===`);
  const configs = [
    { label: "global only",                 offsets: null,    sigma: null },
    { label: "global + per-city offset",    offsets: offsets, sigma: null },
    { label: "global + offset + σ-scale",   offsets: offsets, sigma: sigmaScale }
  ];
  for (const cfg of configs) {
    const r = runBacktest(cityData, bestGlobal.params, inTest, cfg.offsets, cfg.sigma);
    const s = summarize(r, cfg.label);
    console.log(`\n  [${cfg.label}]`);
    console.log(`    n=${s.n}  RMSE=${s.rmse.toFixed(2)}°F  MAE=${s.mae.toFixed(2)}°F  bias=${s.bias.toFixed(2)}°F`);
    console.log(`    σ̄=${s.meanStd.toFixed(2)}  68%CI cov=${(s.cov68*100).toFixed(1)}%  95%CI cov=${(s.cov95*100).toFixed(1)}%`);
  }

  // Per-city test breakdown for best config.
  const finalCfg = configs[2];
  const finalResults = runBacktest(cityData, bestGlobal.params, inTest, finalCfg.offsets, finalCfg.sigma);
  console.log(`\n=== Per-city held-out results (with offset + σ-scale) ===`);
  const byCity = summarizeBy(finalResults, "city").sort((a, b) => b.rmse - a.rmse);
  for (const sub of byCity) {
    console.log(`  ${sub.label.padEnd(6)} n=${sub.n}  RMSE=${sub.rmse.toFixed(2)}  MAE=${sub.mae.toFixed(2)}  bias=${sub.bias.toFixed(2)}  68%=${(sub.cov68*100).toFixed(0)}%  95%=${(sub.cov95*100).toFixed(0)}%`);
  }

  // Output the fitted corrections.
  console.log(`\n=== Fitted per-city offsets (subtract from prediction) ===`);
  console.log(JSON.stringify(offsets, null, 2));
  console.log(`\n=== Fitted per-city σ scaling factors ===`);
  console.log(JSON.stringify(sigmaScale, null, 2));
  console.log(`\n=== Best global params ===`);
  console.log(JSON.stringify(bestGlobal.params, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
