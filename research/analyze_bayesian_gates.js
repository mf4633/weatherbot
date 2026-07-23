#!/usr/bin/env node
// Bayesian gate replacement + LOO-CV backtest. Compares four strategies on
// 138 settled bets:
//
//   (A) NO GATE        : place every admitted bet (= the existing data)
//   (B) CURRENT HEURISTIC : ev≥0.20, hk≥0.10, price≥0.04 (production pre-2026-05-13)
//   (C) STAGED HEURISTIC  : minEdgeFor(b) (0.20 HIGH, 0.30 LOW), hk≥0.15, price≥0.10
//                           (the in-sample-tuned thresholds I staged this turn)
//   (D) BAYESIAN EV       : Beta-Binomial posterior on win-rate per (variable,
//                           price-band) cell, weakly informative prior Beta(2,3).
//                           Place iff posterior E[pnl] > 0.
//
// Each bet is scored via leave-one-out: for bet i in cell c, the Bayesian
// strategy uses posterior fit from all OTHER bets in c. Eliminates the
// in-sample winner's-curse problem that contaminated the heuristic sweep.
//
// Output: total realized P&L under each strategy, plus per-cell diagnostics.

const BASE = "https://weatherbot-mf.netlify.app";
const auth = process.env.AUTH || "x:hydro";

// Prior: Beta(2, 3). Mean = 0.40, ess = 5 prior bets. Weakly informative —
// shrinks small-cell estimates toward a moderate win-rate but is rapidly
// dominated by data once cells fill.
const PRIOR_A = 2, PRIOR_B = 3;

function priceBand(price) {
  if (price == null) return "unknown";
  if (price <= 0.10) return "cheap-tail";
  if (price < 0.45)  return "mid-low";
  if (price < 0.65)  return "mid-high";
  return "favorite";
}
function cellKey(b) { return `${b.variable || "?"}|${priceBand(b.price)}`; }

async function fetchBets() {
  const r = await fetch(`${BASE}/.netlify/functions/jackson_audit`, {
    headers: { authorization: `Basic ${Buffer.from(auth).toString("base64")}` }
  });
  if (!r.ok) throw new Error(`audit ${r.status}`);
  const j = await r.json();
  return (j.temp || []).filter(b => b.outcome === "WIN" || b.outcome === "LOSS");
}

// Build LOO posterior P(win) for each bet given its cell.
function looPosteriors(bets) {
  // Pre-count wins and losses per cell.
  const cellWins   = {}, cellLosses = {};
  for (const b of bets) {
    const k = cellKey(b);
    cellWins[k]   = (cellWins[k]   || 0) + (b.outcome === "WIN"  ? 1 : 0);
    cellLosses[k] = (cellLosses[k] || 0) + (b.outcome === "LOSS" ? 1 : 0);
  }
  // Per-bet LOO: subtract this bet's outcome from its cell counts, then
  // posterior mean = (PRIOR_A + W_loo) / (PRIOR_A + PRIOR_B + W_loo + L_loo).
  const out = [];
  for (const b of bets) {
    const k = cellKey(b);
    let W = cellWins[k], L = cellLosses[k];
    if (b.outcome === "WIN")  W -= 1; else L -= 1;
    const pWinPost = (PRIOR_A + W) / (PRIOR_A + PRIOR_B + W + L);
    out.push({ bet: b, cell: k, pWinPost, cellWLoo: W, cellLLoo: L });
  }
  return out;
}

// Realized P&L if we PLACED this bet (look it up from settled record).
function placedPnl(b) { return b.realized_pnl ?? 0; }

// Strategy decision functions. Return true to PLACE the bet, false to skip.
const strategies = {
  "A: no-gate":           (b, post) => true,
  "B: heuristic current": (b, post) =>
    (b.ev ?? 0) >= 0.20 && (b.halfKelly ?? 0) >= 0.10 && (b.price ?? 0) >= 0.04,
  "C: heuristic staged":  (b, post) => {
    const minEdge = b.variable === "low" ? 0.30 : 0.20;
    return (b.ev ?? 0) >= minEdge && (b.halfKelly ?? 0) >= 0.15 && (b.price ?? 0) >= 0.10;
  },
  "D: bayesian EV (cell only)":  (b, post) => {
    // Uses ONLY the cell-level empirical posterior, ignoring the model's pWin.
    // Discards within-cell conviction signal (halfKelly).
    const fee = 0.07 * (1 - b.price);
    const eVal = post.pWinPost - b.price - post.pWinPost * fee;
    return eVal > 0;
  },
  "E: bayesian shrinkage":       (b, post) => {
    // Hierarchical Bayes: shrink the model's pWin toward the cell empirical mean.
    // Weight = data strength / (data strength + model strength). Model's intrinsic
    // calibration uncertainty σ_p ~ 0.10 (from Kelly-LCB delta-method work);
    // that maps to a "prior strength" of ~25 effective observations.
    const fee = 0.07 * (1 - b.price);
    const pWinModel = (b.ev ?? 0) + b.price + fee;  // invert ev = (pWin - price) - fee
    const nCell = post.cellWLoo + post.cellLLoo;
    const MODEL_PRIOR_N = 25;  // model's effective sample size
    const w = nCell / (nCell + MODEL_PRIOR_N);     // 0 = trust model, 1 = trust data
    const pWinShrunk = w * post.pWinPost + (1 - w) * pWinModel;
    const eVal = pWinShrunk - b.price - pWinShrunk * fee;
    return eVal > 0;
  }
};

