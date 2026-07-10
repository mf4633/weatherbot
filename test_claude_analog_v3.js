// Parity test: lib/claude_analog_v3.js must reproduce claude_analog_v3.py's
// 2026-07-09 KNYC post-mortem replay (L1 upstream / L2 tilt / L3 lock / L4 guard).
// No network. Run: node test_claude_analog_v3.js
import { predict, upstreamAdvection, detectPeakLock, thinAnalogGuard, gradeAnalogBelief, UPSTREAM_STATIONS } from "./netlify/functions/lib/claude_analog_v3.js";
import { getConfig } from "./netlify/functions/lib/claude_analog_v2.js";

let pass = 0, fail = 0;
const approx = (a, b, t = 0.05) => a != null && Math.abs(a - b) <= t;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };
const D = (mo, d, h, mi) => new Date(Date.UTC(2026, mo - 1, d, h + 4, mi));  // fixtures are EDT local; +4 = UTC (2026-07-09 tz bugfix)
const TZ = "America/New_York";
const ob = (mo, d, h, mi, t, td, dir, spd, slp, sky) => ({ ts: D(mo, d, h, mi), temp_f: t, dewpoint_f: td, wind_dir_deg: dir, wind_speed_kt: spd, slp_mb: slp, sky });
const binsMatch = (got, ref) => Object.keys(ref).every(k => approx(got[k], ref[k], 0.002));

const BINS = [{ label: "<=82", lo: -Infinity, hi: 82 }, { label: "83-84", lo: 83, hi: 84 }, { label: "85-86", lo: 85, hi: 86 },
              { label: "87-88", lo: 87, hi: 88 }, { label: "89-90", lo: 89, hi: 90 }, { label: ">=91", lo: 91, hi: Infinity }];
const BOOK = { "<=82": 22, "83-84": 59, "85-86": 28, "87-88": 3, "89-90": 1, ">=91": 1 };
const snap951 = { station: "KNYC", tz: TZ, now: ob(7, 9, 9, 51, 79, 70, 225, 5, 1013.6, "CLR"), max_so_far_f: 79,
  analogs: [{ hourlies: [ob(7, 8, 9, 51, 73, 63, null, 0, 1017.5, "CLR")], max_f: 85 }], slp_24h_ago_mb: 1017.5 };
const UP = {
  KPHL: ob(7, 9, 9, 51, 78, 70, 230, 7, 1013.0, "SCT035 BKN110"),
  KABE: ob(7, 9, 9, 51, 76, 69, 240, 6, 1012.6, "BKN032 OVC100"),
  KAVP: ob(7, 9, 9, 51, 74, 68, 250, 8, 1012.4, "OVC090"),
};

// ---- 9:51 WITHOUT upstream (v2-equivalent info; L4 still fires on SLP/Td) ----
const noup = predict(snap951, null, BINS, BOOK);
ok("NOUP mean 85.73 (floored-mixture)", approx(noup.dist.mean(), 85.73, 0.02));
ok("NOUP R_analog(eff) +8.22 (L4 capped from 12)", approx(noup.components["R_analog(eff)"], 8.22));
ok("NOUP advection_score 0.70", approx(noup.advection_score, 0.70, 0.005));
ok("NOUP A_upstream 0 (no obs)", noup.components.A_upstream === 0);
ok("NOUP bins match py", binsMatch(noup.bin_probs, { "<=82": 0.25058, "83-84": 0.15619, "85-86": 0.17286, "87-88": 0.15855, "89-90": 0.12053, ">=91": 0.14129 }));
ok("NOUP not locked", noup.peak_locked === false);

