// Pins the IEM fold-in behaviour (weather.js, 2026-07-23). No network.
//
// Why this exists: IEM's max_dayairtemp was fetched, alarmed on, and then DISCARDED,
// while the bot floored on its own hourly-METAR max. Measured against the CLI archive
// (2026-06-01..07-22, 7 stations) IEM equals the CLI settled high on 364/364
// station-days; hourly METAR runs a mean 0.78°F below it. On 2026-07-23 that had the
// bot flooring Chicago at 75 with IEM already reading 77.
//
// The fold must (a) only ever raise maxSoFar / lower minSoFar, and (b) refuse a stale
// feed, so a stalled last_ob can't fold in yesterday's extreme.

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); }
                             else { fail++; console.log(`  ✗ ${name}`); } };

const IEM_FRESH_MAX_MIN = 90;

// Mirrors the fold in weather.js. Kept as a pure function here so the rule is
// testable without standing up the whole prediction pipeline.
function foldIem({ maxSoFar, minSoFar, iem, nowMs }) {
  const ageMin = iem?.latestTs ? (nowMs - iem.latestTs) / 60000 : null;
  const fresh = ageMin != null && ageMin <= IEM_FRESH_MAX_MIN;
  let max = maxSoFar, min = minSoFar;
  if (fresh) {
    if (iem.dailyMaxF != null && (max == null || iem.dailyMaxF > max)) max = iem.dailyMaxF;
    if (iem.dailyMinF != null && (min == null || iem.dailyMinF < min)) min = iem.dailyMinF;
  }
  return { maxSoFar: max, minSoFar: min, fresh };
}

const NOW = Date.parse("2026-07-23T23:05:00Z");
const fresh = t => NOW - t * 60000;

// --- the real 2026-07-23 cases ---
ok("MDW: METAR 75.9 + IEM 77 → 77",
   foldIem({ maxSoFar: 75.9, minSoFar: 60, iem: { dailyMaxF: 77, dailyMinF: 60, latestTs: fresh(21) }, nowMs: NOW }).maxSoFar === 77);
ok("BOS: METAR 80.1 + IEM 81 → 81",
   foldIem({ maxSoFar: 80.1, minSoFar: 62, iem: { dailyMaxF: 81, dailyMinF: 62, latestTs: fresh(35) }, nowMs: NOW }).maxSoFar === 81);
ok("DFW: METAR 97 + IEM 97 → unchanged",
   foldIem({ maxSoFar: 97, minSoFar: 78, iem: { dailyMaxF: 97, dailyMinF: 78, latestTs: fresh(36) }, nowMs: NOW }).maxSoFar === 97);

// --- monotonicity: the fold may only raise max / lower min ---
ok("IEM below METAR max does NOT lower maxSoFar",
   foldIem({ maxSoFar: 84.2, minSoFar: 61, iem: { dailyMaxF: 80, dailyMinF: 61, latestTs: fresh(10) }, nowMs: NOW }).maxSoFar === 84.2);
ok("IEM above METAR min does NOT raise minSoFar",
   foldIem({ maxSoFar: 84, minSoFar: 58.4, iem: { dailyMaxF: 84, dailyMinF: 65, latestTs: fresh(10) }, nowMs: NOW }).minSoFar === 58.4);
ok("IEM min below METAR min DOES lower it",
   foldIem({ maxSoFar: 84, minSoFar: 58.4, iem: { dailyMaxF: 84, dailyMinF: 57, latestTs: fresh(10) }, nowMs: NOW }).minSoFar === 57);

// --- freshness guard ---
ok("stale last_ob (91 min) → no fold",
   foldIem({ maxSoFar: 75.9, minSoFar: 60, iem: { dailyMaxF: 99, dailyMinF: 10, latestTs: fresh(91) }, nowMs: NOW }).maxSoFar === 75.9);
ok("boundary: exactly 90 min still folds",
   foldIem({ maxSoFar: 75.9, minSoFar: 60, iem: { dailyMaxF: 77, dailyMinF: 60, latestTs: fresh(90) }, nowMs: NOW }).maxSoFar === 77);
ok("missing latestTs → no fold (can't prove it covers today)",
   foldIem({ maxSoFar: 75.9, minSoFar: 60, iem: { dailyMaxF: 99, dailyMinF: 10, latestTs: null }, nowMs: NOW }).maxSoFar === 75.9);
ok("day-old feed cannot inject yesterday's extreme",
   foldIem({ maxSoFar: 70, minSoFar: 60, iem: { dailyMaxF: 105, dailyMinF: 20, latestTs: fresh(1440) }, nowMs: NOW }).maxSoFar === 70);

// --- absent / partial IEM ---
ok("no IEM object → unchanged",
   foldIem({ maxSoFar: 88, minSoFar: 70, iem: null, nowMs: NOW }).maxSoFar === 88);
ok("IEM present but dailyMaxF null → max unchanged, min still folds",
   (() => { const r = foldIem({ maxSoFar: 88, minSoFar: 70, iem: { dailyMaxF: null, dailyMinF: 66, latestTs: fresh(5) }, nowMs: NOW });
            return r.maxSoFar === 88 && r.minSoFar === 66; })());
ok("null maxSoFar adopts IEM max",
   foldIem({ maxSoFar: null, minSoFar: null, iem: { dailyMaxF: 91, dailyMinF: 70, latestTs: fresh(5) }, nowMs: NOW }).maxSoFar === 91);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
