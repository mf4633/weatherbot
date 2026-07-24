// analyze_stack.js — fit the COMBINATION of the three independent daily-high
// estimators this system produces, instead of the hand-tuned ramp in
// claude_analog_v3.nwsBaseBlend.
//
//   legs:  claude  = pure obs-analog point (claude_analog_v3.predict → dist.mean())
//          bayes   = the served 6-model Bayesian ensemble point (/api/weather highMean)
//          nws     = the raw NWS gridded daily high
//   truth = the settled NWS CLI maximum
//
// Data: the claude_scoreboard blob store (dec/ + settle/), pulled to a local JSON.
// Every logged decision carries all three legs at the SAME asof, so this is a
// matched-pair stack — no leg gets an information advantage from being sampled later.
//
// Method: weights constrained to the simplex (non-negative, sum to 1) per
// hours-to-peak bucket, fit by exhaustive simplex grid on a TRAIN date window,
// reported on a genuinely held-out TEST date window. Baselines: each leg alone,
// the equal (claude+bayes)/2 blend the scoreboard already reports, and the
// production hand-tuned ramp w = clamp((h-2)/10, 0, 0.7).
//
// Usage:  node research/analyze_stack.js [sb_export.json] [--split=YYYY-MM-DD]
//
// Defaults to the committed snapshot; --split defaults to the last ~30% of the
// available contract dates. The export is {records:[…]} of raw blob values:
//   {type:'decision', station, contract_date, asof, claude:{…}, bayes:{…}, nws}
//   {type:'settlement', station, contract_date, cli_max}
//
// Refreshing the input: /api/claude?mode=export lists and reads every blob in one
// request and now exceeds the edge-function timeout (~26s at >5k blobs), so the
// scoreboard-snapshot workflow has been silently no-op'ing — check the freshness of
// data/scoreboard-snapshots/latest.json before trusting a run. To pull the store
// directly, read it with @netlify/blobs from the repo root using the CLI's stored
// token, with concurrency:
//
//   getStore({ name: "claude_scoreboard", siteID, token, consistency: "strong" })
//   → .list(), then .get(key, {type:"json"}) across ~40 parallel workers (~90s)
//
// (siteID from .netlify/state.json, token from the netlify CLI config.)

import { readFileSync } from "node:fs";

const SRC = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2] : "data/scoreboard-snapshots/latest.json";
const SPLIT_ARG = process.argv.find(a => a.startsWith("--split="));

const TZ = {
  KAVL: "America/New_York", KNYC: "America/New_York", KLAX: "America/Los_Angeles",
  KMDW: "America/Chicago", KHOU: "America/Chicago", KPHX: "America/Phoenix",
  KPHL: "America/New_York", KSAT: "America/Chicago", KSAN: "America/Los_Angeles",
  KDFW: "America/Chicago", KJAX: "America/New_York", KAUS: "America/Chicago",
  KTPA: "America/New_York", KSJC: "America/Los_Angeles", KCMH: "America/New_York",
  KCLT: "America/New_York", KIND: "America/Indiana/Indianapolis", KSEA: "America/Los_Angeles",
  KDEN: "America/Denver", KDCA: "America/New_York", KBOS: "America/New_York",
  KMIA: "America/New_York", KSFO: "America/Los_Angeles", KMSY: "America/Chicago",
  KLAS: "America/Los_Angeles", KOKC: "America/Chicago", KMSP: "America/Chicago",
  KATL: "America/New_York",
};
const PACIFIC = new Set(["KLAX", "KSAN", "KSJC", "KSEA", "KSFO", "KLAS"]);

const localHour = (iso, tz) =>
  parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false })
    .format(new Date(iso)), 10) % 24;

