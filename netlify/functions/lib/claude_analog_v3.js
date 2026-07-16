// claude_analog_v3.js — JS port of claude_analog_v3.py: the 2026-07-09 KNYC
// post-mortem encoded as four layers on top of v2 (imported, not duplicated).
//   L1 upstream advection    — neighbors 1–3h upwind lend their CURRENT sky as an
//                              incoming-insolation penalty + variance inflator.
//   L2 informed-market tilt  — optional posterior shift toward the market (off for
//                              the pure ledger, on for sizing) + residual sigma.
//   L3 peak-lock detection   — a falling trace after 11 LT under a cap collapses
//                              the distribution to max_so_far ± rounding.
//   L4 advection-regime guard— warm-advection score caps the analog ramp and
//                              inflates sigma when today isn't the analogs' regime.
// Kept in parity with claude_analog_v3.py (test_claude_analog_v3.js).

import {
  MARINE_SECTORS, getConfig, skyDeficit, analogEnsemble, makeMixture,
  marketPoint, interpretDivergence, inSector,
  bowen, trajectory, airmass, insolation, truncation,
} from "./claude_analog_v2.js";

// --- L1: upstream stations (ASOS neighbors ~1–3h of advection upwind) ---------
// { station: [{ station, lead_h, bearing_from }] }. lead_h ≈ advection time at
// ~25 kt mid-level steering; bearing_from is the flow direction this pairing
// covers. marine_baseline stations are intentionally absent (their cloud is
// locally-generated stratus, not advected — upstream sky is uninformative).
export const UPSTREAM_STATIONS = {
  KNYC: [{ station: "KPHL", lead_h: 1.0, bearing_from: 240 }, { station: "KABE", lead_h: 1.5, bearing_from: 260 },
         { station: "KAVP", lead_h: 2.0, bearing_from: 280 }, { station: "KBWI", lead_h: 2.5, bearing_from: 230 }],
  KBOS: [{ station: "KBDL", lead_h: 1.0, bearing_from: 250 }, { station: "KALB", lead_h: 2.0, bearing_from: 280 },
         { station: "KPOU", lead_h: 1.5, bearing_from: 260 }],
  KPHL: [{ station: "KBWI", lead_h: 1.0, bearing_from: 230 }, { station: "KMDT", lead_h: 1.5, bearing_from: 290 },
         { station: "KIAD", lead_h: 1.5, bearing_from: 240 }],
  KDCA: [{ station: "KCHO", lead_h: 1.5, bearing_from: 230 }, { station: "KIAD", lead_h: 0.5, bearing_from: 280 },
         { station: "KMRB", lead_h: 1.5, bearing_from: 290 }],
  KMDW: [{ station: "KRFD", lead_h: 1.5, bearing_from: 280 }, { station: "KDVN", lead_h: 2.5, bearing_from: 260 },
         { station: "KJOT", lead_h: 0.75, bearing_from: 240 }],
  KDEN: [{ station: "KAPA", lead_h: 0.5, bearing_from: 200 }, { station: "KCOS", lead_h: 1.5, bearing_from: 190 },
         { station: "KBJC", lead_h: 0.5, bearing_from: 270 }],
  KDFW: [{ station: "KACT", lead_h: 1.5, bearing_from: 190 }, { station: "KSPS", lead_h: 2.0, bearing_from: 290 },
         { station: "KMWL", lead_h: 1.0, bearing_from: 260 }],
  KATL: [{ station: "KCSG", lead_h: 1.5, bearing_from: 220 }, { station: "KBHM", lead_h: 2.5, bearing_from: 270 },
         { station: "KRMG", lead_h: 1.0, bearing_from: 300 }],
  KMSP: [{ station: "KSTC", lead_h: 1.0, bearing_from: 290 }, { station: "KRWF", lead_h: 1.5, bearing_from: 240 },
         { station: "KEAU", lead_h: 1.5, bearing_from: 90 }],
  KOKC: [{ station: "KLAW", lead_h: 1.0, bearing_from: 210 }, { station: "KCDS", lead_h: 2.5, bearing_from: 260 },
         { station: "KWWR", lead_h: 2.0, bearing_from: 290 }],
  KHOU: [{ station: "KCXO", lead_h: 1.0, bearing_from: 340 }, { station: "KVCT", lead_h: 1.5, bearing_from: 230 }],
  KMIA: [{ station: "KFLL", lead_h: 0.4, bearing_from: 20 }, { station: "KTMB", lead_h: 0.3, bearing_from: 200 },
         { station: "KAPF", lead_h: 1.5, bearing_from: 260 }],
  KMSY: [{ station: "KBTR", lead_h: 1.0, bearing_from: 290 }, { station: "KASD", lead_h: 0.5, bearing_from: 60 }],
};

