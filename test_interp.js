// lib/interp_knyc.js — port-parity tests against the interpolatornyc upload's
// documented behavior, including its worked example:
//   (76.6·1.0 + 77.4·0.85 + 75.0·1.2) / 3.05 = 76.2
import {
  weightedPolyfit, recencyWeight, mergeKnycPws, stationStats, stationWeights,
  fitPeakBias, peakBiasFactor, applyPeakBias, pwsRegressionEstimate,
  deltaNowcast, blendNowEstimate,
} from "./netlify/functions/lib/interp_knyc.js";

let pass = 0, fail = 0;
const approx = (a, b, t = 0.01) => a != null && Math.abs(a - b) <= t;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// --- WLS: exact recovery of a known line under uniform weights ---
{
  const x = [70, 75, 80, 85, 90], y = x.map(v => 0.6 * v + 25), w = x.map(() => 1);
  const f = weightedPolyfit(x, y, w);
  ok("WLS recovers slope 0.6", approx(f.slope, 0.6, 1e-9));
  ok("WLS recovers intercept 25", approx(f.intercept, 25, 1e-6));
  const g = weightedPolyfit([80, 80, 80], [76, 77, 78], [1, 1, 1]);
  ok("WLS degenerate x → slope 0, intercept ybar", g.slope === 0 && approx(g.intercept, 77));
}

// --- recency weights: 12h half-life is e-folding, not power-of-two ---
ok("recency: age 0 → 1", recencyWeight(0) === 1);
ok("recency: age 12h → e^-1", approx(recencyWeight(12), Math.exp(-1), 1e-9));

// --- pairing: PWS max in (t-1h, t], per station ---
{
  const H = 3600e3, t = 100 * H;
  const knyc = [{ tsMs: t, tempF: 80 }];
  const pws = [
    { tsMs: t - 0.5 * H, station: "A", tempF: 84 },
    { tsMs: t - 0.2 * H, station: "A", tempF: 86 },   // max in window
    { tsMs: t - 1.5 * H, station: "A", tempF: 99 },   // outside window
    { tsMs: t, station: "B", tempF: 82 },              // boundary inclusive
  ];
  const pairs = mergeKnycPws(knyc, pws);
  ok("pairing: station A gets window max 86", pairs.find(p => p.station === "A").proxy === 86);
  ok("pairing: boundary ob (== t) included", pairs.find(p => p.station === "B").proxy === 82);
  ok("pairing: 2 stations → 2 pairs", pairs.length === 2);
}

// --- station stats + combination weights ---
{
  const H = 3600e3, now = 200 * H;
  // 8 clean pairs on a known line for station A; station B noisier
  const pairs = [];
  for (let i = 0; i < 8; i++) {
    const proxy = 70 + i * 2;
    pairs.push({ hourMs: now - i * H, station: "A", knyc: 0.6 * proxy + 25, proxy });
    pairs.push({ hourMs: now - i * H, station: "B", knyc: 0.6 * proxy + 25 + (i % 2 ? 2 : -2), proxy });
  }
  const a = stationStats(pairs, "A", now), b = stationStats(pairs, "B", now);
  ok("stats: A slope ≈ 0.6, rmse ≈ 0", approx(a.slope, 0.6, 1e-6) && a.rmse < 1e-6);
  ok("stats: B rmse ≈ 2", approx(b.rmse, 2, 0.1));
  ok("stats: n<6 → null", stationStats(pairs.slice(0, 4), "A", now) === null);
  const w = stationWeights([a, b]);
  ok("weights: clean station dominates", w.find(s => s.station === "A").weight > 0.95);
  ok("weights: normalized", approx(w.reduce((x, s) => x + s.weight, 0), 1, 1e-9));
}

// --- peak bias: ramp + 65% application + clip ---
ok("peakBiasFactor: 84 → 0", peakBiasFactor(84) === 0);
ok("peakBiasFactor: 90 → 0.5", approx(peakBiasFactor(90), 0.5, 1e-9));
ok("peakBiasFactor: 96 → 1", peakBiasFactor(96) === 1);
ok("applyPeakBias: est+bias·factor·0.65", approx(applyPeakBias(95, 95, 2), 95 + 2 * 1 * 0.65, 1e-9));
{
  const H = 3600e3, now = 50 * H;
  const stats = [{ station: "A", slope: 1, intercept: 0, r: 1, rmse: 0.5 }];
  // residual +5 on hot hours (clip to 3); cool hours ignored
  const pairs = [
    { hourMs: now - H, station: "A", knyc: 95, proxy: 90 },
    { hourMs: now - 2 * H, station: "A", knyc: 96, proxy: 91 },
    { hourMs: now - 3 * H, station: "A", knyc: 80, proxy: 75 },  // < 90F, excluded
  ];
  ok("fitPeakBias clips to 3", fitPeakBias(pairs, stats, now) === 3);
  ok("fitPeakBias 0 with no hot hours", fitPeakBias(pairs.slice(2), stats, now) === 0);
}

