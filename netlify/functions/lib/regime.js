// Kalman regime filter — per-city, per-variable (HIGH/LOW) bias state with
// random-walk dynamics.
//
// State-space model (residual sign matches weather.js: predicted − actual):
//   μ_t = μ_{t-1} + w_t,    w_t ~ N(0, σ_walk²)
//   y_t = μ_t + ε_t,        ε_t ~ N(0, σ_obs²)
// y_t,high = forecastHighF_t − actualMax_t  (positive = over-predict HIGH)
// y_t,low  = forecastLowF_t  − actualMin_t  (positive = over-predict LOW)
//
// Per-city, per-variable σ_walk, σ_obs fit offline via EM
// (kalman_fit_all_cities.js, 5y data) — separate cold/warm seasons. mu_seed
// and p_seed are the production initial state: the filter's converged state
// at the end of the training data, used when no live blob entry exists yet.
//
// Runtime:
//   logger.js  runs kalmanStep() on each daily settle, separately for HIGH
//              (cliData.maxF) and LOW (cliData.minF), persists state to blob
//              under per_city_kalman_state (HIGH) and per_city_kalman_state_low
//              (LOW) — separate blob keys to avoid schema-migration churn.
//   weather.js reads via kalmanCorrection(cli, variable), applies μ as priorMean
//              shift and (P + σ_walk²) into priorStd² in quadrature.

