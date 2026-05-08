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

const candidates = bets.filter(b => b.outcome !== "SOLD");
console.log(`\nBets eligible for gate replay: ${candidates.length}`);

const results = { tailYesHits: [], tailNoHits: [], bucketHits: [], untouched: [] };
let i = 0;
for (const bet of candidates) {
  i++;
  process.stdout.write(`\r[${i}/${candidates.length}] reconstructing ${bet.city} ${bet.ticker}...   `);
  const obs = await reconstructMinMaxSoFar(bet);
  if (!obs) { results.untouched.push({ ...bet, reason: "no-obs" }); continue; }
  const enriched = { ...bet, weatherCity: obs };

  const tailGap = tailBucketObsGap(bet, obs);
  if (tailGap && tailGap.side === "yes" && tailGap.gapF > BUCKET_TAIL_OBS_GAP_MAX_F) {
    results.tailYesHits.push({ ...enriched, gapF: tailGap.gapF, obs: tailGap.obs, kind: "tail-obs-floor" });
    continue;
  }
  if (tailGap && tailGap.side === "no" && tailGap.safetyMargin < BUCKET_TAIL_OBS_GAP_MAX_F) {
    results.tailNoHits.push({ ...enriched, safetyMarginF: tailGap.safetyMargin, obs: tailGap.obs, kind: "tail-obs-ceiling" });
    continue;
  }
  const bucketGap = bucketAboveObsGap(bet, obs);
  if (bucketGap && bucketGap.gapF > BUCKET_ABOVE_OBS_GAP_MAX_F) {
    results.bucketHits.push({ ...enriched, gapF: bucketGap.gapF, obs: bucketGap.obs, kind: "bucket-above-obs" });
    continue;
  }
  results.untouched.push(enriched);
}
console.log("");

function summarize(label, hits, gapField) {
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
    const v = h[gapField];
    console.log(`    ${h.outcome === "LOSS" ? "✓" : "✗"} ${h.ticker} ${h.variable}/${h.side} μ=${h.modelMean}±${h.modelStd} obs=${h.obs?.toFixed(1)} ${gapField}=${v?.toFixed(2)}°F pnl=$${h.realized_pnl}`);
  }
}

summarize("TAIL-OBS-FLOOR  (YES, gapF > 1.5°F)",      results.tailYesHits, "gapF");
summarize("TAIL-OBS-CEILING (NO, safetyMargin < 1.5°F)", results.tailNoHits, "safetyMarginF");
summarize("BUCKET-ABOVE-OBS (LOW YES, gapF > 0.4°F)",   results.bucketHits, "gapF");
const allHits = [...results.tailYesHits, ...results.tailNoHits, ...results.bucketHits];
const totalLossRecouped = allHits.filter(h => h.outcome === "LOSS").reduce((a, b) => a - (b.realized_pnl || 0), 0);
const totalWinForgone = allHits.filter(h => h.outcome === "WIN").reduce((a, b) => a + (b.realized_pnl || 0), 0);
console.log(`\n=== TOTAL GATE IMPACT ===`);
console.log(`Loss P&L recouped:  $${totalLossRecouped.toFixed(2)}`);
console.log(`Win P&L forgone:    $${totalWinForgone.toFixed(2)}`);
console.log(`Net P&L improvement: $${(totalLossRecouped - totalWinForgone).toFixed(2)}`);
console.log(`(${results.untouched.length} bets passed through unchanged)`);

// ===========================================================================
// σ-floor A/B: for each settled bet, recompute EV/Kelly under candidate floors
// and tally which bets would have been skipped (and their realized P&L).
// Mirrors jackson_trader.js gate: ev ≥ 0.20, halfKelly ≥ 0.10, price ≥ 0.04.
// ===========================================================================
const MIN_EDGE = 0.20, MIN_HALF_KELLY = 0.10, MIN_PRICE = 0.04;
function erf(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1) * t * Math.exp(-x*x);
  return sign * y;
}
const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));
function bucketProb(mean, std, loInt, hiInt, lowerFloor, upperFloor) {
  let effLo = loInt === -Infinity || loInt == null ? -Infinity : loInt - 0.5;
  let effHi = hiInt === Infinity  || hiInt == null ? Infinity  : hiInt + 0.5;
  if (lowerFloor != null) { if (effHi < lowerFloor) return 0; if (effLo < lowerFloor) effLo = lowerFloor; }
  if (upperFloor != null) { if (effLo > upperFloor) return 0; if (effHi > upperFloor) effHi = upperFloor; }
  const pHi = effHi === Infinity ? 1 : normCdf((effHi - mean) / std);
  const pLo = effLo === -Infinity ? 0 : normCdf((effLo - mean) / std);
  return Math.max(0, pHi - pLo);
}
function parseBucketStr(s) {
  if (!s) return null;
  s = s.replace(/°F?/g, "").trim();
  let m = s.match(/^(-?\d+)\s*[–-]\s*(-?\d+)$/);
  if (m) return { loInt: +m[1], hiInt: +m[2] };
  m = s.match(/^≤\s*(-?\d+)$/) || s.match(/^<=?\s*(-?\d+)$/);
  if (m) return { loInt: -Infinity, hiInt: +m[1] };
  m = s.match(/^≥\s*(-?\d+)$/) || s.match(/^>=?\s*(-?\d+)$/);
  if (m) return { loInt: +m[1], hiInt: Infinity };
  m = s.match(/^(-?\d+)$/);
  if (m) return { loInt: +m[1], hiInt: +m[1] };
  return null;
}