export const BEARING_TOL = 70.0;
export const K_UPSTREAM = 3.5;
export const UPSTREAM_SIGMA_INFL = 1.6;

// Returns { penalty, sigmaMult, audit }. Penalty phases in with 1/lead (nearer
// upstream cloud = sooner, more certain); off-bearing stations discounted not zeroed.
export function upstreamAdvection(station, upstreamObs, steeringDirDeg, cfg) {
  const pairs = UPSTREAM_STATIONS[station] || [];
  if (!pairs.length || cfg.regime === "marine_baseline") return { penalty: 0, sigmaMult: 1, audit: [] };
  const audit = []; let wsum = 0, acc = 0;
  for (const up of pairs) {
    const ob = (upstreamObs || {})[up.station];
    if (ob == null) continue;
    let deficit = skyDeficit(ob.sky, cfg.sky_ceiling_x100ft);
    // widen the ceiling: advected mid/high decks matter even above the local cut.
    deficit = Math.max(deficit, 0.7 * skyDeficit(ob.sky, 250));
    let bearW;
    if (steeringDirDeg != null) {
      const miss = Math.abs(((steeringDirDeg - up.bearing_from + 180) % 360 + 360) % 360 - 180);
      bearW = Math.max(0.25, 1.0 - miss / (2 * BEARING_TOL));
    } else bearW = 0.6;
    const w = bearW / Math.max(up.lead_h, 0.3);
    audit.push({ station: up.station, deficit: Math.round(deficit * 100) / 100, lead_h: up.lead_h, weight: Math.round(w * 100) / 100 });
    wsum += w; acc += w * deficit;
  }
  if (wsum === 0) return { penalty: 0, sigmaMult: 1, audit };
  const incoming = acc / wsum;
  return { penalty: -K_UPSTREAM * incoming, sigmaMult: 1 + (UPSTREAM_SIGMA_INFL - 1) * incoming, audit };
}

// --- L4: warm-advection regime score (0 in-regime .. 1 analogs unreliable) ----
export const RAMP_CAP_AT_FULL_ADVECTION = 0.55;
export const ADVECTION_SIGMA_INFL = 1.5;

export function advectionRegimeScore(snap, upstreamIncoming, analogTd) {
  let s = 0;
  if (snap.slp_24h_ago_mb != null && snap.now.slp_mb != null) {
    const fall = snap.slp_24h_ago_mb - snap.now.slp_mb;
    s += Math.min(0.4, Math.max(0, fall / 8.0));
  }
  if (snap.now.dewpoint_f != null) {
    const tdRise = snap.now.dewpoint_f - analogTd;
    s += Math.min(0.3, Math.max(0, tdRise / 15.0));
  }
  s += 0.3 * upstreamIncoming;
  return Math.min(1.0, s);
}

// --- A_haze: aerosol insolation discount (2026-07-15 KNYC) ----------------------
// The sky group is blind to haze/smoke: KNYC 10:51 printed "4SM HZ" under CLR while
// the column moistened aloft — a real insolation cut the k_sky term scored as zero.
// Discount only when an obstruction code is present (low vis in rain/fog is a
// different mechanism already covered by the deck) and phases in below 7 miles.
export const HAZE_VIS_CEILING_MI = 7.0;
export const K_HAZE = 2.5;

