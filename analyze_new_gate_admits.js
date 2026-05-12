#!/usr/bin/env node
// Forward-monitor for the 331d06c freshness-gate change. Pulls settled bets via the
// jackson_audit endpoint, filters to bets the OLD gate would have rejected (nwsGridAgeMin > 180)
// but the NEW gate admitted (dataAgeMin <= 180), and compares hit rate / P&L to the population.
//
// Run: AUTH="x:hydro" node analyze_new_gate_admits.js
// Pre-requisite: at least ~30-50 settled bets carrying inputAgesAtBet (clock started 2026-05-12
// with commit ffa9b99). Earlier bets have inputAgesAtBet === undefined and are skipped from
// both samples — the comparison is conditional on bets placed after instrumentation landed.

const BASE = "https://weatherbot-mf.netlify.app";
const auth = process.env.AUTH || "x:hydro";

async function main() {
  const r = await fetch(`${BASE}/.netlify/functions/jackson_audit`, {
    headers: { authorization: `Basic ${Buffer.from(auth).toString("base64")}` }
  });
  if (!r.ok) { console.error("audit fetch failed", r.status); process.exit(1); }
  const j = await r.json();
  const all = (j.weather_settled || j.settled || []).filter(b => b.inputAgesAtBet);

  const newGateAdmits = all.filter(b =>
    b.inputAgesAtBet.nwsGridAgeMin != null && b.inputAgesAtBet.nwsGridAgeMin > 180
    && b.inputAgesAtBet.dataAgeMin   != null && b.inputAgesAtBet.dataAgeMin   <= 180);
  const baselineBets = all.filter(b => !newGateAdmits.includes(b));

  const summarize = (bets, label) => {
    if (!bets.length) { console.log(`${label}: n=0`); return; }
    const wins   = bets.filter(b => b.outcome === "WIN").length;
    const losses = bets.filter(b => b.outcome === "LOSS").length;
    const pnl    = bets.reduce((a, b) => a + (b.realized_pnl ?? 0), 0);
    const stake  = bets.reduce((a, b) => a + (b.stake_dollars ?? 0), 0);
    const hitRate = wins / (wins + losses || 1);
    const roi     = stake > 0 ? pnl / stake : 0;
    console.log(`${label}: n=${bets.length} wins=${wins} losses=${losses} `
              + `hit=${(hitRate * 100).toFixed(1)}% pnl=$${pnl.toFixed(2)} `
              + `stake=$${stake.toFixed(2)} roi=${(roi * 100).toFixed(1)}%`);
  };

  console.log(`Total instrumented settled bets: ${all.length}`);
  summarize(newGateAdmits,  "NEW-GATE ADMITS (old would reject)");
  summarize(baselineBets,   "BASELINE             (old also admitted)");

  if (newGateAdmits.length < 30) {
    console.log(`\n⚠ n=${newGateAdmits.length} too small for confident comparison; resume at ~30-50.`);
  } else {
    // Beta-Binomial posterior on the hit-rate difference. Uniform priors.
    const aN = 1 + newGateAdmits.filter(b => b.outcome === "WIN").length;
    const bN = 1 + newGateAdmits.filter(b => b.outcome === "LOSS").length;
    const aB = 1 + baselineBets.filter(b => b.outcome === "WIN").length;
    const bB = 1 + baselineBets.filter(b => b.outcome === "LOSS").length;
    const sample = () => {
      const g = (a, b) => { let s = 0; for (let i = 0; i < 60; i++) s += Math.random(); return s / 60; }; // crude
      return [g(aN, bN), g(aB, bB)];  // placeholder — replace with proper Beta sampler if needed
    };
    console.log(`\nBeta-Binomial posterior shapes: new=Beta(${aN},${bN}) baseline=Beta(${aB},${bB})`);
    console.log(`Replace the crude sampler with @stdlib/random-base-beta or similar for real inference.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
