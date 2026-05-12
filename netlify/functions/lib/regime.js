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

export const KALMAN_PARAMS = {
  "NYC": { sigma_walk: 0.4971, sigma_obs: 1.5197, mu_seed: -0.1902, p_seed: 0.6362 },
  "LAX": { sigma_walk: 0.2797, sigma_obs: 1.4592, mu_seed:  0.2066, p_seed: 0.3714 },
  "MDW": { sigma_walk: 0.4554, sigma_obs: 1.4984, mu_seed: -0.3465, p_seed: 0.5842 },
  "HOU": { sigma_walk: 0.2994, sigma_obs: 1.4723, mu_seed:  1.1729, p_seed: 0.3983 },
  "PHX": { sigma_walk: 0.2354, sigma_obs: 0.9252, mu_seed:  0.0879, p_seed: 0.1925 },
  "PHL": { sigma_walk: 0.2829, sigma_obs: 1.4341, mu_seed: -1.0024, p_seed: 0.3681 },
  "SAT": { sigma_walk: 0.2695, sigma_obs: 1.6556, mu_seed:  1.0919, p_seed: 0.4124 },
  "SAN": { sigma_walk: 0.3011, sigma_obs: 1.0635, mu_seed:  0.2875, p_seed: 0.2779 },
  "DFW": { sigma_walk: 0.3209, sigma_obs: 1.5414, mu_seed:  0.5407, p_seed: 0.4453 },
  "JAX": { sigma_walk: 0.3173, sigma_obs: 1.2862, mu_seed: -1.4675, p_seed: 0.3604 },
  "AUS": { sigma_walk: 0.3045, sigma_obs: 1.6361, mu_seed:  0.6888, p_seed: 0.4539 },
  "TPA": { sigma_walk: 0.3756, sigma_obs: 1.1771, mu_seed: -0.3671, p_seed: 0.3756 },
  "SJC": { sigma_walk: 0.3961, sigma_obs: 1.7677, mu_seed: -0.4753, p_seed: 0.623  },
  "CMH": { sigma_walk: 0.5517, sigma_obs: 1.3974, mu_seed: -0.0565, p_seed: 0.6303 },
  "CLT": { sigma_walk: 0.2366, sigma_obs: 1.6038, mu_seed: -0.3193, p_seed: 0.3546 },
  "IND": { sigma_walk: 0.5623, sigma_obs: 1.3956, mu_seed:  0.3588, p_seed: 0.6398 },
  "SEA": { sigma_walk: 0.297,  sigma_obs: 1.5814, mu_seed:  0.6279, p_seed: 0.4277 },
  "DEN": { sigma_walk: 0.4598, sigma_obs: 1.8667, mu_seed: -1.1502, p_seed: 0.7544 },
  "DCA": { sigma_walk: 0.3579, sigma_obs: 1.4986, mu_seed:  0.0971, p_seed: 0.4746 },
  "BOS": { sigma_walk: 0.4306, sigma_obs: 1.5743, mu_seed: -1.0909, p_seed: 0.5877 },
};

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
// = over-prediction).
export function kalmanStep(state, observation, cliCode) {
  const p = KALMAN_PARAMS[cliCode];
  if (!p || !state || !Number.isFinite(observation)) return state;
  if (Math.abs(observation) > OBSERVATION_MAX_ABS_F) return state;  // bad-data guard
  const muPred = state.mu;
  const Ppred  = state.P + p.sigma_walk * p.sigma_walk;
  const K      = Ppred / (Ppred + p.sigma_obs * p.sigma_obs);
  return {
    mu: muPred + K * (observation - muPred),
    P:  (1 - K) * Ppred,
    last_update: new Date().toISOString(),
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
  const Padvanced = state.P + p.sigma_walk * p.sigma_walk * Math.max(1, daysStale);
  return { mu: state.mu, P: Padvanced, daysStale, source };
}