// ---- 9:51 WITH upstream (L1 + L4 active) — the shield the market saw ----
const up = predict(snap951, null, BINS, BOOK, UP);
ok("UP mean 83.32 (pulled colder by shield)", approx(up.dist.mean(), 83.32, 0.02));
ok("UP A_upstream -2.86", approx(up.components.A_upstream, -2.86, 0.01));
ok("UP R_analog(eff) +6.89", approx(up.components["R_analog(eff)"], 6.89, 0.01));
ok("UP advection_score 0.95", approx(up.advection_score, 0.9455, 0.005));
ok("UP upstream audit KPHL 0.70 / KABE 0.95 / KAVP 0.95",
  up.upstream_audit.length === 3 && approx(up.upstream_audit[0].deficit, 0.70) && approx(up.upstream_audit[1].deficit, 0.95));
ok("UP bins match py", binsMatch(up.bin_probs, { "<=82": 0.55925, "83-84": 0.10263, "85-86": 0.0918, "87-88": 0.07644, "89-90": 0.05925, ">=91": 0.11063 }));
ok("UP ≈ agreement with market (floored mean 83.3 vs 83.7)", /agreement/.test(up.divergence_note));

// ---- 9:51 + informed-market tilt ON (L2, sizing view) ----
const tilt = predict(snap951, null, BINS, BOOK, UP, null, true);
ok("TILT mean 84.00 (44% toward market)", approx(tilt.dist.mean(), 84.00, 0.02));
ok("TILT note reports 44% toward market", /44% toward market/.test(tilt.tilt_note));
ok("TILT bins match py", binsMatch(tilt.bin_probs, { "<=82": 0.50411, "83-84": 0.1053, "85-86": 0.0978, "87-88": 0.0846, "89-90": 0.06816, ">=91": 0.14002 }));

// ---- 1:05 PM: trace falling under the deck → L3 peak lock ----
const snap1251 = { station: "KNYC", tz: TZ, now: ob(7, 9, 12, 51, 81.9, 72, null, 4, 1012.4, "SCT028 SCT039 OVC110"), max_so_far_f: 82,
  analogs: snap951.analogs, slp_24h_ago_mb: 1016.7 };
const snap1305 = { station: "KNYC", tz: TZ, now: ob(7, 9, 13, 5, 79.4, 72, 170, 6, 1012.3, "SCT028 BKN045 OVC100"), max_so_far_f: 82,
  analogs: snap951.analogs, slp_24h_ago_mb: 1016.6 };
const lock = predict(snap1305, null, BINS, BOOK, null, snap1251);
ok("LOCK peak_locked true", lock.peak_locked === true);
ok("LOCK note 'PEAK LOCKED at 82'", /PEAK LOCKED at 82°F/.test(lock.lock_note));
ok("LOCK mean 82.44 (floored mean of max+0.35, σ0.55)", approx(lock.dist.mean(), 82.44, 0.02));
ok("LOCK collapses to <=82 / 83-84 only", approx(lock.bin_probs["<=82"], 0.60747, 0.002) && approx(lock.bin_probs["83-84"], 0.39249, 0.002) && lock.bin_probs["85-86"] < 0.001);

// ---- helper-level parity ----
const uh = upstreamAdvection("KNYC", UP, 225, getConfig("KNYC"));
ok("upstreamAdvection penalty -2.8645", approx(uh.penalty, -2.8645, 0.001));
ok("upstreamAdvection sigmaMult 1.4911", approx(uh.sigmaMult, 1.4911, 0.001));
// 12:51 with no prev: only 0.1°F off the max → NOT locked (conservative gate)
ok("no lock at 12:51 (0.1°F off max)", detectPeakLock(null, snap1251, getConfig("KNYC")).locked === false);
// coverage: every L1 station is real (starts with K, 4 chars) and no self-reference
ok("upstream maps well-formed, no self-ref", Object.entries(UPSTREAM_STATIONS).every(([s, ups]) =>
  ups.length && ups.every(u => /^K[A-Z]{3}$/.test(u.station) && u.station !== s)));


