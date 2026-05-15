#!/usr/bin/env node
// Empirical fitter for σ_revision(forecastAgeMin) — the staleness-conditioned σ
// term added to weather.js priorStd/priorLowStd on 2026-05-15.
//
// Two parallel estimators:
//
//   (1) Pairwise revision noise. For each {cli, date}, take pairs of snapshots
//       at different capture times. Δpred = pred@later − pred@earlier;
//       Δage = forecastAgeMin@later − forecastAgeMin@earlier. The sample std
//       of Δpred grouped by |Δage| bins gives σ_revision(Δage) directly — no
//       settlement required. Saturates quickly.
//
//   (2) Residual-vs-age. For each settled snapshot, residual = predHigh − actual.
//       Bin by forecastAgeMin. Sample std per bin minus σ_post² (=σ_ens² + σ_res²,
//       reconstructable from stdHigh) gives σ_revision² per bin. Same shape.
//
// (1) is faster (no CLI wait); (2) is the ground-truth check (settled outcomes,
// not internal model agreement). Land σ_revision wiring against (1); validate
// against (2) once n ≥ 80 settled snapshots per variable.
//
// Run: AUTH=x:hydro node analyze_sigma_revision.js
//   --variable=high|low|both   (default: both)
//   --min-pairs=N              (default: 30 — minimum pairs per bin to report)

const BASE = process.env.BASE || "https://weatherbot-mf.netlify.app";
const AUTH = process.env.AUTH || "x:hydro";

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.replace(/^--/, "").split("="))
);
const VARIABLE = args.variable || "both";
const MIN_PAIRS_PER_BIN = parseInt(args["min-pairs"] || "30", 10);

const AGE_BINS_HR = [
  [0,   1], [1,   2], [2,   4], [4,   6], [6,   8],
  [8,  12], [12, 16], [16, 20], [20, 30]
];

function binIndex(ageHr) {
  for (let i = 0; i < AGE_BINS_HR.length; i++) {
    const [lo, hi] = AGE_BINS_HR[i];
    if (ageHr >= lo && ageHr < hi) return i;
  }
  return null;
}

function std(xs) {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

async function fetchSnapshots() {
  const r = await fetch(`${BASE}/api/snapshots?settled=0&limit=5000`, {
    headers: { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` }
  });
  if (!r.ok) throw new Error(`snapshots API ${r.status}`);
  const j = await r.json();
  return j.records || [];
}

function groupByDateCity(records) {
  const map = new Map();
  for (const r of records) {
    const k = `${r.cli}|${r.date}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.localHHMM.localeCompare(b.localHHMM));
  }
  return map;
}

// --- (1) Pairwise revision noise -------------------------------------------
function pairwiseRevisionNoise(map, variable) {
  const predKey = variable === "low" ? "predLow" : "predHigh";
  const binDeltas = AGE_BINS_HR.map(() => []);
  for (const arr of map.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        if (a[predKey] == null || b[predKey] == null) continue;
        if (a.forecastAgeMin == null || b.forecastAgeMin == null) continue;
        const dPred = b[predKey] - a[predKey];
        const dAgeHr = Math.abs(b.forecastAgeMin - a.forecastAgeMin) / 60;
        const idx = binIndex(dAgeHr);
        if (idx == null) continue;
        binDeltas[idx].push(dPred);
      }
    }
  }
  return AGE_BINS_HR.map(([lo, hi], i) => {
    const n = binDeltas[i].length;
    return { bin: `${lo}-${hi}h`, midHr: (lo + hi) / 2, n,
             sigma: n >= MIN_PAIRS_PER_BIN ? std(binDeltas[i]) : null };
  });
}

// --- (2) Residual-vs-age ----------------------------------------------------
function residualVsAge(records, variable) {
  const predKey = variable === "low" ? "predLow" : "predHigh";
  const actKey  = variable === "low" ? "actualLow" : "actualHigh";
  const stdKey  = variable === "low" ? "stdLow" : "stdHigh";
  const binResiduals = AGE_BINS_HR.map(() => []);
  const binPriorStd2 = AGE_BINS_HR.map(() => []);
  for (const r of records) {
    if (!r.settled) continue;
    if (r[predKey] == null || r[actKey] == null) continue;
    if (r.forecastAgeMin == null) continue;
    const idx = binIndex(r.forecastAgeMin / 60);
    if (idx == null) continue;
    binResiduals[idx].push(r[predKey] - r[actKey]);
    if (r[stdKey] != null) binPriorStd2[idx].push(r[stdKey] ** 2);
  }
  return AGE_BINS_HR.map(([lo, hi], i) => {
    const n = binResiduals[i].length;
    const sigmaObs = n >= MIN_PAIRS_PER_BIN ? std(binResiduals[i]) : null;
    const meanPriorVar = binPriorStd2[i].length
      ? binPriorStd2[i].reduce((a, b) => a + b, 0) / binPriorStd2[i].length : null;
    let sigmaRev = null;
    if (sigmaObs != null && meanPriorVar != null) {
      const excess = sigmaObs * sigmaObs - meanPriorVar;
      sigmaRev = excess > 0 ? Math.sqrt(excess) : 0;
    }
    return { bin: `${lo}-${hi}h`, midHr: (lo + hi) / 2, n,
             sigmaObs, sqrtMeanPriorVar: meanPriorVar != null ? Math.sqrt(meanPriorVar) : null,
             sigmaRev };
  });
}

// OLS slope through origin: σ = α × (ageHr − 1) for ageHr > 1.
function fitAlpha(rows) {
  const pts = rows.filter(r => r.sigmaRev != null && r.midHr > 1)
                  .map(r => ({ x: r.midHr - 1, y: r.sigmaRev, w: r.n }));
  if (pts.length < 3) return null;
  const sumWxx = pts.reduce((a, p) => a + p.w * p.x * p.x, 0);
  const sumWxy = pts.reduce((a, p) => a + p.w * p.x * p.y, 0);
  return sumWxx > 0 ? sumWxy / sumWxx : null;
}

function reportTable(rows, title) {
  console.log(`\n=== ${title} ===`);
  console.log("bin      midHr     n     σ_obs    √σ̄_prior²    σ_rev");
  for (const r of rows) {
    console.log(
      r.bin.padEnd(8),
      String(r.midHr).padStart(5),
      String(r.n).padStart(6),
      (r.sigma ?? r.sigmaObs ?? "—").toString().padStart(8),
      (r.sqrtMeanPriorVar?.toFixed(2) ?? "—").padStart(12),
      (r.sigmaRev?.toFixed(2) ?? "—").padStart(8),
    );
  }
}

async function main() {
  console.log(`Pulling /api/snapshots from ${BASE}…`);
  const records = await fetchSnapshots();
  console.log(`Got ${records.length} snapshots. Settled: ${records.filter(r => r.settled).length}.`);
  const map = groupByDateCity(records);

  const variables = VARIABLE === "both" ? ["high", "low"] : [VARIABLE];
  for (const v of variables) {
    const pair = pairwiseRevisionNoise(map, v);
    reportTable(pair, `(1) Pairwise revision noise — ${v.toUpperCase()}`);

    const resid = residualVsAge(records, v);
    reportTable(resid, `(2) Residual-vs-age — ${v.toUpperCase()}`);
    const α = fitAlpha(resid);
    if (α != null) {
      console.log(`Fitted α_${v.toUpperCase()} = ${α.toFixed(3)} °F/hour  (slope through (1h, 0))`);
    } else {
      console.log(`α_${v.toUpperCase()}: insufficient bins with n ≥ ${MIN_PAIRS_PER_BIN}.`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
