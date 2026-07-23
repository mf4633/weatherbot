// Replay backtest: simulate Kalshi markets from a naive baseline model, run our trading
// logic against them, compute realized P&L. Answers "does our model edge translate to actual
// betting profit, and where does it come from?"
//
// Setup:
//   - "Market consensus" = single-model GFS forecast (proxy for what a naive bettor / weak
//     algo would price). We add a 2¢ bid-ask spread.
//   - "Our model" = full 5-model ensemble + bias correction + per-city offsets + truncation
//     (current production parameters).
//   - Bucket structure: 7 buckets centered on the GFS forecast (5 between, 2 tail), each 2°F.
//   - Place bets once per day at 12:00 local; settle next day on actual observed max.
//   - Bankroll & sizing follow the production rules ($20 start, max($1, bankroll/20)).

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("data_models.json", "utf-8"));
const TEST_DAYS = 90;
const BANKROLL_START = 20;
const MAX_CONCURRENT = 20;
const MIN_EDGE = 0.28;
const MIN_HALF_KELLY = 0.20;
const MARKET_SPREAD = 0.02;
const PLACE_HR = 12;  // local hour to place bets
const MODELS = data.models.filter(m => !["jma_seamless", "gem_seamless"].includes(m));
const CITY_OFFSETS = {
  "NYC": 0.20, "LAX": 0.12, "ORD": 0.14, "IAH": 0.43, "PHX": 0.07, "PHL": 0.00,
  "SAT": 0.55, "SAN": 0.10, "DFW": 0.20, "JAX": 0.14, "AUS": 0.40, "TPA": 0.32,
  "SJC": -0.49, "CMH": 0.44, "CLT": 0.04, "IND": 0.15, "SEA": 0.01, "DEN": 0.00,
  "DCA": 0.27, "BOS": 0.32
};

