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

// rounding/5-min-record uncertainty only: CLI may read up to ~1°F above the hourly
// running max (intra-hour spikes), rarely below.
export function lockedDistribution(maxSoFar) {
  return makeMixture(maxSoFar + 0.35, 0.55, 0, 0, 0, maxSoFar);
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
  const rampEff = ramp * rampCredit;

  let mu = snap.now.temp_f + rampEff + aBowen + aTraj + aAir + aSky + aUp;
  mu = Math.max(mu, snap.max_so_far_f);

  // 2026-07-09 bugfix: sigma schedule runs on LOCAL hours (UTC shrank eastern
  // stations' sigma 4-5h early). No tz → stay at sigma_open (widest = safest).
  const h = snap.tz ? localHourFrac(snap.now.ts, snap.tz) : cfg.morning_hour;
  let sigma;
  if (h <= cfg.morning_hour) sigma = cfg.sigma_open;
  else if (h >= cfg.peak_hour) sigma = cfg.sigma_peak;
  else sigma = cfg.sigma_open + ((h - cfg.morning_hour) / (cfg.peak_hour - cfg.morning_hour)) * (cfg.sigma_peak - cfg.sigma_open);
  sigma *= upSigmaMult * (1.0 + (ADVECTION_SIGMA_INFL - 1.0) * adv);

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
      A_bowen: aBowen, A_trajectory: aTraj, A_airmass: aAir, A_sky: aSky, A_upstream: aUp },
    analog_audit: audits, upstream_audit: upAudit, advection_score: adv,
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

// --- local-time helper (2026-07-09 UTC-hours bugfix) ---------------------------
export function localHourFrac(ts, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(ts);
  const get = (t) => parseInt(parts.find(p => p.type === t)?.value ?? "0", 10);
  return (get("hour") % 24) + get("minute") / 60.0;
}