// For each bet, derive pWin_orig from its recorded ev: ev = (pWin - price) - fee.
// Then for each candidate floor, compute pWin_eff using bucketProb at σ=floor (ignoring
// probSum/truncation since both cancel as a multiplicative scaling — for a relative
// shift we only need the *ratio* pYes_eff / pYes_orig).
function pYesRaw(mean, std, bb) { return bucketProb(mean, std, bb.loInt, bb.hiInt); }

// Variants:
//   floor=X     : σ_eff = max(σ_orig, X)   (current production at X=1.0)
//   irred=X     : σ_eff = sqrt(σ_orig² + X²)   (hierarchical prior on member error)
const FLOOR_VARIANTS = [0.5, 1.0, 1.5, 2.0];
const IRRED_VARIANTS = [0.7, 1.0, 1.3, 1.5];
console.log(`\n=== σ-FLOOR A/B (${candidates.length} settled bets — *delta* vs no floor) ===`);
console.log(`Trader gate: ev ≥ ${MIN_EDGE}, halfKelly ≥ ${MIN_HALF_KELLY}, price ≥ ${MIN_PRICE}`);
console.log(`Floor   | newly-skipped | TP (loss) | FP (win) | $loss recouped | $win forgone | net`);
console.log(`--------+---------------+-----------+----------+----------------+--------------+------`);
for (const floor of FLOOR_VARIANTS) {
  let tp = 0, fp = 0, lossRec = 0, winForgone = 0;
  const skipped = [];
  for (const bet of candidates) {
    const sigmaOrig = bet.modelStd ?? 0;
    if (sigmaOrig >= floor) continue;  // floor doesn't bite
    const bb = parseBucketStr(bet.bucket);
    if (!bb) continue;
    const side = (bet.side || "").toLowerCase();
    const fee = 0.07 * (1 - bet.price);
    const pWinOrig = bet.ev + bet.price + fee;
    const pYesOrig = side === "yes" ? pWinOrig : (1 - pWinOrig);
    const rawOrig  = pYesRaw(bet.modelMean, sigmaOrig, bb);
    const rawEff   = pYesRaw(bet.modelMean, floor,    bb);
    if (rawOrig <= 0) continue;
    const pYesEff  = Math.max(0, Math.min(1, pYesOrig * (rawEff / rawOrig)));
    const pWinEff  = side === "yes" ? pYesEff : (1 - pYesEff);
    const evEff    = (pWinEff - bet.price) - fee;
    const kEff     = bet.price < 1 ? Math.max(0, (pWinEff - bet.price) / (1 - bet.price)) : 0;
    const passes   = evEff >= MIN_EDGE && (kEff/2) >= MIN_HALF_KELLY && bet.price >= MIN_PRICE;
    if (!passes) {
      if (bet.outcome === "LOSS") { tp++; lossRec += -(bet.realized_pnl || 0); }
      else if (bet.outcome === "WIN") { fp++; winForgone += (bet.realized_pnl || 0); }
      skipped.push({ bet, sigmaOrig, evEff, halfKEff: kEff/2 });
    }
  }
  const net = lossRec - winForgone;
  console.log(` ${floor.toFixed(1)}°F |       ${String(tp+fp).padStart(3)}     |    ${String(tp).padStart(2)}    |    ${String(fp).padStart(2)}    |    $${lossRec.toFixed(2).padStart(7)}   |   $${winForgone.toFixed(2).padStart(6)}  | $${net.toFixed(2)}`);
  if (floor === 1.0) {
    console.log(`  (σ=1.0 detail:)`);
    skipped.forEach(s => {
      const out = s.bet.outcome === "LOSS" ? "✓" : "✗";
      console.log(`    ${out} ${s.bet.ticker} ${s.bet.variable}/${s.bet.side} σ_orig=${s.sigmaOrig.toFixed(2)} → ev=${s.evEff.toFixed(3)}, halfK=${s.halfKEff.toFixed(3)} pnl=$${s.bet.realized_pnl}`);
    });
  }
}

