// Pins the settled-bet ↔ actuals join in calibration_update-background.js. No network.
//
// Regression origin (2026-07-24): the join was matching 30/176 HIGH and 1/42 LOW, i.e. the
// file's own "eligible≫matched ⇒ broken pipe" criterion, tripped and unnoticed. Measured
// against the live blobs, the 218 eligible settled bets decomposed as:
//
//   HIGH 176 = 85 target a day BEFORE the predictions store's first record (2026-05-11)
//            + 50 prediction record existed WITH actualHigh but was never loaded
//            +  6 prediction captured but never settled (actualHigh null)
//            +  5 no record for that city-day
//            + 30 matched
//   LOW   42 = 29 predate the store
//            + 11 record exists, actualHigh set, actualLow NULL (logger.js only began
//                 writing pred.actualLow on 2026-06-01 and May was never backfilled)
//            +  1 no record
//            +  1 matched
//
// So the two sides failed for DIFFERENT reasons. HIGH's 50 were a key-sort bug: the
// predictions store is keyed `${cli}/${date}` — CLI FIRST — and loadAllBlobEntries sorted
// keys lexicographically before taking the newest 600, which ordered by CITY. The window
// held 100% of TPA…NYC and 0% of AUS…MDW (10 of the 28 cities in the store). LOW's 11 are
// producer-side and no consumer fix can reach them.
//
// The fix: (a) keyDate() so a "most recent N" cap is a date window, not an alphabetical
// slice of cities; (b) a demand-driven join that fetches exactly the `${cli}/${date}`
// records the settled bets ask for, so the join no longer depends on the retention window;
// (c) bets predating the store's coverage counted as out_of_coverage instead of being
// folded into `eligible`, so the broken-pipe alarm measures the pipe, not prehistory.

import { keyDate, PRED_KEY_RE, betJoinTarget, targetLocalDate, indexActualsByCliDate,
         joinSettledToActuals } from "./netlify/functions/calibration_update-background.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); }
                             else { fail++; console.log(`  ✗ ${name}`); } };

// --- keyDate: the actual bug ------------------------------------------------------
ok("keyDate pulls the date segment, not the city", keyDate("MDW/2026-06-14") === "2026-06-14");
ok("keyDate strips the legacy .json suffix", keyDate("AUS/2026-05-04.json") === "2026-05-04");
ok("keyDate on a key with no slash returns it whole", keyDate("global") === "global");

ok("current key shape accepted", PRED_KEY_RE.test("MDW/2026-06-14"));
ok("legacy .json key rejected", !PRED_KEY_RE.test("AUS/2026-05-04.json"));
ok("non-date key rejected", !PRED_KEY_RE.test("MDW/latest"));

