# Strategy: how we could actually beat this market — and how we'd know

Context: `TRADING_POSTMORTEM.md` established that the forecast model is a *worse*
predictor than the Kalshi market it traded (Brier 0.45 vs 0.19) and that the live book
lost −44.6% ROI. This document is the plan for finding a *real* edge without repeating
that mistake, and the infrastructure (shipped here) that lets us test candidates with
**zero dollars at risk** until they earn a pilot.

## The bar

Beating this market does **not** mean "have a good weather forecast." It means:

> Produce a probability that beats the **market's Brier of 0.19** on the same contracts,
> **out-of-sample**, and is **+EV net of the spread we'd actually cross** — confirmed on
> a sample large enough (≥ ~30/side) across multiple weather regimes.

Everything is judged against that, not against actuals or climatology.

## Candidate edges (ranked by realistic odds)

| # | Edge | Why it could beat an efficient market | Odds |
|---|---|---|---|
| **A** | **Observation lock-in / nowcasting** | The daily high/low is *partially realized*. Once obs make a bucket near-certain (high already hit 94° → "≥93" is settled; 5pm & 71° → "≥78" is dead), the only question is whether the thin market has repriced. This is a **latency + precision edge on an already-observed number**, not a forecast. | **Best** |
| **B** | **Settlement-mechanics precision** | Kalshi settles on NWS CLI, with quirks the crowd misprices: °C-internal rounding (87.8°F → 87°F), specific station identity, LST midnight-to-midnight window. Knowing the *contract* better than the market needs no forecast. | Good, small scale |
| **C** | **Genuinely better-calibrated forecast** | Proper statistical post-processing (EMOS / nonhomogeneous regression, analog ensembles, gradient-boosted MOS) trained on years of forecast-vs-CLI residuals — the discipline the hand-tuned-σ model skips. Must beat market Brier 0.19. | High ceiling, low odds |
| **D** | **Liquidity provision** | Earn the wide spread on thin markets with two-sided quotes around a roughly-calibrated fair value; manage inventory. A market-making business, not a directional bet. | Real, different skillset |
| **E** | **Structural / behavioral** | Bucket prices must sum to ~1 after fees (inconsistency = lock); crowd round-number / heat-wave-overreaction biases. Needs market-wide data to see. | Opportunistic |

**A and B are the realistic retail shots** — they exploit market slowness and contract
quirks, not superior forecasting. **C** is the long game. This repo implements the
infrastructure for all of them and **Strategy A as the first testable candidate.**

## How we test — the discipline the postmortem proved we need

0. **Build the dataset we don't have.** We can only see *our selected bets*; you can't
   test a market-inefficiency claim on a selected sample. So first: log the **full order
   book + obs + settlement for all cities**, every cycle, **without trading.**
1. **Pre-register** the hypothesis, metric (beat market Brier *and* +EV net of real
   spread), min-n, and train/test split *before* looking — the antidote to the
   multiple-comparisons trap that manufactured fake winners in the postmortem.
2. **Evaluate with realistic fills** — cross the actual spread (pay the ask), subtract the
   confirmed `ceil(0.07·P·(1−P))` fee, add a latency haircut. (The "fade edge" looked real
   at mid-price and died at a 3¢ spread — this step catches that.)
3. **Forward paper-trade across regimes** — require clearing the pre-registered bar
   out-of-sample over weeks-to-a-season spanning hot/cold/frontal regimes (not the n=10
   July slice that fooled us), positive in **both** halves.
4. **Tiny real-money pilot with a kill-switch** — only after paper clears the bar, sized
   so a full drawdown is affordable, auto-halting if realized ROI/calibration drifts below
   the paper result.

## What's shipped in this repo

**Step 0 — shadow logger** (`netlify/functions/market_logger.js`, route `/api/market_logger`,
records every 15 min, **places no trades**):
- `?mode=record` (also scheduled) — snapshots every city's full book + obs → `market_snapshots` blob.
- `?mode=settle` — joins the CLI final high/low → `market_settlements` blob.
- `?mode=export` — emits snapshots joined with outcomes, ready for the eval harness.