const localHour = (iso, tz) => parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(iso)), 10);
const localDateStr = (iso, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x*x/2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function phi(x) { return Math.exp(-x*x/2) / Math.sqrt(2 * Math.PI); }
function truncMean(mu, sigma, a) {
  const alpha = (a - mu) / sigma;
  if (alpha < -4) return mu;
  if (alpha > 8) return a;
  const oneMinusPhi = 1 - normCdf(alpha);
  if (oneMinusPhi < 1e-9) return a;
  return mu + sigma * (phi(alpha) / oneMinusPhi);
}

console.log("Pre-processing...");
const cityProcessed = {};
for (const [name, c] of Object.entries(data.cities)) {
  const tz = c.meta.tz;
  const obsByDay = {};
  for (let i = 0; i < c.obs.times.length; i++) {
    const ts = c.obs.times[i] + "Z";
    (obsByDay[localDateStr(ts, tz)] ??= []).push({ ts, tempF: c.obs.temps[i], localHr: localHour(ts, tz) });
  }
  const fcByModel = {};
  for (const m of MODELS) {
    const md = c.models[m];
    if (!md) continue;
    const byDay = {};
    for (let i = 0; i < md.times.length; i++) {
      const ts = md.times[i] + "Z";
      (byDay[localDateStr(ts, tz)] ??= []).push({ ts, tempF: md.temps[i], localHr: localHour(ts, tz) });
    }
    fcByModel[m] = byDay;
  }
  // Also keep gfs_seamless separately (for "market" consensus).
  const gfsByDay = fcByModel["gfs_seamless"] || {};
  cityProcessed[name] = { meta: c.meta, obsByDay, fcByModel, gfsByDay, tz };
}

// Construct 7 buckets centered on the GFS forecast: T(low) + 5 between + T(high). 2°F-wide.
function makeBuckets(centerForecast) {
  const c = Math.round(centerForecast);
  return [
    { name: `≤${c-5}`,    loInt: -Infinity, hiInt: c-5 },
    { name: `${c-4}-${c-3}`, loInt: c-4, hiInt: c-3 },
    { name: `${c-2}-${c-1}`, loInt: c-2, hiInt: c-1 },
    { name: `${c}-${c+1}`,   loInt: c,   hiInt: c+1 },
    { name: `${c+2}-${c+3}`, loInt: c+2, hiInt: c+3 },
    { name: `${c+4}-${c+5}`, loInt: c+4, hiInt: c+5 },
    { name: `≥${c+6}`,    loInt: c+6, hiInt: Infinity }
  ];
}

function bucketProb(mean, std, loInt, hiInt, lowerFloor = null) {
  let lo = loInt === -Infinity ? -Infinity : loInt - 0.5;
  let hi = hiInt === Infinity ? Infinity : hiInt + 0.5;
  if (lowerFloor != null) {
    if (hi < lowerFloor) return 0;
    if (lo < lowerFloor) lo = lowerFloor;
  }
  const pHi = hi === Infinity ? 1 : normCdf((hi - mean) / std);
  const pLo = lo === -Infinity ? 0 : normCdf((lo - mean) / std);
  return Math.max(0, pHi - pLo);
}

const allDates = Object.keys(cityProcessed.NYC.obsByDay).sort();
const trainEnd = allDates[allDates.length - 1 - TEST_DAYS];
const testDates = allDates.slice(allDates.indexOf(trainEnd) + 1).sort();

// Run replay across the 90-day window.
let bankroll = BANKROLL_START;
const openBets = new Map();  // betId → { city, date, side, loInt, hiInt, price, stake }
const settled = [];

console.log(`Replay TEST: ${testDates.length} days × ${Object.keys(cityProcessed).length} cities`);
console.log(`Bankroll: $${BANKROLL_START}, place at local ${PLACE_HR}:00, settle next day\n`);

let dailyLog = [];
for (const date of testDates) {
  // Settle any bets whose target date is strictly BEFORE today (i.e., yesterday or earlier).
  // Each bet was placed at PLACE_HR local on day D and targets day D's max — so it settles
  // by the time we step to day D+1.
  for (const [betId, bet] of [...openBets.entries()]) {
    if (bet.date >= date) continue;  // not yet ready to settle (still in flight or current-day)
    const actualMax = Math.max(...(cityProcessed[bet.city].obsByDay[bet.date] || []).map(o => o.tempF));
    if (!isFinite(actualMax)) { openBets.delete(betId); continue; }
    const lo = bet.loInt === -Infinity ? -Infinity : bet.loInt;
    const hi = bet.hiInt === Infinity ? Infinity : bet.hiInt;
    const inBucket = actualMax >= lo && actualMax <= hi;
    const won = bet.side === "YES" ? inBucket : !inBucket;
    const pnl = won ? bet.stake * (1 - bet.price) / bet.price : -bet.stake;
    bankroll = Math.round((bankroll + pnl) * 100) / 100;
    settled.push({ ...bet, actualMax, won, pnl });
    openBets.delete(betId);
  }

  // Place new bets at PLACE_HR local on each city's "today" (which is `date`).
  const dayStakeSize = Math.max(1, bankroll / 20);
  const maxConcurrent = Math.min(MAX_CONCURRENT, Math.floor(bankroll / dayStakeSize));
  let openStakeSum = [...openBets.values()].reduce((a, b) => a + b.stake, 0);
  let cashFree = bankroll - openStakeSum;
  let placedToday = 0;

  for (const [cityName, c] of Object.entries(cityProcessed)) {
    if (openBets.size >= maxConcurrent) break;
    const dayObs = c.obsByDay[date] || [];
    if (dayObs.length < 12) continue;

    // Forecasts: GFS (market) and ensemble (us).
    const gfsDay = c.gfsByDay[date] || [];
    if (!gfsDay.length) continue;
    const gfsForecastHigh = Math.max(...gfsDay.map(o => o.tempF));
    const gfsAtPlace = gfsDay.find(f => f.localHr === PLACE_HR)?.tempF;

    // Ensemble forecast (current production).
    const ensemblePeaks = [];
    const ensembleAts = [];
    for (const m of MODELS) {
      const dayFc = c.fcByModel[m]?.[date] || [];
      if (dayFc.length) {
        ensemblePeaks.push(Math.max(...dayFc.map(o => o.tempF)));
        const at = dayFc.find(f => f.localHr === PLACE_HR);
        if (at) ensembleAts.push(at.tempF);
      }
    }
    if (!ensemblePeaks.length) continue;
    const forecastHigh = ensemblePeaks.reduce((a, b) => a + b, 0) / ensemblePeaks.length;
    const forecastNow = ensembleAts.length ? ensembleAts.reduce((a, b) => a + b, 0) / ensembleAts.length : null;

    // Today's obs up to PLACE_HR.
    const obsUpTo = dayObs.filter(o => o.localHr <= PLACE_HR);
    if (!obsUpTo.length) continue;
    const maxSoFar = Math.max(...obsUpTo.map(o => o.tempF));
    const currentTemp = obsUpTo[obsUpTo.length - 1].tempF;
    const bias = (currentTemp != null && forecastNow != null) ? (currentTemp - forecastNow) : 0;
    const hrsToPeak = Math.max(0, 15 - PLACE_HR);

    // Our model prediction: bias-corrected ensemble, truncated at maxSoFar.
    let priorMean = forecastHigh + 0.4 * bias;
    if (CITY_OFFSETS[cityName] != null) priorMean -= CITY_OFFSETS[cityName];
    const ourMean = truncMean(priorMean, Math.max(0.4, 0.7 + 0.08 * hrsToPeak + 0.10 * Math.abs(bias)), maxSoFar);
    const ourStd = Math.max(0.4, 0.7 + 0.08 * hrsToPeak + 0.10 * Math.abs(bias));

    // Market model prediction: naive single-GFS, no bias correction.
    // Market σ wider (no bias info, no calibration): use 2.0.
    const marketMean = gfsForecastHigh;
    const marketStd = 2.0;

    // Buckets centered on market consensus (so they're "fair" in the market's view).
    const buckets = makeBuckets(gfsForecastHigh);

    // Compute market mid-prices and our probabilities.
    const ourProbSum = buckets.reduce((a, b) => a + bucketProb(ourMean, ourStd, b.loInt, b.hiInt, maxSoFar), 0);

    for (const b of buckets) {
      if (openBets.size >= maxConcurrent) break;
      if (cashFree < dayStakeSize) break;

      const marketP = bucketProb(marketMean, marketStd, b.loInt, b.hiInt);
      const yesAsk = Math.min(0.98, Math.max(0.01, marketP + MARKET_SPREAD));
      const noAsk = Math.min(0.98, Math.max(0.01, (1 - marketP) + MARKET_SPREAD));
      const ourP_raw = bucketProb(ourMean, ourStd, b.loInt, b.hiInt, maxSoFar);
      const ourP = ourProbSum > 0 ? ourP_raw / ourProbSum : 0;

      // Try YES.
      const evYes = ourP - yesAsk;
      const kellyYes = (ourP - yesAsk) / (1 - yesAsk);
      if (evYes >= MIN_EDGE && kellyYes / 2 >= MIN_HALF_KELLY && yesAsk < 0.95) {
        const betId = `${cityName}-${date}-${b.name}-YES`;
        if (!openBets.has(betId)) {
          openBets.set(betId, { city: cityName, date, side: "YES", loInt: b.loInt, hiInt: b.hiInt,
                                price: yesAsk, stake: dayStakeSize, ourP, ev: evYes });
          openStakeSum += dayStakeSize;
          cashFree -= dayStakeSize;
          placedToday++;
          continue;
        }
      }
      // Try NO.
      const ourPno = 1 - ourP;
      const evNo = ourPno - noAsk;
      const kellyNo = (ourPno - noAsk) / (1 - noAsk);
      if (evNo >= MIN_EDGE && kellyNo / 2 >= MIN_HALF_KELLY && noAsk < 0.95) {
        const betId = `${cityName}-${date}-${b.name}-NO`;
        if (!openBets.has(betId)) {
          openBets.set(betId, { city: cityName, date, side: "NO", loInt: b.loInt, hiInt: b.hiInt,
                                price: noAsk, stake: dayStakeSize, ourP: ourPno, ev: evNo });
          openStakeSum += dayStakeSize;
          cashFree -= dayStakeSize;
          placedToday++;
        }
      }
    }
  }

  dailyLog.push({ date, bankroll: Math.round(bankroll * 100) / 100, placed: placedToday, openCount: openBets.size });
}

// Final summary.
const wins = settled.filter(s => s.won);
const losses = settled.filter(s => !s.won);
const totalStaked = settled.reduce((a, b) => a + b.stake, 0);
const totalPnl = settled.reduce((a, b) => a + b.pnl, 0);
const winRate = settled.length ? wins.length / settled.length : 0;
const roi = totalStaked ? totalPnl / totalStaked : 0;

console.log("=".repeat(60));
console.log(`REPLAY RESULTS (${TEST_DAYS}-day held-out backtest)`);
console.log("=".repeat(60));
console.log(`Total bets:    ${settled.length}`);
console.log(`Wins:          ${wins.length} (${(winRate*100).toFixed(1)}%)`);
console.log(`Losses:        ${losses.length}`);
console.log(`Total staked:  $${totalStaked.toFixed(2)}`);
console.log(`Total P&L:     $${totalPnl.toFixed(2)}  (${(roi*100).toFixed(1)}% ROI)`);
console.log(`Final bankroll: $${bankroll.toFixed(2)}  (started $${BANKROLL_START}, ${((bankroll-BANKROLL_START)/BANKROLL_START*100).toFixed(1)}%)`);

// Per-city breakdown.
console.log("\n=== Per-city ===");
const byCity = {};
for (const s of settled) {
  if (!byCity[s.city]) byCity[s.city] = { n: 0, wins: 0, staked: 0, pnl: 0 };
  byCity[s.city].n += 1;
  if (s.won) byCity[s.city].wins += 1;
  byCity[s.city].staked += s.stake;
  byCity[s.city].pnl += s.pnl;
}
const cityRows = Object.entries(byCity).map(([city, c]) => ({
  city, ...c,
  winRate: c.wins / c.n,
  roi: c.pnl / c.staked
})).sort((a, b) => b.pnl - a.pnl);
console.log(`  ${'city'.padEnd(6)} ${'n'.padStart(4)} ${'wins'.padStart(5)} ${'win%'.padStart(6)} ${'staked'.padStart(8)} ${'pnl'.padStart(8)} ${'roi'.padStart(7)}`);
for (const r of cityRows) {
  console.log(`  ${r.city.padEnd(6)} ${r.n.toString().padStart(4)} ${r.wins.toString().padStart(5)} ${(r.winRate*100).toFixed(1).padStart(5)}% $${r.staked.toFixed(2).padStart(7)} $${r.pnl.toFixed(2).padStart(7)} ${(r.roi*100).toFixed(1).padStart(6)}%`);
}

// Edge calibration: bin bets by predicted edge, see realized return.
console.log("\n=== Edge calibration (do +5¢ edges actually return ~5¢?) ===");
const buckets_edge = [
  { range: "5-10¢",  min: 0.05, max: 0.10 },
  { range: "10-20¢", min: 0.10, max: 0.20 },
  { range: "20-30¢", min: 0.20, max: 0.30 },
  { range: "30-50¢", min: 0.30, max: 0.50 },
  { range: "50¢+",   min: 0.50, max: Infinity }
];
for (const eb of buckets_edge) {
  const subset = settled.filter(s => s.ev >= eb.min && s.ev < eb.max);
  if (subset.length === 0) continue;
  const subPnl = subset.reduce((a, b) => a + b.pnl, 0);
  const subStaked = subset.reduce((a, b) => a + b.stake, 0);
  const subRoi = subStaked ? subPnl / subStaked : 0;
  console.log(`  edge ${eb.range.padEnd(8)} n=${subset.length.toString().padStart(4)}  realized ROI = ${(subRoi*100).toFixed(1)}%  (expected ≈${(((eb.min+Math.min(eb.max,1))/2)*100).toFixed(0)}%)`);
}

// Bankroll trajectory.
console.log("\n=== Bankroll trajectory (every ~10 days) ===");
for (let i = 0; i < dailyLog.length; i += Math.max(1, Math.floor(dailyLog.length / 10))) {
  const d = dailyLog[i];
  console.log(`  ${d.date}  bankroll=$${d.bankroll.toFixed(2)}  open=${d.openCount}  placed-this-day=${d.placed}`);
}
const last = dailyLog[dailyLog.length - 1];
console.log(`  ${last.date}  bankroll=$${last.bankroll.toFixed(2)} (final)`);