// Per-city per-variable Kalman params. The seasonal split matters most for
// continental-climate cities on HIGH (BOS, CMH, NYC, IND, MDW, DEN have winter
// σ_walk 2.5-3.5× their warm value due to frontal passages). LOW-side seasonality
// is generally smaller — nighttime troughs are more predictable than daytime
// peaks (less convective noise, calmer atmosphere). SJC is an exception on LOW
// (summer marine layer rolls in unpredictably, warm σ_walk > cold).
export const KALMAN_PARAMS = {
  "NYC": {
    high: { sigma_walk_cold: 0.7444, sigma_obs_cold: 1.2986, sigma_walk_warm: 0.3081, sigma_obs_warm: 1.6764, mu_seed: -0.1902, p_seed: 0.6362 },
    low:  { sigma_walk_cold: 0.5997, sigma_obs_cold: 1.3594, sigma_walk_warm: 0.2557, sigma_obs_warm: 1.3570, mu_seed:  0.7957, p_seed: 0.4914 },
  },
  "LAX": {
    high: { sigma_walk_cold: 0.3135, sigma_obs_cold: 1.4501, sigma_walk_warm: 0.2693, sigma_obs_warm: 1.4353, mu_seed:  0.2066, p_seed: 0.3714 },
    low:  { sigma_walk_cold: 0.3467, sigma_obs_cold: 1.3003, sigma_walk_warm: 0.2043, sigma_obs_warm: 0.9051, mu_seed:  0.2690, p_seed: 0.2720 },
  },
  "MDW": {
    high: { sigma_walk_cold: 0.5548, sigma_obs_cold: 1.4824, sigma_walk_warm: 0.2701, sigma_obs_warm: 1.5439, mu_seed: -0.3465, p_seed: 0.5842 },
    low:  { sigma_walk_cold: 0.2507, sigma_obs_cold: 1.7463, sigma_walk_warm: 0.2945, sigma_obs_warm: 1.2446, mu_seed:  0.5434, p_seed: 0.3576 },
  },
  "HOU": {
    high: { sigma_walk_cold: 0.3037, sigma_obs_cold: 1.3720, sigma_walk_warm: 0.3121, sigma_obs_warm: 1.5764, mu_seed:  1.1729, p_seed: 0.3983 },
    low:  { sigma_walk_cold: 0.2392, sigma_obs_cold: 1.2311, sigma_walk_warm: 0.1921, sigma_obs_warm: 0.9899, mu_seed:  0.6778, p_seed: 0.2189 },
  },
  "PHX": {
    high: { sigma_walk_cold: 0.2874, sigma_obs_cold: 0.8934, sigma_walk_warm: 0.1872, sigma_obs_warm: 0.9425, mu_seed:  0.0879, p_seed: 0.1925 },
    low:  { sigma_walk_cold: 0.2210, sigma_obs_cold: 1.0465, sigma_walk_warm: 0.2906, sigma_obs_warm: 1.4959, mu_seed:  1.4859, p_seed: 0.3086 },
  },
  "PHL": {
    high: { sigma_walk_cold: 0.2784, sigma_obs_cold: 1.2982, sigma_walk_warm: 0.2785, sigma_obs_warm: 1.5784, mu_seed: -1.0024, p_seed: 0.3681 },
    low:  { sigma_walk_cold: 0.2484, sigma_obs_cold: 1.4102, sigma_walk_warm: 0.3000, sigma_obs_warm: 1.3201, mu_seed:  1.1277, p_seed: 0.3388 },
  },
  "SAT": {
    high: { sigma_walk_cold: 0.2737, sigma_obs_cold: 1.6210, sigma_walk_warm: 0.2627, sigma_obs_warm: 1.6961, mu_seed:  1.0919, p_seed: 0.4124 },
    low:  { sigma_walk_cold: 0.2670, sigma_obs_cold: 1.0523, sigma_walk_warm: 0.2901, sigma_obs_warm: 0.9729, mu_seed:  0.0444, p_seed: 0.2451 },
  },
  "SAN": {
    high: { sigma_walk_cold: 0.3293, sigma_obs_cold: 1.0910, sigma_walk_warm: 0.3028, sigma_obs_warm: 0.9973, mu_seed:  0.2875, p_seed: 0.2779 },
    low:  { sigma_walk_cold: 0.3003, sigma_obs_cold: 1.3225, sigma_walk_warm: 0.2684, sigma_obs_warm: 1.1203, mu_seed:  1.7218, p_seed: 0.3096 },
  },
  "DFW": {
    high: { sigma_walk_cold: 0.3278, sigma_obs_cold: 1.4560, sigma_walk_warm: 0.2904, sigma_obs_warm: 1.6480, mu_seed:  0.5407, p_seed: 0.4453 },
    low:  { sigma_walk_cold: 0.1766, sigma_obs_cold: 1.2038, sigma_walk_warm: 0.2338, sigma_obs_warm: 1.1671, mu_seed:  0.9334, p_seed: 0.2218 },
  },
  "JAX": {
    high: { sigma_walk_cold: 0.3470, sigma_obs_cold: 1.1723, sigma_walk_warm: 0.3193, sigma_obs_warm: 1.3809, mu_seed: -1.4675, p_seed: 0.3604 },
    low:  { sigma_walk_cold: 0.2154, sigma_obs_cold: 1.3616, sigma_walk_warm: 0.2426, sigma_obs_warm: 0.9670, mu_seed: -0.0470, p_seed: 0.2439 },
  },
  "AUS": {
    high: { sigma_walk_cold: 0.3179, sigma_obs_cold: 1.5768, sigma_walk_warm: 0.2992, sigma_obs_warm: 1.6959, mu_seed:  0.6888, p_seed: 0.4539 },
    low:  { sigma_walk_cold: 0.2451, sigma_obs_cold: 1.1774, sigma_walk_warm: 0.2759, sigma_obs_warm: 1.0241, mu_seed:  0.2797, p_seed: 0.2501 },
  },
  "TPA": {
    high: { sigma_walk_cold: 0.2762, sigma_obs_cold: 1.1353, sigma_walk_warm: 0.4925, sigma_obs_warm: 1.2078, mu_seed: -0.3671, p_seed: 0.3756 },
    low:  { sigma_walk_cold: 0.2665, sigma_obs_cold: 0.9491, sigma_walk_warm: 0.2420, sigma_obs_warm: 0.7833, mu_seed:  0.4822, p_seed: 0.1922 },
  },
  "SJC": {
    high: { sigma_walk_cold: 0.4458, sigma_obs_cold: 1.5743, sigma_walk_warm: 0.3762, sigma_obs_warm: 1.9363, mu_seed: -0.4753, p_seed: 0.6230 },
    low:  { sigma_walk_cold: 0.2664, sigma_obs_cold: 1.7050, sigma_walk_warm: 0.5425, sigma_obs_warm: 1.5096, mu_seed:  0.6776, p_seed: 0.5189 },
  },
  "CMH": {
    high: { sigma_walk_cold: 0.7806, sigma_obs_cold: 1.2066, sigma_walk_warm: 0.2736, sigma_obs_warm: 1.5633, mu_seed: -0.0565, p_seed: 0.6303 },
    low:  { sigma_walk_cold: 0.3649, sigma_obs_cold: 1.3298, sigma_walk_warm: 0.3715, sigma_obs_warm: 1.0876, mu_seed:  0.0893, p_seed: 0.3583 },
  },
  "CLT": {
    high: { sigma_walk_cold: 0.2071, sigma_obs_cold: 1.7308, sigma_walk_warm: 0.2896, sigma_obs_warm: 1.4374, mu_seed: -0.3193, p_seed: 0.3546 },
    low:  { sigma_walk_cold: 0.2959, sigma_obs_cold: 1.2417, sigma_walk_warm: 0.2380, sigma_obs_warm: 0.9677, mu_seed: -0.1949, p_seed: 0.2625 },
  },
  "IND": {
    high: { sigma_walk_cold: 0.6934, sigma_obs_cold: 1.3601, sigma_walk_warm: 0.2748, sigma_obs_warm: 1.4827, mu_seed:  0.3588, p_seed: 0.6398 },
    low:  { sigma_walk_cold: 0.3604, sigma_obs_cold: 1.4299, sigma_walk_warm: 0.2499, sigma_obs_warm: 1.2303, mu_seed:  1.0114, p_seed: 0.3640 },
  },
  "SEA": {
    high: { sigma_walk_cold: 0.2858, sigma_obs_cold: 1.4790, sigma_walk_warm: 0.3116, sigma_obs_warm: 1.6803, mu_seed:  0.6279, p_seed: 0.4277 },
    low:  { sigma_walk_cold: 0.3437, sigma_obs_cold: 1.3363, sigma_walk_warm: 0.1670, sigma_obs_warm: 1.1453, mu_seed:  2.0679, p_seed: 0.2874 },
  },
  "DEN": {
    high: { sigma_walk_cold: 0.5931, sigma_obs_cold: 2.1175, sigma_walk_warm: 0.2563, sigma_obs_warm: 1.5555, mu_seed: -1.1502, p_seed: 0.7544 },
    low:  { sigma_walk_cold: 0.3702, sigma_obs_cold: 2.2306, sigma_walk_warm: 0.2686, sigma_obs_warm: 1.4348, mu_seed:  0.6258, p_seed: 0.5723 },
  },
  "DCA": {
    high: { sigma_walk_cold: 0.3376, sigma_obs_cold: 1.4709, sigma_walk_warm: 0.3673, sigma_obs_warm: 1.5461, mu_seed:  0.0971, p_seed: 0.4746 },
    low:  { sigma_walk_cold: 0.2553, sigma_obs_cold: 1.3056, sigma_walk_warm: 0.2852, sigma_obs_warm: 1.1752, mu_seed:  1.4083, p_seed: 0.3042 },
  },
  "BOS": {
    high: { sigma_walk_cold: 0.7231, sigma_obs_cold: 1.2904, sigma_walk_warm: 0.2031, sigma_obs_warm: 1.7547, mu_seed: -1.0909, p_seed: 0.5877 },
    low:  { sigma_walk_cold: 0.2908, sigma_obs_cold: 1.3272, sigma_walk_warm: 0.1665, sigma_obs_warm: 0.9820, mu_seed: -0.0638, p_seed: 0.2499 },
  },
};