// Evaluate each strategy on the LOO posteriors.
function evaluate(strategyFn, posteriors) {
  let nPlaced = 0, nSkipped = 0, totalPnl = 0, totalStake = 0;
  let wins = 0, losses = 0;
  for (const p of posteriors) {
    if (strategyFn(p.bet, p)) {
      nPlaced++;
      totalPnl += placedPnl(p.bet);
      totalStake += p.bet.stake_dollars ?? 0;
      if (p.bet.outcome === "WIN")  wins++;
      if (p.bet.outcome === "LOSS") losses++;
    } else {
      nSkipped++;
    }
  }
  const hitRate = wins / (wins + losses || 1);
  const roi = totalStake > 0 ? totalPnl / totalStake : 0;
  return { nPlaced, nSkipped, totalPnl, totalStake, wins, losses, hitRate, roi };
}

async function main() {
  const bets = await fetchBets();
  console.log(`Loaded ${bets.length} settled WIN/LOSS bets.\n`);

  // Show cell composition.
  const cells = {};
  for (const b of bets) { (cells[cellKey(b)] ??= []).push(b); }
  console.log("Cell composition (variable | price-band):");
  for (const k of Object.keys(cells).sort()) {
    const bs = cells[k];
    const w = bs.filter(b => b.outcome === "WIN").length;
    const l = bs.filter(b => b.outcome === "LOSS").length;
    const hr = w / (w + l || 1);
    console.log(`  ${k.padEnd(22)}  n=${String(bs.length).padStart(3)}  W=${String(w).padStart(2)}  L=${String(l).padStart(2)}  hit=${(hr*100).toFixed(1)}%`);
  }
  console.log();

  const posteriors = looPosteriors(bets);

  // Show LOO posterior means by cell (just one example per cell, since LOO
  // changes by ~1 bet they're all near identical within a cell).
  console.log("LOO posterior P(win) by cell (Beta-Binomial, prior Beta(2,3)):");
  const shown = new Set();
  for (const p of posteriors) {
    if (shown.has(p.cell)) continue;
    shown.add(p.cell);
    console.log(`  ${p.cell.padEnd(22)}  W_loo=${p.cellWLoo}  L_loo=${p.cellLLoo}  pWin_post=${p.pWinPost.toFixed(3)}`);
  }
  console.log();

  console.log("=".repeat(86));
  console.log("STRATEGY COMPARISON (LOO-CV; each bet scored using posterior from all OTHER bets)");
  console.log("=".repeat(86));
  console.log(`strategy             | placed | wins | losses | hit-rate | stake     | P&L     | ROI`);
  console.log("-".repeat(86));
  const order = ["A: no-gate", "B: heuristic current", "C: heuristic staged", "D: bayesian EV (cell only)", "E: bayesian shrinkage"];
  const results = {};
  for (const name of order) {
    const r = evaluate(strategies[name], posteriors);
    results[name] = r;
    console.log(`${name.padEnd(20)} | ${String(r.nPlaced).padStart(6)} | ${String(r.wins).padStart(4)} | ${String(r.losses).padStart(6)} |  ${(r.hitRate*100).toFixed(1).padStart(5)}%  | $${r.totalStake.toFixed(2).padStart(7)} | $${r.totalPnl.toFixed(2).padStart(6)} | ${(r.roi*100).toFixed(1)}%`);
  }
  console.log();

  const noGate = results["A: no-gate"].totalPnl;

  console.log("=== Δ vs no-gate baseline ===");
  for (const name of order.slice(1)) {
    const r = results[name];
    const delta = r.totalPnl - noGate;
    console.log(`  ${name.padEnd(30)}: $${delta >= 0 ? "+" : ""}${delta.toFixed(2)} (placed ${r.nPlaced}/${bets.length})`);
  }

  console.log("\n=== Pairwise: bootstrap 95% CI on P&L difference (Bayesian variant − staged heuristic) ===");
  const n = posteriors.length;
  const NBOOT = 4000;
  for (const challenger of ["D: bayesian EV (cell only)", "E: bayesian shrinkage"]) {
    const diffs = [];
    for (let i = 0; i < NBOOT; i++) {
      let challPnl = 0, stgPnl = 0;
      for (let j = 0; j < n; j++) {
        const p = posteriors[Math.floor(Math.random() * n)];
        if (strategies[challenger](p.bet, p))         challPnl += placedPnl(p.bet);
        if (strategies["C: heuristic staged"](p.bet, p)) stgPnl += placedPnl(p.bet);
      }
      diffs.push(challPnl - stgPnl);
    }
    diffs.sort((a, b) => a - b);
    const lo  = diffs[Math.floor(0.025 * NBOOT)];
    const hi  = diffs[Math.floor(0.975 * NBOOT)];
    const med = diffs[Math.floor(0.5 * NBOOT)];
    let verdict;
    if (lo > 0)      verdict = "Bayesian significantly BETTER";
    else if (hi < 0) verdict = "Staged heuristic significantly BETTER";
    else             verdict = "no significant difference";
    console.log(`  ${challenger.padEnd(30)} median=$${med.toFixed(2)}  95% CI [$${lo.toFixed(2)}, $${hi.toFixed(2)}]  → ${verdict}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
