// claude_analog_v2.js — JS port of claude_analog_v2.py: the obs-analog daily-max
// engine with the judgment layer folded in (convective-truncation mixture,
// regime-dependent Bowen, sky cover, multi-day analog ensemble, market divergence,
// marine-baseline regime, checkpoint policy). Kept in parity with the Python
// reference (test_claude_analog_v2.js). erf via the shared erf.js.

import { erf } from "../../../erf.js";

export const MARINE_SECTORS = {
  KNYC: [[90, 200]], KLGA: [[60, 180]], KBOS: [[20, 170]], KPHL: [[100, 180]],
  KMDW: [[0, 110]], KDCA: [[120, 200]], KMIA: [[40, 170]], KHOU: [[100, 210]],
  KMSY: [[90, 230]], KLAX: [[180, 290]], KSEA: [[160, 280]],
};
export const OFFSHORE_SECTORS = {
  KLAX: [[0, 140]], KSEA: [[20, 140]], KSFO: [[0, 120]],
};

export const KALSHI_STATIONS = {
  nyc: "KNYC", la: "KLAX", miami: "KMIA", chicago: "KMDW", boston: "KBOS",
  seattle: "KSEA", denver: "KDEN", philadelphia: "KPHL", austin: "KAUS",
  houston: "KHOU", sf: "KSFO", dallas: "KDFW", nola: "KMSY", vegas: "KLAS",
  okc: "KOKC", dc: "KDCA", phoenix: "KPHX", san_antonio: "KSAT",
  minneapolis: "KMSP", atlanta: "KATL",
};

// Full default config; per-station overrides applied in STATION_CONFIGS.
function cfgOf(station, o = {}) {
  return {
    station, regime: "continental",
    k_td: 0.35, mixing_dilution: 1.0,
    sea_breeze_penalty: 4.0, weak_flow_kt: 8.0,
    k_offshore: 2.5,
    k_slp: 0.4, slp_cap: 2.0,
    k_sky: 4.0, sky_ceiling_x100ft: 150,
    conv_enabled: false, conv_td_ref: 50.0, conv_a_td: 0.12, conv_a_slp: 0.25,
    conv_a_sky: 0.7, conv_base_logit: -2.0, conv_depth_mean: 4.0, conv_depth_sigma: 2.0,
    sigma_open: 4.5, sigma_peak: 1.0, peak_hour: 16, morning_hour: 7,
    ...o,
  };
}

export const STATION_CONFIGS = {
  // Continental / high plains
  KDEN: cfgOf("KDEN", { mixing_dilution: 0.5, conv_enabled: true, sigma_open: 5.0 }),
  KDFW: cfgOf("KDFW", { mixing_dilution: 0.7, conv_enabled: true, sigma_open: 3.5 }),
  KSAT: cfgOf("KSAT", { mixing_dilution: 0.7, conv_enabled: true, conv_base_logit: -2.4, sigma_open: 3.0 }),
  KAUS: cfgOf("KAUS", { mixing_dilution: 0.7, conv_enabled: true, conv_base_logit: -2.4, sigma_open: 3.0 }),
  KOKC: cfgOf("KOKC", { mixing_dilution: 0.6, conv_enabled: true, conv_a_slp: 0.30, sigma_open: 4.0 }),
  KMSP: cfgOf("KMSP", { mixing_dilution: 0.6, conv_enabled: true, sigma_open: 4.5 }),
  KATL: cfgOf("KATL", { mixing_dilution: 0.9, conv_enabled: true, conv_td_ref: 62.0, conv_depth_mean: 3.0, sigma_open: 3.5 }),
  // Desert
  KPHX: cfgOf("KPHX", { mixing_dilution: 0.4, conv_enabled: true, conv_td_ref: 55.0, conv_base_logit: -2.4, conv_depth_mean: 5.0, conv_depth_sigma: 2.5, sigma_open: 3.0 }),
  KLAS: cfgOf("KLAS", { mixing_dilution: 0.4, conv_enabled: true, conv_td_ref: 55.0, conv_base_logit: -2.8, conv_depth_mean: 4.0, sigma_open: 3.0 }),
  // Sea/lake/bay-breeze
  KNYC: cfgOf("KNYC", { regime: "sea_breeze" }),
  KBOS: cfgOf("KBOS", { regime: "sea_breeze", sea_breeze_penalty: 5.0 }),
  KMDW: cfgOf("KMDW", { regime: "sea_breeze", sea_breeze_penalty: 5.0, conv_enabled: true }),
  KPHL: cfgOf("KPHL", { regime: "sea_breeze", sea_breeze_penalty: 3.0, conv_enabled: true, conv_td_ref: 60.0, conv_depth_mean: 3.0 }),
  KDCA: cfgOf("KDCA", { regime: "sea_breeze", sea_breeze_penalty: 2.5, conv_enabled: true, conv_td_ref: 62.0, conv_depth_mean: 3.0 }),
  KMIA: cfgOf("KMIA", { regime: "sea_breeze", sea_breeze_penalty: 2.0, conv_enabled: true, conv_td_ref: 70.0, conv_base_logit: -1.2, conv_depth_mean: 2.5, sigma_open: 2.0, sigma_peak: 0.8, peak_hour: 14 }),
  KHOU: cfgOf("KHOU", { regime: "sea_breeze", sea_breeze_penalty: 2.0, conv_enabled: true, conv_td_ref: 70.0, conv_base_logit: -1.6, conv_depth_mean: 3.0, sigma_open: 2.5, peak_hour: 15 }),
  KMSY: cfgOf("KMSY", { regime: "sea_breeze", sea_breeze_penalty: 1.5, conv_enabled: true, conv_td_ref: 70.0, conv_base_logit: -1.2, conv_depth_mean: 3.0, sigma_open: 2.5, peak_hour: 14 }),
  // Marine-baseline
  KLAX: cfgOf("KLAX", { regime: "marine_baseline", sigma_open: 2.0, sigma_peak: 0.8 }),
  KSEA: cfgOf("KSEA", { regime: "marine_baseline", k_offshore: 3.0, sigma_open: 2.5, sigma_peak: 1.0 }),
  KSFO: cfgOf("KSFO", { regime: "marine_baseline", k_offshore: 5.0, sigma_open: 3.0, sigma_peak: 1.2 }),
};