export function hazeDiscount(snap) {
  const ob = snap.now;
  if (ob.visibility_mi == null || !/\b(HZ|FU)\b/.test(ob.wx || "")) return 0;
  const deficit = Math.max(0, Math.min(1, (HAZE_VIS_CEILING_MI - ob.visibility_mi) / HAZE_VIS_CEILING_MI));
  return -K_HAZE * deficit;
}

// --- mixing signal (2026-07-15 KNYC session) ------------------------------------
// The morning dewpoint TREND against the climb rate, read from today's own trace.
// Two regimes the static Bowen term (level vs analog) cannot distinguish:
//   dry_mixing_breakout — dewpoint breaks ≥2°F below its trailing-3h peak while the
//     temp climbs ≥3°F/hr: deep mixing is tapping drier air aloft, the humid cap is
//     being dismantled, and the Bowen penalty (priced off the dp LEVEL) overstates
//     the drag. KNYC 10:51: 85→90 (+5/hr) as dp fell 72→69 — the print that flipped
//     the day from "capped at 94" to "96-97 live". Positive kick + σ inflation
//     (a regime transition is exactly when the analogs stop binding).
//   moistening_climb — dewpoint ≥2°F above its ~2h-ago value while still climbing:
//     moisture is winning against mixing (KNYC 8:51-9:51: dp 69→72), corroborating
//     the Bowen cap. No mu change (the level term already prices it) — flagged so
//     the grade and the card narrate it.
export const K_BREAKOUT = 2.0;
export const BREAKOUT_SIGMA_INFL = 1.3;

export function mixingSignal(snap, cfg) {
  const none = { kick: 0, sigmaMult: 1, flag: null };
  const hrs = snap.today_hourlies || [];
  if (snap.now.dewpoint_f == null || !snap.tz) return none;
  const h = localHourFrac(snap.now.ts, snap.tz);
  // Morning-to-midday climb only: pre-dawn dp wiggles are radiational, and by peak
  // the ramp is spent so re-crediting it would double-count.
  if (h < cfg.morning_hour + 1 || h > cfg.peak_hour - 1) return none;
  const nowMs = snap.now.ts.getTime();
  const window = hrs.filter(o => o.ts.getTime() < nowMs && nowMs - o.ts.getTime() <= 3 * 3600e3
    && o.dewpoint_f != null && o.temp_f != null);
  if (window.length < 2) return none;
  // Climb rate vs the ob nearest one hour back; dp trend vs the trailing peak
  // (breakout) and the ~2h-ago level (moistening).
  const nearest = (targetMs) => window.reduce((a, o) =>
    Math.abs(o.ts.getTime() - targetMs) < Math.abs(a.ts.getTime() - targetMs) ? o : a);
  const refRate = nearest(nowMs - 3600e3);
  const dtH = (nowMs - refRate.ts.getTime()) / 3600e3;
  if (dtH < 0.5) return none;
  const climbRate = (snap.now.temp_f - refRate.temp_f) / dtH;
  const tdPeak = Math.max(...window.map(o => o.dewpoint_f));
  const tdDrop = tdPeak - snap.now.dewpoint_f;
  if (tdDrop >= 2 && climbRate >= 3) {
    return { kick: K_BREAKOUT * Math.min(1, tdDrop / 4), sigmaMult: BREAKOUT_SIGMA_INFL,
             flag: "dry_mixing_breakout" };
  }
  const refOld = nearest(nowMs - 2 * 3600e3);
  if (snap.now.dewpoint_f - refOld.dewpoint_f >= 2 && climbRate >= 1) {
    return { kick: 0, sigmaMult: 1, flag: "moistening_climb" };
  }
  return none;
}