// ---------------------------------------------------------------- load + join
export function buildRows(records) {
  const truths = {};
  for (const r of records)
    if (r.type === "settlement" && r.cli_max != null) truths[`${r.station}|${r.contract_date}`] = r.cli_max;
  const rows = [];
  for (const r of records) {
    if (r.type !== "decision") continue;
    const truth = truths[`${r.station}|${r.contract_date}`];
    if (truth == null) continue;
    const tz = TZ[r.station];
    if (!tz) continue;
    // The engine's own definition (claude_engine.js): hrsToPeak = max(0, 16 - localHour).
    const lh = localHour(r.asof, tz);
    const hrs = Math.max(0, 16 - lh);
    const claude = r.claude?.guarded_point ?? r.claude?.point;
    const bayes = r.bayes?.point;
    const nws = r.nws;
    if (![claude, bayes, nws].every(v => v != null && Number.isFinite(+v))) continue;
    const floor = r.bayes?.floor != null ? +r.bayes.floor : (r.claude?.floor != null ? +r.claude.floor : -Infinity);
    rows.push({
      station: r.station, date: r.contract_date, asof: r.asof, lh, hrs,
      claude: +claude, bayes: +bayes, nws: +nws, floor,
      bayesSigma: r.bayes?.sigma != null ? +r.bayes.sigma : null,
      claudeSigma: r.claude?.sigma != null ? +r.claude.sigma : null,
      locked: !!r.claude?.peak_locked, truth: +truth,
      pacific: PACIFIC.has(r.station),
    });
  }
  return rows;
}

// -------------------------------------------------------------- combination
// Served point = floor(w·legs) — the served number can never sit under an
// observed max, exactly as nwsBaseBlend does today.
export const applyFloor = (p, floor) => Number.isFinite(floor) ? Math.max(p, floor) : p;

export const combine = (row, w, b = 0) =>
  applyFloor(w.claude * row.claude + w.bayes * row.bayes + w.nws * row.nws + b, row.floor);

// production baseline: analog blended toward NWS on the hand-tuned ramp,
// then that is the claude-side served point (bayes not involved).
export function prodBlend(row) {
  const w = Math.min(0.7, Math.max(0, (row.hrs - 2) / 10));
  return applyFloor(w * row.nws + (1 - w) * row.claude, row.floor);
}

// PROPOSED replacement — the fitted step, anchored on the Bayesian ensemble
// instead of the NWS grid (NWS earns w=0.00 at every hour once the Bayesian is
// present; it is already an ensemble member, residual corr 0.91–0.97).
export const analogWeightFitted = (h) => (h <= 1 ? 0.30 : h <= 3 ? 0.12 : 0.05);
export function fittedBlend(row) {
  const wa = analogWeightFitted(row.hrs);
  return applyFloor(wa * row.claude + (1 - wa) * row.bayes, row.floor);
}

// -------------------------------------------------------------------- stats
export function stats(errs) {
  const n = errs.length;
  if (!n) return { n: 0 };
  const mean = errs.reduce((a, b) => a + b, 0) / n;
  const mae = errs.reduce((a, b) => a + Math.abs(b), 0) / n;
  const rmse = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / n);
  const sd = Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const srt = [...errs].sort((a, b) => a - b);
  const q = (p) => srt[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const m4 = errs.reduce((a, b) => a + (b - mean) ** 4, 0) / n;
  return { n, mean, mae, rmse, sd, kurt: m4 / sd ** 4,
           p02: q(0.025), p16: q(0.16), p50: q(0.5), p84: q(0.84), p97: q(0.975),
           absMax: Math.max(...errs.map(Math.abs)) };
}

// coverage of a Gaussian with the given sigma column
export function coverage(rows, pointFn, sigmaFn) {
  let n = 0, in68 = 0, in95 = 0, z2 = 0;
  for (const r of rows) {
    const s = sigmaFn(r);
    if (!(s > 0)) continue;
    const e = pointFn(r) - r.truth;
    n++; z2 += (e / s) ** 2;
    if (Math.abs(e) <= s) in68++;
    if (Math.abs(e) <= 1.96 * s) in95++;
  }
  return { n, c68: n ? in68 / n : null, c95: n ? in95 / n : null, zRms: n ? Math.sqrt(z2 / n) : null };
}