export function getConfig(station) { return STATION_CONFIGS[station] || cfgOf(station); }

// --- sky ---
const COVER_FRAC = { FEW: 0.15, SCT: 0.40, BKN: 0.70, OVC: 0.95 };
export function skyDeficit(sky, ceiling) {
  let low = 0, high = 0;
  const re = /(FEW|SCT|BKN|OVC)(\d{3})/g; let m;
  while ((m = re.exec(sky || "")) !== null) {
    const frac = COVER_FRAC[m[1]];
    if (parseInt(m[2], 10) <= ceiling) low = Math.max(low, frac);
    else high = Math.max(high, frac);
  }
  return Math.min(1, low + 0.3 * high * (1 - low));
}

// --- helpers ---
const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
export const inSector = (deg, sectors) => deg != null && sectors.some(([lo, hi]) => deg >= lo && deg <= hi);
const logistic = (x) => 1 / (1 + Math.exp(-x));
const hm = (ts) => ts.getUTCHours() * 60 + ts.getUTCMinutes();
function nearestOb(hourlies, ts) {
  const tgt = hm(ts); let best = null, bd = Infinity;
  for (const ob of hourlies || []) { const d = Math.abs(hm(ob.ts) - tgt); if (d < bd) { best = ob; bd = d; } }
  return best;
}

// --- analog ensemble (piece 4) ---
export function analogEnsemble(snap, cfg) {
  const audits = []; let wsum = 0, rampAcc = 0, tdAcc = 0;
  const nowSky = skyDeficit(snap.now.sky, cfg.sky_ceiling_x100ft);
  snap.analogs.forEach((day, i) => {
    const ob = nearestOb(day.hourlies, snap.now.ts);
    if (!ob) return;
    const ramp = day.max_f - ob.temp_f;
    const dTd = (snap.now.dewpoint_f != null && ob.dewpoint_f != null)
      ? Math.abs(snap.now.dewpoint_f - ob.dewpoint_f) : 0;
    const dSky = Math.abs(nowSky - skyDeficit(ob.sky, cfg.sky_ceiling_x100ft));
    const recency = 1 / (1 + i);
    const w = recency * Math.exp(-((dTd / 6) ** 2) - ((dSky / 0.4) ** 2));
    audits.push({ analog_idx: i, same_hr_temp: ob.temp_f, same_hr_td: ob.dewpoint_f, ramp, weight: w });
    wsum += w; rampAcc += w * ramp; if (ob.dewpoint_f != null) tdAcc += w * ob.dewpoint_f;
  });
  if (wsum === 0) return { ramp: 0, analogTd: snap.now.dewpoint_f ?? 0, audits };
  return { ramp: rampAcc / wsum, analogTd: tdAcc / wsum, audits };
}