// Quiet-day gate: when |μ_t| is below this floor, don't apply a correction. Matches
// the existing heuristic REGIME_FLOOR_F=0.5°F. Without the gate, Kalman's natural
// responsiveness adds small corrections on truly-quiet days that regress quiet-day
// RMSE by +0.39°F (HIGH backtest n=4000); gate restores quiet-day behavior at zero
// cost to regime-day wins (the gate triggers only on |μ|<0.5°F by definition).
export const KALMAN_FLOOR_F = 0.5;

// Season selector by month (1-12). Cold = Oct-Mar, warm = Apr-Sep. Returns the
// (σ_walk, σ_obs) pair for the variable.
function seasonalParams(varParams, month) {
  const isCold = (month >= 10 || month <= 3);
  return isCold
    ? { sigma_walk: varParams.sigma_walk_cold, sigma_obs: varParams.sigma_obs_cold }
    : { sigma_walk: varParams.sigma_walk_warm, sigma_obs: varParams.sigma_obs_warm };
}

// Look up the per-variable param block for a city. Returns null if either the
// city is unknown OR the variable isn't fit for that city.
function paramsFor(cliCode, variable) {
  const cityParams = KALMAN_PARAMS[cliCode];
  if (!cityParams) return null;
  return cityParams[variable] || null;
}