// --- the upload's documented blend example: 76.6 / 77.4 / 75.0 → 76.2 ---
{
  const nowMs = Date.now();
  const est = blendNowEstimate(76.6, { tempF: 75.0, tsMs: nowMs - 30 * 60e3 }, 77.4, nowMs);
  ok("blend worked example → 76.2 (anchor <1h, weight 1.2)", approx(est, 76.2, 0.05));
  const est2 = blendNowEstimate(76.6, { tempF: 75.0, tsMs: nowMs - 90 * 60e3 }, 77.4, nowMs);
  ok("blend: 1-2h anchor downweighted to 0.7 (pulls less)", est2 > est);
  const est3 = blendNowEstimate(76.6, { tempF: 75.0, tsMs: nowMs - 3 * 3600e3 }, 77.4, nowMs);
  ok("blend: stale anchor (>2h) dropped", approx(est3, (76.6 + 0.85 * 77.4) / 1.85, 1e-9));
  ok("blend: regression only when nothing else", blendNowEstimate(76.6, null, null, nowMs) === 76.6);
}

// --- delta nowcast: level-anchored, r²-weighted trend ---
{
  const stats = [
    { station: "A", slope: 0.6, intercept: 25, r: 1.0, rmse: 0.5 },
    { station: "B", slope: 1.0, intercept: 0, r: 0.0, rmse: 2 },   // r=0 → zero weight
  ];
  const d = deltaNowcast(75, { A: 78, B: 70 }, [{ station: "A", tempF: 82 }, { station: "B", tempF: 99 }], stats);
  ok("delta nowcast: 75 + 0.6·(82−78) = 77.4", approx(d, 77.4, 1e-9));
  ok("delta nowcast: null without anchors", deltaNowcast(75, {}, [{ station: "A", tempF: 82 }], stats) === null);
}

// --- regression estimate combines stations by weight ---
{
  const w = stationWeights([
    { station: "A", slope: 0.6, intercept: 25, r: 0.98, rmse: 0.5 },
    { station: "B", slope: 0.8, intercept: 10, r: 0.9, rmse: 2 },
  ]);
  const r = pwsRegressionEstimate(w, [{ station: "A", tempF: 85 }, { station: "B", tempF: 85 }], 0);
  const estA = 0.6 * 85 + 25, estB = 0.8 * 85 + 10;
  ok("regression estimate between per-station values", r.estimate > Math.min(estA, estB) && r.estimate < Math.max(estA, estB));
  ok("regression estimate leans to the better station", Math.abs(r.estimate - estA) < Math.abs(r.estimate - estB));
}

// --- selectStations: quality gate + top-N by combination weight ---
{
  const { selectStations } = await import("./netlify/functions/lib/interp_knyc.js");
  const mk = (station, r, rmse) => ({ station, r, rmse, slope: 1, intercept: 0, n: 10 });
  const stats = [
    mk("GOOD1", 0.98, 0.6), mk("GOOD2", 0.95, 1.0), mk("OK", 0.85, 2.0),
    mk("NOISY", 0.9, 5.0),      // rmse > 4 → filtered
    mk("UNCORR", 0.4, 1.0),     // r² < 0.5 → filtered
    mk("G3", 0.92, 1.2), mk("G4", 0.9, 1.5), mk("G5", 0.88, 1.8), mk("G6", 0.87, 1.9),
  ];
  const sel = selectStations(stats, 6);
  ok("selectStations keeps 6", sel.length === 6);
  ok("selectStations drops noisy + uncorrelated", !sel.includes("NOISY") && !sel.includes("UNCORR"));
  ok("selectStations best station first", sel[0] === "GOOD1");
  ok("selectStations falls back when all filtered", selectStations([mk("A", 0.3, 9), mk("B", 0.2, 9)], 6).length === 2);
}

// --- ramp floor: never below a fresh anchor while the trace is rising ---
{
  const nowMs = Date.now();
  const freshAnchor = { tempF: 82, tsMs: nowMs - 10 * 60e3 };
  const low = blendNowEstimate(80.7, freshAnchor, 81.5, nowMs, true);
  ok("ramp floor: rising + fresh anchor → est >= anchor", low >= 82);
  const noFloor = blendNowEstimate(80.7, freshAnchor, 81.5, nowMs, false);
  ok("ramp floor: not rising → original blend (below anchor ok)", noFloor < 82);
  const staleAnchor = { tempF: 82, tsMs: nowMs - 40 * 60e3 };
  ok("ramp floor: stale anchor (>20min) not floored", blendNowEstimate(80.7, staleAnchor, 81.5, nowMs, true) < 82);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
