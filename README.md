# weatherbot

Statistical predictions of today's high and low temperatures for the top 20 US cities, paired with a Kalshi prediction-market trading layer (paper + real money).

Live: **https://weatherbot-mf.netlify.app** (Basic Auth — password `hydro`)

---

## What it does

For each of 20 US cities:
1. Pulls real-time observations (METARs from aviationweather.gov)
2. Pulls forecasts from 5+ NWP models (NWS + GFS + ECMWF + ICON + UKMO + MeteoFrance)
3. Combines into a Bayesian-truncated normal distribution for today's high (and low)
4. Compares the distribution to live Kalshi market prices for the daily-high / daily-low markets
5. Identifies +EV bets, sizes them via Kelly criterion, places them (paper + optionally real)
6. Reconciles each day vs the official NWS CLI<station> climate report

Full algorithm documentation: [ALGORITHMS.md](ALGORITHMS.md).
Operational/deployment notes: [OPERATIONS.md](OPERATIONS.md).

---

## Endpoints

| Path | What |
|---|---|
| `/` | Dashboard (predictions, Kalshi edges, paper trade, real trade) |
| `/api/weather` | Per-city HIGH + LOW predictions with full model context |
| `/api/kalshi` | Per-city Kalshi market data joined with our model probabilities, ranked +EV bets (Kelly-sorted) |
| `/api/paper` | Paper-trade state: bankroll, open positions, settled history, per-city aggregates |
| `/api/jackson` | Real-money Kalshi account state (gated by env vars) |
| `/api/residuals` | Production residual log (rolling validation) |

Everything is gated by HTTP Basic Auth via a Netlify Edge Function.

---

## Architecture

```
                                          ┌────────────────────┐
                                          │ aviationweather.gov│ METARs (hourly)
                                          ├────────────────────┤
                                          │   api.weather.gov  │ NWS forecast (~6×/day)
                                          ├────────────────────┤
                                          │ api.open-meteo.com │ GFS, ECMWF, ICON, UKMO, MF
                                          ├────────────────────┤
                                          │ forecast.weather.gov│ CLI<station> products
                                          ├────────────────────┤
                                          │ api.elections.kalshi│ market data (public)
                                          │  + portfolio API    │ orders/positions (RSA-signed)
                                          └─────────┬──────────┘
                                                    │
        ┌───────────────────────────────────────────┴──────────────────────────────┐
        ▼                                                                           ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ /api/weather (fn)│  │ /api/kalshi (fn) │  │ logger (sched)   │  │ jackson_trader   │
│ ensemble forecast│→ │ join model + mkt │→ │ paper trades     │  │ real trades      │
│ Bayesian truncate│  │ Kelly sort       │  │ every 5 min      │  │ every 5 min      │
└──────────────────┘  └──────────────────┘  └──────────────────┘  └──────────────────┘
                                                    │                       │
                                                    ▼                       ▼
                                            ┌──────────────────┐    ┌──────────────────┐
                                            │ Netlify Blobs    │    │ Kalshi orders    │
                                            │ open_bets,       │    │ (real money)     │
                                            │ settled_bets,    │    │ jackson_open_bets│
                                            │ paper_state,     │    │ ledger           │
                                            │ predictions,     │    └──────────────────┘
                                            │ residuals        │
                                            └──────────────────┘
```

Frontend: vanilla static HTML/CSS/JS. Backend: Netlify Functions.

---

## Validation summary

5-year backtest (Open-Meteo GFS-vs-ERA5), held-out 90 days for HIGH (n=14,400) and 1-year held-out 90 days for LOW (n=10,800):

| | HIGH | LOW |
|---|---|---|
| RMSE | **1.31°F** | **0.91°F** |
| 68% CI coverage | 70% (target 68%) | ~67% |
| 95% CI coverage | 93% (target 95%) | — |
| biasWeight | 0.4 | 0.5 |
| σ formula | `max(0.4, 0.7 + 0.08·hrsToPeak + 0.10·|bias|)` | `max(0.4, 0.5 + 0.05·hrsToTrough + 0.05·|bias|)` |

Tested but rejected as no-gain: cloud-cover correction, spatial interpolation, detrending for warming, σ-spread term.

Replay backtest of the trading layer (simulated Kalshi vs single-GFS market): 67% win rate, 25% per-bet ROI on paper. After fees, 5-10¢ apparent edges realize ≈ 0; 20-30¢ edges realize ~22% (well-calibrated).

---

## Repository layout

```
.
├── README.md, ALGORITHMS.md, OPERATIONS.md   ← docs
├── netlify.toml, package.json
├── index.html, app.js, style.css              ← frontend
├── netlify/edge-functions/auth.js             ← HTTP Basic Auth gate
├── netlify/functions/
│   ├── weather.js          — predictions + ensemble forecast
│   ├── kalshi.js           — Kalshi market data + EV ranking
│   ├── paper.js            — paper-trade dashboard
│   ├── jackson.js          — real-money read endpoint, RSA-signed Kalshi auth
│   ├── jackson_trader.js   — real-money trader (scheduled, idle by default)
│   ├── logger.js           — paper trader (scheduled every 5 min)
│   └── residuals.js        — production residual log
├── research/fetch_data.js, research/fetch_models.js, research/fetch_clouds.js, research/fetch_neighbors.js
├── research/backtest.js, research/backtest_yr.js
├── research/analyze.js, research/analyze_5yr.js, research/analyze_cloud.js, research/analyze_ensemble.js,
│   research/analyze_disagreement.js, research/analyze_low.js, research/analyze_sigma.js,
│   research/analyze_spatial.js, research/analyze_percity_weights.js
├── research/replay_backtest.js                         ← end-to-end replay of trading layer
├── research/check_kalshi.js                            ← local CLI tool: print +EV table
└── test_safety.js                             ← unit test for Kalshi API guards
```

---

## License & disclaimer

Educational only. Not investment advice. Forecasts are heuristic. Real money trading at your own risk. The bot has hard guards against any deposit/withdrawal endpoint, but you should still verify your account's trading-only API permissions on Kalshi's side.
