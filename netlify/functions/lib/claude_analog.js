// claude_analog.js — JS port of claude_analog.py (the "Claude method" obs-analog
// daily-max engine). Deliberately different epistemic stance from the Bayesian
// (NWS-anchored) engine: anchored to observations + yesterday's realized diurnal
// ramp, treating NWS guidance as absent. Run both, show both cards, let the
// disagreement be a signal.
//
//   T_max = T_now + R_analog + A_bowen + A_trajectory + A_airmass
//
// Kept in parity with claude_analog.py (see test_claude_analog.js). The reference
// Python + scoreboard.py remain the offline research/verification implementations.

import { erf } from "../../../erf.js";

// Wind sectors (deg, inclusive) from which marine/lake air reaches the sensor.
export const MARINE_SECTORS = {
  KNYC: [[90, 200]], KLGA: [[60, 180]], KBOS: [[20, 170]], KPHL: [[100, 180]],
  KMDW: [[0, 110]], KDEN: [], KDFW: [], KSAT: [], KLAX: [[180, 290]],
  KSEA: [[160, 280]], KDCA: [[120, 200]],
};

// Per-station tuning defaults (the 2026-07-09 session coefficients).
export function stationConfig(station, overrides = {}) {
  return {
    station,
    k_td: 0.35,             // °F max penalty per °F of Td excess vs analog day
    k_slp: 0.4,             // °F per mb of 24h SLP fall (capped)
    slp_cap: 2.0,           // max |airmass| adjustment, °F
    sea_breeze_penalty: 4.0,
    weak_flow_kt: 8.0,      // below this, land flow can't pin the marine air
    sigma_open: 4.5,        // spread at morning_hour
    sigma_peak: 1.0,        // spread at peak_hour
    peak_hour: 16,
    morning_hour: 7,
    ...overrides,
  };
}

const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

function inSector(deg, sectors) {
  if (deg == null) return false;
  return sectors.some(([lo, hi]) => deg >= lo && deg <= hi);
}

// Yesterday's rise from the ob nearest this clock-hour to yesterday's max.
function analogRamp(snap) {
  const targetMin = snap.now.ts.getUTCHours() * 60 + snap.now.ts.getUTCMinutes();
  let best = null, bestDelta = Infinity;
  for (const ob of snap.yesterday || []) {
    const d = Math.abs((ob.ts.getUTCHours() * 60 + ob.ts.getUTCMinutes()) - targetMin);
    if (d < bestDelta) { best = ob; bestDelta = d; }
  }
  if (!best) return { ramp: 0, analog: null };
  return { ramp: snap.yesterday_max_f - best.temp_f, analog: best };
}

function bowen(snap, analog, cfg) {
  if (!analog || analog.dewpoint_f == null || snap.now.dewpoint_f == null) return 0;
  const dTd = snap.now.dewpoint_f - analog.dewpoint_f;
  return -cfg.k_td * Math.max(0, dTd);
}

function trajectory(snap, cfg) {
  const sectors = MARINE_SECTORS[snap.station] || [];
  if (!sectors.length) return 0;
  const ob = snap.now;
  if (inSector(ob.wind_dir_deg, sectors)) return -cfg.sea_breeze_penalty; // marine air here now
  if ((ob.wind_speed_kt || 0) < cfg.weak_flow_kt) {                       // weak land flow
    const frac = 1 - (ob.wind_speed_kt || 0) / cfg.weak_flow_kt;
    return -0.5 * cfg.sea_breeze_penalty * frac;
  }
  return 0;
}

function airmass(snap, cfg) {
  if (snap.slp_24h_ago_mb == null || snap.now.slp_mb == null) return 0;
  const dSlp = snap.now.slp_mb - snap.slp_24h_ago_mb;      // negative = falling
  const adj = -cfg.k_slp * dSlp;                            // falling → warm bonus
  return Math.max(-cfg.slp_cap, Math.min(cfg.slp_cap, adj));
}

function sigmaAt(ts, cfg) {
  const h = ts.getUTCHours() + ts.getUTCMinutes() / 60;
  if (h <= cfg.morning_hour) return cfg.sigma_open;
  if (h >= cfg.peak_hour) return cfg.sigma_peak;
  const frac = (h - cfg.morning_hour) / (cfg.peak_hour - cfg.morning_hour);
  return cfg.sigma_open + frac * (cfg.sigma_peak - cfg.sigma_open);
}

function flooredNormalCdf(x, mu, sigma, floor) {
  if (x < floor) return 0;
  return phi((x - mu) / sigma);
}

function ci(mu, sigma, floor, z) {
  return [Math.max(floor, mu - z * sigma), Math.max(floor, mu + z * sigma)];
}

// bins: [{label, lo, hi}] whole °F (Infinity/-Infinity for open ends), treated as
// [lo-0.5, hi+0.5) vs the continuous dist (CLI whole-degree rounding).
export function binProbabilities(mu, sigma, floor, bins) {
  const out = {};
  for (const { label, lo, hi } of bins) {
    const a = lo === -Infinity ? -Infinity : lo - 0.5;
    const b = hi === Infinity ? Infinity : hi + 0.5;
    let pHi = b === Infinity ? 1 : flooredNormalCdf(b, mu, sigma, floor);
    let pLo = a === -Infinity ? 0 : flooredNormalCdf(a, mu, sigma, floor);
    if (a <= floor && floor < b) {                          // mass parked at the floor
      const atFloor = phi((floor - mu) / sigma);
      if (a !== -Infinity) pLo = Math.min(pLo, atFloor);
      pHi = Math.max(pHi, atFloor);
    }
    out[label] = Math.max(0, pHi - pLo);
  }
  const s = Object.values(out).reduce((x, y) => x + y, 0);
  if (s > 0) for (const k of Object.keys(out)) out[k] /= s;
  return out;
}

// snapshot: { station, now:{ts,temp_f,dewpoint_f,wind_dir_deg,wind_speed_kt,slp_mb},
//             max_so_far_f, yesterday:[HourlyOb], yesterday_max_f, slp_24h_ago_mb }
export function predict(snapshot, cfg = null, kalshiBins = null) {
  cfg = cfg || stationConfig(snapshot.station);
  const { ramp, analog } = analogRamp(snapshot);
  const aBowen = bowen(snapshot, analog, cfg);
  const aTraj = trajectory(snapshot, cfg);
  const aAir = airmass(snapshot, cfg);

  let mu = snapshot.now.temp_f + ramp + aBowen + aTraj + aAir;
  const sigma = sigmaAt(snapshot.now.ts, cfg);
  const floor = snapshot.max_so_far_f;
  mu = Math.max(mu, floor);                                 // can't forecast below a realized max

  const card = {
    station: snapshot.station,
    asof: snapshot.now.ts,
    point_f: mu,
    sigma_f: sigma,
    floor_f: floor,
    ci68: ci(mu, sigma, floor, 1.0),
    ci95: ci(mu, sigma, floor, 1.96),
    components: {
      T_now: snapshot.now.temp_f, R_analog: ramp, A_bowen: aBowen,
      A_trajectory: aTraj, A_airmass: aAir,
    },
    bin_probs: {},
  };
  if (kalshiBins) card.bin_probs = binProbabilities(mu, sigma, floor, kalshiBins);
  return card;
}
