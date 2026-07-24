// Per-city Bayesian/Claude weighting: is there a city where reweighting finds an edge?
//
// Model point = w*bayes + (1-w)*claude, w in [0,1] per city. Two questions, in order:
//   A. ACCURACY. Does a per-city w beat the global w at predicting the settled CLI high,
//      OUT OF SAMPLE? (clean regression, one point per settled city-day — decent n)
//   B. TRADING. Does any city's fitted w produce a bet-level edge that survives OOS?
//
// The trap this guards against: fitting 13 city weights on ~14 days is many hypotheses,
// and the postmortem's 63-cell heterogeneity scan already showed in-sample winners flip
// out of sample. So w is fit on TRAIN days only and every headline number is the held-out
// TEST. A per-city win must beat the global-w baseline on the SAME test days, or it is
// just overfitting one more parameter.
//
// Usage: SNAPSHOTS=snaps.json SCOREBOARD=sb_full.json node analyze_percity_weight.js
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(process.env.SNAPSHOTS || "./snaps.json", "utf-8"))
  .filter(r => r.settle && r.settle.extremumF != null && r.variable === "high");
const sbRaw = JSON.parse(readFileSync(process.env.SCOREBOARD || "./sb_full.json", "utf-8"));
const sb = (Array.isArray(sbRaw) ? sbRaw : sbRaw.records || [])
  .filter(r => r?.bayes?.point != null && r?.claude?.point != null && r.city && r.contract_date && r.asof);

// actual settled high per city|date
const actual = {};
for (const r of rows) actual[`${r.city}|${r.dateLocal}`] = r.settle.extremumF;

// ---- A. ACCURACY -----------------------------------------------------------
// One (bayes, claude, actual) per settled city-day at a FIXED EARLY lead time (~10:00
// local). This is the honest test: taking the LAST record of the day makes RMSE ~0.2°F
// because both legs have converged near the realized max by evening, so the weight looks
// irrelevant for the wrong reason. At 10:00 local bayes and claude diverge ~8°F on
// average (max 17°F) — where the weighting genuinely matters.
const TZ = { "New York": -4, "Boston": -4, "Philadelphia": -4, "Washington DC": -4,
  "Chicago": -5, "Houston": -5, "Dallas-Fort Worth": -5, "San Antonio": -5, "Austin": -5,
  "Denver": -6, "Phoenix": -7, "Los Angeles": -7, "Seattle": -7 };
const TARGET_LOCAL_HR = 10, LEAD_TOL_HR = 2.5;
const byCityDay = new Map();
for (const r of sb) {
  const k = `${r.city}|${r.contract_date}`;
  if (actual[k] == null || TZ[r.city] == null) continue;
  const d = new Date(r.asof);
  const localHr = ((d.getUTCHours() + d.getUTCMinutes() / 60 + TZ[r.city]) + 24) % 24;
  const dist = Math.abs(localHr - TARGET_LOCAL_HR);
  if (dist > LEAD_TOL_HR) continue;
  const cur = byCityDay.get(k);
  if (!cur || dist < cur.dist) byCityDay.set(k, { dist, t: Date.parse(r.asof), city: r.city,
    date: r.contract_date, bayes: r.bayes.point, claude: r.claude.point, actual: actual[k] });
}
const triples = [...byCityDay.values()];
const cities = [...new Set(triples.map(t => t.city))].sort();
const dates = [...new Set(triples.map(t => t.date))].sort();
const mid = dates[Math.floor(dates.length / 2)];
const isTrain = d => d < mid, isTest = d => d >= mid;

const err = (t, w) => (w * t.bayes + (1 - w) * t.claude) - t.actual;
const rmse = (arr, w) => arr.length ? Math.sqrt(arr.reduce((a, t) => a + err(t, w) ** 2, 0) / arr.length) : null;
// fit w on a 0..1 grid minimizing RMSE
function fitW(arr) {
  if (arr.length < 4) return null;
  let best = 1, bestR = Infinity;
  for (let w = 0; w <= 1.0001; w += 0.05) { const r = rmse(arr, w); if (r < bestR) { bestR = r; best = w; } }
  return Math.round(best * 100) / 100;
}