// Initial Kalman state for a city/variable before any settle has run. Used by
// logger.js when the blob has no entry yet, and by weather.js as fallback if
// the blob entry is missing/corrupted.
export function kalmanInit(cliCode, variable = "high") {
  const p = paramsFor(cliCode, variable);
  if (!p) return null;
  return { mu: p.mu_seed, P: p.p_seed, last_update: null };
}

// Hard sanity bound: any daily residual exceeding this is treated as bad data
// and skipped. Real residuals top out around ±10°F even on extreme regime days.
// A 50°F observation would indicate a CLI parser bug or a unit-mismatch artifact,
// not a real signal — letting it through would yank the filter state out of range.
const OBSERVATION_MAX_ABS_F = 20;

// One forward-filter step. Given prior state and an observation, return the
// posterior state. Sign convention: observation y = predicted − actual (positive
// = over-prediction). Picks σ_walk and σ_obs by current season (cold/warm).
export function kalmanStep(state, observation, cliCode, variable = "high", now = new Date()) {
  const p = paramsFor(cliCode, variable);
  if (!p || !state || !Number.isFinite(observation)) return state;
  if (Math.abs(observation) > OBSERVATION_MAX_ABS_F) return state;  // bad-data guard
  const sp = seasonalParams(p, now.getUTCMonth() + 1);
  const muPred = state.mu;
  const Ppred  = state.P + sp.sigma_walk * sp.sigma_walk;
  const K      = Ppred / (Ppred + sp.sigma_obs * sp.sigma_obs);
  return {
    mu: muPred + K * (observation - muPred),
    P:  (1 - K) * Ppred,
    last_update: now.toISOString(),
  };
}

// Blob key for each variable. HIGH state stays under per_city_kalman_state for
// backward compatibility with the already-deployed HIGH path; LOW gets its own
// key per_city_kalman_state_low. Two separate keys avoids schema migration of
// existing HIGH blob entries.
function blobKeyFor(variable) {
  return variable === "low" ? "per_city_kalman_state_low" : "per_city_kalman_state";
}

// Read the Kalman state and compute today's predict-step values:
//   μ_t|t-1 = μ_{t-1}|{t-1}    (random walk → mean unchanged in expectation)
//   P_t|t-1 = P_{t-1}|{t-1} + σ_walk² × days_since_update
// Days-since-update accounts for missed settles (logger outages); the state
// variance grows by σ_walk² per missed day.
//
// Returns { mu, P, daysStale, source } where source ∈ {"blob", "seed", null}.
// Caller (weather.js) checks |mu| against KALMAN_FLOOR_F to gate the correction.
export function kalmanCorrection(cliCode, variable, regimeBlob, now = Date.now()) {
  const p = paramsFor(cliCode, variable);
  if (!p) return null;
  const blobState = regimeBlob?.[blobKeyFor(variable)]?.[cliCode];
  let state, source;
  if (blobState && Number.isFinite(blobState.mu) && Number.isFinite(blobState.P)) {
    state = blobState; source = "blob";
  } else {
    state = kalmanInit(cliCode, variable); source = "seed";
  }
  let daysStale = 0;
  if (state.last_update) {
    daysStale = Math.max(0, (now - new Date(state.last_update).getTime()) / 86400000);
  }
  const sp = seasonalParams(p, new Date(now).getUTCMonth() + 1);
  const Padvanced = state.P + sp.sigma_walk * sp.sigma_walk * Math.max(1, daysStale);
  return { mu: state.mu, P: Padvanced, daysStale, source };
}