// --- convergence pool (2026-07-15 KDEN, the $81 lesson) --------------------------
// A DCVZ-prone station can sit in a shallow cold pool fed by an organized wind off
// a cool fetch sector while the entire basin runs 4-6°F hotter: every airmass model
// (NWS blend included) is then right about the county and wrong about the contract.
// Detection: wind from the station's pool sector, >=5 kt (an organized feed — calm
// pools cook off), and the official reading >= POOL_DIVERGENCE_F below the warmest
// same-time neighbor. Effect: A_pool = -K_POOL x divergence (half, because pools
// partially leak — 7/15 printed a 92 ridge and settled CLI 94), sigma x1.3, grade D.
// Replayed on 7/15's 2:53 PM: neighbors 95, official 92, E10G23 → blend 96 - 1.5 =
// 94.5 vs CLI 94.
export const POOL_SECTORS = { KDEN: [[40, 160]] };
export const POOL_DIVERGENCE_F = 3.5;
export const K_POOL = 0.5;
export const POOL_SIGMA_INFL = 1.3;

export function convergencePool(snap, upstreamObs) {
  const sectors = POOL_SECTORS[snap.station];
  if (!sectors || !inSector(snap.now.wind_dir_deg, sectors)) return null;
  if ((snap.now.wind_speed_kt || 0) < 5) return null;
  const temps = Object.values(upstreamObs || {}).map(o => o?.temp_f).filter(Number.isFinite);
  if (!temps.length) return null;
  const basin = Math.max(...temps);
  const div = basin - snap.now.temp_f;
  if (div < POOL_DIVERGENCE_F) return null;
  return { penalty: -K_POOL * div, divergence_f: +div.toFixed(1), basin_f: basin,
    note: `convergence pool: official ${div.toFixed(1)}°F below warmest neighbor (${basin.toFixed(0)}°F) ` +
          `under an organized ${snap.now.wind_dir_deg}° feed — microclimate decoupled, airmass models overshoot` };
}

// --- L2: informed-market tilt --------------------------------------------------
// weight toward market grows with divergence: w = |d|/(|d|+3). Residual (what the
// tilt does NOT close) becomes added-in-quadrature sigma.
export function informedMarketTilt(modelMu, mktPt, enabled) {
  const d = modelMu - mktPt;
  if (!enabled) {
    return { mu: modelMu, extraSigma: 0, note:
      `pure model (tilt off); divergence ${d >= 0 ? "+" : ""}${d.toFixed(1)}°F vs market — ` +
      `remember 2026-07-09: ask 'what do they know' before 'why are they slow'` };
  }
  const w = Math.abs(d) / (Math.abs(d) + 3.0);
  const mu = (1 - w) * modelMu + w * mktPt;
  const extraSigma = 0.5 * Math.abs(d) * (1 - w);
  return { mu, extraSigma, note:
    `informed-market tilt: ${Math.round(w * 100)}% toward market (${modelMu.toFixed(1)} → ${mu.toFixed(1)}), ` +
    `+${extraSigma.toFixed(1)}°F sigma for residual disagreement` };
}

// --- L3: peak-lock detection ---------------------------------------------------
// True when the day's max is physically behind us: trace falling ≥1.5°F below the
// running max after 11 LT AND a capping mechanism visibly engaged. Conservative —
// a false lock is worse than a late one.
export function detectPeakLock(snapPrev, snapNow, cfg = null) {
  cfg = cfg || getConfig(snapNow.station);
  // 2026-07-09 bugfix: threshold is 11 LOCAL time. METAR ts is UTC; convert via
  // the snapshot's IANA tz. Without tz we cannot know local time — refuse to
  // lock rather than false-lock a dawn dip at the midnight max (see tests).
  if (!snapNow.tz) return { locked: false, note: "no tz on snapshot — lock disabled (UTC-hours false-lock guard)" };
  const h = localHourFrac(snapNow.now.ts, snapNow.tz);
  if (h < 11.0) return { locked: false, note: "too early to lock" };
  const drop = snapNow.max_so_far_f - snapNow.now.temp_f;
  if (drop < 1.5) return { locked: false, note: `trace only ${drop.toFixed(1)}°F off the max` };
  let falling = true;
  if (snapPrev != null) falling = snapNow.now.temp_f < snapPrev.now.temp_f - 0.4;
  if (!falling) return { locked: false, note: "off the max but not actively falling" };
  const deck = skyDeficit(snapNow.now.sky, 250);
  const marine = inSector(snapNow.now.wind_dir_deg, MARINE_SECTORS[snapNow.station] || []);
  if (deck >= 0.5 || marine) {
    const why = deck >= 0.5 ? "overcast deck" : "marine air at sensor";
    return { locked: true, note:
      `PEAK LOCKED at ${snapNow.max_so_far_f.toFixed(0)}°F — trace falling (${drop.toFixed(1)}°F off max) ` +
      `after 11 LT under ${why}; insolation cannot recover the deficit` };
  }
  return { locked: false, note: "falling but no visible cap — could be transient (outflow)" };
}

