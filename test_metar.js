// Tests for lib/metar.js (METAR decode + snapshot build). No network.
import { parseMetar, buildSnapshot } from "./netlify/functions/lib/metar.js";

let pass = 0, fail = 0;
const approx = (a, b, t = 0.05) => a != null && Math.abs(a - b) <= t;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

const ref = new Date(Date.UTC(2026, 6, 9, 15, 0)); // 2026-07-09 15:00Z

// Standard METAR with RMK T-group + SLP.
const m1 = parseMetar("KNYC 091451Z 22005KT 10SM FEW250 26/21 A2994 RMK AO2 SLP136 T02610211", ref);
ok("temp from T-group ≈ 78.98°F", approx(m1.temp_f, 78.98));
ok("dewpoint from T-group ≈ 69.98°F", approx(m1.dewpoint_f, 69.98));
ok("wind dir 220", m1.wind_dir_deg === 220);
ok("wind speed 5kt", m1.wind_speed_kt === 5);
ok("SLP136 → 1013.6", approx(m1.slp_mb, 1013.6, 0.01));
ok("time day=9 hour=14", m1.ts.getUTCDate() === 9 && m1.ts.getUTCHours() === 14);

// Negative temps (M prefix) + VRB wind + altimeter fallback (no SLP).
const m2 = parseMetar("KDEN 100153Z VRB03KT 10SM CLR M02/M08 A3010 RMK T10171083", ref);
ok("negative temp -1.7°C → 28.94°F", approx(m2.temp_f, 28.94));
ok("VRB wind → dir null", m2.wind_dir_deg === null);
ok("altimeter fallback A3010 → ~1019 hPa", approx(m2.slp_mb, 3010 / 100 * 33.8639, 0.1));

// Body-group fallback when no T-group.
const m3 = parseMetar("KLAX 091553Z 25008KT 6SM BR 20/17 A2998", ref);
ok("body temp 20°C → 68°F", approx(m3.temp_f, 68));
ok("body dewpoint 17°C → 62.6°F", approx(m3.dewpoint_f, 62.6));

// Snapshot build: two local days, yesterday max + now + slp-24h-ago.
const lines = [
  "KNYC 081451Z 20006KT 20/14 RMK SLP174 T02000140",  // yest 14:51Z 68°F
  "KNYC 081751Z 00000KT 29/16 RMK SLP161 T02940160",  // yest 17:51Z 84.9°F (yest max)
  "KNYC 091351Z 22005KT 25/20 RMK SLP140 T02500200",  // today 13:51Z
  "KNYC 091451Z 22005KT 26/21 RMK SLP136 T02610211",  // today 14:51Z (now)
];
const snap = buildSnapshot({ station: "KNYC", tz: "America/New_York", metarLines: lines, refNow: ref, maxSoFarF: 79 });
ok("snapshot now = latest (14:51Z)", snap.now.ts.getUTCHours() === 14);
ok("yesterday has 2 obs", snap.yesterday.length === 2);
ok("yesterday_max ≈ 84.9°F", approx(snap.yesterday_max_f, 84.92, 0.1));
ok("max_so_far from bayes (79)", snap.max_so_far_f === 79);
ok("slp_24h_ago picked (near 081451Z, ~1017.4)", approx(snap.slp_24h_ago_mb, 1017.4, 0.2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
