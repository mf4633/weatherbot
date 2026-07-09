// Parity test: JS claude_analog.js must reproduce claude_analog.py's worked
// example (KNYC 2026-07-09 09:51). No network. Run: node test_claude_analog.js
import { predict, stationConfig, binProbabilities, MARINE_SECTORS } from "./netlify/functions/lib/claude_analog.js";

let pass = 0, fail = 0;
const approx = (a, b, tol = 0.001) => Math.abs(a - b) <= tol;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); }
                             else { fail++; console.log(`  ✗ ${name}`); } };

// Build Dates via Date.UTC so getUTCHours()/getUTCMinutes() match the Python naive-local parts.
const D = (mo, d, h, mi) => new Date(Date.UTC(2026, mo - 1, d, h, mi));

const yesterday = [
  { ts: D(7, 8, 8, 51), temp_f: 71, dewpoint_f: 62, wind_dir_deg: 20, wind_speed_kt: 6, slp_mb: 1017.4 },
  { ts: D(7, 8, 9, 51), temp_f: 73, dewpoint_f: 63, wind_dir_deg: null, wind_speed_kt: 0, slp_mb: 1017.5 },
  { ts: D(7, 8, 13, 51), temp_f: 85, dewpoint_f: 62, wind_dir_deg: 0, wind_speed_kt: 0, slp_mb: 1016.1 },
];
const snap = {
  station: "KNYC",
  now: { ts: D(7, 9, 9, 51), temp_f: 79, dewpoint_f: 70, wind_dir_deg: 225, wind_speed_kt: 5, slp_mb: 1013.6 },
  max_so_far_f: 79.0, yesterday, yesterday_max_f: 85.0, slp_24h_ago_mb: 1017.5,
};
const bins = [
  { label: "<=82", lo: -Infinity, hi: 82 },
  { label: "83-84", lo: 83, hi: 84 },
  { label: "85-86", lo: 85, hi: 86 },
  { label: "87-88", lo: 87, hi: 88 },
  { label: "89-90", lo: 89, hi: 90 },
  { label: ">=91", lo: 91, hi: Infinity },
];

const card = predict(snap, null, bins);

// --- point + sigma + components (vs Python) ---
ok("point ≈ 89.36°F", approx(card.point_f, 89.36, 0.01));
ok("sigma ≈ 3.392°F", approx(card.sigma_f, 3.392, 0.005));
ok("R_analog = +12", approx(card.components.R_analog, 12));
ok("A_bowen = -2.45", approx(card.components.A_bowen, -2.45));
ok("A_trajectory = -0.75", approx(card.components.A_trajectory, -0.75));
ok("A_airmass = +1.56", approx(card.components.A_airmass, 1.56));
ok("floor = 79", card.floor_f === 79);
ok("ci68 ≈ [86.0, 92.8]", approx(card.ci68[0], 85.97, 0.05) && approx(card.ci68[1], 92.76, 0.05));

// --- bin probs vs Python (2.2 / 5.4 / 12.4 / 20.0 / 23.2 / 36.8 %) ---
const ref = { "<=82": 0.022, "83-84": 0.054, "85-86": 0.124, "87-88": 0.200, "89-90": 0.232, ">=91": 0.368 };
let binsMatch = true;
for (const k of Object.keys(ref)) if (!approx(card.bin_probs[k], ref[k], 0.001)) { binsMatch = false; console.log(`    bin ${k}: js ${card.bin_probs[k].toFixed(3)} vs py ${ref[k]}`); }
ok("all bin probs match Python to 0.1%", binsMatch);
ok("bins sum to 1", approx(Object.values(card.bin_probs).reduce((a, b) => a + b, 0), 1.0));

// --- edge cases ---
// no marine sector (KDEN) → trajectory 0
const den = predict({ station: "KDEN", now: { ts: D(7, 9, 14, 0), temp_f: 90, wind_dir_deg: 180, wind_speed_kt: 3, dewpoint_f: 40, slp_mb: 1010 },
  max_so_far_f: 90, yesterday: [{ ts: D(7, 8, 14, 0), temp_f: 88, dewpoint_f: 40 }], yesterday_max_f: 95, slp_24h_ago_mb: 1010 });
ok("KDEN trajectory = 0 (continental)", den.components.A_trajectory === 0);
// mu floored at max-so-far
const floored = predict({ station: "KDEN", now: { ts: D(7, 9, 16, 0), temp_f: 60 }, max_so_far_f: 88,
  yesterday: [{ ts: D(7, 8, 16, 0), temp_f: 85 }], yesterday_max_f: 86 });
ok("mu floored at max-so-far (88)", floored.point_f === 88);

// --- all 20 requested cities are configured (coastal → sector, continental → []) ---
const COASTAL = ["KLAX", "KNYC", "KMIA", "KMDW", "KBOS", "KSEA", "KPHL", "KHOU", "KSFO", "KMSY", "KDCA"];
const CONTINENTAL = ["KDEN", "KAUS", "KDFW", "KLAS", "KOKC", "KPHX", "KSAT", "KMSP", "KATL"];
ok("all 20 requested stations present in MARINE_SECTORS",
   [...COASTAL, ...CONTINENTAL].every(s => s in MARINE_SECTORS));
ok("coastal stations have a marine sector", COASTAL.every(s => (MARINE_SECTORS[s] || []).length > 0));
ok("continental stations have no marine sector", CONTINENTAL.every(s => (MARINE_SECTORS[s] || []).length === 0));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