// rounding/5-min-record uncertainty PLUS a lock-failure tail. First 68 settled
// locked decisions (2026-07-10/11): truth − floor = {0: 38, +1: 23, +2: 5, +6: 1,
// +9: 1} — never negative, mean +0.71, and 10% of locks failed by ≥2°F (re-warming
// after a transient dip, mostly Gulf-coast marine caps). The 12% second component
// at floor+2.55 (σ 1.79) reproduces that outcome distribution: P(floor) 0.55,
// P(+1) 0.35, P(≥+2) 0.10, mean +0.70.
export function lockedDistribution(maxSoFar) {
  return makeMixture(maxSoFar + 0.35, 0.55, 0.12, -2.2, 1.7, maxSoFar);
}

// --- v3 predict ----------------------------------------------------------------
// snap: same shape as v2. upstreamObs: { upstreamStation: HourlyOb }. snapPrev: the
// previous snapshot (for L3 falling-trace detection). marketTilt: enable L2.
export function predict(snap, cfg = null, kalshiBins = null, marketBookCents = null,
                        upstreamObs = null, snapPrev = null, marketTilt = false) {
  cfg = cfg || getConfig(snap.station);
  upstreamObs = upstreamObs || {};

  // L3 first: a locked day short-circuits everything.
  const lock = detectPeakLock(snapPrev, snap, cfg);
  if (lock.locked) {
    const dist = lockedDistribution(snap.max_so_far_f);
    const card = {
      station: snap.station, asof: snap.now.ts, dist,
      components: { max_so_far: snap.max_so_far_f },
      analog_audit: [], upstream_audit: [], advection_score: 0,
      peak_locked: true, lock_note: lock.note, tilt_note: "",
      bin_probs: {}, market_pt: null, divergence_note: "",
    };
    if (kalshiBins) card.bin_probs = dist.binProbs(kalshiBins);
    if (marketBookCents) { card.market_pt = marketPoint(marketBookCents); card.divergence_note = interpretDivergence(dist.mean(), card.market_pt); }
    return card;
  }

  // v2 terms
  const { ramp, analogTd, audits } = analogEnsemble(snap, cfg);
  const aBowen = bowen(snap, analogTd, cfg);
  const aTraj = trajectory(snap, cfg);
  const aAir = airmass(snap, cfg);
  const aSky = insolation(snap, cfg);
  const { p: pTr, depth } = truncation(snap, cfg);

  // L1
  const { penalty: aUp, sigmaMult: upSigmaMult, audit: upAudit } =
    upstreamAdvection(snap.station, upstreamObs, snap.now.wind_dir_deg, cfg);
  const incoming = K_UPSTREAM ? -aUp / K_UPSTREAM : 0;

  // L4
  const adv = advectionRegimeScore(snap, incoming, analogTd);
  const rampCredit = 1.0 - adv * (1.0 - RAMP_CAP_AT_FULL_ADVECTION);
  // Physical ramp ceiling (2026-07-14): a wrong-hour analog match handed the 20:16Z
  // PHX card R_analog(eff)=+25 at 13:00 local — raw Bayesian 119°F, belief C,
  // unguarded; only the NWS blend kept the served point sane. Remaining same-day
  // climb is clock-bounded: ~3.5°F/hr until peak_hour plus 2°F spike headroom.
  // Legitimate pre-dawn ramps (+25 on an 82→108 day) sit far below their ceiling.
  const hRamp = snap.tz ? localHourFrac(snap.now.ts, snap.tz) : cfg.morning_hour;
  const rampCeil = Math.max(0, cfg.peak_hour - hRamp) * 3.5 + 2;
  const rampClamped = ramp * rampCredit > rampCeil;
  const rampEff = rampClamped ? rampCeil : ramp * rampCredit;

  // 2026-07-15 session signals: haze insolation cut + intraday mixing regime +
  // convergence-pool microclimate decoupling.
  const aHaze = hazeDiscount(snap);
  const mix = mixingSignal(snap, cfg);
  const pool = convergencePool(snap, upstreamObs);
  const aPool = pool ? pool.penalty : 0;

  let mu = snap.now.temp_f + rampEff + aBowen + aTraj + aAir + aSky + aUp + aHaze + mix.kick + aPool;
  mu = Math.max(mu, snap.max_so_far_f);

  // 2026-07-09 bugfix: sigma schedule runs on LOCAL hours (UTC shrank eastern
  // stations' sigma 4-5h early). No tz → stay at sigma_open (widest = safest).
  const h = snap.tz ? localHourFrac(snap.now.ts, snap.tz) : cfg.morning_hour;
  let sigma;
  if (h <= cfg.morning_hour) sigma = cfg.sigma_open;
  else if (h >= cfg.peak_hour) sigma = cfg.sigma_peak;
  else sigma = cfg.sigma_open + ((h - cfg.morning_hour) / (cfg.peak_hour - cfg.morning_hour)) * (cfg.sigma_peak - cfg.sigma_open);
  sigma *= upSigmaMult * (1.0 + (ADVECTION_SIGMA_INFL - 1.0) * adv) * mix.sigmaMult * (pool ? POOL_SIGMA_INFL : 1);

  // L2 (post-hoc on the mean; sigma addition in quadrature)
  let tiltNote = "", extraSigma = 0;
  const mktPt = marketBookCents ? marketPoint(marketBookCents) : null;
  if (mktPt != null) {
    const t = informedMarketTilt(mu, mktPt, marketTilt);
    mu = Math.max(t.mu, snap.max_so_far_f); extraSigma = t.extraSigma; tiltNote = t.note;
  }
  sigma = Math.sqrt(sigma ** 2 + extraSigma ** 2);

  const dist = makeMixture(mu, sigma, pTr, depth, cfg.conv_depth_sigma, snap.max_so_far_f);
  const card = {
    station: snap.station, asof: snap.now.ts, dist,
    components: { T_now: snap.now.temp_f, "R_analog(eff)": rampEff, "R_analog(raw)": ramp,
      A_bowen: aBowen, A_trajectory: aTraj, A_airmass: aAir, A_sky: aSky, A_upstream: aUp,
      A_haze: aHaze, A_mixing: mix.kick, A_pool: aPool },
    analog_audit: audits, upstream_audit: upAudit, advection_score: adv,
    ramp_clamped: rampClamped, mixing_flag: mix.flag, pool,
    peak_locked: false, lock_note: "", tilt_note: tiltNote,
    bin_probs: {}, market_pt: null, divergence_note: "",
  };
  if (kalshiBins) card.bin_probs = dist.binProbs(kalshiBins);
  if (mktPt != null) { card.market_pt = mktPt; card.divergence_note = interpretDivergence(dist.mean(), mktPt); }
  return card;
}