// ------------------------------------------------------- simplex weight fit
// Exhaustive grid over the 2-simplex at `step`. 3 legs → ~1300 points at 0.02;
// exact enough that a gradient method buys nothing, and it cannot land in a
// local minimum or violate the constraint.
export function fitSimplex(rows, { step = 0.02, intercept = false } = {}) {
  const K = Math.round(1 / step);
  let best = null;
  for (let i = 0; i <= K; i++) for (let j = 0; i + j <= K; j++) {
    const w = { claude: i / K, bayes: j / K, nws: (K - i - j) / K };
    let s = 0, sum = 0;
    const raw = rows.map(r => combine(r, w) - r.truth);
    for (const e of raw) sum += e;
    const b = intercept ? -sum / raw.length : 0;
    for (const e of raw) s += (e + b) ** 2;
    const mse = s / raw.length;
    if (!best || mse < best.mse) best = { w, b, mse, rmse: Math.sqrt(mse) };
  }
  return best;
}

// ---------------------------------------------- unconstrained OLS (normal eq.)
export function ols(X, y) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < X.length; i++)
    for (let a = 0; a < p; a++) {
      for (let b = 0; b < p; b++) A[a][b] += X[i][a] * X[i][b];
      A[a][p] += X[i][a] * y[i];
    }
  // Gaussian elimination with partial pivoting + a whisper of ridge for stability
  for (let a = 0; a < p; a++) A[a][a] += 1e-6;
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < p; r++) {
      if (r === c || A[c][c] === 0) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[p] / row[i]);
}

// --------------------------------------------------------------------- main
function fmt(x, d = 3) { return x == null ? "  —  " : (+x).toFixed(d); }

function report(label, rows, pointFn) {
  const e = rows.map(r => pointFn(r) - r.truth);
  const s = stats(e);
  return { label, ...s };
}

function printTable(title, lines) {
  console.log(`\n${title}`);
  console.log("  " + "leg".padEnd(26) + "n".padStart(6) + "RMSE".padStart(8) + "MAE".padStart(8) +
              "bias".padStart(8) + "sd".padStart(8) + "kurt".padStart(7) + "p2.5".padStart(8) + "p97.5".padStart(8));
  for (const l of lines)
    console.log("  " + l.label.padEnd(26) + String(l.n).padStart(6) + fmt(l.rmse).padStart(8) +
      fmt(l.mae).padStart(8) + fmt(l.mean).padStart(8) + fmt(l.sd).padStart(8) +
      fmt(l.kurt, 2).padStart(7) + fmt(l.p02, 2).padStart(8) + fmt(l.p97, 2).padStart(8));
}

