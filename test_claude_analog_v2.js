// Parity test: lib/claude_analog_v2.js must reproduce claude_analog_v2.py's replay
// (KNYC / KLAX / KDEN, 2026-07-09). No network. Run: node test_claude_analog_v2.js
import { predict, checkpoint, STATION_CONFIGS, KALSHI_STATIONS, skyDeficit } from "./netlify/functions/lib/claude_analog_v2.js";

let pass = 0, fail = 0;
const approx = (a, b, t = 0.05) => a != null && Math.abs(a - b) <= t;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };
const D = (mo, d, h, mi) => new Date(Date.UTC(2026, mo - 1, d, h, mi));
const ob = (mo, d, h, mi, t, td, dir, spd, slp, sky) => ({ ts: D(mo, d, h, mi), temp_f: t, dewpoint_f: td, wind_dir_deg: dir, wind_speed_kt: spd, slp_mb: slp, sky });
const binsMatch = (got, ref) => Object.keys(ref).every(k => approx(got[k], ref[k], 0.001));

// ---- KNYC 9:51 AM (sea_breeze, no convection) ----
const nyc = predict({
  station: "KNYC", now: ob(7, 9, 9, 51, 79, 70, 225, 5, 1013.6, "CLR"), max_so_far_f: 79,
  analogs: [{ hourlies: [ob(7, 8, 9, 51, 73, 63, null, 0, 1017.5, "CLR")], max_f: 85 }], slp_24h_ago_mb: 1017.5,
}, null,
  [{ label: "<=82", lo: -Infinity, hi: 82 }, { label: "83-84", lo: 83, hi: 84 }, { label: "85-86", lo: 85, hi: 86 },
   { label: "87-88", lo: 87, hi: 88 }, { label: "89-90", lo: 89, hi: 90 }, { label: ">=91", lo: 91, hi: Infinity }],
  { "<=82": 22, "83-84": 59, "85-86": 28, "87-88": 3, "89-90": 1, ">=91": 1 });
ok("KNYC mixture mean 89.4", approx(nyc.dist.mean(), 89.4, 0.05));
ok("KNYC p_trunc 0", nyc.dist.pTrunc === 0);
ok("KNYC A_bowen -2.45", approx(nyc.components.A_bowen, -2.45));
ok("KNYC A_trajectory -0.75", approx(nyc.components.A_trajectory, -0.75));
ok("KNYC A_airmass +1.56", approx(nyc.components.A_airmass, 1.56));
ok("KNYC bins match py", binsMatch(nyc.bin_probs, { "<=82": 0.022, "83-84": 0.054, "85-86": 0.124, "87-88": 0.200, "89-90": 0.232, ">=91": 0.368 }));
ok("KNYC market_pt 83.7", approx(nyc.market_pt, 83.7, 0.1));
ok("KNYC divergence flagged hotter", /hotter/.test(nyc.divergence_note));

// ---- KLAX 6:53 AM (marine_baseline, offshore = warm) ----
const lax = predict({
  station: "KLAX", now: ob(7, 9, 6, 53, 66, 62, 90, 3, 1011.5, "FEW009 FEW015"), max_so_far_f: 66,
  analogs: [{ hourlies: [ob(7, 8, 6, 53, 66, 60, null, 0, 1014.5, "CLR")], max_f: 74 },
            { hourlies: [ob(7, 7, 6, 53, 65, 61, 248, 3, 1013.5, "FEW009 FEW012 SCT029")], max_f: 74 }], slp_24h_ago_mb: 1014.5,
}, null,
  [{ label: "<=72", lo: -Infinity, hi: 72 }, { label: "73-74", lo: 73, hi: 74 }, { label: "75-76", lo: 75, hi: 76 },
   { label: "77-78", lo: 77, hi: 78 }, { label: "79-80", lo: 79, hi: 80 }, { label: ">=81", lo: 81, hi: Infinity }],
  { "<=72": 1, "73-74": 23, "75-76": 51, "77-78": 25, "79-80": 4, ">=81": 4 });