// Global baseline weight, fit on all TRAIN days.
const globalW = fitW(triples.filter(t => isTrain(t.date)));
console.log(`settled city-days ${triples.length}, cities ${cities.length}, dates ${dates[0]}..${dates[dates.length-1]}, split ${mid}`);
console.log(`\nglobal weight (fit on TRAIN) = ${globalW}  [1.0 = pure Bayesian, 0.0 = pure Claude]`);
console.log(`  TEST RMSE @ global w:  ${rmse(triples.filter(t => isTest(t.date)), globalW).toFixed(3)}`);
console.log(`  TEST RMSE @ w=1 (bayes only): ${rmse(triples.filter(t => isTest(t.date)), 1).toFixed(3)}\n`);

console.log("=== A. Per-city weight — does fitting w per city beat global w OUT OF SAMPLE? ===");
console.log("city              nTr nTe  w*    RMSE_test(w*)  RMSE_test(global)  RMSE_test(bayes)   winner");
let sumOwn = 0, sumGlobal = 0, sumBayes = 0, nTeTot = 0, citiesOwnWins = 0;
for (const c of cities) {
  const tr = triples.filter(t => t.city === c && isTrain(t.date));
  const te = triples.filter(t => t.city === c && isTest(t.date));
  if (te.length < 2 || tr.length < 3) continue;
  const w = fitW(tr);
  if (w == null) continue;
  const rOwn = rmse(te, w), rGlob = rmse(te, globalW), rBay = rmse(te, 1);
  for (const t of te) { sumOwn += err(t, w) ** 2; sumGlobal += err(t, globalW) ** 2; sumBayes += err(t, 1) ** 2; }
  nTeTot += te.length;
  const best = Math.min(rOwn, rGlob, rBay);
  const winner = best === rOwn ? "per-city" : best === rGlob ? "global" : "bayes";
  if (winner === "per-city") citiesOwnWins++;
  console.log(`${c.padEnd(17)} ${String(tr.length).padStart(3)} ${String(te.length).padStart(3)}  ${w.toFixed(2)}   `
    + `${rOwn.toFixed(3).padStart(9)}      ${rGlob.toFixed(3).padStart(9)}         ${rBay.toFixed(3).padStart(9)}      ${winner}`);
}
console.log(`\nPOOLED TEST RMSE:  per-city-w ${Math.sqrt(sumOwn/nTeTot).toFixed(3)}   `
  + `global-w ${Math.sqrt(sumGlobal/nTeTot).toFixed(3)}   bayes-only ${Math.sqrt(sumBayes/nTeTot).toFixed(3)}   (n=${nTeTot})`);
console.log(`cities where per-city w won OOS: ${citiesOwnWins}/${cities.filter(c => triples.filter(t=>t.city===c&&isTest(t.date)).length>=2).length}`);

// ---- B. TRADING ------------------------------------------------------------
// For each city, price buckets with that city's TRAIN-fitted w, apply the production
// gate, hold to settlement, and compare TRAIN vs TEST ROI. Nearest scoreboard estimate
// within 6h of each snapshot.
const sbSeq = new Map();
for (const r of sb) {
  const k = `${r.city}|${r.contract_date}`;
  if (!sbSeq.has(k)) sbSeq.set(k, []);
  sbSeq.get(k).push({ t: Date.parse(r.asof), bayes: r.bayes.point, claude: r.claude.point });
}
for (const v of sbSeq.values()) v.sort((a, b) => a.t - b.t);
function nearest(city, date, tsIso) {
  const arr = sbSeq.get(`${city}|${date}`); if (!arr?.length) return null;
  const t = Date.parse(tsIso); let best = arr[0];
  for (const e of arr) if (Math.abs(e.t - t) < Math.abs(best.t - t)) best = e;
  return Math.abs(best.t - t) <= 6 * 3600_000 ? best : null;
}
const MIN_EDGE = 0.28, MIN_HALF_KELLY = 0.20, SIGMA = 2.131, fee = p => 0.07 * (1 - p);
function normCdf(z){const s=z<0?-1:1,a=Math.abs(z)/Math.SQRT2;const t=1/(1+0.3275911*a);return 0.5*(1+s*(1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-a*a)));}
function bp(m,s,lo,hi,fl){let l=(lo==null||lo===-Infinity)?-Infinity:lo-0.5,h=(hi==null||hi===Infinity)?Infinity:hi+0.5;if(fl!=null){if(h<fl)return 0;if(l<fl)l=fl;}return Math.max(0,(h===Infinity?1:normCdf((h-m)/s))-(l===-Infinity?0:normCdf((l-m)/s)));}
const hk=(p,c)=>(c<=0||c>=1)?0:Math.max(0,(p*((1-c)/c)-(1-p))/((1-c)/c))/2;
const won_=(e,lo,hi)=>e>=((lo==null||lo===-Infinity)?-Infinity:lo)&&e<=((hi==null||hi===Infinity)?Infinity:hi);