function main() {
  const raw = JSON.parse(readFileSync(SRC, "utf8"));
  const rows = buildRows(raw.records || raw);
  const dates = [...new Set(rows.map(r => r.date))].sort();
  // Split by DATE, never by row: decisions within a station-day are the same
  // weather seen at different hours, so a random row split leaks the answer.
  const SPLIT = SPLIT_ARG ? SPLIT_ARG.slice(8) : dates[Math.max(1, Math.ceil(dates.length * 0.7))];
  console.log(`rows ${rows.length}  dates ${dates[0]}..${dates[dates.length - 1]} (${dates.length})  stations ${new Set(rows.map(r => r.station)).size}`);
  console.log(`split: TRAIN date < ${SPLIT}  |  TEST date >= ${SPLIT}${SPLIT_ARG ? "" : "  (default: last 30% of dates)"}`);

  const train = rows.filter(r => r.date < SPLIT);
  const test = rows.filter(r => r.date >= SPLIT);
  const sd = (rs) => new Set(rs.map(r => `${r.station}|${r.date}`)).size;
  console.log(`TRAIN n=${train.length} (${sd(train)} station-days, ${new Set(train.map(r => r.date)).size} days)`);
  console.log(` TEST n=${test.length} (${sd(test)} station-days, ${new Set(test.map(r => r.date)).size} days)`);

  // hours-to-peak buckets. 0-1 / 2-3 / 4-5 / 6-7 / 8+ keeps ≥1 full day of
  // station-days in each cell on this sample.
  const BUCKETS = [[0, 1], [2, 3], [4, 5], [6, 7], [8, 99]];
  const bucketOf = (h) => BUCKETS.findIndex(([lo, hi]) => h >= lo && h <= hi);

  const LEGS = {
    "claude (pure analog)": r => applyFloor(r.claude, r.floor),
    "bayes (6-model ens.)": r => applyFloor(r.bayes, r.floor),
    "nws (raw grid)": r => applyFloor(r.nws, r.floor),
    "equal claude+bayes": r => applyFloor((r.claude + r.bayes) / 2, r.floor),
    "PROD nwsBaseBlend": prodBlend,
    "PROPOSED fitted blend": fittedBlend,
  };

  printTable("=== TEST-window baselines (all hours) ===",
    Object.entries(LEGS).map(([k, f]) => report(k, test, f)));

  // ---- global fitted weights ------------------------------------------------
  const gfit = fitSimplex(train);
  const gfitB = fitSimplex(train, { intercept: true });
  console.log(`\nglobal fit (TRAIN): w = claude ${fmt(gfit.w.claude, 2)} / bayes ${fmt(gfit.w.bayes, 2)} / nws ${fmt(gfit.w.nws, 2)}   train RMSE ${fmt(gfit.rmse)}`);
  console.log(`global fit + intercept: w = claude ${fmt(gfitB.w.claude, 2)} / bayes ${fmt(gfitB.w.bayes, 2)} / nws ${fmt(gfitB.w.nws, 2)}  b ${fmt(gfitB.b, 2)}  train RMSE ${fmt(gfitB.rmse)}`);

  // ---- per-bucket fitted weights -------------------------------------------
  const perBucket = BUCKETS.map(([lo, hi], bi) => {
    const tr = train.filter(r => bucketOf(r.hrs) === bi);
    return { lo, hi, n: tr.length, nsd: sd(tr), fit: tr.length >= 30 ? fitSimplex(tr) : null };
  });
  console.log("\n=== fitted weights by hours-to-peak (TRAIN) ===");
  console.log("  bucket   n   st-days   claude  bayes    nws   trainRMSE   prod w_nws");
  for (const b of perBucket) {
    const pw = Math.min(0.7, Math.max(0, ((b.lo + b.hi) / 2 - 2) / 10));
    console.log(`  ${String(b.lo + "-" + (b.hi === 99 ? "+" : b.hi)).padEnd(7)}${String(b.n).padStart(5)}${String(b.nsd).padStart(9)}   ` +
      `${fmt(b.fit?.w.claude, 2)}   ${fmt(b.fit?.w.bayes, 2)}   ${fmt(b.fit?.w.nws, 2)}      ${fmt(b.fit?.rmse)}      ${fmt(pw, 2)}`);
  }

  const bucketFn = (r) => {
    const b = perBucket[bucketOf(r.hrs)];
    return b?.fit ? combine(r, b.fit.w) : combine(r, gfit.w);
  };

  printTable("=== TEST-window fitted stacks (all hours) ===", [
    report("global fitted w", test, r => combine(r, gfit.w)),
    report("global fitted w + b", test, r => combine(r, gfitB.w, gfitB.b)),
    report("per-bucket fitted w", test, bucketFn),
    report("PROD nwsBaseBlend", test, prodBlend),
    report("PROPOSED fitted blend", test, fittedBlend),
    report("bayes (6-model ens.)", test, r => applyFloor(r.bayes, r.floor)),
  ]);

  // ---- per-bucket TEST breakdown -------------------------------------------
  console.log("\n=== TEST RMSE by hours-to-peak bucket ===");
  console.log("  bucket   n  st-d   claude   bayes     nws    PROD   fitted   Δ(fit-bayes)  Δ(fit-PROD)");
  for (let bi = 0; bi < BUCKETS.length; bi++) {
    const te = test.filter(r => bucketOf(r.hrs) === bi);
    if (!te.length) continue;
    const R = (f) => stats(te.map(r => f(r) - r.truth)).rmse;
    const c = R(r => applyFloor(r.claude, r.floor)), b = R(r => applyFloor(r.bayes, r.floor));
    const nw = R(r => applyFloor(r.nws, r.floor)), p = R(prodBlend), f = R(bucketFn);
    const [lo, hi] = BUCKETS[bi];
    console.log(`  ${String(lo + "-" + (hi === 99 ? "+" : hi)).padEnd(7)}${String(te.length).padStart(4)}${String(sd(te)).padStart(6)}` +
      `${fmt(c, 2).padStart(9)}${fmt(b, 2).padStart(8)}${fmt(nw, 2).padStart(8)}${fmt(p, 2).padStart(8)}${fmt(f, 2).padStart(9)}` +
      `${fmt(f - b, 2).padStart(15)}${fmt(f - p, 2).padStart(13)}`);
  }

  // ---- the specific hypothesis: Pacific mid-afternoon ----------------------
  console.log("\n=== Pacific cities, mid-afternoon (hrs 1-4) — the reported failure mode ===");
  const pac = test.filter(r => r.pacific && r.hrs >= 1 && r.hrs <= 4);
  const pacTr = train.filter(r => r.pacific && r.hrs >= 1 && r.hrs <= 4);
  console.log(`  TRAIN n=${pacTr.length} (${sd(pacTr)} st-days)   TEST n=${pac.length} (${sd(pac)} st-days)`);
  if (pac.length) printTable("  (TEST)", [
    report("claude", pac, r => applyFloor(r.claude, r.floor)),
    report("bayes", pac, r => applyFloor(r.bayes, r.floor)),
    report("nws", pac, r => applyFloor(r.nws, r.floor)),
    report("PROD nwsBaseBlend", pac, prodBlend),
    report("PROPOSED fitted blend", pac, fittedBlend),
    report("per-bucket fitted", pac, bucketFn),
  ]);

  // ---- calibration ---------------------------------------------------------
  console.log("\n=== calibration on TEST (Gaussian coverage with the served sigma) ===");
  const cov = [
    ["bayes point / bayes σ", r => applyFloor(r.bayes, r.floor), r => r.bayesSigma],
    ["claude point / claude σ", r => applyFloor(r.claude, r.floor), r => r.claudeSigma],
    ["PROD blend / claude σ", prodBlend, r => r.claudeSigma],
    ["PROPOSED blend / claude σ", fittedBlend, r => r.claudeSigma],
    ["PROD blend / bayes σ", prodBlend, r => r.bayesSigma],
    ["fitted stack / bayes σ", bucketFn, r => r.bayesSigma],
    ["PROPOSED blend / bayes σ", fittedBlend, r => r.bayesSigma],
  ];
  console.log("  " + "variant".padEnd(26) + "n".padStart(6) + "cov68".padStart(8) + "cov95".padStart(8) + "z-rms".padStart(8));
  for (const [lbl, pf, sf] of cov) {
    const c = coverage(test, pf, sf);
    console.log("  " + lbl.padEnd(26) + String(c.n).padStart(6) + fmt(c.c68).padStart(8) + fmt(c.c95).padStart(8) + fmt(c.zRms).padStart(8));
  }

  // ---- unconstrained OLS ---------------------------------------------------
  // The simplex is a strong prior. If the analog carries information that is
  // orthogonal-but-biased, an unconstrained fit (coefficients free, intercept
  // free) is where it would show up. Solved by normal equations, 4x4.
  console.log("\n=== unconstrained OLS (claude, bayes, nws, 1) — TRAIN fit, TEST RMSE ===");
  console.log("  bucket   b_claude  b_bayes   b_nws   const   trainRMSE   testRMSE   bayes-only testRMSE");
  for (let bi = 0; bi < BUCKETS.length; bi++) {
    const tr = train.filter(r => bucketOf(r.hrs) === bi);
    const te = test.filter(r => bucketOf(r.hrs) === bi);
    if (tr.length < 40 || !te.length) continue;
    const X = tr.map(r => [r.claude, r.bayes, r.nws, 1]), y = tr.map(r => r.truth);
    const beta = ols(X, y);
    const pred = (r) => applyFloor(beta[0] * r.claude + beta[1] * r.bayes + beta[2] * r.nws + beta[3], r.floor);
    const trR = stats(tr.map(r => pred(r) - r.truth)).rmse;
    const teR = stats(te.map(r => pred(r) - r.truth)).rmse;
    const bR = stats(te.map(r => applyFloor(r.bayes, r.floor) - r.truth)).rmse;
    const [lo, hi] = BUCKETS[bi];
    console.log(`  ${String(lo + "-" + (hi === 99 ? "+" : hi)).padEnd(7)}${fmt(beta[0], 3).padStart(9)}${fmt(beta[1], 3).padStart(9)}${fmt(beta[2], 3).padStart(8)}` +
      `${fmt(beta[3], 2).padStart(8)}${fmt(trR, 3).padStart(12)}${fmt(teR, 3).padStart(11)}${fmt(bR, 3).padStart(21)}`);
  }

  // ---- does the analog ever earn weight? segmented -------------------------
  console.log("\n=== segment: where (if anywhere) the analog beats the Bayesian (TEST) ===");
  const segs = {
    "peak-locked (grade A)": r => r.locked,
    "hrs<=1": r => r.hrs <= 1,
    "hrs<=1 & !locked": r => r.hrs <= 1 && !r.locked,
    "hrs 2-4": r => r.hrs >= 2 && r.hrs <= 4,
    "hrs>=5": r => r.hrs >= 5,
    "pacific hrs 1-4": r => r.pacific && r.hrs >= 1 && r.hrs <= 4,
  };
  console.log("  " + "segment".padEnd(24) + "n".padStart(6) + "st-d".padStart(6) +
              "claude".padStart(9) + "bayes".padStart(8) + "nws".padStart(8) + "PROD".padStart(8) + "fit-w(c/b/n)".padStart(18));
  for (const [lbl, f] of Object.entries(segs)) {
    const te = test.filter(f), tr = train.filter(f);
    if (!te.length) continue;
    const R = (rs, g) => stats(rs.map(r => g(r) - r.truth)).rmse;
    const wf = tr.length >= 40 ? fitSimplex(tr, { step: 0.05 }) : null;
    console.log("  " + lbl.padEnd(24) + String(te.length).padStart(6) + String(sd(te)).padStart(6) +
      fmt(R(te, r => applyFloor(r.claude, r.floor)), 2).padStart(9) +
      fmt(R(te, r => applyFloor(r.bayes, r.floor)), 2).padStart(8) +
      fmt(R(te, r => applyFloor(r.nws, r.floor)), 2).padStart(8) +
      fmt(R(te, prodBlend), 2).padStart(8) +
      (wf ? `  ${fmt(wf.w.claude, 2)}/${fmt(wf.w.bayes, 2)}/${fmt(wf.w.nws, 2)}` : "        —").padStart(18));
  }

  // ---- day-block bootstrap on the headline delta ---------------------------
  // Decisions within a station-day are strongly correlated; resample whole
  // DAYS so the interval reflects the real 13-day sample, not 4414 rows.
  console.log("\n=== day-block bootstrap, TEST: RMSE(fitted stack) − RMSE(bayes alone) ===");
  const testDays = [...new Set(test.map(r => r.date))];
  const byDay = Object.fromEntries(testDays.map(d => [d, test.filter(r => r.date === d)]));
  const deltas = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let b = 0; b < 2000; b++) {
    const samp = [];
    for (let k = 0; k < testDays.length; k++) samp.push(...byDay[testDays[Math.floor(rnd() * testDays.length)]]);
    deltas.push(stats(samp.map(r => bucketFn(r) - r.truth)).rmse -
                stats(samp.map(r => applyFloor(r.bayes, r.floor) - r.truth)).rmse);
  }
  deltas.sort((a, b) => a - b);
  console.log(`  median ${fmt(deltas[1000], 3)}°F   90% CI [${fmt(deltas[100], 3)}, ${fmt(deltas[1900], 3)}]  (negative = stack better)`);

  // and the one delta that is NOT a wash: the served Claude-card point.
  const boot = (fA, fB) => {
    const d = [];
    let s2 = 999;
    const rn = () => ((s2 = (s2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let b = 0; b < 2000; b++) {
      const samp = [];
      for (let k = 0; k < testDays.length; k++) samp.push(...byDay[testDays[Math.floor(rn() * testDays.length)]]);
      d.push(stats(samp.map(r => fA(r) - r.truth)).rmse - stats(samp.map(r => fB(r) - r.truth)).rmse);
    }
    d.sort((a, b) => a - b);
    return `median ${fmt(d[1000], 3)}°F  90% CI [${fmt(d[100], 3)}, ${fmt(d[1900], 3)}]`;
  };
  console.log(`  RMSE(PROPOSED card blend) − RMSE(PROD nwsBaseBlend): ${boot(fittedBlend, prodBlend)}`);
  console.log(`  RMSE(PROPOSED card blend) − RMSE(bayes alone):       ${boot(fittedBlend, r => applyFloor(r.bayes, r.floor))}`);
  const pacT = test.filter(r => r.pacific && r.hrs >= 1 && r.hrs <= 4);
  if (pacT.length) {
    const R = (f) => stats(pacT.map(r => f(r) - r.truth)).rmse;
    console.log(`  Pacific hrs1-4 TEST RMSE: PROD ${fmt(R(prodBlend), 2)} → PROPOSED ${fmt(R(fittedBlend), 2)} (bayes ${fmt(R(r => applyFloor(r.bayes, r.floor)), 2)}, n=${pacT.length}/${sd(pacT)} st-days)`);
  }

  // ---- what /api/kalshi actually prices -------------------------------------
  // kalshi.js:582 does NOT serve the Bayesian point to the bucket probabilities:
  //   highMu = claudeHigh != null ? (city.mean + city.claudeHigh) / 2 : city.mean
  // i.e. an unconditional 50/50 of the Bayesian and whatever the analog card is
  // serving that week. Every Student-t bucket probability, the paper shadow and
  // the traders all stand on that number, so its point error is the one that
  // matters most — measure it under each generation of claudeHigh.
  console.log("\n=== the point /api/kalshi prices HIGH buckets on (TEST) ===");
  const kal = (cardFn) => (r) => 0.5 * applyFloor(r.bayes, r.floor) + 0.5 * cardFn(r);
  printTable("  ", [
    report("50/50 w/ pure analog  (pre 07-22)", test, kal(r => applyFloor(r.claude, r.floor))),
    report("50/50 w/ nwsBaseBlend (07-22..)", test, kal(prodBlend)),
    report("50/50 w/ fitted blend (proposed)", test, kal(fittedBlend)),
    report("Bayesian point alone", test, r => applyFloor(r.bayes, r.floor)),
  ]);
  console.log("  coverage of that point under the served Bayesian σ:");
  for (const [lbl, f] of [["50/50 pure analog", kal(r => applyFloor(r.claude, r.floor))],
                          ["50/50 nwsBaseBlend", kal(prodBlend)],
                          ["50/50 fitted blend", kal(fittedBlend)],
                          ["bayes alone", r => applyFloor(r.bayes, r.floor)]]) {
    const c = coverage(test, f, r => r.bayesSigma);
    console.log("    " + lbl.padEnd(22) + `cov68 ${fmt(c.c68)}  cov95 ${fmt(c.c95)}  z-rms ${fmt(c.zRms)}`);
  }

  // ---- the ORACLE ceiling --------------------------------------------------
  // The question that closes the whole exercise: with the bias removed exactly and
  // the weights known exactly (in-sample, zero estimation error), how much residual
  // sd could a convex combination possibly save over the Bayesian alone? Whatever
  // this says is an UPPER BOUND on any fitting procedure, any regularisation, any
  // amount of extra data — and on any additional vendor leg with a comparable or
  // higher residual correlation.
  console.log("\n=== ORACLE ceiling on stacking (in-sample, exact debias, exact weights) ===");
  console.log("  bucket  leg      n    sd(bayes)  sd(leg)  corr   w*_leg   best sd   MAX GAIN °F");
  const cbuckets = [...BUCKETS, [0, 99]];
  for (const [lo, hi] of cbuckets) {
    const s = rows.filter(r => r.hrs >= lo && r.hrs <= hi);
    for (const [name, f] of [["analog", r => applyFloor(r.claude, r.floor)], ["nws", r => applyFloor(r.nws, r.floor)]]) {
      const a = s.map(r => f(r) - r.truth), b = s.map(r => applyFloor(r.bayes, r.floor) - r.truth);
      const mean = (x) => x.reduce((p, q) => p + q, 0) / x.length;
      const ma = mean(a), mb = mean(b);
      let va = 0, vb = 0, cv = 0;
      for (let i = 0; i < a.length; i++) { va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; cv += (a[i] - ma) * (b[i] - mb); }
      va /= a.length - 1; vb /= a.length - 1; cv /= a.length - 1;
      const sa = Math.sqrt(va), sb = Math.sqrt(vb), rho = cv / (sa * sb);
      const w = Math.max(0, Math.min(1, (vb - cv) / (va + vb - 2 * cv)));
      const best = Math.sqrt(w * w * va + (1 - w) * (1 - w) * vb + 2 * w * (1 - w) * cv);
      const lbl = lo === 0 && hi === 99 ? "all" : `${lo}-${hi === 99 ? "+" : hi}`;
      console.log(`  ${lbl.padEnd(7)} ${name.padEnd(7)}${String(s.length).padStart(5)}   ${fmt(sb, 2).padStart(7)}  ${fmt(sa, 2).padStart(7)}` +
        `  ${fmt(rho, 2).padStart(5)}  ${fmt(w, 3).padStart(6)}  ${fmt(best, 3).padStart(8)}  ${fmt(sb - best, 3).padStart(11)}`);
    }
  }

  // ---- leave-one-day-out stability of the fitted weights -------------------
  console.log("\n=== weight stability: leave-one-day-out refits (all data) ===");
  const allDates = [...new Set(rows.map(r => r.date))].sort();
  for (let bi = 0; bi < BUCKETS.length; bi++) {
    const cw = [], bw = [], nw = [];
    for (const d of allDates) {
      const sub = rows.filter(r => r.date !== d && bucketOf(r.hrs) === bi);
      if (sub.length < 30) continue;
      const f = fitSimplex(sub, { step: 0.05 });
      cw.push(f.w.claude); bw.push(f.w.bayes); nw.push(f.w.nws);
    }
    if (!cw.length) continue;
    const rng = (a) => `${Math.min(...a).toFixed(2)}–${Math.max(...a).toFixed(2)}`;
    const [lo, hi] = BUCKETS[bi];
    console.log(`  ${String(lo + "-" + (hi === 99 ? "+" : hi)).padEnd(7)} claude ${rng(cw).padEnd(12)} bayes ${rng(bw).padEnd(12)} nws ${rng(nw)}`);
  }
}

main();