ok("KLAX mixture mean 76.8", approx(lax.dist.mean(), 76.8, 0.05));
ok("KLAX A_trajectory +2.50 (offshore warm)", approx(lax.components.A_trajectory, 2.5));
ok("KLAX A_sky -0.60", approx(lax.components["A_sky"], -0.6, 0.02));
ok("KLAX R_analog(ens) +8.30", approx(lax.components["R_analog(ens)"], 8.30, 0.05));
ok("KLAX bins match py", binsMatch(lax.bin_probs, { "<=72": 0.016, "73-74": 0.109, "75-76": 0.315, "77-78": 0.362, "79-80": 0.166, ">=81": 0.032 }));
ok("KLAX ≈ agreement", /agreement/.test(lax.divergence_note));

// ---- KDEN 7:53 AM (continental, convective truncation mixture) ----
const den = predict({
  station: "KDEN", now: ob(7, 9, 7, 53, 66, 56, 157, 5, 1011.4, "FEW100 SCT120 SCT150"), max_so_far_f: 66,
  analogs: [{ hourlies: [ob(7, 8, 7, 53, 74, 49, null, 0, 1013.4, "SCT090 BKN150 BKN220")], max_f: 94 },
            { hourlies: [ob(7, 7, 7, 53, 70, 48, 225, 9, 1012.8, "FEW220")], max_f: 97 }], slp_24h_ago_mb: 1013.4,
}, null,
  [{ label: "<=83", lo: -Infinity, hi: 83 }, { label: "84-85", lo: 84, hi: 85 }, { label: "86-87", lo: 86, hi: 87 },
   { label: "88-89", lo: 88, hi: 89 }, { label: "90-91", lo: 90, hi: 91 }, { label: ">=92", lo: 92, hi: Infinity }],
  { "<=83": 3, "84-85": 3, "86-87": 14, "88-89": 24, "90-91": 44, ">=92": 21 });
ok("KDEN full-ramp mode 85.7", approx(den.dist.mu, 85.7, 0.05));
ok("KDEN p_trunc ≈ 0.48", approx(den.dist.pTrunc, 0.48, 0.005));
ok("KDEN mixture mean 83.8 (< mode)", approx(den.dist.mean(), 83.8, 0.05));
ok("KDEN depth 4.0", approx(den.dist.depth, 4.0));
ok("KDEN R_analog(ens) +21.78", approx(den.components["R_analog(ens)"], 21.78, 0.05));
ok("KDEN A_sky -1.60", approx(den.components["A_sky"], -1.6, 0.02));
ok("KDEN bins match py", binsMatch(den.bin_probs, { "<=83": 0.471, "84-85": 0.151, "86-87": 0.136, "88-89": 0.105, "90-91": 0.069, ">=92": 0.067 }));
ok("KDEN market_pt 89.6, model colder", approx(den.market_pt, 89.6, 0.1) && /colder/.test(den.divergence_note));

// ---- checkpoint (piece 7): marine_baseline offshore persisting → press ----
const cpPrev = { station: "KLAX", now: ob(7, 9, 8, 53, 70, 60, 90, 4, 1011, "CLR") };
const cpNow = { station: "KLAX", now: ob(7, 9, 9, 53, 74, 60, 100, 4, 1011, "CLR") };
const cp = checkpoint(cpPrev, cpNow);
ok("checkpoint offshore → press_upper_bins", cp.stance === "press_upper_bins");
ok("checkpoint reports hourly rise +4", approx(cp.hourly_rise, 4));

// ---- coverage: all 20 Kalshi stations have a StationConfig ----
ok("all 20 Kalshi stations configured", Object.values(KALSHI_STATIONS).every(s => s in STATION_CONFIGS));
ok("sky parse: FEW100 SCT120 SCT150 deficit > 0", skyDeficit("FEW100 SCT120 SCT150", 150) > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
