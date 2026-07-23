# weatherbot — algorithms & statistical inferences

A complete rundown of the math and methods used in the predictive engine, ranked by how much actual lift each provides. Honest about what's *not* used and why.

---

## 1. Data sources & pipeline

| Source | Use | Update cadence |
|---|---|---|
| **NWS forecast API** (`api.weather.gov`) | Primary forecast (forecaster-edited blend of GFS+HRRR+ECMWF+human judgment) | ~6×/day |
| **Open-Meteo Historical Forecast** (`api.open-meteo.com`) | GFS, ECMWF, ICON, UKMO, MeteoFrance forecasts | ~6×/day |
| **AviationWeather.gov METAR API** | Real-time airport observations (the `currentTemp`, `maxSoFar`, `minSoFar`) | Hourly :53, plus SPECIs |
| **NWS CLI products** (`forecast.weather.gov`) | Official daily climate report (the value Kalshi settles to) | Once per morning, ~01:30 local |
| **Kalshi v2 API** | Daily-high & daily-low prediction market state | Continuously |
| **Open-Meteo Archive** (ERA5 reanalysis) | Backtest ground truth | Historical only |

Frontend → static (HTML/CSS/JS) on Netlify.
Backend → Netlify Functions (`/api/weather`, `/api/kalshi`, `/api/paper`, `/api/residuals`, scheduled `logger`).

---

## 2. Forecasting algorithms (in order of importance)

### 2.1 Multi-model ensemble (BIGGEST LIFT — 36% RMSE reduction)

**What:** equal-weighted average of 5 numerical weather prediction (NWP) models for the day's high/low.

```
forecastHigh = mean(NWS, GFS, ECMWF, ICON, UKMO, MeteoFrance)
```

(Production uses NWS + 4 of the 5 above; backtest used 5 Open-Meteo models since NWS isn't archived.)

**Why it works:** each model has different physical assumptions, different data assimilation, different resolution. Their errors are partially uncorrelated. Averaging reduces variance — classic "wisdom of crowds" / bagging.

**Backtest result (1y held-out 90 days, n=7,200):**
- Best single model RMSE: 2.02°F (GFS)
- 5-model equal-weighted ensemble RMSE: 1.31°F (−36%)

This is the single biggest improvement we made. JMA and GEM hurt the ensemble (worst single-model RMSEs); dropped them.

### 2.2 Bias correction from real-time observations

**What:** when current temperature differs from forecast at the current hour, partially propagate that bias to the predicted high/low.

```
bias = currentTemp − forecastNow                    # observed minus expected for this hour
priorMean = forecastPeak + biasWeight × bias        # weight tuned to 0.4 (high) / 0.5 (low)
```

**Why partial weight (not 1.0):** transient biases regress to zero. If it's running 5°F above forecast at 9 AM, the high won't necessarily be 5°F above forecast — usually somewhere in between. Backtest grid search confirmed 0.4 (high) and 0.5 (low) as optima.

### 2.3 Per-city systematic bias offset

**What:** subtract a city-specific constant from `priorMean`, capturing systematic forecast biases for each station (UHI gradients, microclimate, station vs. grid mismatch).

**How fit:** for each city, compute mean residual on training set, store as `CITY_OFFSETS[name]`. Halved in production because backtest data was GFS-vs-ERA5 but production uses NWS (forecaster-edited, less biased) — full GFS-derived offset would over-correct.

Different offsets for HIGH vs LOW (different bias structure). LOW backtest fit its own table.

**Backtest lift:** +5% RMSE reduction on top of ensemble (1.87 → 1.77 in 1y).

### 2.4 Bayesian truncation at observed extremum

This is **the only place we genuinely use Bayes' theorem**. It's the most principled inference in the system.

**Setup:**
- *Prior*: forecast-derived prediction `priorMean` ± `priorStd` (Gaussian)
- *Observation*: today's max so far is `maxSoFar` (or for LOW: `minSoFar`)
- *Constraint*: today's actual maximum cannot be less than `maxSoFar` (it's already been observed). Symmetric for LOW (actual min ≤ minSoFar).

