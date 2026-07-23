// The post-peak predictive distribution, measured.
//
// Reframing (2026-07-23): I claimed the model's late-day upper mass was on "impossible"
// buckets. That was WRONG. Kalshi HIGH settles on the NWS CLI daily high, computed from
// 1-minute ASOS, which routinely lands ABOVE the :53 routine METAR max — see
// reference_cli_metar_gap (KLAX mean +0.92, max +3). So a bucket above the observed
// METAR max is not impossible; its fair price is the frequency of a gap that large.
//
// The quantity that actually belongs in the model post-peak is therefore NOT "sigma
// shrunk toward zero at maxSoFar" but the empirical distribution of
//     gap(h) = CLI_high - maxSoFar_from_METAR(h)
// per station, per local hour. That distribution is the predictive model once the day's
// heating is done. This measures it over 2025-01-01 -> present (~570 station-days each)
// rather than the 12-day sample the gap was first spotted on.
//
// CAVEAT: maxSoFar here is routine-METAR-only (report_type=3). The live bot merges METAR
// + 1-minute ASOS + DSM, so its maxSoFar is >= this and its true gap is SMALLER. This
// measurement is therefore an UPPER bound on the gap the bot faces. Where 1-min is
// flowing the correction shrinks; where it is not (KLAX today read 80.1, a METAR T-group
// value) this is the right number.
//
// Run: node analyze_cli_gap.js          (caches raw pulls under _cli_cache/)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const CACHE = "_cli_cache";
if (!existsSync(CACHE)) mkdirSync(CACHE);

// The 13 cities with live Kalshi HIGH series.
const STATIONS = [
  { cli: "NYC", asos: "NYC", tz: "America/New_York" },
  { cli: "LAX", asos: "LAX", tz: "America/Los_Angeles" },
  { cli: "MDW", asos: "MDW", tz: "America/Chicago" },
  { cli: "HOU", asos: "HOU", tz: "America/Chicago" },
  { cli: "PHX", asos: "PHX", tz: "America/Phoenix" },
  { cli: "PHL", asos: "PHL", tz: "America/New_York" },
  { cli: "SAT", asos: "SAT", tz: "America/Chicago" },
  { cli: "DFW", asos: "DFW", tz: "America/Chicago" },
  { cli: "AUS", asos: "AUS", tz: "America/Chicago" },
  { cli: "SEA", asos: "SEA", tz: "America/Los_Angeles" },
  { cli: "DEN", asos: "DEN", tz: "America/Denver" },
  { cli: "DCA", asos: "DCA", tz: "America/New_York" },
  { cli: "BOS", asos: "BOS", tz: "America/New_York" },
];
const YEARS = [2025, 2026];
const HOURS = [14, 15, 16, 17, 18, 19, 20, 21, 22];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// IEM rate-limits; memory says 5-25s backoff on 429/503.
async function getCached(name, url, parse) {
  const path = `${CACHE}/${name}`;
  if (existsSync(path)) return parse(readFileSync(path, "utf-8"));
  let delay = 5000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url);
    if (r.ok) {
      const txt = await r.text();
      if (txt && txt.length > 50) { writeFileSync(path, txt); await sleep(1200); return parse(txt); }
    }
    console.log(`   retry ${name} (status ${r.status}) in ${delay / 1000}s`);
    await sleep(delay); delay = Math.min(25000, delay * 2);
  }
  console.log(`   FAILED ${name}`);
  return null;
}

const cliUrl = (st, y) => `https://mesonet.agron.iastate.edu/json/cli.py?station=K${st}&year=${y}`;
const asosUrl = (st, tz, y) =>
  `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${st}&data=tmpf`
  + `&year1=${y}&month1=1&day1=1&year2=${y}&month2=12&day2=31`
  + `&tz=${encodeURIComponent(tz)}&format=onlycomma&latlon=no&report_type=3&missing=empty`;

