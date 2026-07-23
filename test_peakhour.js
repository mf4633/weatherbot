// Unit tests for the forecast-derived peak hour (hoursToPeak). No network.
//
// Regression origin: 2026-07-23 21:11Z. hoursToPeak() hardcoded a 15:00 local peak,
// so at 14:11 PDT Seattle/LAX/Phoenix all got hrsToPeak=0.7, tripping the
// `hrsToPeak < 1.0` peak-realized branch that pins mean ≈ maxSoFar. KSEA was 73F and
// still climbing ~2F/hr toward an NWS-forecast 79F peak at 17:00 PDT; the model served
// 74.1F and the fake edge ranked #1 and #2 on the Kalshi HIGH board.
import { hoursToPeak, forecastPeakHourToday } from "./netlify/functions/weather.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); }
                             else { fail++; console.log(`  ✗ ${name}`); } };

// Build an hourly series in a given IANA tz: temps[i] is the temp at local hour i.
function hourlySeries(tz, dateISO, temps) {
  return temps.map((tempF, hr) => ({
    ts: new Date(new Date(`${dateISO}T00:00:00Z`).getTime()
                 + (hr + tzOffsetHours(tz, dateISO)) * 3600 * 1000),
    tempF
  }));
}
// UTC offset (hours to ADD to local to get UTC) for the given tz on the given date.
function tzOffsetHours(tz, dateISO) {
  const probe = new Date(`${dateISO}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour: "2-digit", hour12: false
  });
  const localHr = parseInt(fmt.format(probe), 10);
  return 12 - localHr;
}
function localMidnightUTCFor(tz, dateISO) {
  return new Date(new Date(`${dateISO}T00:00:00Z`).getTime()
                  + tzOffsetHours(tz, dateISO) * 3600 * 1000);
}

const DATE = "2026-07-23";
const SEA = "America/Los_Angeles";

// --- forecastPeakHourToday ---
// Seattle 2026-07-23 NWS hourly (the real grid): peak 79F at 17:00 local.
const seaTemps = [59,58,58,57,57,57,58,60,62,64,66,68,70,72,75,77,77,79,78,78,77,74,72,70];
const seaMid = localMidnightUTCFor(SEA, DATE);
const seaPeakHr = forecastPeakHourToday(hourlySeries(SEA, DATE, seaTemps), seaMid, SEA);
ok("KSEA forecast peak hour = 17:00 local", seaPeakHr === 17);

ok("null hourly → null", forecastPeakHourToday(null, seaMid, SEA) === null);
ok("empty hourly → null", forecastPeakHourToday([], seaMid, SEA) === null);

// Plateau ties resolve to the EARLIEST hour at the max (16:00, not 18:00).
const plateau = [...seaTemps];
plateau[16] = 79; plateau[17] = 79; plateau[18] = 79;
ok("plateau tie → earliest peak hour (16:00)",
   forecastPeakHourToday(hourlySeries(SEA, DATE, plateau), seaMid, SEA) === 16);

// --- hoursToPeak: the actual regression ---
// 14:11 PDT = 21:11Z on 2026-07-23.
const NOW = new Date("2026-07-23T21:11:00Z");
const seaHrs = hoursToPeak(SEA, NOW, seaPeakHr);
ok("KSEA 14:11 PDT with 17:00 peak → hrsToPeak ≈ 2.8",
   Math.abs(seaHrs - 2.8167) < 0.02);
ok("KSEA 14:11 PDT NO LONGER trips peak-realized (hrsToPeak ≥ 1.0)", seaHrs >= 1.0);
// The bug, pinned: without the forecast hour it still reads 0.82 and trips the branch.
ok("regression pin: hardcoded-15:00 path gives 0.82 and trips peak-realized",
   Math.abs(hoursToPeak(SEA, NOW, null) - 0.8167) < 0.02
   && hoursToPeak(SEA, NOW, null) < 1.0);

// Eastern cities were already correct — the fix must not disturb them.
// 17:11 EDT is past any plausible peak → 0 either way.
const NYC = "America/New_York";
ok("KNYC 17:11 EDT → hrsToPeak 0 (unchanged)",
   hoursToPeak(NYC, NOW, 17) === 0 && hoursToPeak(NYC, NOW, null) === 0);

// --- guard window [11, 19] ---
ok("peak hour 02:00 (cold advection) outside window → falls back to 15:00 default",
   hoursToPeak(SEA, NOW, 2) === hoursToPeak(SEA, NOW, null));
ok("peak hour 23:00 (garbage/late front) outside window → falls back to default",
   hoursToPeak(SEA, NOW, 23) === hoursToPeak(SEA, NOW, null));
ok("peak hour 19:00 is inside the window (boundary)",
   Math.abs(hoursToPeak(SEA, NOW, 19) - 4.8167) < 0.02);
ok("peak hour 11:00 is inside the window (boundary) → already past → 0",
   hoursToPeak(SEA, NOW, 11) === 0);
ok("null peak hour → 15:00 default preserved (back-compat)",
   Math.abs(hoursToPeak(SEA, NOW) - 0.8167) < 0.02);

// Monotonic: earlier in the day → more hours to peak.
const morning = new Date("2026-07-23T17:00:00Z"); // 10:00 PDT
ok("10:00 PDT with 17:00 peak → 7.0 hrs", Math.abs(hoursToPeak(SEA, morning, 17) - 7.0) < 0.02);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