// --- 2026-07-09 tz bugfix regressions (dawn false-lock) -------------------------
{
  const dawnPrev = { station: "KNYC", tz: TZ, now: { ts: new Date(Date.UTC(2026, 6, 10, 10, 51)), temp_f: 72, dewpoint_f: 68, wind_dir_deg: 340, wind_speed_kt: 4, slp_mb: 1014, sky: "OVC012" }, max_so_far_f: 75 };
  const dawnNow  = { station: "KNYC", tz: TZ, now: { ts: new Date(Date.UTC(2026, 6, 10, 11, 51)), temp_f: 71, dewpoint_f: 68, wind_dir_deg: 340, wind_speed_kt: 4, slp_mb: 1014, sky: "OVC012" }, max_so_far_f: 75 };
  ok("TZ no dawn false-lock at 7:51 AM EDT", detectPeakLock(dawnPrev, dawnNow).locked === false);
  const seaPrev = { station: "KSEA", tz: "America/Los_Angeles", now: { ts: new Date(Date.UTC(2026, 6, 10, 11, 53)), temp_f: 58, dewpoint_f: 54, wind_dir_deg: 200, wind_speed_kt: 5, slp_mb: 1016, sky: "OVC008" }, max_so_far_f: 61 };
  const seaNow  = { station: "KSEA", tz: "America/Los_Angeles", now: { ts: new Date(Date.UTC(2026, 6, 10, 12, 53)), temp_f: 57, dewpoint_f: 54, wind_dir_deg: 200, wind_speed_kt: 5, slp_mb: 1016, sky: "OVC008" }, max_so_far_f: 61 };
  ok("TZ no dawn false-lock at 5:53 AM PDT (marine arm)", detectPeakLock(seaPrev, seaNow).locked === false);
  const noTz = { station: "KNYC", now: dawnNow.now, max_so_far_f: 82 };
  ok("TZ missing-tz fail-safe refuses lock", detectPeakLock(null, noTz).locked === false);
}


// --- thin-analog guard (2026-07-10: KLAX "high = current temp at 8:53 AM") ------
{
  const snapLAX = { analogs: [{ max_f: 74 }] };
  const g1 = thinAnalogGuard(68, snapLAX, 0.1, 5.7);
  ok("guard floors degenerate LAX 68 → 73 (persistence 74 − 1)", g1.guarded === true && approx(g1.point, 73));
  ok("guard off when ramp healthy (+8.7)", thinAnalogGuard(75.2, snapLAX, 8.7, 5.7).guarded === false);
  ok("guard off near peak (1h left — flat trace is real)", thinAnalogGuard(68, snapLAX, 0.1, 1.0).guarded === false);
  ok("guard off when point already ≥ persistence−1", thinAnalogGuard(73.5, snapLAX, 0.1, 5.7).guarded === false);
  ok("guard off with no analogs", thinAnalogGuard(68, { analogs: [] }, 0.1, 5.7).guarded === false);
}

// --- belief grade (A strongest … F) ---------------------------------------------
{
  ok("grade: peak-locked day → A", gradeAnalogBelief(lock).grade === "A");
  ok("grade: persistence fallback → D", gradeAnalogBelief(noup, { guarded: true }).grade === "D");
  // the 9:51 KNYC morning call (wide σ 4.6, advection 0.70, weak-ish analog) — the
  // call that verified 4°F hot — must grade near the bottom.
  const gNoup = gradeAnalogBelief(noup);
  ok("grade: out-of-regime wide-σ morning call → F", gNoup.grade === "F" && /out-of-regime/.test(gNoup.why));
  // strong conditions: tight σ, in-regime, strong analog match, near peak → A
  const strong = { peak_locked: false, dist: { sigma: 1.2, pTrunc: 0 }, advection_score: 0.1,
                   analog_audit: [{ weight: 0.9 }] };
  ok("grade: tight-σ in-regime near-peak → A", gradeAnalogBelief(strong, { hrsToPeak: 1.5 }).grade === "A");
  // convective coin-flip drags a middling day down
  const conv = { peak_locked: false, dist: { sigma: 2.5, pTrunc: 0.6 }, advection_score: 0,
                 analog_audit: [{ weight: 0.5 }] };
  ok("grade: convective coin-flip → D", gradeAnalogBelief(conv).grade === "D");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);