// --- thin-analog guard (2026-07-10 display hardening) ---------------------------
// With hours of heating left, a near-zero analog ramp is almost always a data
// artifact (sparse prior-day hourlies → nearestOb lands far from the current hour),
// not a real "done warming" call — the KLAX 8:53 AM card read high = current temp
// with 5.7h to peak. When ≥2h from peak, the ramp credited <1.5°F, and yesterday's
// realized max sits above the prediction, floor the point at damped persistence
// (yesterday's max − 1°F). Display/gating hardening only — the scored ledger stays
// the pure v3 model. Unfitted prior; see EDGE_AUDIT.md.
export function thinAnalogGuard(point, snap, rampEff, hrsToPeak) {
  const maxes = (snap.analogs || []).map(a => a.max_f).filter(Number.isFinite);
  if (!maxes.length) return { point, guarded: false };
  const persistence = Math.max(...maxes);
  if (hrsToPeak == null || hrsToPeak < 2) return { point, guarded: false };
  if ((rampEff ?? 0) >= 1.5) return { point, guarded: false };
  const floor = persistence - 1;
  if (floor <= point) return { point, guarded: false };
  return { point: floor, guarded: true };
}

// --- belief grade (2026-07-10) ---------------------------------------------------
// How much the analog believes its own number, A (strongest) … F, from the same
// signals used to argue a call: peak-lock (max physically in → A), persistence
// fallback (not a belief at all → D cap), distribution tightness, out-of-regime
// advection, analog match weight, convective coin-flips, and hours to peak.
// Displayed next to the card's number and logged with each ledger decision so the
// grade itself gets scored against truth (do A-days verify better than D-days?).
export function gradeAnalogBelief(card, { guarded = false, hrsToPeak = null } = {}) {
  if (card.peak_locked) return { grade: "A", why: "peak locked — max is physically in" };
  if (guarded) return { grade: "D", why: "thin analog — persistence fallback, not a model belief" };
  if (card.ramp_clamped) return { grade: "D", why: "ramp clamped — analog climb exceeded the clock's physical ceiling" };
  if (card.pool) return { grade: "D", why: `convergence pool — official ${card.pool.divergence_f}°F below basin, microclimate decoupled; airmass models overshoot` };
  let s = 3;                                    // C baseline
  const why = [];
  const sigma = card.dist.sigma;
  if (sigma <= 1.5) { s += 1; why.push(`tight σ ${sigma.toFixed(1)}`); }
  else if (sigma >= 3.5) { s -= 1; why.push(`wide σ ${sigma.toFixed(1)}`); }
  const adv = card.advection_score || 0;
  if (adv > 0.5) { s -= 2; why.push(`out-of-regime (advection ${adv.toFixed(2)})`); }
  else if (adv > 0.25) { s -= 1; why.push(`advection ${adv.toFixed(2)}`); }
  if (card.mixing_flag === "dry_mixing_breakout") { s -= 1; why.push("dry mixing breakout — humid-cap regime dismantling mid-climb"); }
  else if (card.mixing_flag === "moistening_climb") { why.push("moistening climb — Bowen cap corroborated by the trend"); }
  const wsum = (card.analog_audit || []).reduce((a, x) => a + (x.weight || 0), 0);
  if (wsum >= 0.8) { s += 1; why.push("strong analog match"); }
  else if (wsum < 0.2) { s -= 1; why.push("weak analog match"); }
  if ((card.dist.pTrunc || 0) > 0.5) { s -= 1; why.push(`convective coin-flip (p ${(card.dist.pTrunc).toFixed(2)})`); }
  if (hrsToPeak != null) {
    if (hrsToPeak <= 2) { s += 1; why.push("near peak"); }
    else if (hrsToPeak >= 7) { s -= 1; why.push(`${Math.round(hrsToPeak)}h to peak`); }
  }
  const grade = s >= 5 ? "A" : s >= 4 ? "B" : s >= 3 ? "C" : s >= 2 ? "D" : "F";
  return { grade, why: why.join(", ") || "baseline evidence" };
}

// --- local-time helper (2026-07-09 UTC-hours bugfix) ---------------------------
export function localHourFrac(ts, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(ts);
  const get = (t) => parseInt(parts.find(p => p.type === t)?.value ?? "0", 10);
  return (get("hour") % 24) + get("minute") / 60.0;
}