**Bayes' theorem applied:**
```
P(high = x) ∝ P(prior says high = x) × P(observation | high = x)

where P(observation | high = x) = 1 if x ≥ maxSoFar, 0 otherwise.
```

The likelihood is a hard constraint (probability 1 inside support, 0 outside). This makes the posterior a **truncated normal**:

```
X | X ≥ a   where X ~ N(μ, σ²) and a = maxSoFar
```

**Closed-form posterior mean** (Greene, *Econometric Analysis*):
```
α = (a − μ) / σ
λ(α) = φ(α) / (1 − Φ(α))    # the inverse Mills ratio
E[X | X ≥ a] = μ + σ · λ(α)
```

`φ` is standard normal PDF, `Φ` is the CDF. Implemented in `weather.js` as `truncNormalMean(mu, sigma, a)`.

**For LOW** (truncation from above): mirror around zero. `truncNormalMeanUpper(mu, sigma, a) = -truncNormalMean(-mu, sigma, -a)`.

**What this gives us:**
- When the forecast prior is well below `maxSoFar`, the posterior mean shifts upward toward `maxSoFar` (we know we've already seen at least that)
- The "hybrid" approach: we use the **truncated-normal mean** for the point estimate but keep the **empirically-calibrated σ** (not the truncated variance — that would over-shrink, since our σ formula was tuned to actual error variance, not the prior's variance)
- The CI lower bound is **clipped** at `maxSoFar`. P(true max < maxSoFar) = 0 by physics, so the CI must respect that.

**Backtest result on "binding" cases** (where `maxSoFar` > prior forecast):
- Untruncated: RMSE 0.78°F, CI span 1.45
- Hybrid (truncated mean + empirical σ + clipped CI): RMSE 0.64°F, CI span 1.22

18% RMSE improvement on the 11% of days where truncation is binding. No effect when not binding.

### 2.5 Continuous σ formula (calibrated)

The standard deviation of the predicted-max distribution is modeled as:

```
σ = max(σ_min, σ_base + σ_lead × hrsToPeak + σ_bias × |bias|)
```

- `hrsToPeak`: hours until 3 PM local (the time the day's max typically occurs). Returns 0 after 3 PM. For LOW: `hrsToTrough` = hours until 6 AM local, 0 after 7 AM.
- `|bias|`: magnitude of current obs vs forecast deviation. Uncertainty grows when forecast is already failing.

**Production parameters (HIGH):** σ_min=0.4, σ_base=0.7, σ_lead=0.08, σ_bias=0.10.
**Production parameters (LOW):** σ_min=0.4, σ_base=0.5, σ_lead=0.05, σ_bias=0.05.

Tuned via grid search on TRAIN set, scored by `|cov68 - 0.68| + |cov95 - 0.95|` (calibration). Held-out coverage: 70% / 93% (target 68% / 95%).

---

## 3. Statistical inference — what we do

### 3.1 Bayesian inference

Used **only** at section 2.4 (truncation). The prior comes from the deterministic forecast pipeline; the observation is `maxSoFar`/`minSoFar`; the likelihood is a hard constraint; the posterior is a truncated normal with closed-form mean.

We **do not** use Bayesian inference more broadly (e.g., learning model weights from data, posterior over forecast parameters). The ensemble weights and bias-correction coefficient are point estimates from frequentist grid search, not Bayesian posteriors.

### 3.2 Frequentist parameter estimation via held-out RMSE

Every parameter (biasWeight, σ formula coefs, ensemble weights, per-city offsets) was tuned by:
1. Define a parameter grid
2. For each combo, compute RMSE on TRAIN set (chronologically earlier days)
3. Pick the combo that minimizes a chosen score (RMSE, or RMSE + calibration penalty)
4. **Validate on TEST set** (chronologically held-out 90 days the model never saw)
5. Reject if held-out RMSE doesn't match TRAIN RMSE (overfit)

This is **not Bayesian** — there's no posterior distribution over parameters. It's standard cross-validation.

### 3.3 Continuity correction for integer-quantized buckets

Kalshi reports the high as a whole-degree integer (e.g., `65`, `66`). When converting our continuous Gaussian model to bucket probabilities:
```
P(temp in bucket [a, b])  =  Φ((b + 0.5 − μ)/σ) − Φ((a − 0.5 − μ)/σ)
```
The `± 0.5` accounts for integer rounding (a temp of 65.49 reports as 65; 65.50 as 66).

### 3.4 Coverage-based calibration

For each prediction, record whether the actual high fell within the predicted ±1σ (68% CI) and ±1.96σ (95% CI). Aggregated across the test set, this gives empirical coverage. We tune σ to land coverage at the nominal 68% / 95% targets.

A model is **well-calibrated** if a "70% confidence" prediction is right 70% of the time over many trials.

---

## 4. Trading algorithms

### 4.1 Kelly criterion (bet sizing)

For a binary contract priced at `p_ask`, with our model probability of winning `p_model`, the optimal stake fraction is:
```
f* = (p_model − p_ask) / (1 − p_ask)
```
This is the unique fraction that maximizes expected logarithm of wealth (long-run wealth growth rate).

We use **half-Kelly** (`f* / 2`) in practice because full Kelly assumes the probability is exact. Our RMSE-derived probabilities have real noise, so over-betting amplifies model error.

**Bankroll rule (paper trading):**
```
stake_per_bet = max($1, bankroll / 20)
n_concurrent_max = min(20, floor(bankroll / stake_per_bet))
```

### 4.2 Sell-loser rule

Each cron firing, evaluate all open bets:
```
sell_proceeds = (stake / price_paid) × current_kalshi_bid
hold_EV       = (stake / price_paid) × current_p_model

if sell_proceeds ≥ stake:           HOLD       # winning, let it ride
elif hold_EV ≥ stake:               HOLD       # underwater but model recovers
else:                               SELL       # underwater AND model now negative
```

Sell only the genuinely-soured positions. Lets winners ride per design.

### 4.3 Dedup by betId

Each bet is keyed `${cli}-${targetLocalDate}-${ticker}-${side}-${variable}`. A second placement attempt on the same key is rejected to prevent stacking on the same market.

---

## 5. What we explicitly do NOT use

### 5.1 Markov chains — NO

A Markov chain models a system as discrete states with transition probabilities `P(state_{t+1} | state_t)`. Useful for:
- Weather *regime* sequences (e.g., "fair → rain → fair" probability matrix)
- Discrete weather classification ("clear", "cloudy", "rain")

Not appropriate here because:
- Daily high temperature is **continuous**, not discrete-state
- The state we care about (today's high) doesn't depend on yesterday's high in a way useful for one-step-ahead — we have NWP forecasts that already incorporate full atmospheric state
- A Markov chain would be a step *down* in information from what we already have

You'll see Markov chains in: HMM-based weather classification (cloud type from satellite), weather generator simulators (long-run climate scenarios), regime-switching financial models. None apply to our forecasting problem.

### 5.2 Hidden Markov Models — could but don't

An HMM could model unobserved synoptic regimes ("cold front passing", "ridging", "marine layer", "monsoon flow") with regime-specific forecast errors. We **don't** because:
- Regime classification is hard to label automatically
- The benefit would mostly be tail-event handling, and we measured (cloud-cover correction, spatial features) that the model is saturated on these continuous-feature improvements

### 5.3 Neural networks — no

Too few features (<20), too little training data (~7,000 prediction-days), and the model is already near its information ceiling. A neural network would likely overfit and underperform the calibrated ensemble.

### 5.4 Heavy-tailed distributions (Student-t) — deferred

Forecast errors have fatter tails than Gaussian (frontal passages produce errors > 3σ more often than normal predicts). A Student-t distribution would improve 95% CI coverage on extreme days at the cost of slightly looser 68% coverage on normal days. We **measured** this trade-off and decided 95% calibration was already at 93% (close enough); deferred until production residuals justify.

### 5.5 Spatial interpolation (upstream-station features) — tested, didn't help

Pulled ERA5 reanalysis at 8 directional neighbors per city. Tested mean-neighbor-delta, upstream-cooling-rate, and lateral-gradient as additive corrections. **Held-out gain: 0.008°F (0.6%)** — within noise. ERA5 reanalysis assimilates real station obs, so neighbor points share the same data the ensemble forecasts already use. Real station mesonet (Synoptic API, NOAA MADIS) might still help — independent observations — but harder to source consistently.

### 5.6 Cloud-cover deviation correction — tested, didn't help

Pulled forecast cloud cover and observed cloud cover, computed deviation as additive bias term. **Held-out gain: 0.000°F.** The temperature bias correction (`currentTemp − forecastNow`) already absorbs essentially all of the cloud signal. Adding cloud cover is redundant.

### 5.7 Detrending for global warming — tested, doesn't matter

Linear regression of model residuals on time over 5 years showed slope = −0.04°F/year, statistically insignificant. The forecast (NWS / GFS) warms with reality, so the *residual* doesn't trend. Correcting wouldn't help.

---

## 6. Validation — what we measured

| Test | Held-out RMSE delta | Result |
|---|---|---|
| Cloud-cover correction | 0.000°F | reject |
| Detrending (warming) | 0.000°F | reject |
| Multi-model ensemble | **−0.72°F (−36%)** | **shipped** |
| Spatial interpolation (ERA5) | −0.008°F | reject |
| Per-city offset (HIGH) | −0.10°F (−5%) | shipped |
| Bayesian truncation (binding cases) | −0.14°F (−18% on 11% of days) | shipped |
| Sigma re-tune for 5-model ensemble | calibration only | shipped |
| HIGH→LOW with separate parameters | LOW RMSE 0.91°F | shipped |

---

## 7. Production metrics (current, pre-paper-trade-data)

- **HIGH RMSE on 1-year held-out**: 1.31°F
- **LOW RMSE on 1-year held-out**: 0.91°F
- **CI calibration**: 70% empirical / 68% nominal; 93% empirical / 95% nominal
- **Ensemble update cadence**: 5 min (driven by Netlify scheduled function)
- **Cache TTL on `/api/weather`**: 3 min

**True production accuracy is unknown** — backtest used GFS-vs-ERA5 (Open-Meteo data); production uses NWS-vs-METAR. The phase 0 paper trade is collecting real-world residuals; ~30 days will give us trustworthy numbers on the deployed-data accuracy.

---

## 9. Trading layer

### 9.1 Bet selection

The trader pulls Kalshi market state from `/api/kalshi`, which returns a list of buckets per city for both HIGH and LOW markets, with model probabilities computed from our normal posterior (with truncation, per-city offset, and continuity correction). For each bucket × side (YES/NO):

```
edge_gross = p_model − price_ask
fee_per_$  = 0.07 × (1 − price_ask)               # Kalshi BUY fee (continuous approx)
edge_net   = edge_gross − fee_per_$                # what we expect to net per $1 staked
kelly      = max(0, (p_model − price) / (1 − price))
half_kelly = kelly / 2
```

Kalshi's exact fee formula: `fee_cents = ceil(7 × count × yes_price × (1 − yes_price))`. Per $1 staked, this resolves to ~0.7¢ near the tails (P=0.01 or 0.99) and ~3.5¢ at P=0.5. **Fees apply on BUY only** — settlement is free.

Qualifying threshold: `edge_net ≥ 0.05` AND `half_kelly ≥ 0.02`. The trader sorts by Kelly fraction, dedups against open positions, and places top N up to `min(20 concurrent, bankroll/stake_per_bet)`.

### 9.2 Bankroll model

```
bet_size       = max($1, bankroll / 20)
max_concurrent = min(20, floor(bankroll / bet_size))
spare_capacity = max_concurrent − currently_open
```

Bankroll = total wealth (cash + open stake). Placing a bet does not decrement bankroll; settlement adjusts it by the realized P&L (`stake × (1−price)/price` on win, `−stake` on loss). Sale realized P&L = `sell_proceeds − stake`.

### 9.3 Sell-loser rule

For each open position (via `/api/kalshi` lookup of current bid):
```
sell_proceeds = contracts × current_bid_for_our_side
hold_EV       = contracts × p_model_now

if sell_proceeds ≥ stake:           HOLD                   # winning, let it ride
elif hold_EV ≥ stake:               HOLD                   # underwater but model recovers
else:                               SELL at current bid    # underwater AND model expects net loss
```

Never sells winners; only closes positions where the updated model now expects a net loss.

### 9.4 Real-money safety guards (Andrew Jackson)

Three layers of defense between the bot and the account's funds:

1. **Endpoint allowlist** — only `balance`, `positions`, `orders`, `fills`, `markets`, `events` paths permitted by `kalshiAuthedFetch`. Any other path throws `SAFETY: endpoint not on allowlist`.
2. **Endpoint denylist** — defense in depth. Any path matching `deposit|withdraw|transfer|bank|ach|wire|payout|payment` (case-insensitive) is rejected even if the allowlist were buggy.
3. **Hard arm-switch** — `KALSHI_TRADING_LIVE` env var must explicitly be set to `true` (or one of `1/yes/on/live`) for the trader to fire orders. Without it, the function short-circuits with `paused: true`.

Plus the bot maintains its own ledger (Netlify Blob `jackson_open_bets`). The sell-loser logic ONLY iterates ledger entries — pre-existing user-placed positions on the same Kalshi account are invisible to the bot's sell logic. Buy dedup uses the full Kalshi position list to avoid doubling down on user-managed markets.

12-case unit test (`test_safety.js`) asserts the allowlist+denylist correctly block transfer-like paths.

---

## 10. Replay backtest of the trading layer

`research/replay_backtest.js` simulates 90 days of trading by pricing a synthetic Kalshi market at single-GFS forecast probabilities (with a 2¢ bid-ask spread) and running our actual trading logic against it. Headline numbers (n=1,736 simulated bets):

- Win rate: **67.0%**
- Per-bet ROI: **+24.7%** (gross, before fees)
- Edge calibration:
  - 5-10¢ apparent edge → realized **−6.6%** (fees eat the edge)
  - 10-20¢ apparent edge → +20% (close to expected 15%)
  - 20-30¢ apparent edge → +23% (well-calibrated to 25%)
  - 50¢+ apparent edge → −12% on small N (overconfident long-shots)

Caveat: simulated market is not a real Kalshi market. Real markets are tighter, have slippage, and other algos compete. Production paper-trade data (live) will produce trustworthy numbers; replay is just a sanity check that our trading layer is internally consistent.

The replay's most important finding: **Kalshi's fees materially affect 5-10¢ apparent edges**. This drove the addition of fee-aware EV calculation in `/api/kalshi`.

---

## 8. References

- Greene, *Econometric Analysis* (truncated normal moments)
- Kelly, "A New Interpretation of Information Rate" (1956)
- Wilks, *Statistical Methods in the Atmospheric Sciences*, 4th ed. (calibration, ensemble theory)
- Murphy, "What is a good forecast? An essay on the nature of goodness in weather forecasting" (1993)
- Open-Meteo API docs
- Kalshi API v2 docs
