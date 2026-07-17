// Tests for lib/metar.js (METAR decode + snapshot build). No network.
import { parseMetar, buildSnapshot, buildSnapshotV2 } from "./netlify/functions/lib/metar.js";

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

// Visibility + obstruction codes (2026-07-15: KNYC "4SM HZ" under CLR was a real
// insolation cut the sky group can't see).
ok("visibility 10SM", m1.visibility_mi === 10);
ok("no obstruction → wx empty", m1.wx === "");
ok("visibility 6SM + BR", m3.visibility_mi === 6 && m3.wx === "BR");
const m4 = parseMetar("KNYC 151451Z 27008KT 4SM HZ CLR 32/21 A2990 RMK AO2 SLP113 T03220206", ref);
ok("haze day: 4SM HZ", m4.visibility_mi === 4 && m4.wx === "HZ");
const m5 = parseMetar("KBOS 151451Z 09010KT 1 1/2SM BR OVC005 18/17 A2995", ref);
ok("fractional visibility 1 1/2SM → 1.5", approx(m5.visibility_mi, 1.5, 0.001));
const m6 = parseMetar("KSEA 151453Z 00000KT M1/4SM FG VV002 12/12 A3005", ref);
ok("M1/4SM → 0.25, FG", approx(m6.visibility_mi, 0.25, 0.001) && m6.wx === "FG");
// codes after RMK must not leak into wx
const m7 = parseMetar("KDEN 151453Z 18008KT 10SM CLR 30/10 A3002 RMK AO2 FU LYR ALQDS T03000100", ref);
ok("RMK-only FU ignored", m7.wx === "" && m7.visibility_mi === 10);
// 2026-07-17 KDCA smoke tape: VV020 = sky obscured by the plume itself
const m8 = parseMetar("KDCA 171252Z 00000KT 1 1/2SM FU VV020 28/17 A3007 RMK AO2 SLP183", ref);
ok("smoke day: 1.5SM FU + VV020 obscured", approx(m8.visibility_mi, 1.5, 0.001) && m8.wx === "FU" && m8.sky_obscured === true);
ok("smoke day: VV020 kept in sky string", /VV020/.test(m8.sky));
ok("clean day: sky_obscured false", m1.sky_obscured === false);

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

// sky field parse (feeds claude_analog_v2 insolation/sky-cover terms).
const s1 = parseMetar("KDEN 091353Z 15005KT 10SM FEW100 SCT120 SCT150 19/12 A2984 RMK T01890122", ref);
ok("sky parses layered cover", s1.sky === "FEW100 SCT120 SCT150");
const s2 = parseMetar("KDEN 100153Z VRB03KT 10SM CLR M02/M08 A3010 RMK T10171083", ref);
ok("sky CLR normalized", s2.sky === "CLR");

// buildSnapshotV2: multi-day analog ensemble (3 local days → today + 2 prior analogs).
const v2lines = [
  "KDEN 071553Z 20006KT SCT090 21/09 RMK SLP174 T02110094",  // 3 days ago 15:53Z
  "KDEN 071953Z 22009KT FEW220 36/09 RMK SLP150 T03610094",  // 3 days ago 19:53Z (max ~96.9)
  "KDEN 081353Z 00000KT SCT090 BKN150 23/09 RMK SLP161 T02330094",  // 2 days ago 13:53Z
  "KDEN 081953Z 22008KT FEW200 34/08 RMK SLP150 T03440083",  // 2 days ago 19:53Z (max ~93.9)
  "KDEN 091353Z 15005KT FEW100 SCT120 19/12 RMK SLP140 T01890122",  // today 13:53Z
  "KDEN 091453Z 15005KT FEW100 20/12 RMK SLP136 T02000122",  // today 14:53Z (now)
];
const v2 = buildSnapshotV2({ station: "KDEN", tz: "America/Denver", metarLines: v2lines, refNow: ref });
ok("v2 now = latest (14:53Z)", v2.now.ts.getUTCHours() === 14);
ok("v2 two analogs, most-recent-first", v2.analogs.length === 2 && approx(v2.analogs[0].max_f, 93.9, 0.1));
ok("v2 second analog older day", approx(v2.analogs[1].max_f, 96.9, 0.2));
ok("v2 analog hourlies carry sky", v2.analogs[0].hourlies.some(h => /SCT090/.test(h.sky)));
ok("v2 max_so_far from today obs", approx(v2.max_so_far_f, 68, 0.1));
ok("v2 today_hourlies carries the day's own trace (2026-07-15 mixing signal)",
  v2.today_hourlies.length === 2 && v2.today_hourlies[1].ts.getTime() === v2.now.ts.getTime());

// bugsweep FIX 3 regression: a missing dewpoint ("27/ ") must keep the temp, not drop the ob.
{
  const m = parseMetar("KNYC 091951Z 22005KT 10SM FEW026 27/ A2994 RMK AO2 SLP136", new Date(Date.UTC(2026, 6, 9, 20, 0)));
  ok("FIX3: '27/ ' keeps temp, dew null", m && Math.abs(m.temp_f - 80.6) < 0.1 && m.dewpoint_f === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
