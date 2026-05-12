// Kalman regime filter — per-city bias state with random-walk dynamics.
//
// State-space model (HIGH residuals, sign matches weather.js: predicted - actual):
//   μ_t = μ_{t-1} + w_t,    w_t ~ N(0, σ_walk²)
//   y_t = μ_t + ε_t,        ε_t ~ N(0, σ_obs²)
// y_t = forecastHighF_t − actualMax_t observed daily from CLI settle in logger.js.
//
// Per-city σ_walk, σ_obs fit offline via EM (kalman_fit_all_cities.js, 5y data).
// mu_seed / p_seed are the production initial state — the filter's converged state
// at the end of the training data, used when no live blob entry exists yet.
//
// Runtime usage:
//   logger.js  runs kalmanStep() each daily settle, persists state to blob
//   weather.js reads state via kalmanCorrection(), applies μ as priorMean shift
//              and (P + σ_walk²) as additional priorStd² contribution

// Per-city Kalman params fit per season (cold=Oct-Mar, warm=Apr-Sep). The seasonal
// split matters most for continental-climate cities (BOS, CMH, NYC, IND, MDW, DEN)
// where winter frontal passages produce σ_walk 2.5-3.5× the calmer summer value.
// Single-σ_walk fit averaged these and was too low for winter / too high for summer,
// causing the 5/20 inland regression in the original A/B. See kalman_fit_all_cities.js.
export const KALMAN_PARAMS = {
  "NYC": { sigma_walk_cold: 0.7444, sigma_obs_cold: 1.2986, sigma_walk_warm: 0.3081, sigma_obs_warm: 1.6764, mu_seed: -0.1902, p_seed: 0.6362 },
  "LAX": { sigma_walk_cold: 0.3135, sigma_obs_cold: 1.4501, sigma_walk_warm: 0.2693, sigma_obs_warm: 1.4353, mu_seed:  0.2066, p_seed: 0.3714 },
  "MDW": { sigma_walk_cold: 0.5552, sigma_obs_cold: 1.4818, sigma_walk_warm: 0.2702, sigma_obs_warm: 1.5439, mu_seed: -0.3465, p_seed: 0.5842 },
  "HOU": { sigma_walk_cold: 0.3041, sigma_obs_cold: 1.3722, sigma_walk_warm: 0.3122, sigma_obs_warm: 1.5759, mu_seed:  1.1729, p_seed: 0.3983 },
  "PHX": { sigma_walk_cold: 0.2872, sigma_obs_cold: 0.8932, sigma_walk_warm: 0.1865, sigma_obs_warm: 0.9425, mu_seed:  0.0879, p_seed: 0.1925 },
  "PHL": { sigma_walk_cold: 0.2776, sigma_obs_cold: 1.2978, sigma_walk_warm: 0.2786, sigma_obs_warm: 1.5783, mu_seed: -1.0024, p_seed: 0.3681 },
  "SAT": { sigma_walk_cold: 0.2741, sigma_obs_cold: 1.6207, sigma_walk_warm: 0.2627, sigma_obs_warm: 1.6962, mu_seed:  1.0919, p_seed: 0.4124 },
  "SAN": { sigma_walk_cold: 0.3289, sigma_obs_cold: 1.0913, sigma_walk_warm: 0.3028, sigma_obs_warm: 0.9970, mu_seed:  0.2875, p_seed: 0.2779 },
  "DFW": { sigma_walk_cold: 0.3280, sigma_obs_cold: 1.4561, sigma_walk_warm: 0.2903, sigma_obs_warm: 1.6478, mu_seed:  0.5407, p_seed: 0.4453 },
  "JAX": { sigma_walk_cold: 0.3469, sigma_obs_cold: 1.1717, sigma_walk_warm: 0.3194, sigma_obs_warm: 1.3814, mu_seed: -1.4675, p_seed: 0.3604 },
  "AUS": { sigma_walk_cold: 0.3175, sigma_obs_cold: 1.5772, sigma_walk_warm: 0.2987, sigma_obs_warm: 1.6963, mu_seed:  0.6888, p_seed: 0.4539 },
  "TPA": { sigma_walk_cold: 0.2761, sigma_obs_cold: 1.1352, sigma_walk_warm: 0.4924, sigma_obs_warm: 1.2083, mu_seed: -0.3671, p_seed: 0.3756 },
  "SJC": { sigma_walk_cold: 0.4458, sigma_obs_cold: 1.5736, sigma_walk_warm: 0.3760, sigma_obs_warm: 1.9355, mu_seed: -0.4753, p_seed: 0.623  },
  "CMH": { sigma_walk_cold: 0.7807, sigma_obs_cold: 1.2069, sigma_walk_warm: 0.2742, sigma_obs_warm: 1.5634, mu_seed: -0.0565, p_seed: 0.6303 },
  "CLT": { sigma_walk_cold: 0.2071, sigma_obs_cold: 1.7311, sigma_walk_warm: 0.2901, sigma_obs_warm: 1.4374, mu_seed: -0.3193, p_seed: 0.3546 },
  "IND": { sigma_walk_cold: 0.6929, sigma_obs_cold: 1.3601, sigma_walk_warm: 0.2749, sigma_obs_warm: 1.4830, mu_seed:  0.3588, p_seed: 0.6398 },
  "SEA": { sigma_walk_cold: 0.2858, sigma_obs_cold: 1.4790, sigma_walk_warm: 0.3122, sigma_obs_warm: 1.6797, mu_seed:  0.6279, p_seed: 0.4277 },
  "DEN": { sigma_walk_cold: 0.5926, sigma_obs_cold: 2.1183, sigma_walk_warm: 0.2557, sigma_obs_warm: 1.5564, mu_seed: -1.1502, p_seed: 0.7544 },
  "DCA": { sigma_walk_cold: 0.3380, sigma_obs_cold: 1.4711, sigma_walk_warm: 0.3675, sigma_obs_warm: 1.5462, mu_seed:  0.0971, p_seed: 0.4746 },
  "BOS": { sigma_walk_cold: 0.7234, sigma_obs_cold: 1.2898, sigma_walk_warm: 0.2027, sigma_obs_warm: 1.7553, mu_seed: -1.0909, p_seed: 0.5877 },
};

