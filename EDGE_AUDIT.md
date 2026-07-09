# Edge audit — 2026-07-07

A code-level audit of where the Kalshi trading edge is most likely leaking, across
three areas: **fee/EV math**, **σ-calibration**, and **entry gates + Kelly sizing**.

> **Method & caveat.** This was a *static* audit — every backtest
> (`backtest_gates.js`, `analyze_gate_sweeps.js`, `replay_backtest.js`) and every
> live endpoint (`/api/residuals`, `/api/calibration_state`, …) needs data behind
> hosts that were unreachable from the audit environment (open-meteo, Kalshi,
> aviationweather, the Netlify site all refused the connection). So findings are
> split into **shipped** (safe, no re-tune needed), **confirmed-but-data-gated**
> (needs a backtest re-sweep before changing), and **needs-live-data**.

---

## Shipped in this branch (no bet-pricing or threshold re-tune)

| # | Change | Files |
|---|---|---|
| A | **Auto-close no longer self-locks the city/variable.** The 99¢ auto-close is a profit-take-and-recycle, but the post-sell handler stamped the 60-min `cv:<city>:<variable>` cooldown (meant for model-*flip* sells) on every sell — blocking the very capital redeployment auto-close exists for. Now the cv-lock is skipped when `autoClose` is true (ticker+side cooldown still applies). | `jackson_trader.js` sell loop |
| B | **Auto-close posts a limit at ≥98¢ instead of crossing to our bid.** On a wide spread (our bid 90-95¢, opposing ask 1¢) it was dumping near-certain winners at the low bid. Now `effSellPrice = max(bid, AUTO_CLOSE_MIN_SELL=0.98)`; if it doesn't fill it rides to settlement at $1.00 — strictly ≥ crossing to the bid. ev-flip exits still cross the bid (goal there is to exit now). | `jackson_trader.js` |
| C | **pWin (Platt) recalibration wired in behind `PWIN_CALIBRATION_ENABLED` (default OFF).** `pwin_calibration_fit.js` fits a per-variable Platt map every cycle but nothing consumed it. The hook now loads `pwin_calibration_state` and applies the per-variable map to each bet's win prob + EV + Kelly. **Off by default → byte-identical to prior behavior** (verified: `max|cal−raw| = 0` when disabled). Enable only after validating the fit (see below). | `kalshi.js` |
| D | **Liquidity gate prefers 24h volume with a safe fallback.** `MIN_VOLUME=20` was documented as "traded today" but read Kalshi *lifetime* volume. Now the gate uses `volume24h ?? volume`, so a market with 0 recent volume is rejected, but a missing 24h field falls back to lifetime and can never zero the gate / halt the bot. (For daily temp markets lifetime ≈ today, so this mostly tightens genuinely multi-day/stale markets.) | `kalshi.js`, `jackson_trader.js` |

**To enable pWin calibration (C):** set env `PWIN_CALIBRATION_ENABLED=true`, but first
confirm the live `pwin_calibration_state/current.json` has `fit: true`,
`platt_high`/`platt_low` converged, and `brier_platt < brier_uncal` on a decent
`n_bets` (the fitter's own gate is n≥20; the file's note asks for ≥50 fresh
post-σ_revision bets). It's monotonic, so worst case is a mild shift — but validate
the direction first.

---

## Confirmed but DATA-GATED (do not change without re-running the sweeps)

### E. Fee is mis-unit'd: per-dollar fee subtracted from per-contract edge
`kalshi.js` `kalshiFeePerDollar(price) = 0.07·(1−price)` is the fee **per $1 staked**,
but it's subtracted from `grossEv = p_model − price`, which is **per contract**. The
true per-contract fee is `0.07·price·(1−price)` (the code's own settlement math at
`jackson_trader.js` paper-settle uses exactly this). So the entry gate over-charges
fees by ~1/price: ≈5.7¢ too much at price 0.10, ~1.75¢ at 0.50, ~0 at 0.90 →
**systematically too conservative, worst on cheap contracts.**

**Why it's not free money:** the backtests subtract the *same* mis-unit'd fee, so
`MIN_EDGE=0.28` was tuned around it. Correcting the fee without re-tuning `MIN_EDGE_*`
would swing the bot from too-conservative to **over-admitting**. Also the "5-10¢
edges realize ≈0 after fees" narrative is a symptom of this: the real per-contract
drag is only ~1-2¢, so the 28¢ floor is compensating for **calibration/spread**, not
fees (the code half-admits this in the `MIN_EDGE_HIGH` comment).

**Status — prepared on branch `claude/weatherbot-fee-resweep`:**
- The corrected fee `feePerContract = ceil(0.07·price·(1−price)·100)/100` is wired into
  `kalshi.js` and `jackson_trader.js` behind `FEE_PER_CONTRACT` (env flag, **default
  off** → byte-identical to today until you flip it).
- `resweep_fee.js` recomputes every settled bet's net edge under the corrected fee and
  re-runs the `MIN_EDGE` tightening sweep (ALL/HIGH/LOW), plus a "hold-selectivity"
  floor = the `MIN_EDGE_new` that still admits exactly the bets the old 0.28 gate did.
  Run it offline from a saved dump: `BETS_FILE=./audit.json node resweep_fee.js`, or
  live: `AUTH="x:hydro" node resweep_fee.js`.

