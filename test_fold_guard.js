// Day-boundary fold guard (weather.js, 2026-07-24). No network.
//
// A "daily extremum" field — DSM max/min, IEM max_dayairtemp, a 1-min running max — can
// still carry YESTERDAY's value in the first hours of the local climate day. Folding one
// in produces an already-impossible observation floor, and kalshi.js consumes that floor
// as a HARD certainty (it zeroes bucket probabilities below it), so the bot stakes a
// claimed certainty on an observation that is wrong.
//
// Measured over the logged snapshots: floor > settled extremum in 8.3% of local-hour-0
// snapshots and 0.9% of hour-1, against 0 of 2831 at hours 2–16. Exemplar — KSAT at
// 01:xx local on 2026-07-11 carried maxSoFar 95 on a day that settled 86, while the same
// city read 78 two hours later. Seven of 462 gated entries were built on such a floor.
//
// The DSM guard that already existed FAILED OPEN (`coversMonthDay == null` was read as
// "covers today"), and the IEM fold had no day stamp at all.

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); }
                             else { fail++; console.log(`  ✗ ${name}`); } };

const EARLY_FOLD_HR = 3;
const EARLY_FOLD_MAX_GAP_F = 3;

// Mirrors foldGuard() in weather.js.
function foldGuard(candidate, kind, foldLocalHr, metarMaxToday, metarMinToday) {
  if (foldLocalHr >= EARLY_FOLD_HR) return true;
  const base = kind === "max" ? metarMaxToday : metarMinToday;
  if (base == null) return false;
  return kind === "max"
    ? candidate <= base + EARLY_FOLD_MAX_GAP_F
    : candidate >= base - EARLY_FOLD_MAX_GAP_F;
}
// Mirrors the fail-closed dsmCoversToday.
const dsmCoversToday = (coversMonthDay, todayMonthDay, foldLocalHr) =>
  coversMonthDay != null ? coversMonthDay === todayMonthDay : foldLocalHr >= EARLY_FOLD_HR;

// --- the real KSAT regression ---
// 2026-07-11 ~01:00 local: a daily field claimed 95; today's METARs supported ~78.
ok("KSAT 01:00 local — stale 95 REJECTED against a METAR max of 78",
   foldGuard(95, "max", 1.0, 78, 70) === false);
ok("KSAT 05:01 local (h0 case) — stale 97 REJECTED against 80",
   foldGuard(97, "max", 0.5, 80, 72) === false);
ok("same stale 95 ACCEPTED once the day is underway (14:00)",
   foldGuard(95, "max", 14.0, 78, 70) === true);

// --- legitimate early folds still pass ---
ok("real between-METAR spike (+2F) passes at 01:00",
   foldGuard(80, "max", 1.0, 78, 70) === true);
ok("boundary: exactly +3F passes", foldGuard(81, "max", 1.0, 78, 70) === true);
ok("just past boundary: +3.1F rejected", foldGuard(81.1, "max", 1.0, 78, 70) === false);
ok("boundary hour: exactly 3.0 local is trusted", foldGuard(999, "max", 3.0, 10, 0) === true);
ok("just before: 2.99 local still guarded", foldGuard(999, "max", 2.99, 10, 0) === false);

// --- MIN side is symmetric (a stale daily MIN wrongly lowers the LOW ceiling) ---
ok("stale low 40 REJECTED against today's METAR min of 70",
   foldGuard(40, "min", 1.0, 78, 70) === false);
ok("real dip (−2F) passes at 01:00", foldGuard(68, "min", 1.0, 78, 70) === true);
ok("boundary: exactly −3F passes", foldGuard(67, "min", 1.0, 78, 70) === true);
ok("just past: −3.1F rejected", foldGuard(66.9, "min", 1.0, 78, 70) === false);

// --- no corroboration available ---
ok("no METAR today → reject early fold (cannot verify)",
   foldGuard(95, "max", 0.5, null, null) === false);
ok("no METAR today → but after the window, trust it",
   foldGuard(95, "max", 6.0, null, null) === true);

// --- DSM fail-closed ---
ok("DSM stamped today → covers today", dsmCoversToday("07/24", "07/24", 1.0) === true);
ok("DSM stamped yesterday → rejected", dsmCoversToday("07/23", "07/24", 1.0) === false);
ok("DSM UNPARSED at 01:00 → NOT trusted (was the fail-open hole)",
   dsmCoversToday(null, "07/24", 1.0) === false);
ok("DSM unparsed once day is underway → trusted",
   dsmCoversToday(null, "07/24", 9.0) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