// A 3-city × 10-day store. Sorting the WHOLE key desc keeps only the alphabetically last
// city; sorting by keyDate keeps the newest days across all three.
const cities = ["AUS", "MDW", "TPA"];
const days = Array.from({ length: 10 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
const allKeys = cities.flatMap(c => days.map(d => `${c}/${d}`));
const CAP = 9;
const lexWindow  = [...allKeys].sort().reverse().slice(0, CAP);
const dateWindow = [...allKeys]
  .sort((a, b) => keyDate(b).localeCompare(keyDate(a)) || a.localeCompare(b)).slice(0, CAP);
const citiesIn = ks => new Set(ks.map(k => k.split("/")[0])).size;
ok("lexicographic window collapses to one city (the bug)", citiesIn(lexWindow) === 1);
ok("date window spans every city (the fix)", citiesIn(dateWindow) === cities.length);
ok("date window really is the newest days",
   new Set(dateWindow.map(keyDate)).size === 3 && dateWindow.every(k => keyDate(k) >= "2026-06-08"));

// --- betJoinTarget ----------------------------------------------------------------
const bet = (o) => ({ variable: "high", city: "Chicago", modelMean: 80, modelStd: 2,
                      placedAtUTC: "2026-06-14T16:00:00.000Z", ...o });
ok("maps city → CLI and builds the predictions key",
   betJoinTarget(bet()).key === "MDW/2026-06-14");
ok("unknown city is not joinable", betJoinTarget(bet({ city: "Reykjavik" })) === null);
ok("rain/other variables are not joinable", betJoinTarget(bet({ variable: "rain" })) === null);
ok("modelStd <= 0 is not joinable", betJoinTarget(bet({ modelStd: 0 })) === null);
ok("missing modelMean is not joinable", betJoinTarget(bet({ modelMean: null })) === null);
ok("missing placedAtUTC is not joinable", betJoinTarget(bet({ placedAtUTC: null })) === null);

// The target day is the city's LOCAL day, not the UTC day.
ok("late-evening Pacific bet keeps its local date",
   targetLocalDate({ placedAtUTC: "2026-06-15T04:30:00.000Z" }, "America/Los_Angeles")
     === "2026-06-14");
ok("morning Eastern bet keeps its local date",
   targetLocalDate({ placedAtUTC: "2026-06-14T12:00:00.000Z" }, "America/New_York")
     === "2026-06-14");

// --- the join ---------------------------------------------------------------------
const predictions = [
  { cli: "MDW", date: "2026-06-14", predHigh: 78, predLow: 60, actualHigh: 84, actualLow: 61 },
  // May record: settled before logger.js began writing pred.actualLow (2026-06-01).
  { cli: "BOS", date: "2026-05-16", predHigh: 79, predLow: 50, actualHigh: 80 },
  // Captured but never settled — no actual at all.
  { cli: "DEN", date: "2026-05-21", predHigh: 70, predLow: 40 }
];
const actuals = indexActualsByCliDate(predictions);
ok("index is keyed cli/date", actuals["MDW/2026-06-14"].actualHigh === 84);
ok("absent actualLow indexes as null", actuals["BOS/2026-05-16"].actualLow === null);

const settled = [
  bet({ city: "Chicago", modelMean: 80, modelStd: 2 }),                       // matches
  bet({ city: "Boston",  variable: "low", modelMean: 52, modelStd: 2,
        placedAtUTC: "2026-05-16T14:00:00.000Z" }),                           // actualLow null
  bet({ city: "Denver",  modelMean: 71, modelStd: 2,
        placedAtUTC: "2026-05-21T18:00:00.000Z" }),                           // never settled
  bet({ city: "Philadelphia", modelMean: 75, modelStd: 2,
        placedAtUTC: "2026-05-05T15:00:00.000Z" })                            // predates coverage
];
const j = joinSettledToActuals(settled, actuals, "2026-05-11");

ok("HIGH z uses (actual − modelMean) / modelStd", j.zHigh.length === 1 && j.zHigh[0] === 2);
ok("a bet predating the store is NOT counted eligible", j.eligibleHigh === 2);
ok("it is reported as out_of_coverage instead", j.outOfCoverageHigh === 1);
ok("in-coverage HIGH join rate is honest", j.zHigh.length / j.eligibleHigh === 0.5);
ok("LOW with actualHigh set but actualLow null stays unmatched", j.zLow.length === 0);
ok("...and still counts as eligible, so the alarm fires", j.eligibleLow === 1);
ok("unmatched counts both null-actual cases", j.unmatched === 2);
ok("matched is the sum of both sides", j.matched === j.zHigh.length + j.zLow.length);

// Without a coverage floor, prehistory sinks the join rate — the 17%/2% symptom.
const jNoFloor = joinSettledToActuals(settled, actuals, null);
ok("no coverage floor ⇒ prehistoric bets dilute eligible", jNoFloor.eligibleHigh === 3);
ok("no coverage floor ⇒ join rate understates the pipe",
   jNoFloor.zHigh.length / jNoFloor.eligibleHigh < j.zHigh.length / j.eligibleHigh);

// --- the demand-driven join: a record outside the population window must still join ---
// This is the 50-bet HIGH failure. The population window is the newest 2 records; the bet
// points at an older day whose record exists and carries actualHigh.
const store = {
  "MDW/2026-07-22": { cli: "MDW", date: "2026-07-22", predHigh: 90, actualHigh: 91 },
  "MDW/2026-07-23": { cli: "MDW", date: "2026-07-23", predHigh: 92, actualHigh: 93 },
  "MDW/2026-06-14": { cli: "MDW", date: "2026-06-14", predHigh: 78, actualHigh: 84 }
};
const popKeys = Object.keys(store)
  .sort((a, b) => keyDate(b).localeCompare(keyDate(a))).slice(0, 2);
const oldBet = bet({ city: "Chicago", modelMean: 80, modelStd: 2 });
const windowOnly = joinSettledToActuals(
  [oldBet], indexActualsByCliDate(popKeys.map(k => store[k])), "2026-05-11");
ok("population window alone misses the older day", windowOnly.zHigh.length === 0);

const wanted = [betJoinTarget(oldBet).key].filter(k => store[k] && !popKeys.includes(k));
const demandDriven = joinSettledToActuals(
  [oldBet],
  indexActualsByCliDate([...popKeys, ...wanted].map(k => store[k])),
  "2026-05-11");
ok("demand-driven fetch pulls exactly the missing key", wanted.length === 1);
ok("...and the bet then joins", demandDriven.zHigh.length === 1 && demandDriven.matched === 1);

// A key the store does not have costs zero fetches (prehistoric days).
const ghost = betJoinTarget(bet({ city: "Philadelphia", placedAtUTC: "2026-05-05T15:00:00.000Z" }));
ok("absent key is filtered out before fetching", !Object.keys(store).includes(ghost.key));

// --- guards -----------------------------------------------------------------------
const empty = joinSettledToActuals([], {}, null);
ok("empty ledger yields no z and no eligible",
   empty.zHigh.length === 0 && empty.eligibleHigh === 0 && empty.eligibleLow === 0);
ok("non-finite z is dropped, not pushed",
   joinSettledToActuals([bet({ modelStd: Number.NaN })], actuals, null).zHigh.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
