// Parity test: lib/claude_analog_v3.js must reproduce claude_analog_v3.py's
// 2026-07-09 KNYC post-mortem replay (L1 upstream / L2 tilt / L3 lock / L4 guard).
// No network. Run: node test_claude_analog_v3.js
import { predict, upstreamAdvection, detectPeakLock, thinAnalogGuard, gradeAnalogBelief, UPSTREAM_STATIONS, hazeDiscount, smokeShield, mixingSignal, convergencePool } from "./netlify/functions/lib/claude_analog_v3.js";
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
ok("LOCK mean 82.70 (88% at max+0.35 σ0.55 + 12% lock-failure tail at +2.55)", approx(lock.dist.mean(), 82.70, 0.02));
ok("LOCK mass mostly <=82 / 83-84 with failure tail above (P(>=85) ~6%)", approx(lock.bin_probs["<=82"], 0.5496, 0.002) && approx(lock.bin_probs["83-84"], 0.3890, 0.002) && approx(1 - lock.bin_probs["<=82"] - lock.bin_probs["83-84"], 0.0614, 0.005));

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

// ---- physical ramp ceiling (2026-07-14 PHX R_analog(eff)=+25 at 13:00 local) ----
{
  // 13:00 local, analogs claim a +25 remaining climb — must clamp to (16-13)*3.5+2
  const hot = { station: "KPHX", tz: TZ, now: ob(7, 9, 13, 0, 98, 63, 270, 5, 1010.5, "CLR"), max_so_far_f: 102,
    analogs: [{ hourlies: [ob(7, 8, 13, 0, 73, 63, null, 0, 1010.5, "CLR")], max_f: 98 }], slp_24h_ago_mb: 1010.5 };
  const card = predict(hot, null, null, null);
  ok("ramp ceiling: eff clamped to clock bound", card.components["R_analog(eff)"] <= (16 - 13) * 3.5 + 2 + 0.01);
  ok("ramp ceiling: raw preserved for audit", card.components["R_analog(raw)"] > 20);
  ok("ramp ceiling: card flagged", card.ramp_clamped === true);
  ok("ramp ceiling: belief capped at D", gradeAnalogBelief(card, { hrsToPeak: 3 }).grade === "D");
  // pre-dawn +25 is legitimate: ceiling at 05:00 is (16-5)*3.5+2 = 40.5 — no clamp
  const dawn = { ...hot, now: ob(7, 9, 5, 0, 82, 63, 90, 5, 1011.2, "CLR"), max_so_far_f: 82 };
  const card2 = predict(dawn, null, null, null);
  ok("ramp ceiling: pre-dawn +25 passes unclamped", card2.ramp_clamped === false && card2.components["R_analog(eff)"] > 20);
}