const gapsByStation = {}, gapsByHour = {};
for (const s of STATIONS) {
  // CLI daily highs.
  const cliByDate = {};
  for (const y of YEARS) {
    const j = await getCached(`cli_${s.cli}_${y}.json`, cliUrl(s.cli, y), JSON.parse);
    if (!j?.results) continue;
    for (const r of j.results) {
      if (r.high == null || r.high === "M") continue;
      cliByDate[r.valid] = Number(r.high);
    }
  }
  // Hourly METAR, local time.
  const obsByDate = {};
  for (const y of YEARS) {
    const csv = await getCached(`asos_${s.asos}_${y}.csv`, asosUrl(s.asos, s.tz, y), t => t);
    if (!csv) continue;
    for (const line of csv.split("\n")) {
      const p = line.split(",");
      if (p.length < 3 || p[0] === "station") continue;
      const t = parseFloat(p[2]);
      if (!isFinite(t)) continue;
      const [d, hm] = p[1].split(" ");
      if (!hm) continue;
      (obsByDate[d] ??= []).push({ h: parseInt(hm.slice(0, 2), 10), t });
    }
  }
  let n = 0;
  for (const [date, cliHigh] of Object.entries(cliByDate)) {
    const obs = obsByDate[date];
    if (!obs || obs.length < 20) continue;
    for (const h of HOURS) {
      const upto = obs.filter(o => o.h <= h);
      if (!upto.length) continue;
      const maxSoFar = Math.max(...upto.map(o => o.t));
      const gap = cliHigh - maxSoFar;
      (gapsByStation[s.cli] ??= {});
      (gapsByStation[s.cli][h] ??= []).push(gap);
      (gapsByHour[h] ??= []).push(gap);
    }
    n++;
  }
  console.log(`${s.cli}: ${n} station-days`);
}

function dist(arr) {
  if (!arr?.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length, mean: m,
    sd: Math.sqrt(s.reduce((a, x) => a + (x - m) ** 2, 0) / s.length),
    p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s[s.length - 1],
    // Settlement lands in the bucket containing maxSoFar only when the gap is small
    // enough not to cross a bucket edge; these are the decision-relevant masses.
    pLE0: s.filter(x => x <= 0).length / s.length,
    pGE1: s.filter(x => x >= 1).length / s.length,
    pGE2: s.filter(x => x >= 2).length / s.length,
    pGE3: s.filter(x => x >= 3).length / s.length,
  };
}

console.log("\n=== gap = CLI_high - METAR_maxSoFar(h),  ALL STATIONS POOLED ===");
console.log("hour   n       mean    sd     p50   p90   p99   max    P(<=0)  P(>=1)  P(>=2)  P(>=3)");
for (const h of HOURS) {
  const d = dist(gapsByHour[h]); if (!d) continue;
  console.log(`${String(h).padStart(4)}  ${String(d.n).padEnd(7)} ${d.mean.toFixed(2).padStart(5)}  ${d.sd.toFixed(2).padStart(5)}  `
    + `${String(d.p50).padStart(4)}  ${String(d.p90).padStart(4)}  ${String(d.p99).padStart(4)}  ${String(d.max).padStart(4)}   `
    + `${(d.pLE0 * 100).toFixed(1)}%   ${(d.pGE1 * 100).toFixed(1)}%   ${(d.pGE2 * 100).toFixed(1)}%   ${(d.pGE3 * 100).toFixed(1)}%`);
}

console.log("\n=== per station, at hour 18 and 20 local ===");
console.log("station   h=18: mean  P(>=1)  P(>=2)  P(>=3)    |  h=20: mean  P(>=1)  P(>=2)  P(>=3)");
for (const s of STATIONS) {
  const a = dist(gapsByStation[s.cli]?.[18]), b = dist(gapsByStation[s.cli]?.[20]);
  if (!a || !b) { console.log(`${s.cli.padEnd(9)} (insufficient)`); continue; }
  console.log(`${s.cli.padEnd(9)} ${a.mean.toFixed(2).padStart(5)}  ${(a.pGE1 * 100).toFixed(1).padStart(5)}%  ${(a.pGE2 * 100).toFixed(1).padStart(5)}%  ${(a.pGE3 * 100).toFixed(1).padStart(5)}%`
    + `    |  ${b.mean.toFixed(2).padStart(5)}  ${(b.pGE1 * 100).toFixed(1).padStart(5)}%  ${(b.pGE2 * 100).toFixed(1).padStart(5)}%  ${(b.pGE3 * 100).toFixed(1).padStart(5)}%`);
}

// What the flat sigma=2.131 implies vs what the data says, at hour 20.
console.log("\n=== flat sigma=2.131 vs measured, hour 20 pooled ===");
{
  const d = dist(gapsByHour[20]);
  if (d) {
    console.log(`  measured: mean ${d.mean.toFixed(2)}  sd ${d.sd.toFixed(2)}  P(gap>=2) ${(d.pGE2 * 100).toFixed(1)}%  P(gap>=3) ${(d.pGE3 * 100).toFixed(1)}%`);
    console.log(`  a N(mu=maxSoFar+${d.mean.toFixed(2)}, sigma=2.131) would give P(gap>=2) ~ `
      + `${((1 - normCdf((2 - d.mean) / 2.131)) * 100).toFixed(1)}%  P(gap>=3) ~ ${((1 - normCdf((3 - d.mean) / 2.131)) * 100).toFixed(1)}%`);
    console.log(`  implied honest sigma for the post-peak gap: ${d.sd.toFixed(2)}F`);
  }
}
function normCdf(z) {
  const s = z < 0 ? -1 : 1; z = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}