// --- adjustment terms (exported so claude_analog_v3.js can reuse them) ---
export function bowen(snap, analogTd, cfg) {
  if (snap.now.dewpoint_f == null) return 0;
  return -cfg.k_td * cfg.mixing_dilution * Math.max(0, snap.now.dewpoint_f - analogTd);
}
export function trajectory(snap, cfg) {
  const ob = snap.now;
  if (cfg.regime === "sea_breeze") {
    if (inSector(ob.wind_dir_deg, MARINE_SECTORS[snap.station] || [])) return -cfg.sea_breeze_penalty;
    if ((ob.wind_speed_kt || 0) < cfg.weak_flow_kt) return -0.5 * cfg.sea_breeze_penalty * (1 - (ob.wind_speed_kt || 0) / cfg.weak_flow_kt);
    return 0;
  }
  if (cfg.regime === "marine_baseline") {
    if (inSector(ob.wind_dir_deg, OFFSHORE_SECTORS[snap.station] || [])) return cfg.k_offshore;
    return 0;
  }
  return 0;
}
export function airmass(snap, cfg) {
  if (snap.slp_24h_ago_mb == null || snap.now.slp_mb == null) return 0;
  return Math.max(-cfg.slp_cap, Math.min(cfg.slp_cap, -cfg.k_slp * (snap.now.slp_mb - snap.slp_24h_ago_mb)));
}
export function insolation(snap, cfg) { return -cfg.k_sky * skyDeficit(snap.now.sky, cfg.sky_ceiling_x100ft); }
export function truncation(snap, cfg) {
  if (!cfg.conv_enabled) return { p: 0, depth: 0 };
  const td = snap.now.dewpoint_f != null ? snap.now.dewpoint_f : cfg.conv_td_ref;
  let slpFall = 0;
  if (snap.slp_24h_ago_mb != null && snap.now.slp_mb != null) slpFall = Math.max(0, snap.slp_24h_ago_mb - snap.now.slp_mb);
  const debris = skyDeficit(snap.now.sky, 160) > 0.25 ? 1 : 0;
  const logit = cfg.conv_base_logit + cfg.conv_a_td * (td - cfg.conv_td_ref) + cfg.conv_a_slp * slpFall + cfg.conv_a_sky * debris;
  return { p: logistic(logit), depth: cfg.conv_depth_mean };
}

// --- mixture distribution ---
export function makeMixture(mu, sigma, pTrunc, depth, depthSigma, floor) {
  const cdf = (x) => {
    if (x < floor) return 0;
    const c1 = phi((x - mu) / sigma);
    const s2 = Math.sqrt(sigma ** 2 + depthSigma ** 2);
    const c2 = phi((x - (mu - depth)) / s2);
    return (1 - pTrunc) * c1 + pTrunc * c2;
  };
  const quantile = (p) => {
    let lo = floor, hi = mu + 8 * sigma;
    if (cdf(lo) >= p) return lo;
    for (let i = 0; i < 60; i++) { const mid = 0.5 * (lo + hi); if (cdf(mid) < p) lo = mid; else hi = mid; }
    return 0.5 * (lo + hi);
  };
  const mean = () => mu - pTrunc * depth;
  const binProbs = (bins) => {
    const out = {};
    for (const { label, lo, hi } of bins) {
      const a = lo === -Infinity ? -Infinity : lo - 0.5;
      const b = hi === Infinity ? Infinity : hi + 0.5;
      const pa = a === -Infinity ? 0 : cdf(a);
      const pb = b === Infinity ? 1 : cdf(b);
      out[label] = Math.max(0, pb - pa);
    }
    const s = Object.values(out).reduce((x, y) => x + y, 0);
    if (s > 0) for (const k of Object.keys(out)) out[k] /= s;
    return out;
  };
  return { mu, sigma, pTrunc, depth, depthSigma, floor, cdf, quantile, mean, binProbs };
}

// --- market prior (piece 5) ---
export function marketPoint(bookCents) {
  let total = 0, acc = 0;
  for (let [lbl, cents] of Object.entries(bookCents)) {
    const p = cents / 100; lbl = lbl.replace(/°/g, "").trim();
    let mid;
    if (lbl.startsWith("<=")) mid = parseInt(lbl.slice(2), 10) - 1;
    else if (lbl.startsWith(">=")) mid = parseInt(lbl.slice(2), 10) + 1;
    else if (lbl.includes("-")) { const [lo, hi] = lbl.split("-"); mid = (+lo + +hi) / 2; }
    else mid = +lbl;
    acc += p * mid; total += p;
  }
  return total ? acc / total : NaN;
}
export function interpretDivergence(modelPt, mktPt) {
  const d = modelPt - mktPt;
  if (Math.abs(d) < 1) return "≈ agreement — market fair per model, edge (if any) is in tails";
  const side = d > 0 ? "hotter" : "colder";
  return `⚠ model ${d >= 0 ? "+" : ""}${d.toFixed(1)}°F ${side} than market. The crowd trades NBM/AFD; ` +
    "divergence means guidance and obs disagree — identify WHICH scenario guidance is pricing " +
    "(marine shift / convection / cloud) before sizing, and prefer owning the corridor between the two modes.";
}