// Season selector by month (1-12). Cold = Oct-Mar, warm = Apr-Sep. Returns the
// pair of (σ_walk, σ_obs) appropriate for the current date. Step transition at
// month boundary is acceptable: the Kalman state P briefly inflates/deflates but
// converges within ~3-5 days via the gain mechanism. Smoothing across seasons
// (e.g., cosine taper on day-of-year) is a Phase 5 nice-to-have.
function seasonalParams(p, month) {
  const isCold = (month >= 10 || month <= 3);
  return isCold
    ? { sigma_walk: p.sigma_walk_cold, sigma_obs: p.sigma_obs_cold }
    : { sigma_walk: p.sigma_walk_warm, sigma_obs: p.sigma_obs_warm };
}

// Quiet-day gate: when |μ_t| is below this floor, don't apply a correction. Matches
// the existing heuristic REGIME_FLOOR_F=0.5°F. Without the gate, Kalman's natural
// responsiveness adds small corrections on truly-quiet days that regress quiet-day
// RMSE by +0.39°F (backtest n=4000); gate restores quiet-day behavior at zero cost
// to regime-day wins (the gate triggers only on |μ|<0.5°F by definition).
export const KALMAN_FLOOR_F = 0.5;

// Initial Kalman state for a city before any settle has run. Used by logger.js when
// the blob has no entry yet, AND by weather.js as fallback if the blob entry is
// missing/corrupted.
export function kalmanInit(cliCode) {
  const p = KALMAN_PARAMS[cliCode];
  if (!p) return null;
  return { mu: p.mu_seed, P: p.p_seed, last_update: null };
}

// Hard sanity bound: any daily residual exceeding this is treated as bad data
// and skipped. Real residuals top out around ±10°F even on extreme regime days
// (5y backtest max was ~+8°F at PHX in heat dome). A 50°F observation would
// indicate a CLI parser bug or a unit-mismatch artifact (like the ones in
// data_models.json's early-history), not a real signal — letting it through
// would yank the filter state out of physical range.
const OBSERVATION_MAX_ABS_F = 20;

// One forward-filter step. Given prior state and an observation, return the
// posterior state. Sign convention: observation y = predicted − actual (positive
// = over-prediction). Picks σ_walk and σ_obs by current season (cold/warm).
export function kalmanStep(state, observation, cliCode, now = new Date()) {
  const p = KALMAN_PARAMS[cliCode];
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

// Read the Kalman state and compute today's predict-step values:
//   μ_t|t-1 = μ_{t-1}|{t-1}    (random walk → mean unchanged in expectation)
//   P_t|t-1 = P_{t-1}|{t-1} + σ_walk² × days_since_update
// Days-since-update accounts for missed settles (logger outages); the state
// variance grows by σ_walk² per missed day.
//
// Returns { mu, P, days_stale, source } where source ∈ {"blob", "seed", null}.
// Caller (weather.js) checks |mu| against KALMAN_FLOOR_F to gate the correction.
export function kalmanCorrection(cliCode, regimeBlob, now = Date.now()) {
  const p = KALMAN_PARAMS[cliCode];
  if (!p) return null;
  const blobState = regimeBlob?.per_city_kalman_state?.[cliCode];
  let state, source;
  if (blobState && Number.isFinite(blobState.mu) && Number.isFinite(blobState.P)) {
    state = blobState; source = "blob";
  } else {
    state = kalmanInit(cliCode); source = "seed";
  }
  let daysStale = 0;
  if (state.last_update) {
    daysStale = Math.max(0, (now - new Date(state.last_update).getTime()) / 86400000);
  }
  const sp = seasonalParams(p, new Date(now).getUTCMonth() + 1);
  const Padvanced = state.P + sp.sigma_walk * sp.sigma_walk * Math.max(1, daysStale);
  return { mu: state.mu, P: Padvanced, daysStale, source };
}
