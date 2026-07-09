// Tests for lib/asos1min.js airmass cross-check helpers (recentRise,
// coverageCrossCheck). Pure — no network. Run: node test_asos1min.js
import { recentRise, coverageCrossCheck, COVERAGE_NEIGHBORS } from "./netlify/functions/lib/asos1min.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };
const approx = (a, b, t = 0.3) => a != null && Math.abs(a - b) <= t;

const TZ = "America/New_York";
const NOW = new Date(Date.UTC(2026, 6, 9, 19, 30, 0)); // 3:30 PM EDT, July 9

// n one-min obs starting at startMs, temp t0 rising dtPerMin each minute.
function series(startMs, n, t0, dtPerMin) {
  const s = [];
  for (let i = 0; i < n; i++) s.push({ ts: new Date(startMs + i * 60000), tempF: t0 + i * dtPerMin });
  return s;
}
const at = (h, m) => Date.UTC(2026, 6, 9, h, m, 0);

// KLGA: 31 fresh 1-min obs 19:00→19:30Z rising 80→84°F (+4 over 30 min).
const klgaRising = series(at(19, 0), 31, 80, 4 / 30);
// KJFK: fresh but flat at 78°F.
const klgaFlat = series(at(19, 0), 31, 78, 0);
// stale witness: last ob 50 min before NOW.
const klgaStale = series(at(18, 10), 31, 80, 4 / 30);

ok("recentRise picks up +3.7°F/30min ramp", approx(recentRise({ K: klgaRising }, "K", 30, NOW), 3.7, 0.4));
ok("recentRise ~0 on flat stream", approx(recentRise({ K: klgaFlat }, "K", 30, NOW), 0, 0.05));
ok("recentRise null on sparse feed", recentRise({ K: klgaRising.slice(0, 5) }, "K", 30, NOW) === null);

// KNYC (Central Park) degraded → cross-check against rising KLGA.
const xc = coverageCrossCheck({ KLGA: klgaRising }, "KNYC", TZ, NOW);
ok("cross-check selects KLGA witness", xc && xc.neighbor === "KLGA");
ok("cross-check reports 1min freshness", xc && xc.neighborCov === "1min");
ok("cross-check surfaces the +ramp", xc && approx(xc.rise30F, 3.7, 0.4));

// falls through a stale first neighbor to a fresh one.
const xc2 = coverageCrossCheck({ KLGA: klgaStale, KJFK: klgaFlat }, "KNYC", TZ, NOW);
ok("cross-check skips stale KLGA → KJFK", xc2 && xc2.neighbor === "KJFK");
ok("cross-check flat neighbor rise ≈ 0", xc2 && approx(xc2.rise30F, 0, 0.05));

// no usable witness (all stale) → null.
ok("cross-check null when all neighbors stale", coverageCrossCheck({ KLGA: klgaStale }, "KNYC", TZ, NOW) === null);
// station with no configured neighbor → null.
ok("cross-check null for un-neighbored station", coverageCrossCheck({ KLGA: klgaRising }, "KDEN", TZ, NOW) === null);
// settlement-safety contract: only KNYC is configured, and it never lists itself.
ok("KNYC neighbors are airports, not KNYC", COVERAGE_NEIGHBORS.KNYC.length > 0 && !COVERAGE_NEIGHBORS.KNYC.includes("KNYC"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