**Strategy A — observation lock-in** (`netlify/functions/lib/diurnal.js`,
`netlify/functions/lib/strategy_lockin.js`):
- Conservative *physical* bounds on the final CLI extremum from obs in hand (no model).
- A bet is emitted **only** when `[floor, ceil]` is entirely inside the winning set
  (near-certain) AND the market still misprices it by more than the fee — else it abstains.
- Bounds carry a `SETTLE_MARGIN` (CLI rounding) and remaining-rise/fall tables in
  `lib/diurnal_bounds.js`, so it errs toward abstention. The tables ship as **conservative
  placeholders**; regenerate them from data (a `/api/snapshots` export or shadow-logger
  export) with `research/fit_diurnal.mjs`, which sets each hour's bound to a safe upper envelope
  (P99.5 + 1°F buffer) of the observed remaining move and reports the coverage/frequency
  tradeoff:
  - `node research/fit_diurnal.mjs --synthetic` — self-test (recovers a known envelope at 100% coverage)
  - `SNAPSHOTS=<export.json> node research/fit_diurnal.mjs --write` — regenerate `diurnal_bounds.js`

**Evaluation harness** (`research/eval_strategy.mjs`): replays snapshots through a strategy with
realistic fills + settlement and reports the numbers that decide a pilot — **realized win
rate vs claimed probability** (for lock-in it must be ≈100%; below that the bounds are too
tight), net ROI after real fills, and abstention rate, split train/test.
- Run now on synthetic data: `node research/eval_strategy.mjs --synthetic`
- Run on real shadow data: `SNAPSHOTS=<export.json> node research/eval_strategy.mjs`

**Tests** (`test_diurnal.js`, wired into `npm test`): 17 assertions proving the lock-in
logic is correct and never asserts a false certainty.

## The go/no-go for Strategy A

Deploy the shadow logger to production → let it collect a few weeks of book+settlement →
`?mode=export` → run `research/eval_strategy.mjs`. Promote to a real-money pilot **only if**:
realized lock-in win rate ≈ 100%, net ROI > 0 after real fills, in **both** train and test
splits, at n ≥ ~30/side. Otherwise widen the bounds (the harness names the offending bets)
or conclude the market reprices too fast for a retail lock-in and move to B or C.

*Scope note: the shadow logger fixes the postmortem's core data gap — it records the whole
market, not just what we'd bet — so for the first time these hypotheses become testable
against the market rather than against our own selection.*

## Pre-registered trading gate (the Claude / v3 obs-analog strategy)

The v2/v3 obs-analog engine is a **hypothesis**, not a demonstrated edge. Its parity
tests prove it reproduces its own reference — not that it is *right*. The 2026-07-09
KNYC replay is one day encoded after the fact; treating it as proof would be
overfitting to an anecdote. Nothing gets real money on faith.

**The gate** (`evaluateGate` in `lib/scoreboard.js`, surfaced live at
`/api/claude?mode=scoreboard` → `gate`, and as the banner atop the dashboard
scoreboard):

- Take the **last pre-settlement decision** per settled city-day (no peeking).
- Keep only days where **both** the v3 card and the Kalshi book posted a full set of bins.
- Score a multi-bin **Brier** for each. The market's probs are its **raw yes-ask prices**
  (price/100), so "beat the market" means beat the posted book **net of spread** — the
  real bar, not a normalized toy.
- `passed` iff **v3 Brier < market Brier** over **n ≥ 30** paired city-days.

**Rule: trading stays OFF until `gate.passed` is true.** No live Claude trader is built
or enabled, and both existing real-money traders (`jackson_trader`, `jackson_rain_trader`)
remain halted behind their double-key env gates, until the gate clears. When it clears,
the first step is a *small* pilot, not full Kelly — the gate proves calibration, not the
fill/impact economics, which still need their own out-of-sample confirmation.

This is deliberately the same discipline as Strategy A above: the shadow scoreboard
records the whole market and the settled truth, so for the first time the model is scored
against reality rather than against our own selection. Watch the one number. If it never
clears 0.19-ish, the honest conclusion is that there is no edge here — and that is a valid,
money-saving result.
