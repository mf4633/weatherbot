<!--
Produced 2026-07-08 from an exhaustive, adversarially-verified edge hunt over the
real Andrew Jackson settled-bet audit (368 bets, May–Jul 2026). Eight independent
hypotheses were probed in parallel; every EDGE / CORRECTNESS_BUG claim was handed
to a separate agent instructed to refute it. The three load-bearing numbers below
(market-vs-model Brier, the fade collapse, and the zero cross-split +EV cells) were
then re-computed by hand and matched exactly. Analysis scripts live in the session
scratchpad (enrich_bets.mjs, probe_*.mjs, verify_crux.mjs).
-->

# Trading Post-Mortem: Kalshi Weather Bot (May–Jul 2026)

## 1. Verdict: Can this bot make money?

**No.** Over May–July 2026 the bot placed 344 temperature bets, staked $1,606.91, and lost $716.63 — a **−44.6% ROI** at an 18.3% win rate (all-in, incl. out-of-scope oil trades: −50.2%, −$1,266). An exhaustive edge hunt across eight independent hypotheses — fading the model, favorite-longshot structure, a suspected obs-locked correctness bug, honest recalibration, Kelly sizing, a 63-cell heterogeneity scan, the sell logic, and market efficiency — found **zero deployable, verified positive-EV strategies** in the executed book. Every stake quartile loses even gross of fees; every in-sample winning pocket flips sign out-of-sample; the market prices the bot's own bets far better than the model does (market Brier 0.1925 vs model 0.4481, and the model is worse than a constant base-rate predictor at 0.1752). The single mechanistically-sound signal — that fading the model beats following it — is **INCONCLUSIVE**: real as a direction but it collapses to ~1% ROI under the bot's actual capital deployment, dies at a 3-cent spread, and was never executed. The losses are a bet-*selection* failure driven by an overconfident, cold-biased model, not a lever (sizing, sells, timing) that can be flipped to profit.

## 2. Evidence table

| Hypothesis | Key numbers | Verdict |
|---|---|---|
| **Contrarian / fade the model** | Capital-weighted mirror (2c spread, true fee): train ROI +1.4%, test +0.6% (PnL +$8.11, 95% CI [−$233,+$191], P(loss)=44%); dies at ≥3c spread. Equal-weight 1-ct fade: train +0.152/ct (t=7.05), test +0.133/ct (t=2.52), survives to 8c spread. | **INCONCLUSIVE** |
| **Favorite-longshot bias** | Every price bin negative & significant. Book calibration: mean price 0.370 vs realized 0.183 (−19c). "Favorites" bin .65–.85 priced 0.696, won 0.459. No bin +EV in both splits at n≥20. | **NO_EDGE** |
| **Post-peak HIGH root cause** | Post-peak HIGH n=92, win 7.6%, ROI −42.7% (≈ overall −44.6%). Suspected missing HIGH obs-gate + sigma-collapse touch ≤3/92 bets and would not have fired on the losers. | **CORRECTNESS_BUG → REFUTED → NO_EDGE** |
| **Honest-calibration replay** | Isotonic top bucket (pWin 0.92–1.0) won 34%; Platt slope 0.049 (near-flat, no signal). EV>0-kept ROI −86.9%/−83.9%. Model Brier 0.4481 vs market 0.1925 vs climatology 0.1752. | **NO_EDGE** |
| **Kelly sizing amplified losses?** | Stake-quartile ROI improves monotonically −88.2%→−37.3%; corr(stake,win)=+0.177. Equal-dollar counterfactual −$1,114.84 (−69.4%) vs actual −$716.63. Every quartile loses gross of fees. | **NO_EDGE (refuted — sizing was protective)** |
| **Heterogeneity scan (63 cells)** | Cells passing EDGE gate (n≥20 both splits, +ROI both): **0**. Cells +ROI in both splits at any n: **0**. All 10 test-n≥20 cells negative. Every in-sample city/series winner flips sign OOS. | **NO_EDGE** |
| **Sell logic (ev-flip / auto-close)** | 95.6% held to settlement; 16 real exits, all May, all temp. 15 winners sold early (Δ −$5.91); the one "loss cut" was a 0-contract dust position. | **NO_EDGE (mildly negative feature)** |
| **Is the market efficient?** | Market Brier 0.1925 vs model 0.4481; log-loss 0.55 vs 1.79; market closer on 72.6% of bets. Model 0.9–1.0 bin claimed 0.946, won 0.292. Only +EV thing = fading own model (counterfactual). | **NO_EDGE** |

## 3. Root cause: why it loses

The loss traces to **model bet-selection**, not to any risk-management lever. Three reinforcing failures, all in the executed book:

- **Anti-calibrated pWin (overconfidence).** The model's high-confidence bins are its worst: pWin 0.9–1.0 (n=72) claimed 0.946, won 0.292; 0.8–0.9 (n=48) claimed 0.864, won 0.229. The model's Brier (0.4481) is worse not only than the market (0.1925) but than a constant base-rate predictor (0.1752). The pWin score carries almost no discriminative signal (Platt slope 0.049), so no monotone recalibration can rescue it.
- **Cold-biased, under-dispersed mean.** The bias-corrected mean and `maxSoFar` systematically *understate* the CLI-settled daily high, and σ is too tight to cover the residual. The book is uniformly overpaid ~19c versus realized frequency (mean price 0.370 vs realized 0.183). Post-peak, the bot fights an already-efficient market (75% favorite accuracy) with a low-biased, near-certain estimate and lands on the market underdog 77.2% of the time.
- **The wiring is correct; the model is wrong.** 182/212 pWin bets have claimEdge>0 — there is **no sign inversion**. The bot faithfully bets the side its (broken) model favors.

**On the suspected obs-locked bug:** the post-peak HIGH slice was probed as a discrete defect — a missing HIGH-side analogue of the LOW-only `bucketAboveObsGap()` guard (`netlify/functions/jackson_trader.js`, whose comment explicitly notes no HIGH symmetric version exists) plus a peak-realized σ collapse in `weather.js`. This **did not survive verification**. Post-peak HIGH's −42.7% ROI merely equals the −44.6% baseline; its 7.6% win rate is an artifact of betting deep underdogs (avg price 0.25), not an outsized catastrophe. The missing gate would not have fired on most losers (the bot's own `maxSoFar` was below the bucket, so it didn't *know* the temp had reached it), and the σ collapse was floored on 2026-05-07 before most bets. It is the known bad-model baseline restated on one slice — **not a distinct fixable bug**, and fixing either candidate would not flip the sign.

## 4. Genuine wins found

**None that clear the bar as a deployable edge, and none that survived as a fixable bug.** The proof:

- **No +EV pocket exists in the book.** The 63-cell heterogeneity scan found 0 cells +EV in both train and test at *any* n. With 63 cells scanned, chance alone predicted ~2–3 false positives at 5%; we got fewer than the null would produce.
- **The one recurring positive signal is fading the model — and it is INCONCLUSIVE, not an edge.** The *direction* (fade beats follow) is robust and mechanistically sound: it monetizes the documented overconfidence, and as an equal-weight 1-contract strategy it passes the statistical bar out-of-sample (test +0.133/ct, t=2.52, survives to 8c spread). But it is **not deployable**: (a) entirely counterfactual — the opposite side was never quoted or executed; (b) under the bot's *actual* capital deployment it collapses to ~1% ROI with a CI spanning zero and dies by a 3c spread; (c) ~90% of that capital would buy liquid favorites at ~91c for a ~7c margin a realistic spread on thin weather books likely erases; (d) self-referential — it evaporates the instant the model is changed. (The tempting "+22% on ALL bets" figure is a red herring from ~28 out-of-scope Brent-oil orphan trades.)
- **The refuted hypotheses are useful negatives.** Kelly sizing did *not* amplify losses — it was mildly protective (flat sizing would have lost ~$398 more). The sell logic was a rounding-error-scale *negative* feature (≈ −$6, only ever clipped winners). Neither is a lever back to profit, because every stake quartile loses gross of fees.

The real deliverable of this analysis is the negative result itself, and the tooling that produced it (`EDGE_AUDIT.md`, `research/resweep_fee.js`, the probe scripts): a clean, reusable benchmark showing the market reliably out-forecasts this model, and that the model's own pWin is a reliable *anti-signal*.

## 5. Honest recommendation

- **Stop deploying real money.** The bot has a verified, robust, both-splits negative expectancy rooted in a model that is a *worse* forecaster than the market it trades against and worse than climatology. No sizing, timing, sell-rule, or price-band configuration of the current model reaches breakeven — the losses are structural to bet selection.
- **What the project IS good for.** A working, instrumented execution/logging harness against a genuinely efficient market, and a strong weather-*forecasting* dashboard. Keep it on **paper only**.
- **What a real edge would require.** (1) A forecast that beats the *market's* Brier (0.1925), not just climatology — the current model (0.4481) is nowhere close. (2) Honest calibration built in from the start (post-hoc recalibration cannot help a near-zero-discrimination score). (3) Validation on **live, executed** fills with real spreads — every positive result here is in-sample, counterfactual, or from test cells too thin (Jun+Jul = 70 bets, 8 with pWin, July = 0) to confirm at n≥20.

*Scope caveat: all analyses are over model-**selected** bets, not a random market draw, so none confirm or refute a market-wide structural edge — they establish only that THIS executed book has no positive-EV region.*