// ---- 2026-07-15 session signals: haze discount + intraday mixing regime ----
{
  const hz = (vis, wx) => ({ now: { ...ob(7, 15, 10, 51, 90, 69, 270, 8, 1010.6, "CLR"), visibility_mi: vis, wx } });
  // KNYC 10:51 printed "4SM HZ" under CLR — deficit (7-4)/7, k 2.5 ≈ -1.07
  ok("haze: 4SM HZ ≈ -1.07", approx(hazeDiscount(hz(4, "HZ")), -2.5 * 3 / 7, 0.01));
  ok("haze: FU handed off to smokeShield (no double count)", hazeDiscount(hz(3, "FU")) === 0);
  ok("haze: clean 10SM → 0", hazeDiscount(hz(10, "")) === 0);
  ok("haze: low vis without HZ/FU code → 0 (rain/fog is the deck's job)", hazeDiscount(hz(4, "")) === 0);
  ok("haze: vis missing → 0", hazeDiscount({ now: ob(7, 15, 10, 51, 90, 69, 270, 8, 1010.6, "CLR") }) === 0);

  // The KNYC 2026-07-15 morning, verbatim: dp 69→70→72 (moistening climb), then
  // the 10:51 break — 85→90 (+5/hr) as dp fell 72→69 (dry mixing breakout).
  const trace = [ob(7, 15, 7, 51, 80, 69, null, 3, 1011.4, "CLR"),
                 ob(7, 15, 8, 51, 82, 70, null, 6, 1011.3, "CLR"),
                 ob(7, 15, 9, 51, 85, 72, null, 3, 1011.0, "CLR")];
  const cfgN = getConfig("KNYC");
  const m951 = mixingSignal({ station: "KNYC", tz: TZ, now: trace[2], today_hourlies: trace.slice(0, 2) }, cfgN);
  ok("mixing 9:51: dp +3 over 2h while climbing → moistening_climb", m951.flag === "moistening_climb");
  ok("mixing 9:51: no mu kick (Bowen already prices the level)", m951.kick === 0 && m951.sigmaMult === 1);
  const m1051 = mixingSignal({ station: "KNYC", tz: TZ,
    now: ob(7, 15, 10, 51, 90, 69, 270, 8, 1010.6, "CLR"), today_hourlies: trace }, cfgN);
  ok("mixing 10:51: dp -3 off trailing peak at +5/hr → dry_mixing_breakout", m1051.flag === "dry_mixing_breakout");
  ok("mixing 10:51: kick 2.0×(3/4) = +1.5", approx(m1051.kick, 1.5, 0.01));
  ok("mixing 10:51: σ inflated 1.3 (regime transition)", approx(m1051.sigmaMult, 1.3, 0.001));
  // gates: pre-dawn dp wiggles are radiational, not mixing; no trace → no signal
  const dawn = mixingSignal({ station: "KNYC", tz: TZ,
    now: ob(7, 15, 5, 51, 78, 69, null, 3, 1011.3, "CLR"), today_hourlies: trace }, cfgN);
  ok("mixing: pre-dawn gated off", dawn.flag === null && dawn.kick === 0);
  ok("mixing: no today_hourlies → none", mixingSignal({ station: "KNYC", tz: TZ,
    now: ob(7, 15, 10, 51, 90, 69, 270, 8, 1010.6, "CLR") }, cfgN).flag === null);

  // predict() integration: breakout kick + flag land on the card, haze in components
  const snapBreak = { station: "KNYC", tz: TZ,
    now: { ...ob(7, 15, 10, 51, 90, 69, 270, 8, 1010.6, "CLR"), visibility_mi: 4, wx: "HZ" },
    max_so_far_f: 90, today_hourlies: trace,
    analogs: [{ hourlies: [ob(7, 14, 10, 51, 82, 66, null, 0, 1018.2, "CLR")], max_f: 90 }],
    slp_24h_ago_mb: 1018.2 };
  const cardB = predict(snapBreak, null, null, null);
  ok("card: mixing_flag = dry_mixing_breakout", cardB.mixing_flag === "dry_mixing_breakout");
  ok("card: A_mixing +1.5", approx(cardB.components.A_mixing, 1.5, 0.01));
  ok("card: A_haze ≈ -1.07", approx(cardB.components.A_haze, -2.5 * 3 / 7, 0.01));
  // belief: a breakout mid-climb is exactly when the analogs stop binding
  const gB = gradeAnalogBelief({ peak_locked: false, dist: { sigma: 2.5, pTrunc: 0 }, advection_score: 0,
    analog_audit: [{ weight: 0.5 }], mixing_flag: "dry_mixing_breakout" });
  ok("grade: dry mixing breakout drags C → D", gB.grade === "D" && /breakout/.test(gB.why));
}