function trade(city, w, dateFilter) {
  const taken = new Map();
  for (const r of rows) {
    if (r.city !== city || !dateFilter(r.dateLocal)) continue;
    const est = nearest(r.city, r.dateLocal, r.ts); if (!est) continue;
    const mean = w * est.bayes + (1 - w) * est.claude;
    const floor = r.maxSoFar != null ? Math.floor(r.maxSoFar) : null;
    const raw = r.buckets.map(b => bp(mean, SIGMA, b.loInt, b.hiInt, floor));
    const sum = raw.reduce((a, x) => a + x, 0); if (sum <= 0) continue;
    for (let i = 0; i < r.buckets.length; i++) {
      const b = r.buckets[i], p = raw[i] / sum;
      for (const side of ["YES", "NO"]) {
        const price = side === "YES" ? b.yes_ask : b.no_ask;
        if (price == null || price <= 0 || price >= 1) continue;
        const pw = side === "YES" ? p : 1 - p;
        if (pw - price - fee(price) < MIN_EDGE || hk(pw, price) < MIN_HALF_KELLY) continue;
        const key = `${r.dateLocal}|${b.ticker}|${side}`; if (taken.has(key)) continue;
        const won = side === "YES" ? won_(r.settle.extremumF, b.loInt, b.hiInt) : !won_(r.settle.extremumF, b.loInt, b.hiInt);
        taken.set(key, { price, won, pnl: (won ? 1 - price : -price) - fee(price) * price });
      }
    }
  }
  const bets = [...taken.values()];
  const st = bets.reduce((a, b) => a + b.price, 0), pnl = bets.reduce((a, b) => a + b.pnl, 0);
  return { n: bets.length, roi: st > 0 ? pnl / st : 0, pnl, st, win: bets.length ? bets.filter(b => b.won).length / bets.length : 0 };
}

console.log("\n=== B. Per-city trading with the city's TRAIN-fitted weight ===");
console.log("city              w*    TRAIN: n  roi        TEST: n  roi       pnl$");
let tePnl = 0, teSt = 0;
for (const c of cities) {
  const tr = triples.filter(t => t.city === c && isTrain(t.date));
  if (tr.length < 3) continue;
  const w = fitW(tr); if (w == null) continue;
  const trd = trade(c, w, isTrain), ted = trade(c, w, isTest);
  if (trd.n === 0 && ted.n === 0) continue;
  tePnl += ted.pnl; teSt += ted.st;
  console.log(`${c.padEnd(17)} ${w.toFixed(2)}   ${String(trd.n).padStart(4)}  ${(trd.roi*100).toFixed(1).padStart(7)}%   `
    + `${String(ted.n).padStart(4)}  ${(ted.roi*100).toFixed(1).padStart(7)}%   ${ted.pnl.toFixed(2).padStart(6)}`);
}
console.log(`\nPER-CITY-FITTED PORTFOLIO, TEST: $${tePnl.toFixed(2)} on $${teSt.toFixed(2)} = ${teSt>0?(tePnl/teSt*100).toFixed(1):"0"}% out of sample`);
console.log("(A per-city weight is 13 extra fitted parameters. Judge only the TEST column,");
console.log(" and only against the global-w baseline — an in-sample win here is expected and worthless.)");
