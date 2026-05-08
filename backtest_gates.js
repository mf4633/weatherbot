// Backtest today's gates (tail-obs-floor + bucket-above-obs) against historical
// settled bets from jackson_settled_bets blob. Run with:
//   node backtest_gates.js [/path/to/all_settled.ndjson]
//
// For each LOW-side bet, fetch decision-time minSoFar from Open-Meteo archive
// (hourly temps from local midnight to placedAtUTC), then apply each gate's
// would-skip predicate. Tally:
//   - true positives  : gate would skip + bet lost   (gate would have saved us)
//   - false positives : gate would skip + bet won    (gate would have cost us)
//   - missed bads     : gate would NOT skip + bet lost (gate didn't help)
//   - correct allows  : gate would NOT skip + bet won (gate didn't get in the way)
//
// Net P&L impact = sum(realized_pnl of true positives) − sum(realized_pnl of false positives)
// (negative TP pnl means losses recouped; positive FP pnl means wins forgone).

import { readFileSync } from "node:fs";

const NDJSON_PATH = process.argv[2] || "/tmp/all_settled.ndjson";

const CITY_TZ = {
  "New York": "America/New_York", "Los Angeles": "America/Los_Angeles",
  "Chicago": "America/Chicago", "Houston": "America/Chicago",
  "Phoenix": "America/Phoenix", "Philadelphia": "America/New_York",
  "San Antonio": "America/Chicago", "Dallas-Fort Worth": "America/Chicago",
  "Austin": "America/Chicago", "Seattle": "America/Los_Angeles",
  "Denver": "America/Denver", "Miami": "America/New_York",
  "Boston": "America/New_York"
};
const CITY_LATLON = {
  "New York": [40.7789, -73.9692], "Los Angeles": [33.9425, -118.4081],
  "Chicago": [41.7860, -87.7524], "Houston": [29.6454, -95.2769],
  "Phoenix": [33.4342, -112.0116], "Philadelphia": [39.8729, -75.2437],
  "San Antonio": [29.5337, -98.4698], "Dallas-Fort Worth": [32.8998, -97.0403],
  "Austin": [30.1945, -97.6699], "Seattle": [47.4502, -122.3088],
  "Denver": [39.8617, -104.6731], "Miami": [25.7917, -80.2906],
  "Boston": [42.3656, -71.0096]
};

// ---- gate functions: copy of jackson_trader.js logic ----
const BUCKET_TAIL_OBS_GAP_MAX_F = 1.5;
const BUCKET_ABOVE_OBS_GAP_MAX_F = 0.4;

function tailBucketObsGap(b, weatherCity) {
  const side = b.side?.toLowerCase();
  if (side !== "yes" && side !== "no") return null;
  const code = b.ticker?.split("-").pop();
  if (!code || !code.startsWith("T")) return null;
  const N = parseInt(code.slice(1), 10);
  if (!Number.isFinite(N)) return null;
  if (b.variable === "low") {
    const m = weatherCity?.minSoFar;
    if (m == null) return null;
    const boundary = N - 0.5;
    if (side === "yes") {
      const gapF = Math.max(0, m - boundary);
      return { variable: "low", side: "yes", obs: m, boundary, gapF };
    }
    const safetyMargin = m - boundary;
    return { variable: "low", side: "no", obs: m, boundary, safetyMargin };
  }
  if (b.variable === "high") {
    const m = weatherCity?.maxSoFar;
    if (m == null) return null;
    const boundary = N + 0.5;
    if (side === "yes") {
      const gapF = Math.max(0, boundary - m);
      return { variable: "high", side: "yes", obs: m, boundary, gapF };
    }
    const safetyMargin = boundary - m;
    return { variable: "high", side: "no", obs: m, boundary, safetyMargin };
  }
  return null;
}

function bucketAboveObsGap(b, weatherCity) {
  const side = b.side?.toLowerCase();
  if (side !== "yes" || b.variable !== "low") return null;
  const code = b.ticker?.split("-").pop();
  if (!code || !code.startsWith("B")) return null;
  const v = parseFloat(code.slice(1));
  if (!Number.isFinite(v)) return null;
  const N = Math.floor(v);
  const m = weatherCity?.minSoFar;
  if (m == null) return null;
  if (m < N + 1.5) return null;
  return { variable: "low", side: "yes", obs: m, boundary: N + 1.5, gapF: m - (N + 1.5) };
}