// ---- convergence pool (2026-07-15 KDEN: prints ridge 92, CLI 94, basin 95-96) ----
{
  const TZD = "America/Denver";
  const obD = (h, mi, t, dir, spd) => ({ ts: new Date(Date.UTC(2026, 6, 15, h + 6, mi)), temp_f: t,
    dewpoint_f: 44, wind_dir_deg: dir, wind_speed_kt: spd, slp_mb: 1010, sky: "FEW110" });
  const snap253 = { station: "KDEN", tz: TZD, now: obD(14, 53, 92, 90, 10), max_so_far_f: 92,
    analogs: [{ hourlies: [obD(14, 53, 94, 130, 15)], max_f: 95 }], slp_24h_ago_mb: 1012.1 };
  const UPW = { KAPA: obD(14, 53, 95, 200, 6), KBJC: obD(14, 47, 96, 250, 4) };
  const pool = convergencePool(snap253, UPW);
  ok("pool: 7/15 2:53 fixture fires (div 4.0)", pool && pool.divergence_f === 4);
  ok("pool: penalty is half the divergence", Math.abs(pool.penalty + 2) < 1e-9);
  ok("pool: calm feed -> null (pools cook off)", convergencePool({ ...snap253, now: obD(14, 53, 92, 90, 3) }, UPW) === null);
  ok("pool: westerly wind -> null (not the pool sector)", convergencePool({ ...snap253, now: obD(14, 53, 92, 270, 10) }, UPW) === null);
  ok("pool: small divergence -> null", convergencePool(snap253, { KAPA: obD(14, 53, 94, 200, 6) }) === null);
  ok("pool: no neighbors -> null", convergencePool(snap253, {}) === null);
  const card = predict(snap253, null, null, null, UPW);
  ok("card: A_pool applied", Math.abs(card.components.A_pool + 2) < 1e-9);
  ok("card: pool object carried", card.pool && /decoupled/.test(card.pool.note));
  const g = gradeAnalogBelief(card, { hrsToPeak: 1 });
  ok("grade: pooled day capped low with the why", ["D","F"].includes(g.grade) && /pool/.test(g.why));
}

// ---- 2026-07-17 KDCA smoke shield: FU is a shield, dryness is the relief ----
{
  const fu = (t, dp, vis, obsc) => ({ now: { ...ob(7, 17, 10, 52, t, dp, 0, 3, 1018.0, "OVC030"),
    visibility_mi: vis, wx: "FU", sky_obscured: !!obsc } });
  // KDCA 8:52am verbatim: 82/62, 1.5mi FU, VV020. deficit (7-1.5)/7, relief (20-15)/20=0.25
  const s852 = smokeShield(fu(82, 62, 1.5, true));
  ok("smoke 8:52: penalty -2.36", approx(s852.penalty, -4.0 * (5.5 / 7) * 0.75, 0.01));
  ok("smoke 8:52: shield (vis ≤3) + obscured carried", s852.shield === true && s852.obscured === true);
  // KDCA 12:52pm: 89/60, 2.5mi FU. spread 29 → relief capped at 0.5 — the dry
  // mixing that drove +9°F/5h through the plume halves the tax, never erases it.
  const s1252 = smokeShield(fu(89, 60, 2.5, false));
  ok("smoke 12:52: dry relief capped at 50%", approx(s1252.dry_relief, 0.5, 0.001));
  ok("smoke 12:52: penalty -1.29", approx(s1252.penalty, -4.0 * (4.5 / 7) * 0.5, 0.01));
  ok("smoke: thin plume (5mi) is a tint, not a shield", smokeShield(fu(90, 65, 5, false)).shield === false);
  ok("smoke: vis ≥7 → null", smokeShield(fu(90, 65, 8, false)) === null);
  ok("smoke: no FU code → null", smokeShield({ now: { ...ob(7, 17, 10, 52, 88, 60, 0, 3, 1018.0, "OVC030"), visibility_mi: 2.5, wx: "HZ" } }) === null);

  // predict() integration: A_smoke lands, sigma inflates, belief caps at D
  const snapFu = { station: "KDCA", tz: TZ,
    now: { ...ob(7, 17, 12, 52, 89, 60, 160, 5, 1018.1, "OVC030"), visibility_mi: 2.5, wx: "FU", sky_obscured: false },
    max_so_far_f: 90,
    analogs: [{ hourlies: [ob(7, 16, 12, 52, 92, 75, 180, 9, 1013.7, "FEW045")], max_f: 99 }],
    slp_24h_ago_mb: 1013.7 };
  const cardS = predict(snapFu, null, null, null);
  ok("card: A_smoke ≈ -1.29", approx(cardS.components.A_smoke, -1.29, 0.02));
  ok("card: smoke object carried", cardS.smoke && cardS.smoke.shield === true);
  const noFu = predict({ ...snapFu, now: { ...snapFu.now, wx: "", visibility_mi: 10 } }, null, null, null);
  ok("card: σ inflated 1.35 vs clean-sky twin", cardS.dist.sigma > noFu.dist.sigma * 1.2);
  const gS = gradeAnalogBelief(cardS, { hrsToPeak: 4 });
  ok("grade: plume day capped at D with the why", gS.grade === "D" && /smoke shield/.test(gS.why));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);