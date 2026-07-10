// Tests for claude.js CLI-product parsing (bugsweep FIX 1). No network — we feed
// canned product text to parseCliProduct. Run: node test_claude.js
import { parseCliProduct } from "./netlify/functions/claude.js";
import { stationLines } from "./netlify/functions/lib/claude_engine.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// Regression: aviationweather format=raw lines are "METAR KNYC ..."/"SPECI KNYC ..."
// (prefixed). The old startsWith(station+" ") matched ZERO — empty snapshots, empty
// scoreboard, "n/a" cards. The regex filter must match prefixed lines and only the
// right station.
{
  const raw = [
    "METAR KNYC 101451Z 22006KT 10SM CLR 28/17 A3001 RMK AO2 SLP160 T02780172",
    "SPECI KNYC 101305Z 18004KT 10SM CLR 25/17 A3003 RMK AO2 T02500172",
    "METAR KLAX 101453Z 25008KT 6SM BR 20/17 A2998 RMK AO2 SLP150 T02000172",
    "KDEN 101453Z 15005KT 10SM FEW100 19/12 A2984 RMK T01890122",  // some feeds omit the prefix
  ].join("\n");
  ok("stationLines matches METAR+SPECI-prefixed KNYC (2)", stationLines(raw, "KNYC").length === 2);
  ok("stationLines isolates KLAX (1)", stationLines(raw, "KLAX").length === 1);
  ok("stationLines still matches un-prefixed KDEN (1)", stationLines(raw, "KDEN").length === 1);
  ok("stationLines does not cross-match", stationLines(raw, "KJFK").length === 0);
}

// A final product: MAXIMUM is the day's max (82); a later RECORD line (103) must NOT win.
const final = `<html><body><pre>
000
CDUS41 KOKX 100600
CLINYC

CLIMATE SUMMARY FOR JULY 9 2026...

WEATHER ITEM   OBSERVED TIME   RECORD YEAR NORMAL DEPARTURE LAST
TEMPERATURE (F)
 TODAY
  MAXIMUM         82   1153 PM  103  2011  85     -3       88
  MINIMUM         70    459 AM   58  1914  70      0       74
</pre></body></html>`;

const p1 = parseCliProduct(final);
ok("final: coversDate 2026-07-09", p1.coversDate === "2026-07-09");
ok("final: not partial", p1.isPartial === false);
ok("final: MAXIMUM 82 (not RECORD 103)", p1.maxF === 82);

// An evening preliminary partial for the SAME day — must be flagged so settle waits.
const partial = `<pre>
CLIMATE SUMMARY FOR JULY 9 2026
VALID AS OF 0500 PM

  MAXIMUM         79    303 PM
</pre>`;
const p2 = parseCliProduct(partial);
ok("partial: flagged isPartial", p2.isPartial === true);
ok("partial: still parses date + max", p2.coversDate === "2026-07-09" && p2.maxF === 79);

// A product covering a DIFFERENT day — its coversDate must differ so settle rejects it.
const otherDay = `<pre>
CLIMATE SUMMARY FOR JULY 10 2026

  MAXIMUM         88   0200 PM
</pre>`;
ok("other day: coversDate 2026-07-10", parseCliProduct(otherDay).coversDate === "2026-07-10");

// Signed winter max parses (regex allows leading minus).
const winter = `<pre>
CLIMATE SUMMARY FOR JANUARY 15 2026

  MAXIMUM         -4    1201 AM
</pre>`;
const p3 = parseCliProduct(winter);
ok("winter: coversDate + negative MAXIMUM -4", p3.coversDate === "2026-01-15" && p3.maxF === -4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