// snapshot: { station, now:{ts,temp_f,dewpoint_f,wind_dir_deg,wind_speed_kt,slp_mb,sky},
//             max_so_far_f, analogs:[{hourlies:[HourlyOb], max_f}], slp_24h_ago_mb }
export function predict(snap, cfg = null, kalshiBins = null, marketBookCents = null) {
  cfg = cfg || getConfig(snap.station);
  const { ramp, analogTd } = analogEnsemble(snap, cfg);
  const aBowen = bowen(snap, analogTd, cfg);
  const aTraj = trajectory(snap, cfg);
  const aAir = airmass(snap, cfg);
  const aSky = insolation(snap, cfg);
  const { p: pTr, depth } = truncation(snap, cfg);

  let mu = snap.now.temp_f + ramp + aBowen + aTraj + aAir + aSky;
  mu = Math.max(mu, snap.max_so_far_f);

  const h = snap.now.ts.getUTCHours() + snap.now.ts.getUTCMinutes() / 60;
  let sigma;
  if (h <= cfg.morning_hour) sigma = cfg.sigma_open;
  else if (h >= cfg.peak_hour) sigma = cfg.sigma_peak;
  else sigma = cfg.sigma_open + ((h - cfg.morning_hour) / (cfg.peak_hour - cfg.morning_hour)) * (cfg.sigma_peak - cfg.sigma_open);

  const dist = makeMixture(mu, sigma, pTr, depth, cfg.conv_depth_sigma, snap.max_so_far_f);
  const card = {
    station: snap.station, asof: snap.now.ts, dist,
    components: { T_now: snap.now.temp_f, "R_analog(ens)": ramp, A_bowen: aBowen, A_trajectory: aTraj, A_airmass: aAir, A_sky: aSky },
    bin_probs: {}, market_pt: null, divergence_note: "",
  };
  if (kalshiBins) card.bin_probs = dist.binProbs(kalshiBins);
  if (marketBookCents) { card.market_pt = marketPoint(marketBookCents); card.divergence_note = interpretDivergence(dist.mean(), card.market_pt); }
  return card;
}

// --- checkpoint policy (piece 7) ---
export function checkpoint(prev, now, cfg = null, expectedHourlyRise = 3.0) {
  cfg = cfg || getConfig(now.station);
  const sig = { signals: [], stance: "hold" };
  const rise = now.now.temp_f - prev.now.temp_f;
  sig.hourly_rise = rise;
  if (rise >= expectedHourlyRise) sig.signals.push(`ramp nominal-to-hot (+${rise.toFixed(0)})`);
  else if (rise >= expectedHourlyRise - 2) sig.signals.push(`ramp soft (+${rise.toFixed(0)})`);
  else { sig.signals.push(`ramp stalled (+${rise.toFixed(0)}) — investigate wind/sky`); sig.stance = "downgrade"; }

  if (cfg.regime === "sea_breeze" && inSector(now.now.wind_dir_deg, MARINE_SECTORS[now.station] || [])) {
    sig.signals.push("wind veered MARINE — cap engaged"); sig.stance = "exit_upper_bins";
  }
  if (cfg.regime === "marine_baseline") {
    const wasOff = inSector(prev.now.wind_dir_deg, OFFSHORE_SECTORS[now.station] || []);
    const nowOff = inSector(now.now.wind_dir_deg, OFFSHORE_SECTORS[now.station] || []);
    if (wasOff && !nowOff) { sig.signals.push("onshore arrival — plateau begins, max ≈ current + 1-2"); sig.stance = "settle_mode_bin"; }
    else if (nowOff) { sig.signals.push("offshore persisting — each hour ≈ +1°F on max; press upper bins"); sig.stance = "press_upper_bins"; }
  }
  if (now.now.dewpoint_f != null && prev.now.dewpoint_f != null) {
    const dtd = now.now.dewpoint_f - prev.now.dewpoint_f;
    if (dtd >= 2) sig.signals.push(`Td climbing (${dtd >= 0 ? "+" : ""}${dtd.toFixed(0)}) — moisture transport, cu/convection risk up`);
    else if (dtd <= -3 && cfg.regime === "continental") sig.signals.push(`Td mixing out (${dtd.toFixed(0)}) — deep-BL dilution on schedule, hot path intact`);
  }
  const dSky = skyDeficit(now.now.sky, cfg.sky_ceiling_x100ft) - skyDeficit(prev.now.sky, cfg.sky_ceiling_x100ft);
  if (dSky > 0.15) { sig.signals.push("sky thickening — insolation tax rising"); if (sig.stance === "hold") sig.stance = "downgrade"; }
  return sig;
}