// ===========================================================================
// HIERARCHICAL σ A/B (replacement for floor — never collapses, always smooth)
// σ_eff = sqrt(σ_orig² + σ_irreducible²)
// ===========================================================================
console.log(`\n=== HIERARCHICAL σ A/B (σ_eff = √(σ_orig² + σ_irred²)) ===`);
console.log(`Floor   | newly-skipped | TP (loss) | FP (win) | $loss recouped | $win forgone | net`);
console.log(`--------+---------------+-----------+----------+----------------+--------------+------`);
for (const irred of IRRED_VARIANTS) {
  let tp = 0, fp = 0, lossRec = 0, winForgone = 0;
  for (const bet of candidates) {
    const sigmaOrig = bet.modelStd ?? 0;
    const sigmaEff  = Math.sqrt(sigmaOrig*sigmaOrig + irred*irred);
    if (sigmaEff <= sigmaOrig + 1e-9) continue;
    const bb = parseBucketStr(bet.bucket);
    if (!bb) continue;
    const side = (bet.side || "").toLowerCase();
    const fee = 0.07 * (1 - bet.price);
    const pWinOrig = bet.ev + bet.price + fee;
    const pYesOrig = side === "yes" ? pWinOrig : (1 - pWinOrig);
    const rawOrig  = pYesRaw(bet.modelMean, sigmaOrig, bb);
    const rawEff   = pYesRaw(bet.modelMean, sigmaEff, bb);
    if (rawOrig <= 0) continue;
    const pYesEff  = Math.max(0, Math.min(1, pYesOrig * (rawEff / rawOrig)));
    const pWinEff  = side === "yes" ? pYesEff : (1 - pYesEff);
    const evEff    = (pWinEff - bet.price) - fee;
    const kEff     = bet.price < 1 ? Math.max(0, (pWinEff - bet.price) / (1 - bet.price)) : 0;
    const passes   = evEff >= MIN_EDGE && (kEff/2) >= MIN_HALF_KELLY && bet.price >= MIN_PRICE;
    if (!passes) {
      if (bet.outcome === "LOSS") { tp++; lossRec += -(bet.realized_pnl || 0); }
      else if (bet.outcome === "WIN") { fp++; winForgone += (bet.realized_pnl || 0); }
    }
  }
  const net = lossRec - winForgone;
  console.log(` ${irred.toFixed(1)}°F |       ${String(tp+fp).padStart(3)}     |    ${String(tp).padStart(2)}    |    ${String(fp).padStart(2)}    |    $${lossRec.toFixed(2).padStart(7)}   |   $${winForgone.toFixed(2).padStart(6)}  | $${net.toFixed(2)}`);
}

// ===========================================================================
// LIQUIDITY PROXY AUDIT — settled records lack at-trade volume/spread, so we
// approximate by city (per-city volume is stable in days-scale) and by bucket
// type (T-tail typically thinner than B-bucket near forecast mean). The aim
// is to find where the loss density is concentrated, not to measure slippage.
// ===========================================================================
console.log(`\n=== LIQUIDITY-PROXY AUDIT — by city ===`);
const byCity = {};
for (const b of bets) {
  const c = b.city || "?";
  byCity[c] ??= { n: 0, w: 0, l: 0, pnl: 0, staked: 0, tail: 0 };
  byCity[c].n++;
  if (b.outcome === "WIN")  byCity[c].w++;
  if (b.outcome === "LOSS") byCity[c].l++;
  byCity[c].pnl    += b.realized_pnl || 0;
  byCity[c].staked += b.stake_dollars || 0;
  if ((b.ticker?.split("-").pop() || "").startsWith("T")) byCity[c].tail++;
}
const cityRows = Object.entries(byCity).sort((a,b) => a[1].pnl - b[1].pnl);
console.log(`city            | n  | W-L  | tail% | staked  | pnl       | roi`);
console.log(`----------------+----+------+-------+---------+-----------+--------`);
for (const [c, r] of cityRows) {
  const roi = r.staked > 0 ? (r.pnl / r.staked) * 100 : 0;
  console.log(` ${c.padEnd(15)}| ${String(r.n).padStart(2)} | ${String(r.w).padStart(2)}-${String(r.l).padStart(2)} | ${(100*r.tail/r.n).toFixed(0).padStart(3)}%  | $${r.staked.toFixed(2).padStart(6)} | $${r.pnl.toFixed(2).padStart(7)}  | ${roi.toFixed(0)}%`);
}

console.log(`\n=== LIQUIDITY-PROXY AUDIT — tail vs B-bucket ===`);
const buckets = { T: { n: 0, w: 0, l: 0, pnl: 0, staked: 0 }, B: { n: 0, w: 0, l: 0, pnl: 0, staked: 0 } };
for (const b of bets) {
  const code = (b.ticker?.split("-").pop() || "")[0];
  if (code !== "T" && code !== "B") continue;
  const r = buckets[code];
  r.n++;
  if (b.outcome === "WIN")  r.w++;
  if (b.outcome === "LOSS") r.l++;
  r.pnl    += b.realized_pnl || 0;
  r.staked += b.stake_dollars || 0;
}
console.log(`type | n  | W-L  | staked  | pnl       | roi    | implied per-bet edge`);
console.log(`-----+----+------+---------+-----------+--------+---------------------`);
for (const [k, r] of Object.entries(buckets)) {
  const roi = r.staked > 0 ? (r.pnl / r.staked) * 100 : 0;
  const perBet = r.n > 0 ? r.pnl / r.n : 0;
  console.log(`  ${k}  | ${String(r.n).padStart(2)} | ${String(r.w).padStart(2)}-${String(r.l).padStart(2)} | $${r.staked.toFixed(2).padStart(6)} | $${r.pnl.toFixed(2).padStart(7)}  | ${roi.toFixed(0)}%   | $${perBet.toFixed(2)}/bet`);
}