**To ship:** run `resweep_fee.js` against real settled bets → set `MIN_EDGE_HIGH/LOW`
(and `MIN_PRICE`) to the chosen new floors → deploy with `FEE_PER_CONTRACT=true`. Ship
the fee flag and the new floors **together**. (Settled data can't measure
over-admission, so the hold-selectivity floor is the conservative starting point; the
sweep tells you whether tightening further pays.)

### F. σ that prices bets is flat, population-fit, and hard-capped at 2.5
`kalshi.js` prices buckets on a single `sigmaEff = clamp([1.5, 2.5], calibration.sigmaHigh)`
— all the per-city σ machinery (Kalman, σ_revision, σ_frontal) is bypassed for the
*width* (μ is still per-city). This is a **deliberate, backtested** choice (bet-matched
per-city σ was selection-biased and over-inflated to 2.775). Two real residual risks:
1. **The cap 2.5 can't widen for volatile regimes.** Denver's fitted σ_obs alone is
   ~2.1-2.2 before adding ensemble/frontal terms; frontal days need more. On those
   days/cities the model stays overconfident → overbets.
2. **σ is fit on the calm *population* but applied to *selected* tail bets**, where
   residuals are systematically larger → overconfident on exactly the placed bets.

**To resolve:** add a *selected-bet* coverage monitor (track cov68 on placed bets;
widen σ or raise the cap when it drops below 0.68), or make the cap regime-conditional.
Needs live settled-bet residuals to calibrate.

### G. `MIN_EDGE_LOW` may be over-tightened (0.28 vs LOW-specific peak 0.25)
`MIN_EDGE_LOW=0.28` came from a joint all-bets sweep, but the LOW-specific sweep peaked
at 0.25 ("lower dilutes"). Verify against the `MIN_EDGE (LOW)` block of
`analyze_gate_sweeps.js`; if LOW net-delta stays positive to 0.25, drop it back.

### H. Kalman params are stale / pre-summer
`per_city_kalman_params.json` is `fitted_at: 2026-05-12` on data ending `2026-05-03`
— the warm-regime params predate summer while the bot trades July highs. Refit through
summer (`node kalman_fit_all_cities.js`, needs the data archive). Params look
non-degenerate; mild over/under-fit flags on SJC/TPA warm-walk worth a glance.

---

## Needs live data to even confirm

- **LOW ν stuck at ~4?** `predictive_nu = 4 + n_bet-matched`; if LOW had few settled
  bets its t-tails are very fat → LOW bucket probs pulled to 0.5 → misses LOW edge.
  Check live `calibration_state` `low.predictive_nu` / `sigma_low.n`.
- **Is `actualLow` actually flowing?** The code pipe is connected
  (`logger.js` writes `pred.actualLow`), but confirm `sigma_low.n ≥ 30` and that
  `eligibleLow` isn't ≫ `n` (broken-join detector).
- **Silent-freeze gap:** the population σ fit has no recency alarm — if CLI-settle
  stops writing `actualHigh/Low`, σ trains on an aging window while `updated_at` still
  looks fresh. Add an n/recency check on the population residual window.
- **`probSum` renormalization** (`kalshi.js`): `p_model` is divided by the sum over
  *listed* Kalshi buckets while prices aren't — if an event's buckets don't tile the
  line, edge is biased up. Check snapshot logs for `probSum` far from 1.

---

## Hygiene noted (not changed — some are load-bearing, handle with care)

- `SIGMA_IRREDUCIBLE_F` is dead in `kalshi.js` but **still live** in
  `jackson_trader.js` — don't blind-delete; the `kalshi.js` comment describing the old
  `σ_eff=√(σ_ens²+σ_irred²)` formula is stale.
- `predictive_scale` is read (`kalshi.js`) but never applied — apply it or delete the field.
- `backtest_gates.js` / `analyze_gate_sweeps.js` still print the pre-2026-06-13
  thresholds (0.20/0.10/0.04) as "current production" — will mislead the next tuner.
- `netlify.toml` schedules `pwin_calibration_fit` hourly; the file declares `*/30`.

---

## claude_analog v3 — unfitted priors (re-fit once the ledger has volume)

The L4 advection-regime layer (`claude_analog_v3.js`) ships with **hand-set priors,
not fitted coefficients** — flagged here so they're re-estimated once the shadow
scoreboard accumulates advection days, not treated as validated:

- **L1 upstream:** `K_UPSTREAM = 3.5` °F at full overcast, `UPSTREAM_SIGMA_INFL = 1.6`,
  `BEARING_TOL = 70°`, and the per-station `UPSTREAM_STATIONS` lead-hours/bearings.
- **L4 regime score:** SLP-fall cap `0.4` (÷8 mb), Td-rise cap `0.3` (÷15 °F),
  upstream weight `0.3`; `RAMP_CAP_AT_FULL_ADVECTION = 0.55`, `ADVECTION_SIGMA_INFL = 1.5`.
- **L2 tilt / L3 lock:** tilt `w = |d|/(|d|+3)`; lock gate `drop ≥ 1.5 °F` + `deck ≥ 0.5`.

These were chosen to reproduce the 2026-07-09 KNYC post-mortem — a single day — so
they are an anecdote-fit, not an out-of-sample fit. **Do not size on the L4 path until
the pre-registered gate (`evaluateGate`) clears and these are re-fit against settled
advection days.** The scored ledger is pure (tilt off), so the gate measures the model
unaided regardless.