// ---- Open-Meteo archive fetch ----
async function fetchHourlyObs(lat, lon, dateStr) {
  const url = `https://archive-api.open-meteo.com/v1/archive`
    + `?latitude=${lat}&longitude=${lon}`
    + `&start_date=${dateStr}&end_date=${dateStr}`
    + `&hourly=temperature_2m`
    + `&temperature_unit=fahrenheit`
    + `&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  return (j.hourly?.time || []).map((t, i) => ({ ts: t + "Z", tempF: j.hourly.temperature_2m[i] }));
}

function localDateAndMidnight(isoUtc, tz) {
  // Day in local tz of `isoUtc`, plus the UTC instant of that local midnight.
  const d = new Date(isoUtc);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  });
  const localDate = fmt.format(d);
  // Walk back hour-by-hour to find the UTC instant where local-date matches.
  let lo = d;
  for (let h = 0; h < 30; h++) {
    const t = new Date(d.getTime() - h * 3600 * 1000);
    if (fmt.format(t) === localDate) lo = t;
    else break;
  }
  return { localDate, midnightUtc: lo };
}

async function reconstructMinMaxSoFar(bet) {
  const tz = CITY_TZ[bet.city];
  const ll = CITY_LATLON[bet.city];
  if (!tz || !ll) return null;
  const { localDate, midnightUtc } = localDateAndMidnight(bet.placedAtUTC, tz);
  const obs = await fetchHourlyObs(ll[0], ll[1], localDate);
  if (!obs) return null;
  const placedMs = new Date(bet.placedAtUTC).getTime();
  const filtered = obs.filter(o => {
    const t = new Date(o.ts).getTime();
    return t >= midnightUtc.getTime() && t <= placedMs && Number.isFinite(o.tempF);
  });
  if (filtered.length === 0) return null;
  return {
    minSoFar: Math.min(...filtered.map(x => x.tempF)),
    maxSoFar: Math.max(...filtered.map(x => x.tempF)),
    n: filtered.length
  };
}

// ---- Main ----
const lines = readFileSync(NDJSON_PATH, "utf-8").trim().split(/\r?\n/);
const bets = lines.map(l => JSON.parse(l));
console.log(`Loaded ${bets.length} settled bets.`);
console.log(`  by outcome:`, Object.entries(
  bets.reduce((a, b) => ((a[b.outcome] = (a[b.outcome] || 0) + 1), a), {})
));
console.log(`  by variable:`, Object.entries(
  bets.reduce((a, b) => ((a[b.variable] = (a[b.variable] || 0) + 1), a), {})
));
const totalPnl = bets.reduce((a, b) => a + (b.realized_pnl ?? 0), 0);
console.log(`  total realized P&L: $${totalPnl.toFixed(2)}`);

const candidates = bets.filter(b =>
  b.variable === "low" && b.side === "YES" && b.outcome !== "SOLD"
);
console.log(`\nLOW-YES bets eligible for gate replay: ${candidates.length}`);

const results = { tailHits: [], bucketHits: [], untouched: [] };
let i = 0;
for (const bet of candidates) {
  i++;
  process.stdout.write(`\r[${i}/${candidates.length}] reconstructing ${bet.city} ${bet.ticker}...   `);
  const obs = await reconstructMinMaxSoFar(bet);
  if (!obs) { results.untouched.push({ ...bet, reason: "no-obs" }); continue; }
  const enriched = { ...bet, weatherCity: obs };

  const tailGap = tailBucketObsGap(bet, obs);
  if (tailGap && tailGap.side === "yes" && tailGap.gapF > BUCKET_TAIL_OBS_GAP_MAX_F) {
    results.tailHits.push({ ...enriched, gapF: tailGap.gapF, kind: "tail-obs-floor" });
    continue;
  }
  if (tailGap && tailGap.side === "no" && tailGap.safetyMargin < BUCKET_TAIL_OBS_GAP_MAX_F) {
    results.tailHits.push({ ...enriched, safetyMarginF: tailGap.safetyMargin, kind: "tail-obs-ceiling" });
    continue;
  }
  const bucketGap = bucketAboveObsGap(bet, obs);
  if (bucketGap && bucketGap.gapF > BUCKET_ABOVE_OBS_GAP_MAX_F) {
    results.bucketHits.push({ ...enriched, gapF: bucketGap.gapF, kind: "bucket-above-obs" });
    continue;
  }
  results.untouched.push(enriched);
}
console.log("");

function summarize(label, hits) {
  const losses = hits.filter(h => h.outcome === "LOSS");
  const wins = hits.filter(h => h.outcome === "WIN");
  const lossPnl = losses.reduce((a, b) => a + (b.realized_pnl || 0), 0);
  const winPnl = wins.reduce((a, b) => a + (b.realized_pnl || 0), 0);
  console.log(`\n--- ${label} ---`);
  console.log(`  Bets gated: ${hits.length}  (${losses.length} losses, ${wins.length} wins)`);
  console.log(`  Loss P&L recouped: $${(-lossPnl).toFixed(2)}`);
  console.log(`  Win P&L forgone:   $${winPnl.toFixed(2)}`);
  console.log(`  Net impact:        $${(-lossPnl - winPnl).toFixed(2)}`);
  for (const h of hits) {
    console.log(`    ${h.outcome === "LOSS" ? "✓" : "✗"} ${h.ticker}  ${h.bucket}  pWin=${h.modelMean ? `μ=${h.modelMean}±${h.modelStd}` : "?"}  m=${h.weatherCity.minSoFar}  gap=${h.gapF.toFixed(2)}°F  pnl=$${h.realized_pnl}`);
  }
}

summarize("TAIL-OBS-FLOOR (T-bucket YES, gap > 1.5°F)", results.tailHits);
summarize("BUCKET-ABOVE-OBS (B-bucket LOW YES, gap > 0.4°F)", results.bucketHits);
const allHits = [...results.tailHits, ...results.bucketHits];
const totalLossRecouped = allHits.filter(h => h.outcome === "LOSS").reduce((a, b) => a - (b.realized_pnl || 0), 0);
const totalWinForgone = allHits.filter(h => h.outcome === "WIN").reduce((a, b) => a + (b.realized_pnl || 0), 0);
console.log(`\n=== TOTAL GATE IMPACT ===`);
console.log(`Loss P&L recouped:  $${totalLossRecouped.toFixed(2)}`);
console.log(`Win P&L forgone:    $${totalWinForgone.toFixed(2)}`);
console.log(`Net P&L improvement: $${(totalLossRecouped - totalWinForgone).toFixed(2)}`);
console.log(`(${results.untouched.length} LOW-YES bets passed through unchanged)`);
