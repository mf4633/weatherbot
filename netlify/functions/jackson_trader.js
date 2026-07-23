// "Andrew Jackson" trader — places REAL Kalshi orders matching the paper-trade rules.
// Runs every 5 min. Dormant if Kalshi env vars not set.
//
// Logic mirror of the paper trader (logger.js):
//   - Read live balance + open positions from Kalshi
//   - Sell positions whose model has flipped negative (would-be losers)
//   - Place new buys for top Kelly-ranked +EV bets, deduped against already-open positions
//   - Bankroll = real Kalshi balance; max 20 concurrent; stake = max($1, balance/20)
//
// Same SAFETY guards as jackson.js: allowlist + denylist on Kalshi endpoints.
// No deposits, withdrawals, or transfers under any circumstance.

import { kalshiAuthedFetch, getBalance, getPositions, getRecentFills, getMarketResult } from "./jackson.js";
import { getStore } from "@netlify/blobs";
import { normCdf01 } from "./lib/stats.js";
import { lowScreenCheck, highScreenCheck } from "./lib/low_screen.js";
import { buildOrderBody, normalizeOrderResponse, V2_ORDERS_PATH } from "./lib/kalshi_orders.js";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
// No concurrent-position cap. Threshold gates (EV / halfKelly / Kelly-LCB), tile
// conflicts, event-side stack caps, and the cash budget (cashDollars - committed
// ≥ STAKE_FLOOR) bound how many bets a cycle can place. Removed the 20-bet cap
// 2026-05-13 — was a soft safety bound from early development; per-bet stake
// remains 1-10% of bankroll, so 100 small bets is no riskier than 20 bigger ones.
// 2026-05-13: also enables higher-frequency capital recycling via the 99¢ auto-
// close (e874773) — keeping the cap would have throttled that velocity benefit.
// High-conviction floor: net-of-fee edge ≥ 10¢ AND halfKelly ≥ 5%. Model RMSE is
// ~1.7°F so anything below this is likely noise.
// Audit on 2026-05-04 of bot's first 28 settled positions: 3 wins (10.7%), all on
// high-conviction NO bets at 45-85¢. Cheap-tail YES (≤10¢) hit rate was 0/8.
// Tightened from 0.10/0.05 to 0.20/0.10 to filter out the cold-mean-tail-YES pattern
// that lost ~$50 over May 2-3 by pricing left-tail outcomes the model couldn't actually
// hit (model was running 1.5-2.3°F cold across cities).
// 2026-05-13: MIN_EDGE held at 0.20 for HIGH, raised to 0.30 for LOW. n=138 settled
// bet sweep (analyze_gate_sweeps.js): LOW at production 0.20 hit only 19.4% (6W/25L,
// -$201, -68% ROI), and tightening LOW to 0.30 would have recouped +$99 with only
// $7 of LOW wins forgone. HIGH at 0.20 was healthier (36.4% hit, -28% ROI); further
// HIGH tightening masks an underlying EV-calibration bias rather than fixing it,
// so leave at 0.20 and revisit once Kalman LOW (dcee27c) improves residuals.
// 2026-05-14: MIN_EDGE_LOW relaxed 0.30 → 0.25 after σ_irred bump 1.0 → 1.3 (commit
// e7ad122) made σ_eff wider and pulled effective EV down, dropping placement volume
// below sustainable rate. The σ bump is the principled overconfidence fix; the EV
// gate should be measured in σ_eff-units, so loosening here just compensates for the
// nominal EV scale shift, not unwinding the May-13 risk control.
// 2026-05-14 (PM): MIN_EDGE_HIGH 0.20 → 0.17 — symmetric counterpart to the LOW
// relaxation. Live decision-column audit at 102 min post-bump showed 7 of 15 HIGH
// candidates clustered at 16–19.4¢ edge with halfKelly 19–36% (e.g., Boston B59.5
// NO at 18¢/35.7% hK, Chicago B66.5 NO at 17.2¢/23.1% hK). The σ_irred bump dropped
// nominal EV scale by ~15-20% across the candidate pool, so the floor needs to drop
// by the same fraction to preserve placement volume without unwinding the May-13 risk
// envelope. halfKelly ≥ 15% remains the hard conviction backstop.
// 2026-05-26 (data-pure): MIN_EDGE_HIGH 0.17 → 0.25. EV-threshold sweep under the corrected
// β (gate-2 cache, σ=2.5, price≥0.10): ROI climbs monotonically with the floor —
// 0.17:+3%/$7.35, 0.20:+5%, 0.25:+12%/$14.68 (max total P&L), 0.30:+13% — so 0.17 was
// admitting marginal 17-25¢ bets that dragged ROI to ~breakeven. 0.25 ~4× the ROI and maxes
// total P&L. (In-sample, σ=2.5, pre-σ-margin; the threshold ORDERING is robust to those.)
// LOW kept at 0.25 — that's its peak stable ROI (+43%); lower thresholds only dilute it.
//
// 2026-06-13 theoretical tightening (backtested via analyze_gate_sweeps.js on n=331
// real settled WIN/LOSS from jackson_audit): Current book on 331 bets: 19.3% hit, -$867 PnL.
// Raising to edge 0.28 / hk 0.20 produces large positive net_delta (~+$520 to +$590 range
// depending on exact combo; e.g. hk=0.20 alone +$519 by recouping $665 from losers while
// forgoing only $146 in winner PnL). Joint matrix confirms further gains at 0.28/0.20+.
// This is the highest-leverage entry filter improvement supported by the historical
// admissions. (Upward-only sim on past placed bets; future candidate distribution may differ.)
//
// Full-pool replay_backtest.js (data_models.json, synthetic market, identical model +
// sizing + decision logic, only the two thresholds changed):
//   Loose (0.05/0.02): 90d 24.0% ROI (1735 bets); 30d 23.3% ROI (567 bets, bankroll $20→~$8.96k).
//   Tight (0.28/0.20): 90d 69.2% ROI (1398 bets); 30d 69.2% ROI (409 bets, bankroll $20→~$78.1k).
// ~3× ROI, 19–28% fewer bets. Edge calibration improves at the higher bar (20-30¢ band near
// perfectly calibrated in tight runs). Consistent with "marginal bets were net negative."
const MIN_EDGE_HIGH = 0.28;
const MIN_EDGE_LOW  = 0.28;
function minEdgeFor(b) { return b.variable === "low" ? MIN_EDGE_LOW : MIN_EDGE_HIGH; }
// 2026-05-13: MIN_HALF_KELLY raised from 0.10 → 0.15. n=138 sweep: tightening to 0.15
// rejected 4 bets (0W/4L), recouped $44 with zero wins forgone — clean Pareto win.
// 0.20 would recoup $152 but rejects 27 bets including 2 wins (risk of overfit on n=138).
//
// 2026-06-13: Further to 0.20 (paired with edge 0.28) per fresh n=331 sweep in
// analyze_gate_sweeps.js — strong +$519 net_delta on the full historical book.
// Replay confirms ~3× simulated ROI vs loose baseline.
const MIN_HALF_KELLY = 0.20;
// Cheap-tail floor: 2026-05-13 sweep on n=138 — bets at price ≤ 0.10 were 26/26
// LOSSES, -$218 net. Raising 0.04 → 0.10 recoups $202 with ZERO wins forgone on
// the existing population. The cleanest signal in the entire sweep. Cheap tails
// continue to be a graveyard because the model can't price left-tail outcomes
// accurately at sub-10¢ resolution — the EV calc bakes in pWin estimates that
// settled-bet history shows are systematically too high in this band.
const MIN_PRICE = 0.10;
// Price-band restriction REMOVED 2026-05-26 (same day it was added). It was a defensive
// patch for the OLD anti-predictive model. After the intraday-β fix (commit db722d8), a
// historical gate-2 backtest (Kalshi candlesticks, 11 cities, ~45d, fee-aware bucket P&L)
// showed the edge is driven by EV-THRESHOLD selectivity, NOT price range: at EV ≥ 0.15 the
// corrected model is +EV across all σ assumptions (+3% to +11% ROI) over the full price
// range, while ≤0.10 thresholds lose to fees. So selectivity is enforced by MIN_EDGE_*
// (0.17 high / 0.25 low) — the validated gate — not a price band that also blocked
// legitimate edges outside 0.30–0.40.
// Volume floor: skip orders on markets with paper-thin orderbook depth. Daily
// volume is a proxy for liquidity (true book-depth isn't in our snapshot).
// 20 contracts traded today = at least minimal interest; below that, partial
// fills become probable. SATX bet on 2026-05-06 hit this exact pattern: 7-contract
// intent at 63¢, 1-share fill, 6 contracts canceled at expiration.
const MIN_VOLUME = 20;
// 2026-06-01: CALIBRATION-HEALTH PAUSE GATE. The σ-inflation loop
// (calibration_update.js → calibration_state blob → kalshi.js σ_eff) is what
// makes the backtested edge survive live: it's only +EV at σ≈2.5, and the loop
// widens σ to keep realized stdev(z)≈1. But the loop can silently die — exactly
// what happened to LOW (predictions blob never carried actualLow → 0 matched
// bets → inflation_factor stuck at 1.0 → σ≈1.21 → bleed). kalshi.js can't tell a
// dead loop (factor 1.0 by default) from a genuinely-calibrated one (factor 1.0
// by computation). So we gate HERE, data-pure: do NOT place new buys on a
// variable whose calibration we cannot currently CERTIFY. A side is certifiable
// only if its loop has enough matched bets AND the empirical residual spread is
// not runaway. Otherwise abstain on that side until the loop recovers — this is
// the "pause" arm of the gate; the "widen σ" arm lives in calibration_update.
// 2026-06-01 (Bayesian rework): the n<N and stdev_z>X cliffs were removed.
// Calibration *uncertainty* now flows into σ via the Student-t posterior
// predictive (calibration_update emits ν/scale; kalshi.js builds bucket probs
// from t_ν). A thin or noisy side gets low ν → fat tails → shrunk edges →
// it self-abstains through the existing EV gate, with no discontinuity. What
// remains here is pure LIVENESS — broken-pipe detection, not a statistical test:
const CAL_MAX_AGE_MIN  = 180;  // calibration_state older than this = cron dark → abstain (can't trust σ)
// 2026-06-08: SELF-HEAL. calibration_update-background's only reliable external driver was
// cron-job.org job 7725770 (*/30), which was gapping to 1-3h — cal_age sawtoothed to ~300min
// and 18% of cycles abstained whole-book on cal-stale, even though obs/forecast were fresh.
// The TRADER's cron (cron-job.org 7725767, */5) is rock-solid. So instead of depending on a
// separate fragile job, the trader fire-and-forgets a refresh of the background fn whenever
// it sees calibration getting old. Background fn returns 202 instantly, so this never blocks
// the cycle. Threshold well under CAL_MAX_AGE_MIN so a write lands long before the gate trips.
const CAL_REFRESH_MIN  = 45;   // cal_age past this → trader kicks the calibration background fn
// 2026-06-08: re-enable the σ-revision / intraday-β refit (frozen since 2026-05-26 when
// logger's INLINE_REFIT was disabled) by self-kicking the sigma_refit-background fn off the
// trader's reliable */5 cron — ONCE PER HOUR (UTC minute < 5). GATED to start only after
// SIGMA_REFIT_RESUME_TS so it doesn't move live σ during the hands-off observation window;
// before that timestamp the kick is a no-op. Fire-and-forget with a bounded timeout, like
// the cal kick. See sigma_refit-background.js, project_weatherbot_calibration_selfheal.
const SIGMA_REFIT_RESUME_TS = Date.parse("2026-06-13T00:00:00Z");  // after the ~06-12 hands-off window
// 2026-06-05: σ is now sourced from the POPULATION fit (sigma_{side}.posterior), not
// bet-matched z. So liveness certifies on the population sample count, not the old
// bet-matched cal-join-broken check (which deadlocked LOW: it couldn't trade → 0 settled
// LOW bets → bet-matched n stuck at 0 → permanently "broken"). The population grows from
// EVERY city's daily settle (logger writes actualLow for all cities) ~20/day, independent
// of LOW betting — so this count climbs and LOW self-admits without ever needing to trade
// first. Below this n the σ fit is mostly prior anyway (nu0=30), so the floor is cheap.
const CAL_POP_MIN_N = 30;
// 2026-05-28: CONCENTRATION CAP — no single (ticker,side) position may exceed
// CONCENTRATION_CAP of equity. Enforced two ways: (1) new-entry stake sizing capped
// at the limit; (2) sell-loop trim pass sells the excess on any over-concentrated
// position and marks its ledger entry `concentration_capped:true` so the buy and
// pyramid loops won't re-grow it ("not repurchased"). Flag clears on settlement.
const CONCENTRATION_CAP = 0.20;
// 2026-05-28 AFTER OVERNIGHT BLEED (~$190 lost): two more protections, both added
// because per-position concentration alone didn't catch the failure mode. The bleed
// was AGGREGATE — many small (~$5-10) LOW NO positions correlated by the dawn regime,
// all losing at the trough simultaneously.
//
// (a) LOW_HARD_OFF: pending the LOW intraday backtest. HIGH was rigorously validated
// (intraday-price + Bayesian σ work) and time-gated; LOW has had NO equivalent backtest
// and was the source of last night's drain. Hard-off until the same analysis is done.
// To re-enable: complete the LOW intraday backtest + set time gate, then flip false.
//
// 2026-05-28 (later): RE-ENABLED. LOW backtest done (_intraday_collect_low.py / 229
// events / 1,374 pulls / _intraday_analyze_low.py): +65.7% ROI on 257 bets at σ=2.5,
// edge UNIFORMLY +EV across all decision hours 0-5 (no time gate helps; gating hurts).
// The live-vs-backtest paradox (live bled, backtest +EV) was diagnosed in `_sigma_audit.py`:
// production σ for LOW averaged 1.21 with |z|/exp=5.91 — catastrophically overconfident.
// SIGMA_FLOOR_LOW=2.0 in kalshi.js now floors that. Combined with AGGREGATE_EXPOSURE_CAP=0.50
// (would have prevented last night's correlated pile-on) and CONCENTRATION_CAP=0.20, the
// failure mode is structurally blocked. Re-enable accepted with eyes open. Re-flip true
// if (a) live LOW bleeds again, or (b) σ-audit on new settled LOW bets shows |z|/exp > 2.
//
// 2026-06-04: RE-FLIPPED TRUE — criterion (a) met. Bot-only settled audit (jackson_audit,
// segmented to exclude manual/orphan trades): LOW-NO −65.6% ROI, LOW-YES −74.5% ROI.
// calibration_state shows low.n=0 (the actualLow join is empty → LOW has ZERO live
// calibration; predictive_scale=1, no inflation). LOW had no equivalent of the HIGH σ-cap
// / population-calibration validation. Hard-off until LOW gets the same treatment (population
// refit on snapshot residualLow + its own price-level backtest). HIGH stays live (capped).
//
// 2026-06-05: RE-FLIPPED FALSE — the documented exit criterion above is now MET. LOW got
// the exact HIGH treatment: (1) ADAPTIVE sigma_low in calibration_update-background.js +
// kalshi.js — population fit (actualLow−predLow), clamped to the same [1.5,2.5] guardrails,
// prior fallback. The old SIGMA_FLOOR_LOW=2.0 that drove the −65% bleed was itself a
// BET-MATCHED-audit artifact (|z|/exp≈5.9 = selection bias, the same one that inflated HIGH
// to 2.775); the UNSELECTED population says RMS≈1.37/bias−0.13/no-fat-tails → honest σ≈1.45.
// (2) Price-level backtest (backtest_bucket_pnl_low.mjs, 231 real-fill events): +EV across
// the ENTIRE [1.5,2.5] envelope (+30.8/+28.2/+25.3% at thr 0.15) — a runaway fit can't lose.
// Safety still layered: the cal-pop-thin gate holds LOW until sigma_low.n≥30, the Student-t
// nu (bet-matched, starts fat-tailed at nu=4) keeps LOW humble until LOW bets prove out,
// HOU LOW stays on LOW_PAUSED_CITIES, + CONCENTRATION/AGGREGATE caps. Re-flip true if live
// LOW bleeds again or a fresh population σ-audit on settled LOW shows |z|/exp > 2.
const LOW_HARD_OFF = false;
// LOW screening heuristics (lib/low_screen.js — physics floor, jagged-trace,
// undercut-live advisory). Modes: "off" | "shadow" (compute + log, never act)
// | "enforce" (skips low-physics-floor and low-jagged-no candidates). Default
// shadow: like every calibrated gate before it, it earns enforce on logged
// evidence, not on the night it was written (2026-07-22).
const LOW_SCREEN_MODE = (process.env.LOW_SCREEN_MODE || "shadow").trim().toLowerCase();
// HIGH-side mirror (high-cloud-capped, high-spike-no, late-surge advisory).
// Independent flag so HIGH — the validated live side — flips on its own
// evidence, not LOW's.
const HIGH_SCREEN_MODE = (process.env.HIGH_SCREEN_MODE || "shadow").trim().toLowerCase();
// (b) AGGREGATE_EXPOSURE_CAP: total open exposure / equity ceiling. Per-position
// concentration (above) doesn't help when N small positions all sink together. 50%
// keeps half of equity in cash reserve. Heuristic — needs its own backtest. Skips new
// buys (doesn't trim existing) when adding them would push aggregate over the cap.
const AGGREGATE_EXPOSURE_CAP = 0.50;
// City -> IANA tz for the HIGH time gate. Backtested in _intraday_analyze_bayes.py
// (full 585-event sample, 1,679 +EV bets, fixed σ=2.5): post-peak HIGH bets (local
// hour >= 14, hp <= 1) returned -3.5% ROI vs +10.9% at noon; cutting them lifts
// overall ROI +9.0%->+11.8% AND total P&L +$60->+$64 (Pareto-improving). The deeper
// reason is Bayesian: by 2pm the market's posterior has converged to truth (Brier
// 0.072) and our overconfident-σ posterior loses to it; tightening σ to residuals
// REFUTED in the same backtest (made it +4.0%, worse). Solution = abstain late, not
// recalibrate σ. LOW left ungated pending its own intraday backtest.
const CITY_TZ_FOR_PEAK = new Map([
  ["New York","America/New_York"], ["Los Angeles","America/Los_Angeles"],
  ["Chicago","America/Chicago"], ["Houston","America/Chicago"],
  ["Phoenix","America/Phoenix"], ["Philadelphia","America/New_York"],
  ["San Antonio","America/Chicago"], ["Dallas-Fort Worth","America/Chicago"],
  ["Austin","America/Chicago"], ["Seattle","America/Los_Angeles"],
  ["Denver","America/Denver"], ["Washington DC","America/New_York"],
  ["Boston","America/New_York"], ["Asheville","America/New_York"],
]);
// HIGH near-peak window lower bound (local hour). Peak ≈ 15:00 local, so localHour 11
// ≈ hrsToPeak 4 — the early edge of the backtest-validated noon cell (β≥0.61). Combined
// with the existing localHour>=14 post-peak cut, HIGH trades only in [11,14) local.
const HIGH_NEAR_PEAK_LOCAL_MIN = 11;
const PER_CITY_FRESHNESS_MAX_MIN = 180;
// Bayesian humility cap on pWin. Anything > 0.95 implies our σ_post collapsed
// below ~σ_resolution (=1.0°F HIGH, 0.7°F LOW), which physically only happens
// if all ensemble models agree AND they're stale together. See comments at the
// gate site in the buy loop for the empirical anchor.
const P_WIN_CAP = 0.95;
// Don't re-enter a ticker+side within this window after selling it.
const COOLDOWN_MIN = 60;
// After ANY successful buy on (city, variable), block ALL further buys on the same
// (city, variable) for this many minutes, even on different strikes/sides. Catches
// model thrashing across runs — e.g., SATX low 2026-05-07 placed YES on B62.5 at
// 11:46 (model μ≈62), then NO on B60.5 at 12:40 (model μ≈59.9) when the cold front
// shifted the forecast. tileConflict is supposed to catch dual-loss across runs but
// depends on Kalshi-position visibility + ledger blob propagation, both of which can
// lag. This cooldown is a strict structural backstop independent of state-store sync.
const BUY_CITYVAR_COOLDOWN_MIN = 60;
// Sell hysteresis. Require expected hold value to be at least this fraction below
// the current market bid before flipping. Higher = bot rides through more noise
// before giving up winners. 2026-05-05 raised 0.10 → 0.20 per user preference to
// not surrender winners cheaply; clears round-trip fees comfortably and ignores
// typical per-cycle model wiggle.
const SELL_HYSTERESIS = 0.20;
// Auto-close threshold: if the bid on our side reaches this, sell to free capital
// for new bets rather than wait for settlement. At 99¢ vs $1.00 settlement we give
// up ~1.07¢/contract (cents + 7%×1¢ sell fee), in exchange for the staked capital
// being free to fund the next EV+ candidate. Bypasses the SELL_HYSTERESIS / EV
// comparison entirely — this is a velocity-of-money optimization, not a sell-loser
// signal. 2026-05-13.
const AUTO_CLOSE_AT_PRICE = 0.99;
// Floor limit price for an auto-close sell. On a near-certain winner we never dump
// below this — a wide-spread market can show our bid at 90-95¢ while the opposing
// ask is 1¢, and crossing to that low bid gives up far more than settlement would.
// Posting a limit at ≥98¢ either fills better or rides to settlement at $1.00.
const AUTO_CLOSE_MIN_SELL = 0.98;
// Fee model for the trader-side EV recomputes (σ-climb, Kelly-LCB gates). Mirrors
// kalshi.js: default is the legacy per-$ fee; FEE_PER_CONTRACT=true switches to the
// corrected per-contract fee (EDGE_AUDIT.md finding E). Keep this flag in lockstep
// with kalshi.js's FEE_PER_CONTRACT so entry EV and these gate recomputes agree.
// Off by default → these gates are byte-identical to before.
const FEE_PER_CONTRACT = process.env.FEE_PER_CONTRACT === "true";
function entryFee(price) {
  return FEE_PER_CONTRACT ? Math.ceil(0.07 * price * (1 - price) * 100) / 100
                          : 0.07 * (1 - price);
}
// Stake = halfKelly × bankroll, floored at $1 and capped at 10% of bankroll.
// At $20 bankroll: stake range $1–$2. At $200: $1–$20. Conviction-weighted.
const STAKE_FLOOR = 1.0;
const STAKE_CEIL_FRAC = 0.10;
// Earn-back boost: below STAKE_BOOST_EQUITY_THRESHOLD equity, the per-bet ceiling
// becomes min(STAKE_BOOST_FRAC * cash, STAKE_BOOST_DOLLAR_CAP) instead of the
// normal STAKE_CEIL_FRAC * cash. At/above the threshold, normal sizing resumes
// automatically. Set 2026-05-21 over the standing "don't raise stake during
// drawdown" guidance — user override, intent is to escape the $1-floor fee-drag
// trap that compounding alone can't escape from $13 in any reasonable window.
const STAKE_BOOST_EQUITY_THRESHOLD = 200.0;
const STAKE_BOOST_FRAC = 0.40;
const STAKE_BOOST_DOLLAR_CAP = 5.0;
// ── Variable-limit (maker) pricing, 2026-05-26 ──────────────────────────────
// Instead of crossing to the ask, post a liquidity-scaled limit BELOW the ask to capture
// the bid-ask spread (the 15-min expiration on placeBuyOrder lets it rest). Backtest
// (backtest_variable_limit.mjs): captures ~3-4¢; beats taker only if adverse selection is
// mild. LOW stays +EV through MODERATE AS -> ARMED. HIGH flips NEGATIVE under moderate AS
// (+7.7% taker -> -20.5%) -> HELD as taker; we log its would-be limits to measure live AS,
// then flip VLIM_ARM_HIGH=true once mild. Qualification stays at the ask (unchanged gate),
// so a posted limit only ever improves an already-+EV entry.
//
// 2026-05-27: HIGH ARMED. The "-20.5% under moderate AS" was a MODELED assumption (single
// price snapshot, no intra-window path). Re-measured with REAL minute candlesticks over the
// 15-min order window across 349 historical HIGH +EV bets (_high_as_study.mjs): adverse
// selection is BENIGN, not toxic — maker-filled win% 43 vs taker 42 (no degradation), fill
// rate 57%, ROI taker +8.1% -> maker-filled +22.0% -> maker→taker-fallback +13.0%. Downside
// is bounded (unfilled orders expire/fall back to taker = the +8.1% we already get). Caveats:
// one season, modeled fills (ask-touched-L proxy, so fill rate is optimistic) — but the
// no-AS-degradation finding is robust to fill-rate optimism. Revert to false if live HIGH
// maker fills start under-performing taker.
const VLIM_ARM_LOW    = true;
const VLIM_ARM_HIGH   = true;    // ARMED 2026-05-27 — real-minute AS study shows benign AS (see above)
const VLIM_REF_SPREAD = 0.05;    // spread (fraction) at/below which we post at the bid
const VLIM_EV_FLOOR   = 0.10;    // never post so high that net-of-fee EV drops below this
// Hard-pause LOW bets where settled-bet evidence is decisive AND a passive
// observable defines the unpause condition (not a bet count the pause itself
// suppresses; see feedback_hard_pause_exit_criteria memory).
//
// 2026-05-11 original pause: SATX/PHX/HOU/DFW LOW = 17 bets, 1 win, –$131
// (–67% ROI). Pattern: NO-side at strikes near μ, actuals come in 1–3°F
// warmer than forecast — per-city LOW residual bias.
//
// 2026-05-14 PM review against jackson_settled.ndjson (n=148 + diff by city):
//   SATX LOW:  0W/6L lifetime, 0W/4L last 7d.  Strong signal — keep paused.
//   PHX  LOW:  0W/5L lifetime, 0W/5L last 7d.  Strong signal — keep paused.
//   HOU  LOW:  1W/3L lifetime, 0W/1L last 7d.  Thin — soft-reopen at 0.5×
//                                              (see SOFT_REOPEN_DERATE).
//   DFW  LOW:  1W/2L lifetime, 1W/1L last 7d.  Sample too small to justify
//                                              a pause at all — full unpause.
//
// Unpause criterion for SATX and PHX (replaces the original "≥10 fresh bets"
// which was structurally unmeasurable while paused): the city's
// per_city_residual_mean_7d_low value in the regime blob (written by
// logger.js from passive prediction settlement, no betting required) must
// satisfy |residual| < 1.0°F. Read manually until automation lands.
// 2026-05-26 DATA-DRIVEN FLIP: the corrected intraday-β (commit db722d8) removed the
// cold-low bias that caused the SATX/PHX pause. Per-city residual (model−actual) over the
// last ~31 days is now PHX +0.84°F and SATX −0.10°F — both inside the |<1°F| unpause
// criterion — and both backtest strongly +EV (PHX +62%, SATX +51% at EV≥0.10), BEATING
// full-size DFW (+45%). So they FULL-reopen (no derate) — data-pure: a 0.5× hedge would
// single them out for caution the data doesn't support. Meanwhile HOU LOW is now the worst
// LOW city (−40% ROI, 31% win), so it moves ONTO the hard pause. All per-city LOW edges here
// are small-n/in-sample; the live per_city_residual_mean_7d_low confirms them forward once
// the logger cron is restored.
const LOW_PAUSED_CITIES = new Set(["Houston"]);

// HIGH pauses. Currently empty — LA moved to SOFT_REOPEN_DERATE on 2026-05-14 PM
// because the "≥5 fresh HIGH bets back to mean" criterion was unreachable while
// the city was hard-paused (chicken-and-egg). LA still on a half-size leash; see
// SOFT_REOPEN_DERATE comment below.
const HIGH_PAUSED_CITIES = new Set();

// Soft-reopen de-rate: city|variable → halfKelly multiplier in (0, 1]. Lets a
// previously-paused city accumulate fresh settled bets at reduced stake so the
// "back to mean" check can actually be evaluated. Applied multiplicatively on top
// of synopticCoverage de-rate (so the two compose if both fire).
//
// 2026-05-14 PM: LA HIGH re-enabled at 0.5 after biasF improved 2.4 → 1.9°F and
// σ_eff tightened 5.5 → 3.86°F over 3 days. Memo's "5 fresh HIGH bets" criterion
// can't be met from inside a hard pause; this is the structural fix. Auto-promote
// to 1.0 once LA's per_city_residual_mean_7d in the regime blob crosses |biasF| <
// 1.0°F (manually verified — no automation yet).
const SOFT_REOPEN_DERATE = new Map([
  // 2026-05-26 (data-pure): SATX/PHX LOW run FULL — not derated. Their corrected-β residuals
  // are inside the |<1°F| unpause criterion (PHX +0.84, SATX −0.10) and they backtest
  // +62%/+51% ROI, BEATING full-size DFW (+45%). A 0.5× hedge would single them out for
  // caution the data doesn't support (every per-city LOW edge here is equally small-n /
  // in-sample). HOU LOW is hard-paused (−40% / 31% win, the one decisively-negative city).
  // LA|high stays derated (separate 2026-05-14 HIGH reopen — unchanged, no new data).
  ["Los Angeles|high", 0.5]
]);

// Parse a B-bucket ticker code into integer outcome range. Only B-prefix is
// safely parseable from the code alone — T-prefix is direction-ambiguous (Kalshi
// uses it for both left tails "≤ N-1" and right tails "≥ N+1"), so for T-buckets
// callers MUST provide explicit loInt/hiInt rather than relying on this function.
// B<N>.5 = "[N, N+1]" (middle bucket, integer span). Subtitle "59° to 60°" for B59.5.
function bucketToRange(bucket) {
  if (!bucket || typeof bucket !== "string") return null;
  if (bucket.startsWith("B")) {
    const v = parseFloat(bucket.slice(1));
    if (!Number.isFinite(v)) return null;
    const lo = Math.floor(v);
    return { lo, hi: lo + 1 };
  }
  return null;
}

// Does bet win at integer outcome x? Prefers explicit numeric bounds (loInt/hiInt)
// when carried on the bet — these are always correct for both T-less and T-greater
// buckets. Falls back to bucketToRange for B-buckets when explicit bounds aren't
// available. Returns false for T-buckets without explicit bounds (caller bug).
// Bounds use ±Infinity (kalshi.js) or null (JSON-roundtripped) for unbounded ends.
// Previous bug: passed b.bucket (human label like "48–49°F") which silently failed parse
// and made every bet appear to "lose at every x", over-firing tile-conflict skips.
function betWinsAt(bet, x) {
  let lo, hi;
  if (bet.loInt !== undefined || bet.hiInt !== undefined) {
    lo = (bet.loInt == null || bet.loInt === -Infinity) ? null : bet.loInt;
    hi = (bet.hiInt == null || bet.hiInt === Infinity)  ? null : bet.hiInt;
  } else {
    const r = bucketToRange(bet.ticker);
    if (!r) return false;
    lo = r.lo; hi = r.hi;
  }
  const inRange = (lo == null || x >= lo) && (hi == null || x <= hi);
  // Case-insensitive: kalshi.js emits "YES"/"NO" uppercase, seed loop emits lowercase.
  return bet.side?.toLowerCase() === "yes" ? inRange : !inRange;
}

// Bucket-rounding-boundary margin for B-bucket bets that lean on already-observed extremes.
// CLI rounds to integer °F; B-bucket "[N, N+1]" catches any continuous CLI in [N-0.5, N+1.5).
//
// NO side (existing): bet wins if CLI rounds OUTSIDE the bucket. For LOW NO, achievable
//   side is below (since low ≤ minSoFar). Margin = (N - 0.5) - minSoFar. HIGH NO mirror.
//
// YES side (added 2026-05-07): bet wins if CLI rounds INSIDE the bucket.
//   For LOW YES: minSoFar=m is upper bound on low. m < N-0.5 → YES auto-loses (low is
//     already below bucket; can only stay or drop further). m in [N-0.5, N+1.5) → margin =
//     m - (N - 0.5) = headroom before further drop kicks low below the bucket. m ≥ N+1.5 →
//     bucket is reachable from above; model drives.
//   HIGH YES symmetric.
//
// Threshold splits: NO bets use 0.6°F (CHI B48.5 NO calibration). YES bets use 1.5°F because
// YES headroom is not bounded — frontal events can keep dropping the low another 2-3°F well
// past minSoFar. SATX 2026-05-07 ate this exact pattern: YES on B62.5 with minSoFar=62.6
// (margin 1.1°F) lost when a cold front pushed the low to 60.8°F.
//
// Returns null only when truly inapplicable (no observation yet, wrong bucket type, or obs
// far from bucket so model drives).
// 2026-05-04: previous NO version bailed out when observation was inside/above the bucket;
// that missed the CHI low B48.5 NO failure mode where minSoFar landed inside the bucket.
const BUCKET_MARGIN_MIN_F = 0.6;       // NO-side threshold
// Sigma-aware bucket-margin (2026-05-13): require model μ ≥ z·σ_eff from the
// nearest decisive B-bucket boundary. Replaces the implicit "all bets equally
// margin-sensitive" assumption — a 0.6°F absolute margin is loose when σ=2°F
// and tight when σ=0.5°F. Posterior-σ-units is the principled framing.
// Backtest on n=138 (analyze_fix_proposals.js, strategy G): cuts 60 of 101
// staged-heuristic bets, median P&L improvement +$99 (95% CI [-$25, +$222]).
// CI doesn't exclude 0 but the lower bound is small and the conceptual
// argument is independent of the data. Mirrors kalshi.js's SIGMA_IRREDUCIBLE_F.
// 2026-05-14: 1.0 → 1.3, see kalshi.js comment for full calibration history.
const SIGMA_IRREDUCIBLE_F      = 1.3;
const SIGMA_BUCKET_MARGIN_Z    = 0.5;
// Earn-back boost (paired with STAKE_BOOST_* above): while equity < threshold,
// loosen the σ-margin gate from 0.5z to 0.3z. Post-5/18 settled-bet evidence
// (n=16, B-bucket NO win-rate 56%, +$1.77) shows residual edge in B-buckets,
// but the 0.5z gate at σ_eff = 2.6–5.9°F is structurally unsatisfiable inside
// a 1°F bucket — gate is blocking the wrong slice. Auto-reverts to 0.5z above
// the equity threshold so the original calibration kicks back in once we're
// out of the fee-drag trap. 2026-05-21.
const SIGMA_BUCKET_MARGIN_Z_BOOST = 0.3;
const BUCKET_YES_MARGIN_MIN_F = 1.5;   // YES-side threshold (stricter; see header)
// Tail-bucket (T-prefix) YES gate: for cold-tail LOW YES or hot-tail HIGH YES, the
// daily extremum must move past the tail boundary for the bet to settle. If the
// already-observed extremum requires a larger residual move than this, skip.
// Calibrated 2026-05-08 after KXLOWTSATX-26MAY08-T60 YES at 7¢: model said pWin=0.614
// (μ_low≈59 truncated above minSoFar=62.1) but the morning low had already passed
// at 62.1°F and a further 2.6°F drop pre-midnight is uncommon. Same magnitude as
// BUCKET_YES_MARGIN_MIN_F because the underlying physical phenomenon (post-min frontal
// drop / post-max frontal rise) is the same.
const BUCKET_TAIL_OBS_GAP_MAX_F = 1.5;

// Tighter threshold for B-bucket-above-obs YES bets (LOW YES on bucket below minSoFar,
// or HIGH YES on bucket above maxSoFar). The tail-tail gate above is "drop into the tail
// at all"; this gate is "drop into a 1°F window AND stop there" — strictly harder, hence
// stricter threshold. Calibrated 2026-05-08 against same-day SAT B60.5 YES (μ=61.8,
// minSoFar=62.0, gap=0.5°F → skip) and DFW B58.5 YES (μ=60.6, minSoFar=60.8,
// gap=1.3°F → skip), where the existing B-YES margin filter only fires when obs is
// INSIDE the bucket and lets these "obs above bucket" cases through to the model. Set
// just under 0.5°F so a single-degree drop required (gap = 0.5°F exactly, the most
// common "barely past upper edge" case) is gated; gaps below 0.4°F (i.e., <half a
// rounding tick past the bucket) still defer to the model.
const BUCKET_ABOVE_OBS_GAP_MAX_F = 0.4;

// CLI-grade observed extremes for tail / bucket gates. Kalshi settles on CLI,
// which is generated from 5-min weighted ASOS (DI-1 internal). Raw maxSoFar /
// minSoFar may include 1-min spikes CLI never sees — using them in tail-gates
// can auto-reject bets that CLI would actually settle in the bot's favor (same
// failure mode shipped in 96e5a62 for CI floors). Keep the precise float (not
// the floored Cli variant) so the posterior z-score doesn't shift by up to 1°F.
function cliMaxObs(c) {
  const cand = [c?.oneMinAsos?.max5MinSoFar, c?.dsmDailyMaxF].filter(v => v != null);
  return cand.length ? Math.max(...cand) : (c?.maxSoFar ?? null);
}
function cliMinObs(c) {
  const cand = [c?.oneMinAsos?.min5MinSoFar, c?.dsmDailyMinF].filter(v => v != null);
  return cand.length ? Math.min(...cand) : (c?.minSoFar ?? null);
}

function bucketBoundaryMargin(b, weatherCity) {
  const side = b.side?.toLowerCase();
  if (side !== "yes" && side !== "no") return null;
  const code = b.ticker;
  if (!code || !code.startsWith("B")) return null;
  const v = parseFloat(code.slice(1));
  if (!Number.isFinite(v)) return null;
  const N = Math.floor(v);  // continuous bucket = [N - 0.5, N + 1.5) after rounding

  if (b.variable === "low") {
    const m = cliMinObs(weatherCity);
    if (m == null) return null;
    if (side === "no") {
      if (m >= N + 1.5) return null;
      if (m >= N - 0.5) return -Math.abs(N - 0.5 - m) - 0.01;
      return (N - 0.5) - m;
    }
    // side === "yes"
    if (m >= N + 1.5) return null;                          // obs above bucket → reachable from above; model drives
    if (m < N - 0.5) return -Math.abs(N - 0.5 - m) - 0.01;  // obs below bucket → YES auto-loses
    return m - (N - 0.5);                                    // obs in bucket → headroom before further drop
  }
  if (b.variable === "high" || !b.variable) {
    const m = cliMaxObs(weatherCity);
    if (m == null) return null;
    if (side === "no") {
      if (m <= N - 0.5) return null;
      if (m <= N + 1.5) return -Math.abs(m - (N + 1.5)) - 0.01;
      return m - (N + 1.5);
    }
    // side === "yes"
    if (m <= N - 0.5) return null;                          // obs below bucket → reachable from below; model drives
    if (m > N + 1.5) return -Math.abs(m - (N + 1.5)) - 0.01; // obs above bucket → YES auto-loses
    return (N + 1.5) - m;                                    // obs in bucket → headroom before further rise
  }
  return null;
}

// Tail-bucket posterior P(win | obs): the Bayes-shaped form of the old gapF/safetyMargin
// gates (work order #2). σ_cooling = residual uncertainty in the daily extremum given
// the running min/max — calibrated 2026-05-08 against the 49-bet sample at 0.7°F. Skip
// when P(win) < PI_TAIL_SKIP. One π replaces the °F-scale BUCKET_TAIL_OBS_GAP_MAX_F.
//
// Cold-tail LOW: boundary = hi + 0.5 (continuous CLI bound).
//   YES wins iff low < boundary → P(YES) = Φ((boundary - m) / σ_cooling)
//   NO  wins iff low ≥ boundary → P(NO)  = 1 − Φ((boundary - m) / σ_cooling)
// Hot-tail HIGH: boundary = lo - 0.5 (continuous CLI bound).
//   YES wins iff high ≥ lo → P(YES) = 1 − Φ((boundary - m) / σ_cooling)
//   NO  wins iff high <  lo → P(NO)  = Φ((boundary - m) / σ_cooling)
// Hot-tail LOW (added 2026-05-18 after KXLOWTDAL-26MAY18-T77 NO lost $0.76 — minSoFar
// 78.1°F locked at 04:53 CDT, bet placed at 07:58 CDT with raw μ=76.5 letting it past
// noStrikeMargin's 1.0°F threshold). boundary = lo - 0.5.
//   YES wins iff low ≥ lo (continuous low ≥ boundary) → P(YES) = 1 − Φ((boundary - m)/σ)
//   NO  wins iff low <  lo → P(NO) = Φ((boundary - m)/σ)
// Cold-tail HIGH (added same): boundary = hi + 0.5.
//   YES wins iff high < boundary → P(YES) = Φ((boundary - m)/σ)
//   NO  wins iff high ≥ boundary → P(NO) = 1 − Φ((boundary - m)/σ)
// normCdf01 (A&S 7.1.26) is imported from lib/stats.js.
function tailBucketPosteriorP(b, weatherCity, sigmaCooling) {
  const side = b.side?.toLowerCase();
  if (side !== "yes" && side !== "no") return null;
  const code = b.ticker;
  if (!code || !code.startsWith("T")) return null;
  const lo = b.loInt, hi = b.hiInt;
  const minObs = cliMinObs(weatherCity);
  const maxObs = cliMaxObs(weatherCity);
  if (b.variable === "low" && minObs != null
      && lo == null && Number.isFinite(hi)) {
    const boundary = hi + 0.5;
    const z = (boundary - minObs) / sigmaCooling;
    const pYes = normCdf01(z);
    return { pWin: side === "yes" ? pYes : (1 - pYes),
             obs: minObs, boundary, kind: "cold-tail-low" };
  }
  if (b.variable === "high" && maxObs != null
      && hi == null && Number.isFinite(lo)) {
    const boundary = lo - 0.5;
    const z = (boundary - maxObs) / sigmaCooling;
    const pYesLose = normCdf01(z);  // P(high < boundary) = P(YES loses)
    const pYes = 1 - pYesLose;
    return { pWin: side === "yes" ? pYes : (1 - pYes),
             obs: maxObs, boundary, kind: "hot-tail-high" };
  }
  // Hot-tail LOW (low ≥ N markets, e.g. T77 = "≥ 78°F"). Boundary = lo - 0.5.
  if (b.variable === "low" && minObs != null
      && hi == null && Number.isFinite(lo)) {
    const boundary = lo - 0.5;
    const z = (boundary - minObs) / sigmaCooling;
    const pYesLose = normCdf01(z);  // P(low < boundary) = P(YES loses)
    const pYes = 1 - pYesLose;
    return { pWin: side === "yes" ? pYes : (1 - pYes),
             obs: minObs, boundary, kind: "hot-tail-low" };
  }
  // Cold-tail HIGH (high ≤ N markets). Boundary = hi + 0.5.
  if (b.variable === "high" && maxObs != null
      && lo == null && Number.isFinite(hi)) {
    const boundary = hi + 0.5;
    const z = (boundary - maxObs) / sigmaCooling;
    const pYes = normCdf01(z);  // P(high < boundary) = P(YES wins)
    return { pWin: side === "yes" ? pYes : (1 - pYes),
             obs: maxObs, boundary, kind: "cold-tail-high" };
  }
  return null;
}
const SIGMA_COOLING_F = 0.7;     // residual extremum noise given running min/max
const PI_TAIL_SKIP    = 0.10;    // skip when posterior P(win) < this

// σ_climb (2026-05-19) — additional uncertainty on final daily extremum when the
// day hasn't peaked yet. Anchored on n=406 settled prediction_snapshots: residual
// std of (actualHigh − predHigh) grows from 0.77°F post-peak to 1.84°F at 8+hr
// pre-peak. The model's std already absorbs ensemble spread + σ_resolution +
// kalman + σ_revision, but those don't capture "the temperature still has to
// climb." Adds in quadrature: σ_eff_climb = √(modelStd² + σ_climb(hrs)²). The
// gate downstream recomputes pWin/EV/halfKelly under σ_eff_climb and skips if
// the bet falls below trader minimums.
//
// Empirical bins (std of actualHigh − predHigh):
//   hrsToPeak [0, 0.5):  0.77   → 0 (post-peak; σ_cooling regime handles this)
//   hrsToPeak [1, 2):    1.41   → σ_climb ≈ √(1.41² − 0.75²) = 1.19
//   hrsToPeak [2, 4):    1.48   → σ_climb ≈ √(1.48² − 0.75²) = 1.27
//   hrsToPeak [4, 8):    1.70   → σ_climb ≈ √(1.70² − 0.75²) = 1.53
//   hrsToPeak [8, 24):   1.84   → σ_climb ≈ √(1.84² − 0.75²) = 1.68
//
// 2026-05-19 calibration target: Houston T87 YES cluster (5 buy/sell cycles).
// At hrsToPeak=2, modelStd≈1.5, σ_climb=1.2 → σ_eff=1.92, pWin drops from
// 0.577 → ~0.40, ev drops from 0.21 → ~0.03, hits MIN_EDGE_HIGH=0.17 floor.
function sigmaClimbF(hrs) {
  if (hrs == null || hrs <= 0.5) return 0;
  if (hrs < 2)  return 1.2;
  if (hrs < 4)  return 1.3;
  if (hrs < 8)  return 1.5;
  return 1.7;
}
// μ_climb (2026-05-19) — empirical mean of (actualHigh − predHigh) by hrsToPeak
// across n=406 settled prediction_snapshots. The model is systematically COOL
// pre-peak (predicts lower than actuals) and the bias grows with horizon. σ_climb
// alone is insufficient to reject Houston-style cool-bias trades because widening
// σ pulls pWin toward 0.5 — which can *increase* pWin when μ is already near the
// bucket boundary. Adding μ_climb shifts the center upward and tightens the gate.
//
// Empirical means (actualHigh − predHigh):
//   hrsToPeak [0, 1):  -0.13  → 0 (post-peak, no shift)
//   hrsToPeak [1, 2):   0.00  → 0
//   hrsToPeak [2, 4):  +0.32  → 0.3
//   hrsToPeak [4, 8):  +0.44  → 0.4
//   hrsToPeak [8, 24): +0.79  → 0.8
//
// HIGH-only. LOW-side residual mean by hrsToTrough not yet computed — leave 0
// for now to avoid spurious adjustments on the cooler-than-forecast direction.
function muClimbF(hrs, variable) {
  if (variable !== "high") return 0;
  if (hrs == null || hrs <= 1) return 0;
  if (hrs < 2)  return 0.0;
  if (hrs < 4)  return 0.3;
  if (hrs < 8)  return 0.4;
  return 0.8;
}

// Tail-obs-pyramid (2026-05-19) — inversion of AUTO_CLOSE_AT_PRICE. When a bot
// position is post-peak/trough AND observed extremum is comfortably past the
// bucket boundary in our favor AND market still offers our side at a discount,
// ADD contracts. Captures slow-market mispricing on near-certain outcomes.
// Bypasses already-held / city-var-cooldown / event-side-stack-cap (those are
// designed to prevent loss pyramids, not block winning-side obs-arbs). Strict
// per-event caps keep risk bounded even on $10 bankroll.
//
// Trigger conditions (all must hold):
//   1. Position is bot-placed and held this cycle
//   2. Not in cycleSellTickerKeys (we didn't just sell it this cycle)
//   3. hrsToPeak ≤ 0.5 (HIGH) or hrsToTrough ≤ 0.5 (LOW)  — extremum realized
//   4. tailBucketPosteriorP(obs-anchored, σ_cooling).pWin ≥ PYRAMID_PWIN_MIN
//   5. Observed extremum past boundary by ≥ PYRAMID_MARGIN_F in our direction
//   6. Market ask on our side ≤ PYRAMID_MAX_PRICE
//   7. Cash available ≥ STAKE_FLOOR
//
// Sizing: contracts = min(PYRAMID_MAX_CONTRACTS, floor(budget/price)) where
// budget = min(PYRAMID_MAX_DOLLARS, remaining cash). On a 95% bet at 38¢ this
// adds 5 contracts × 38¢ = $1.90, EV ≈ +$0.95.
const PYRAMID_PWIN_MIN      = 0.90;
const PYRAMID_MAX_PRICE     = 0.70;
const PYRAMID_MARGIN_F      = 1.0;
const PYRAMID_MAX_CONTRACTS = 5;
const PYRAMID_MAX_DOLLARS   = 2.0;
// Max obs-pyramid ADDS per (ticker, side) across the position's life. Each add is
// already bounded in size (MAX_CONTRACTS/MAX_DOLLARS), but nothing capped the COUNT
// of adds — so a persistently-qualifying (and, as it turned out, overconfident)
// posterior could re-add every cycle. On 2026-05-28 it stacked 23 adds into one
// Chicago LOW-NO as the ask climbed 0.15→0.43; a late-night low then flipped it
// inside the bucket → a 24× correlated loss pile. Cap the count so a wrong obs
// anchor can't compound into a concentrated bet.
const PYRAMID_MAX_ADDS      = 3;

// LOW-NO-near-strike gate (2026-05-11). T-tail NO bets in southern cities lost
// 8 of last 10 at strikes within 1°F of model μ — pattern: μ=70.9 σ=1.8, strike
// at 71, NO wins if min ≤ 70 (boundary 70.5); margin = 70.5 − 70.9 = −0.4°F.
// The bot saw EV/Kelly edge from fees and σ but the bet was structurally
// thin: any forecast revision of 0.5°F flips it. Backtest at thr=1.0°F over
// 114 settled bets, LOW only: 7 hits, 6 TP/1 FP, +$36.52 net. HIGH side has
// asymmetric loss/win mix (Houston T76 NO won big at margin −0.1) — gate
// LOW only. boundary = ticker code N for "≥ N+1" bucket → loInt − 0.5.
const NO_STRIKE_MARGIN_MIN_F = 1.0;
function noStrikeMargin(b) {
  if ((b.side || "").toLowerCase() !== "no") return null;
  if (b.variable !== "low") return null;   // HIGH excluded — see header
  const code = (b.ticker || "").split("-").pop();
  if (!code || !code.startsWith("T")) return null;
  if (b.modelMean == null) return null;
  // For LOW T<N> (bucket "≥ N+1"): YES wins at low ≥ N+1; NO wins at low ≤ N.
  // boundary = loInt − 0.5 where loInt is the bucket's lower integer (N+1).
  // b.loInt is set upstream by kalshi.js (mirror of bucket parse).
  if (b.loInt == null || b.loInt === -Infinity) return null;
  const boundary = b.loInt - 0.5;
  return boundary - b.modelMean;   // + = model below strike (favors NO)
}

// Kelly-under-uncertainty (Bayes work order #5): use lower confidence bound on
// pWin instead of point estimate. σ_p comes from the delta method:
//   p_YES = Φ((b+0.5−μ)/σ) − Φ((a−0.5−μ)/σ)   [B-bucket [a,b]]
//   ∂p_YES/∂μ = (φ((a−0.5−μ)/σ) − φ((b+0.5−μ)/σ)) / σ
//   σ_p ≈ |∂p/∂μ| × σ_μ                       [σ_μ = forecast revision noise]
//   p_LCB = p_hat − z_α × σ_p
// Then check the trader's MIN_EDGE/MIN_HALF_KELLY using p_LCB instead of p_hat.
// Calibrated against backtest_gates.js Kelly-LCB A/B at z_α=0.5: +$112 net.
// σ_μ floor — used when no forecast-age info is on the bet (legacy bets / null
// inputAges). When age IS available, see sigmaForecastRevisionMu below — α × age
// scales σ_μ with staleness so the LCB tightens on stale-forecast bets.
// Calibrated against backtest_gates.js Kelly-LCB A/B at z_α=0.5: +$112 net.
const SIGMA_FORECAST_REVISION_F = 0.5;  // σ_μ — revision of model mean over short horizon
// Seed α values, used when the prediction payload doesn't carry the resolved
// sigmaRevisionAlphas (legacy / missing field). When weather.js exposes them
// (post-48339d0 follow-up), we use the SAME α that built σ_post — keeps prior
// and Kelly-LCB in lockstep so the auto-fit propagates cleanly.
const SIGMA_MU_ALPHA_HIGH_SEED = 0.4;
const SIGMA_MU_ALPHA_LOW_SEED  = 0.3;
const SIGMA_MU_AGE_FREE_HR = 1.0;
function sigmaForecastRevisionMu(b, cityInputAges, alphasFromWeather) {
  const ageMin = cityInputAges?.nwsGridAgeMin;
  if (ageMin == null) return SIGMA_FORECAST_REVISION_F;
  const ageHr = ageMin / 60;
  const seed = b.variable === "low" ? SIGMA_MU_ALPHA_LOW_SEED : SIGMA_MU_ALPHA_HIGH_SEED;
  const fit  = b.variable === "low" ? alphasFromWeather?.low  : alphasFromWeather?.high;
  const α = Number.isFinite(fit) ? fit : seed;
  const dynamic = α * Math.max(0, ageHr - SIGMA_MU_AGE_FREE_HR);
  return Math.max(SIGMA_FORECAST_REVISION_F, dynamic);
}
const KELLY_LCB_Z = 0.5;                // 0.5σ lower bound (mild); 1.0/1.65 more aggressive
function kellyLcbAdjust(b, cityInputAges, alphasFromWeather) {
  const σ = b.modelStd, μ = b.modelMean;
  if (!Number.isFinite(σ) || σ <= 0 || !Number.isFinite(μ)) return null;
  const lo = b.loInt, hi = b.hiInt;
  const zLo = (lo == null || lo === -Infinity) ? null : (lo - 0.5 - μ) / σ;
  const zHi = (hi == null || hi === Infinity)  ? null : (hi + 0.5 - μ) / σ;
  const phi = z => Math.exp(-z*z/2) / Math.sqrt(2*Math.PI);
  const phiLo = zLo == null ? 0 : phi(zLo);
  const phiHi = zHi == null ? 0 : phi(zHi);
  const dPdMu = Math.abs(phiLo - phiHi) / σ;
  const sigmaMu = sigmaForecastRevisionMu(b, cityInputAges, alphasFromWeather);
  const sigmaP = dPdMu * sigmaMu;
  const pHat = b.pWin;
  if (!Number.isFinite(pHat)) return null;
  // For NO-side bets, pWin = 1 - pYes; sensitivity flips sign but |·| same.
  const pLCB = Math.max(0, pHat - KELLY_LCB_Z * sigmaP);
  return { pHat, pLCB, sigmaP };
}

// Tail-bucket (T-prefix) obs-vs-boundary gate. Returns YES "gapF" (residual move
// required to enter the tail) or NO "safetyMargin" (room obs has before falling into
// the tail), or null if not applicable / model drives. Uses loInt/hiInt from kalshi.js
// bucketBounds, which already encodes Kalshi's strict-inequality strikes (off-by-one
// fix from 2026-05-05). RETAINED for diagnostic logs alongside the posterior gate.
//
// Cold tail (loInt = -Infinity, hiInt finite). Boundary = hiInt + 0.5.
//   LOW YES wins if low ≤ hiInt (continuous: low < boundary).
//     gapF = max(0, m - boundary)  — drop needed from minSoFar.
//   LOW NO wins if low > hiInt (continuous: low ≥ boundary).
//     safetyMargin = m - boundary  — room above tail. Negative = auto-loss
//     (low has already rounded ≤ hi); small positive = one cool gust kills it.
// Hot tail (loInt finite, hiInt = +Infinity). Boundary = loInt - 0.5.
//   HIGH YES wins if high ≥ loInt → gapF = max(0, boundary - m) (rise from maxSoFar).
//   HIGH NO  wins if high <  loInt → safetyMargin = boundary - m (room below tail).
//
// NO-side gate added 2026-05-08 after KXLOWPHX-26MAY08-T69 NO at 30¢ lost $9 — model
// μ_low=70.9 above strike but minSoFar had already dropped past 69.5 by 8:34 AM MST,
// so NO was structurally auto-loss the model couldn't see. Symmetric to the YES gate
// added the same morning; same threshold magnitude (BUCKET_TAIL_OBS_GAP_MAX_F = 1.5°F)
// because the underlying physics is the same — once the diurnal extremum is locked,
// the model's truncated normal still places mass past the boundary.
function tailBucketObsGap(b, weatherCity) {
  const side = b.side?.toLowerCase();
  if (side !== "yes" && side !== "no") return null;
  const code = b.ticker;
  if (!code || !code.startsWith("T")) return null;
  // NOTE: kalshi.js bucketBounds uses ±Infinity for tail bounds, but those become `null`
  // after JSON.stringify round-trip through fetchInternal. So a tail bound is detected
  // as `loInt == null` (cold tail) or `hiInt == null` (hot tail), not strict ±Infinity.
  const lo = b.loInt, hi = b.hiInt;

  if (b.variable === "low") {
    const m = cliMinObs(weatherCity);
    if (m == null) return null;
    if (lo == null && Number.isFinite(hi)) {
      const boundary = hi + 0.5;
      if (side === "yes") {
        const gapF = Math.max(0, m - boundary);
        return { variable: "low", side: "yes", obs: m, boundary, gapF, kind: "drop-needed" };
      }
      const safetyMargin = m - boundary;
      return { variable: "low", side: "no", obs: m, boundary, safetyMargin, kind: "no-margin-above-tail" };
    }
    // Hot-tail LOW: out of scope (rare market; obs-vs-strike relation differs).
    return null;
  }
  if (b.variable === "high") {
    const m = cliMaxObs(weatherCity);
    if (m == null) return null;
    if (hi == null && Number.isFinite(lo)) {
      const boundary = lo - 0.5;
      if (side === "yes") {
        const gapF = Math.max(0, boundary - m);
        return { variable: "high", side: "yes", obs: m, boundary, gapF, kind: "rise-needed" };
      }
      const safetyMargin = boundary - m;
      return { variable: "high", side: "no", obs: m, boundary, safetyMargin, kind: "no-margin-below-tail" };
    }
    return null;
  }
  return null;
}

// B-bucket "obs already past bucket" gate for LOW YES bets — symmetric to tailBucketObsGap
// but for B-buckets where the bucket sits entirely below minSoFar. These cases are NOT
// covered by bucketBoundaryMargin: that function returns null when obs is past the bucket
// on the reachable side, deferring to the model. The model's truncated normal can still
// produce confident pWin here, but conditional on minSoFar being already above the bucket
// AND the diurnal min having physically passed (post-sunrise on a normal day), additional
// cooling enough to enter the bucket is uncommon.
//
// LOW YES: bucket = [N-0.5, N+1.5). Bet wins iff low rounds to N or N+1.
//   m = minSoFar bounds low from above. m >= N+1.5 means bucket entirely below obs.
//   Drop required to enter bucket at all = m - (N+1.5).
//   Drop required to land within bucket window = m - (N+1.5) to m - (N-0.5).
//   Threshold gates the "drop to enter" gap.
//
// LOW only (no HIGH symmetric). The HIGH analog would require post-peak detection: at
// sunrise, maxSoFar is naturally far below the forecasted high, and gating that case
// would block every morning bet on a hot-day high. The min-side gate works any time of
// day because once minSoFar is observed, "low can only stay or decrease" — but mid-day
// we know it can't decrease much without an evening cold push, and the model doesn't
// distinguish those. A future HIGH-side version should require localHour > sunset+1h
// or similar.
function bucketAboveObsGap(b, weatherCity) {
  const side = b.side?.toLowerCase();
  if (side !== "yes") return null;
  if (b.variable !== "low") return null;
  const code = b.ticker;
  if (!code || !code.startsWith("B")) return null;
  const v = parseFloat(code.slice(1));
  if (!Number.isFinite(v)) return null;
  const N = Math.floor(v);

  const m = cliMinObs(weatherCity);
  if (m == null) return null;
  if (m < N + 1.5) return null;  // obs in or below bucket → bucketBoundaryMargin handles
  const boundary = N + 1.5;
  const gapF = m - boundary;
  return { variable: "low", side: "yes", obs: m, boundary, gapF, kind: "drop-needed-to-enter" };
}

// Tile-coverage check: would adding `candidate` to `committed` create a dual-loss zone
// inside the model's high-density region? Returns {ok: true} or {ok: false, reason}.
// High-density = within ±1.5σ of model mean. Catches the CHI-lows-on-2026-05-03 trap
// (T45 YES + B44.5 NO both lose at 45) and the AUS-2026-05-03 trap (T76 YES + B76.5 YES
// both lose at 80, where model mean was 78).
function tileConflict(candidate, committed) {
  if (!committed || committed.length === 0) return { ok: true };
  const mean = candidate.modelMean;
  const std = Math.max(0.4, candidate.modelStd || 1.0);
  if (!Number.isFinite(mean)) return { ok: true };
  const lo = Math.round(mean - 1.5 * std);
  const hi = Math.round(mean + 1.5 * std);
  for (let x = lo; x <= hi; x++) {
    const candWins = betWinsAt(candidate, x);
    if (candWins) continue;  // candidate would win here — fine
    const allCommittedLose = committed.every(b => !betWinsAt(b, x));
    if (allCommittedLose) {
      return { ok: false, reason: `dual-loss-at-${x}F (model ${mean.toFixed(1)}±${std.toFixed(1)})` };
    }
  }
  return { ok: true };
}

async function fetchInternal(path) {
  const auth = "Basic " + btoa("internal:hydro");
  const r = await fetch(`${SITE_BASE}${path}`, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return await r.json();
}

// Liquidity-scaled maker limit price for a buy on our side. `ask`/`bid` are our-side best
// quotes (for NO bets: no_ask/no_bid); `pWin` is the model win-prob for the side. Tight
// spread -> post at the bid (full capture, trustworthy two-sided book); wide spread -> step
// toward the ask (don't reach across a lonely/stale quote). Never exceeds the price that
// keeps net-of-fee EV >= VLIM_EV_FLOOR. Falls back to the ask (taker) if there's no real
// bid. Validated in backtest_variable_limit.mjs (2026-05-26).
function variableLimitPrice(ask, bid, pWin) {
  if (!(ask > 0) || !(bid > 0) || bid >= ask) return ask;   // no two-sided market -> taker
  const spread = ask - bid;
  const frac = Math.min(1, Math.max(0, VLIM_REF_SPREAD / spread));   // tight->1 (bid), wide->small
  let px = ask - spread * frac;
  const healthCap = (pWin - 0.07 - VLIM_EV_FLOOR) / 0.93;   // invert net-of-fee EV = p - 0.07 - 0.93*L
  if (Number.isFinite(healthCap)) px = Math.min(px, healthCap);
  return Math.min(ask, Math.max(bid, px));
}

// Place a buy order via Kalshi. Returns the order response.
// Kalshi prices are integer cents 1-99. Stake comes through `count` (number of contracts).
// V2 (2026-07-23): the payload is built in lib/kalshi_orders.js — the old endpoint is
// 410 Gone and V2 quotes everything on the YES leg, so a NO buy goes out as a YES sell
// at the complement price. This signature and its cents stay unchanged for callers.
async function placeBuyOrder(ticker, side, count, priceCents) {
  const body = buildOrderBody({
    ticker, action: "buy", side, count, priceCents,
    // 15-min expiration (extended from 5-min on 2026-05-07): on illiquid temp
    // markets the 5-min window often expired with partial or zero fills (SATX
    // 7-contract intent → 1-share fill). 15 min lets resting orders catch new
    // offers as they post. Phantom-grace reconcile (jackson_trader.js) keeps
    // ledger entries alive within 1h, so the longer expiration doesn't cause
    // double-buys on the next 5-min cycle.
    expirySec: 60 * 15,
    clientOrderId: `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  });
  const r = await kalshiAuthedFetch("POST", V2_ORDERS_PATH, body);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: normalizeOrderResponse(j) };
}

// Place a sell order to close an existing position.
async function placeSellOrder(ticker, side, count, priceCents) {
  const body = buildOrderBody({
    ticker, action: "sell", side, count, priceCents, expirySec: 60 * 15,
    clientOrderId: `wb-sell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  });
  const r = await kalshiAuthedFetch("POST", V2_ORDERS_PATH, body);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: normalizeOrderResponse(j) };
}

// Public (no-auth) Kalshi market-result lookup — paper mode runs without Kalshi
// creds, so it can't use the authed getMarketResult. Mirrors jackson_audit's
// getMarketPublic. Returns "yes"/"no" once settled, else null.
async function getMarketResultPublic(ticker) {
  try {
    const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000)
    });
    if (!r.ok) return null;
    const j = await r.json();
    const result = j?.market?.result;
    return (result === "yes" || result === "no") ? result : null;
  } catch (e) { return null; }
}

// Core trade cycle. isPaper=false (default) = the live "Andrew Jackson" trader.
// isPaper=true = a faithful PAPER shadow on a virtual $100 bankroll: it runs the
// IDENTICAL candidate gate stack + Kelly sizing, but (a) never touches Kalshi,
// (b) sources bankroll/positions from the paper blob stores (open_bets /
// settled_bets / paper_state, the ones /api/paper reads), and (c) is buys-only,
// holding every position to settlement (no pyramid, no active sells). That last
// choice is deliberate: it isolates the ENTRY-signal edge, which is exactly the
// live-vs-backtest gap we're diagnosing (project_weatherbot_backtest_vs_live_gap).
// Driven by paper_trader.js on its own */5 cron; reset/seed via /api/paper_reset.
export async function runTraderCycle(isPaper = false) {
  if (!isPaper && (!process.env.KALSHI_ACCESS_KEY_ID || !process.env.KALSHI_PRIVATE_KEY)) {
    return new Response(JSON.stringify({ ok: true, dormant: true,
      message: "Real-trader dormant: KALSHI_ACCESS_KEY_ID/KALSHI_PRIVATE_KEY not set" }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
  // Hard arm-switch: real trading only fires when KALSHI_TRADING_LIVE === "true".
  // Without this, the trader is paused even if creds are present. Lets us land
  // safety changes without immediately firing real orders. Paper mode bypasses
  // the arm-switch entirely (no real money at risk) and always runs the loop.
  let isLive = false, isDryRun = false;
  if (!isPaper) {
    const liveFlag = (process.env.KALSHI_TRADING_LIVE || "").trim().toLowerCase();
    // POST-MORTEM HALT (TRADING_POSTMORTEM.md): the model is a proven net loser
    // (−45% ROI, May–Jul 2026; it forecasts worse than the market it trades). Real
    // trading is HARD-HALTED regardless of KALSHI_TRADING_LIVE until a candidate
    // strategy clears the go/no-go bar in STRATEGY.md. Resuming is a deliberate
    // double-key: set KALSHI_TRADING_RESUME="true" AND KALSHI_TRADING_LIVE="true".
    // Dry-run and paper are unaffected (no real money at risk).
    const resumed = process.env.KALSHI_TRADING_RESUME === "true";
    isLive = resumed && ["true", "1", "yes", "on", "live"].includes(liveFlag);
    // Distinguish "paused"/"halted" from "dry-run" mode. In dry-run we still execute the
    // placement loop (computing all skip/place decisions) but don't call Kalshi to submit
    // orders — lets us instrument without trading. Dry-run stays available while halted.
    isDryRun = !isLive && ["dryrun", "dry-run", "shadow"].includes(liveFlag);
    if (!isLive && !isDryRun) {
      return new Response(JSON.stringify({ ok: true, paused: true, halted: !resumed,
        flagValueSeen: liveFlag ? "(non-empty but not truthy)" : "(empty/unset)",
        message: resumed
          ? "Real-trader paused: KALSHI_TRADING_LIVE must be 'true' (or 1/yes/on/live). Set to 'dryrun' for instrumentation-only mode."
          : "Real-trader HALTED per TRADING_POSTMORTEM.md (model is a net loser). No real orders will be placed. To resume, set KALSHI_TRADING_RESUME='true' AND KALSHI_TRADING_LIVE='true'." }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
  }
  // noKalshi: simulate fills + skip every Kalshi network call. True in BOTH paper
  // and dry-run. The buy loop already had a dryRun fork at each placeBuyOrder; we
  // widen it to noKalshi so paper reuses the exact same placement path.
  const noKalshi = isPaper || isDryRun;
  const PAPER_SEED = 100;

  const placements = [], sales = [], errors = [], skipped = [];
  const lowScreen = [];  // shadow/enforce records from lib/low_screen.js
  const ledgerStore = getStore(isPaper ? "open_bets" : "jackson_open_bets");
  const settledStore = getStore(isPaper ? "settled_bets" : "jackson_settled_bets");
  const cooldownStore = getStore(isPaper ? "paper_cooldown" : "jackson_cooldown");
  const calibrationStore = getStore("calibration_state");
  const paperStateStore = isPaper ? getStore("paper_state") : null;
  let paperState = null;          // loaded below; bankroll persisted at end
  let paperOpenEntries = null;    // paper open bets, reused as `ledger`
  let paperRealizedDelta = 0;     // net (post-fee) P&L booked this cycle
  try {
    // 1. Read live state from Kalshi + bot ledger + cooldown map.
    const [balanceRaw, positionsRaw, kalshiData, weatherData, { blobs: ledgerBlobs }, cooldownRaw, calState, paperStateRaw] = await Promise.all([
      isPaper ? Promise.resolve(null) : getBalance(),
      isPaper ? Promise.resolve(null) : getPositions(),
      fetchInternal("/api/kalshi"),
      fetchInternal("/api/weather"),
      ledgerStore.list().catch(() => ({ blobs: [] })),
      cooldownStore.get("map.json", { type: "json" }).catch(() => ({})),
      calibrationStore.get("current.json", { type: "json" }).catch(() => null),
      isPaper ? paperStateStore.get("global", { type: "json" }).catch(() => null) : Promise.resolve(null)
    ]);
    // Calibration-health gate: certify each side's σ-inflation loop is alive and
    // sane before allowing new buys on it. See CAL_* constants. A side fails if
    // its loop has too few matched bets, runaway residual spread, or the
    // calibration_state blob is stale (cron dark). Returns {ok, reason} per side.
    const calAgeMin = calState?.updated_at
      ? Math.round((Date.now() - new Date(calState.updated_at).getTime()) / 60000) : null;
    // Self-heal stale calibration off the trader's reliable */5 cron (see CAL_REFRESH_MIN).
    // The background fn returns 202 in ~200ms and writes within ~15s, so THIS cycle still
    // gates on the current (stale) cal age — the refresh lands for the NEXT cycle. We AWAIT
    // (not fire-and-forget) with a bounded timeout: an un-awaited fetch can be discarded when
    // the serverless instance freezes before the request is even sent, so the kick would
    // silently never fire. The AbortController caps the wait so a hung endpoint can't stall
    // the trade cycle; any failure is swallowed (refresh is best-effort, never blocks trading).
    if (!isPaper && (calAgeMin == null || calAgeMin >= CAL_REFRESH_MIN)) {
      try {
        const _ac = new AbortController();
        const _t = setTimeout(() => _ac.abort(), 3000);
        await fetch(`${SITE_BASE}/.netlify/functions/calibration_update-background`, {
          headers: { authorization: "Basic " + btoa("internal:hydro") }, signal: _ac.signal
        }).finally(() => clearTimeout(_t));
      } catch { /* best-effort: never let a refresh failure break the trade cycle */ }
    }
    // Hourly σ-revision/intraday-β refit kick — gated to start after the hands-off window
    // (SIGMA_REFIT_RESUME_TS). UTC minute < 5 makes it fire ~once/hour off the */5 cron.
    // Same bounded fire-and-forget contract as the cal kick: can never stall/break a cycle.
    {
      const _nowMs = Date.now();
      if (!isPaper && _nowMs >= SIGMA_REFIT_RESUME_TS && new Date(_nowMs).getUTCMinutes() < 5) {
        try {
          const _ac2 = new AbortController();
          const _t2 = setTimeout(() => _ac2.abort(), 3000);
          await fetch(`${SITE_BASE}/.netlify/functions/sigma_refit-background`, {
            headers: { authorization: "Basic " + btoa("internal:hydro") }, signal: _ac2.signal
          }).finally(() => clearTimeout(_t2));
        } catch { /* best-effort */ }
      }
    }
    const calHealthFor = (variable) => {
      const v = variable === "low" ? "low" : "high";
      // Liveness ONLY. Uncertainty is handled upstream by the Student-t predictive;
      // here we hard-skip a side only when its calibration loop is DEAD:
      if (!calState) return { ok: false, reason: "cal-blob-missing" };
      if (calAgeMin != null && calAgeMin > CAL_MAX_AGE_MIN)
        return { ok: false, reason: `cal-stale-${calAgeMin}min` };  // cron dark
      // Certify on the POPULATION σ fit (sigma_{side}) — the actual σ source — not the
      // legacy bet-matched block. Missing posterior = the fit isn't published yet
      // (e.g. calibration_update predates this side); thin n = not enough population
      // residuals to trust. Both self-heal as daily settles accumulate. This is what
      // replaced the deadlocking cal-join-broken bet-matched check (see CAL_POP_MIN_N).
      const sig = calState?.[`sigma_${v}`];
      if (sig?.posterior == null) return { ok: false, reason: `cal-sigma-missing-${v}` };
      if ((sig.n ?? 0) < CAL_POP_MIN_N) return { ok: false, reason: `cal-pop-thin-${v}-n${sig.n ?? 0}` };
      return { ok: true, reason: null };
    };
    // Surfaced in the run summary (responseBody + trader_logs) so a dead/paused
    // side is visible at a glance, not buried in per-bet skip reasons.
    let calBlocked = {};  // variable -> reason; populated in the buy loop below
    // Prune expired cooldown entries. Two key shapes:
    //   "<ticker>-<SIDE>"      → after-sell ticker+side cooldown (TTL = COOLDOWN_MIN)
    //   "cv:<city>:<variable>" → after-buy city+variable cooldown (TTL = BUY_CITYVAR_COOLDOWN_MIN)
    const cooldownMap = cooldownRaw || {};
    const nowMs = Date.now();
    const sellCooldownMs = COOLDOWN_MIN * 60 * 1000;
    const buyCvCooldownMs = BUY_CITYVAR_COOLDOWN_MIN * 60 * 1000;
    for (const k of Object.keys(cooldownMap)) {
      const ttl = k.startsWith("cv:") ? buyCvCooldownMs : sellCooldownMs;
      if (nowMs - new Date(cooldownMap[k]).getTime() > ttl) delete cooldownMap[k];
    }
    const cityVarKey = (city, variable) => `cv:${city}:${variable || "high"}`;

    // Cash + equity. LIVE reads them from Kalshi; PAPER derives them from the
    // virtual bankroll: equity = bankroll, free cash = bankroll − open paper
    // stakes (each open bet's cost is "spent" until it settles). Bankroll is
    // updated only at settlement (+= net realized), so this stays self-consistent.
    let cashDollars, equityDollars, positions;
    if (isPaper) {
      paperState = paperStateRaw || { bankroll: PAPER_SEED, n_bets_total: 0, n_wins_total: 0, total_staked: 0, total_pnl: 0 };
      paperOpenEntries = (await Promise.all(
        ledgerBlobs.map(b => ledgerStore.get(b.key, { type: "json" }).catch(() => null))
      )).filter(Boolean);
      const openStake = paperOpenEntries.reduce((s, e) => s + (e.stake_dollars || 0), 0);
      equityDollars = paperState.bankroll;
      cashDollars = Math.max(0, paperState.bankroll - openStake);
      positions = [];   // paper dedup runs off the ledger (botPlacedKeys), not Kalshi
    } else {
      // Kalshi historically returns balance/portfolio_value in integer cents; the
      // 2026-07 quote-schema migration moved market fields to *_dollars strings, so
      // parse defensively in case the portfolio endpoints follow (live-readiness
      // hardening 2026-07-22 — a silent 0 here would zero the bankroll and halt
      // sizing on the day the flag gets flipped).
      const asCents = (cents, dollars) =>
        cents != null ? +cents
        : dollars != null ? Math.round(parseFloat(dollars) * 100)
        : 0;
      const cashCents = asCents(balanceRaw.balance, balanceRaw.balance_dollars);
      cashDollars = cashCents / 100;
      // Equity = free cash + portfolio_value (open positions). Mirrors rain trader's line-457 formula.
      equityDollars = cashDollars + (asCents(balanceRaw.portfolio_value, balanceRaw.portfolio_value_dollars) / 100);
      // Normalize Kalshi position fields. Real fields: position_fp (string of float;
      // sign = direction), market_exposure_dollars (string), realized_pnl_dollars (string).
      positions = (positionsRaw.market_positions || []).map(p => ({
        ...p,
        qty: parseFloat(p.position_fp || "0"),
        exposure: parseFloat(p.market_exposure_dollars || "0"),
        realizedPnl: parseFloat(p.realized_pnl_dollars || "0")
      }));
    }
    // Stake-boost regime: below the threshold, "earn-back mode" sizes each bet at
    // the lesser of STAKE_BOOST_FRAC*cash and STAKE_BOOST_DOLLAR_CAP; at/above it,
    // normal STAKE_CEIL_FRAC*cash. Identical for paper so it faithfully mirrors what
    // live WOULD do at the same equity. The single boost flag also drives the
    // σ-margin gate threshold; both revert in lockstep at equity ≥ threshold.
    const stakeBoosted = equityDollars < STAKE_BOOST_EQUITY_THRESHOLD;
    const stakeCeilDollars = stakeBoosted
      ? Math.min(STAKE_BOOST_FRAC * cashDollars, STAKE_BOOST_DOLLAR_CAP)
      : STAKE_CEIL_FRAC * cashDollars;
    const sigmaBucketMarginZ = stakeBoosted ? SIGMA_BUCKET_MARGIN_Z_BOOST : SIGMA_BUCKET_MARGIN_Z;
    const allOpenCount = positions.filter(p => p.qty !== 0).length;
    // Shared across pyramid loop (2b) and buy loop (3). Each placement adds its
    // dollar cost; cash-floor checks read `cashDollars - committed`.
    let committed = 0;

    // Bot ledger: entries we placed. Sell-loser logic ONLY iterates these.
    // User's pre-existing positions are off-limits.
    const ledger = paperOpenEntries ?? (await Promise.all(
      ledgerBlobs.map(b => ledgerStore.get(b.key, { type: "json" }).catch(() => null))
    )).filter(Boolean);
    const botKey = (ticker, side) => `${ticker}-${side}`;

    // Reconcile: ledger entries no longer held by Kalshi are settled or fully sold.
    // Kalshi's /portfolio/positions does NOT return closed rows on the elections API
    // (settlement_status=all has no effect — verified 2026-05-05), so we cannot read
    // realized_pnl_dollars from the position. Instead, query /markets/{ticker} for
    // the settlement result and compute realized P&L ourselves from the ledger's
    // cost basis. Sold-before-settlement entries fall back to sell-fill proceeds.
    const heldByKalshi = new Set();
    for (const p of positions) {
      if (p.qty > 0) heldByKalshi.add(botKey(p.ticker, "YES"));
      if (p.qty < 0) heldByKalshi.add(botKey(p.ticker, "NO"));
    }
    const liveLedger = [];
    const settlingEntries = [];
    for (const entry of ledger) {
      const key = botKey(entry.ticker, entry.side);
      if (heldByKalshi.has(key)) liveLedger.push(entry);
      else settlingEntries.push(entry);
    }
    if (!isPaper && settlingEntries.length > 0) {
      // Pull recent fills once for fee + sell-proceeds attribution. Limit 200
      // covers ~3-4 days of bot activity at current pace; longer-tail sells will
      // miss fee data but the realized payout from /markets is still authoritative.
      let fillsByTicker = {};
      try {
        const fillsResp = await getRecentFills(200);
        for (const f of (fillsResp.fills || [])) {
          (fillsByTicker[f.ticker] ??= []).push(f);
        }
      } catch (e) {
        errors.push({ where: "fills-fetch", err: String(e) });
      }
      // Look up market settlement results in parallel.
      const results = await Promise.all(settlingEntries.map(e => getMarketResult(e.ticker)));
      for (let i = 0; i < settlingEntries.length; i++) {
        const entry = settlingEntries[i];
        const result = results[i];
        const fills = fillsByTicker[entry.ticker] || [];
        const sideLower = (entry.side || "").toLowerCase();
        const matchingFills = fills.filter(f => f.side === sideLower);
        const totalFees = matchingFills.reduce((s, f) => s + parseFloat(f.fee_cost || "0"), 0);

        let realized = null, outcome = "UNKNOWN";
        if (result === "yes" || result === "no") {
          const won = (sideLower === result);
          realized = (won ? 1.0 : 0.0) * (entry.contracts || 0) - (entry.stake_dollars || 0);
          outcome = won ? "WIN" : "LOSS";
        } else {
          // Market not yet settled — must have been sold. Compute proceeds from sell fills.
          const sellFills = matchingFills.filter(f => f.action === "sell");
          if (sellFills.length > 0) {
            const proceeds = sellFills.reduce((s, f) => {
              const price = parseFloat((f.side === "yes" ? f.yes_price_dollars : f.no_price_dollars) || "0");
              const count = parseFloat(f.count_fp || "0");
              return s + price * count;
            }, 0);
            realized = proceeds - (entry.stake_dollars || 0);
            outcome = "SOLD";
          }
        }

        // Phantom-or-pending guard: if outcome is UNKNOWN, the entry is either
        // (a) phantom — limit order never filled, ledger has a ghost write, OR
        // (b) Kalshi positions endpoint had a transient miss (eventual consistency).
        // Either way, prematurely writing to settledStore as UNKNOWN pollutes the
        // analytics and we lose the ability to recover via re-discovery next cycle.
        // Audit on 2026-05-06: 13 of 28 settled bets were UNKNOWN — most of those
        // were SATX/NY/DC entries placed minutes before the reconcile fired, where
        // Kalshi's positions endpoint hadn't reflected the new fill yet.
        // Fix: keep recent UNKNOWNs alive in liveLedger; let next cycle retry.
        // After PHANTOM_GRACE_MS (1 hour) with still-no-result-and-no-fills, treat
        // as confirmed phantom — delete from ledger but DON'T write to settled (it
        // was never a real position).
        const PHANTOM_GRACE_MS = 60 * 60 * 1000;
        if (outcome === "UNKNOWN") {
          const placedAt = entry.placedAtUTC ? new Date(entry.placedAtUTC).getTime() : 0;
          const ageMs = Date.now() - placedAt;
          if (ageMs < PHANTOM_GRACE_MS) {
            // Restore to live ledger — retry reconcile next cycle.
            liveLedger.push(entry);
            continue;
          }
          // Confirmed phantom. Delete from ledger silently; don't write to settled.
          await ledgerStore.delete(`${entry.betId}.json`).catch(() => {});
          continue;
        }

        const settledRecord = {
          ...entry,
          settledAtUTC: new Date().toISOString(),
          realized_pnl: realized != null ? Math.round(realized * 100) / 100 : null,
          fees_paid: Math.round(totalFees * 100) / 100,
          outcome,
          marketResult: result
        };
        await settledStore.setJSON(`${entry.betId}.json`, settledRecord)
          .catch(err => errors.push({ where: "settled-write", betId: entry.betId, err: String(err) }));
        await ledgerStore.delete(`${entry.betId}.json`).catch(() => {});

        // Over-sell self-heal (added 2026-05-18 after KXHIGHDEN-26MAY18-T50 over-sold
        // by 8 contracts due to eventual-consistency lag, auto-flipping into long YES
        // that the sell loop's botPlacedKeys safety check then orphaned). If the bet
        // settled as SOLD but Kalshi still holds a position on the OPPOSITE side, that
        // residual is the bot's own auto-flip — write a synthetic ledger entry so the
        // next cycle's sell loop can close it normally.
        if (outcome === "SOLD") {
          const flippedSide = sideLower === "no" ? "YES" : "NO";
          const flipped = positions.find(p => p.ticker === entry.ticker
            && ((flippedSide === "YES" && p.qty > 0) || (flippedSide === "NO" && p.qty < 0)));
          if (flipped) {
            const contracts = Math.abs(flipped.qty);
            const avgEntry = contracts > 0 ? flipped.exposure / contracts : 0;
            const syntheticBetId = `${entry.ticker}-${flippedSide}-flipped-${Date.now()}`;
            const syntheticEntry = {
              betId: syntheticBetId, ticker: entry.ticker, side: flippedSide, contracts,
              price: avgEntry, stake_dollars: flipped.exposure,
              city: entry.city, variable: entry.variable, bucket: entry.bucket,
              placedAtUTC: new Date().toISOString(),
              kalshiOrderId: null,
              flippedFromBetId: entry.betId,
            };
            await ledgerStore.setJSON(`${syntheticBetId}.json`, syntheticEntry)
              .catch(err => errors.push({ where: "synthetic-ledger-write",
                                          betId: syntheticBetId, err: String(err) }));
            liveLedger.push(syntheticEntry);  // make available to THIS cycle's sell loop
          }
        }
      }
    }
    // PAPER settle: every open paper bet whose market has resolved is booked at
    // its terminal outcome (no fills, no sells, no phantom concept — paper fills
    // are guaranteed). Unresolved markets stay in liveLedger (still "held"), with
    // no age-based phantom deletion. Net P&L (incl. an entry-fee estimate matching
    // Kalshi's 7% maker/taker schedule) accrues to paperRealizedDelta → bankroll.
    if (isPaper && settlingEntries.length > 0) {
      const results = await Promise.all(settlingEntries.map(e => getMarketResultPublic(e.ticker)));
      for (let i = 0; i < settlingEntries.length; i++) {
        const entry = settlingEntries[i];
        const result = results[i];
        if (result !== "yes" && result !== "no") { liveLedger.push(entry); continue; }  // unresolved → still held
        const sideLower = (entry.side || "").toLowerCase();
        const won = sideLower === result;
        const contracts = entry.contracts || 0;
        const stake = entry.stake_dollars || 0;
        const realized = (won ? 1.0 : 0.0) * contracts - stake;   // ex-fee, matches live audit basis
        const p = entry.price || 0;
        const fee = Math.ceil(0.07 * contracts * p * (1 - p) * 100) / 100;   // Kalshi fee estimate
        const net = realized - fee;
        const settledRecord = {
          ...entry,
          settledAtUTC: new Date().toISOString(),
          realized_pnl: Math.round(realized * 100) / 100,
          fees_paid: fee,
          pnl_dollars: Math.round(net * 100) / 100,   // net — /api/paper by_city reads this
          outcome: won ? "WIN" : "LOSS",
          marketResult: result,
          targetCli: entry.city || null,              // /api/paper by_city groups on this
        };
        await settledStore.setJSON(`${entry.betId}.json`, settledRecord)
          .catch(err => errors.push({ where: "paper-settled-write", betId: entry.betId, err: String(err) }));
        await ledgerStore.delete(`${entry.betId}.json`).catch(() => {});
        paperRealizedDelta += net;
      }
    }
    const botPlacedKeys = new Set(liveLedger.map(e => botKey(e.ticker, e.side)));
    // Total open exposure for the aggregate-exposure cap (set near top of file).
    const currentExposureDollars = isPaper
      ? liveLedger.reduce((s, e) => s + (e.stake_dollars || 0), 0)
      : positions.reduce((s, p) => s + (p.exposure || 0), 0);
    const botOpenCount = liveLedger.length;
    // Replaces the old "MAX_CONCURRENT - botOpenCount" definition. Reports how many
    // additional bets fit at STAKE_FLOOR with remaining cash — the real binding
    // constraint now that the 20-bet cap is gone.

    // cashDollars hasn't been adjusted by committed yet at this point; the real
    // running constraint is the (cashDollars - committed) check inside the buy loop.
    const spareCapacity = Math.max(0, Math.floor(cashDollars / STAKE_FLOOR));

    // Buy dedup: union of bot's blob ledger AND Kalshi's authoritative position list.
    // Kalshi positions are eventually-consistent within seconds; the blob ledger lags by
    // up to several minutes due to Netlify Blobs eventual consistency, which previously
    // allowed "double-buy" patterns where the bot bought the same (ticker, side) twice
    // across adjacent cycles before the ledger entry from cycle N was visible in cycle
    // N+1. Including Kalshi-side held positions in the dedup set fixes this.
    // SELL safety: only botPlacedKeys is consulted in the sell loop, so user-placed
    // positions remain off-limits to the sell logic.
    const heldKey = new Set(botPlacedKeys);
    for (const p of positions) {
      if (p.qty > 0) heldKey.add(botKey(p.ticker, "YES"));
      if (p.qty < 0) heldKey.add(botKey(p.ticker, "NO"));
    }
    // Same-event-same-side stack cap (added 2026-05-11 after PHX 5/5 series: dawn
    // NO B78.5 placed 05:08 AZ → won; noon NO B80.5 placed 12:54 AZ → lost). The
    // 60-min cv-cooldown had long expired by noon; tile-conflict allowed different
    // buckets; the noon σ had collapsed from morning's 1.53 to 0.96 on the same
    // (already-falsified) prior. Block adding a same-side bet on the same event
    // once we already hold a position — different buckets allowed only on the
    // opposite side (legitimate barbell), same side blocked (regime stacking).
    const heldEventSide = new Set();  // e.g. "KXHIGHTPHX-26MAY05:no"
    for (const k of heldKey) {
      const m = k.match(/^(.+)-(YES|NO)$/);
      if (!m) continue;
      const fullTicker = m[1];
      const lastDash = fullTicker.lastIndexOf("-");
      if (lastDash < 0) continue;
      const eventTicker = fullTicker.slice(0, lastDash);
      heldEventSide.add(`${eventTicker}:${m[2].toLowerCase()}`);
    }

    // 2. Sell positions where forward EV diverges from the current market bid by
    // more than SELL_HYSTERESIS (in either direction — losers AND overshooting
    // winners). ONLY among bot-placed positions. Skipped entirely in paper mode
    // (buys-only, hold-to-settlement — see runTraderCycle header).
    if (!isPaper && kalshiData?.cities) {
      const cityIndex = Object.fromEntries(kalshiData.cities.map(c => [c.name, c]));
      // 2026-05-28: CONCENTRATION TRIM PASS — cap any held position whose Kalshi
      // exposure exceeds CONCENTRATION_CAP * equityDollars. Sells the excess at the
      // current bid and marks the ledger entry `concentration_capped:true` so the
      // buy/pyramid loops won't re-grow it. Runs BEFORE the main sell loop and
      // updates cached p.qty/p.exposure so downstream logic sees the reduced pos.
      // cooldownMap check prevents double-trim within COOLDOWN_MIN of a prior trim.
      if (equityDollars > 0) {
        const concCap = CONCENTRATION_CAP * equityDollars;
        for (const p of positions) {
          if (p.qty === 0) continue;
          const side = p.qty > 0 ? "YES" : "NO";
          if (!botPlacedKeys.has(botKey(p.ticker, side))) continue;
          if (cooldownMap[botKey(p.ticker, side)]) continue;
          if (p.exposure <= concCap) continue;
          const qty = Math.abs(p.qty);
          const excess = p.exposure - concCap;
          const contractsToSell = Math.min(qty, Math.ceil(qty * excess / p.exposure));
          if (contractsToSell < 1) continue;
          // Find current bid for our side from kalshi snapshot.
          let bid = null;
          for (const c of kalshiData.cities) {
            for (const variant of [c.highBuckets, c.lowBuckets]) {
              if (!variant) continue;
              const found = variant.find(b => b.ticker === p.ticker);
              if (found) { bid = side === "YES" ? found.yes_bid : found.no_bid; break; }
            }
            if (bid != null) break;
          }
          if (bid == null || bid <= 0) continue;
          const sellCents = Math.max(1, Math.round(bid * 100));
          const res = isDryRun
            ? { ok: true, body: { dryRun: true } }
            : await placeSellOrder(p.ticker, side, contractsToSell, sellCents);
          sales.push({ ticker: p.ticker, side, count: contractsToSell, sellPriceCents: sellCents,
                       dryRun: isDryRun, ok: res.ok, reason: "concentration-trim",
                       exposureBefore: Math.round(p.exposure * 100) / 100,
                       equityNow: Math.round(equityDollars * 100) / 100,
                       capPct: CONCENTRATION_CAP });
          if (!res.ok) { errors.push({ where: "concentration-trim", ticker: p.ticker, response: res.body }); continue; }
          if (!isDryRun) {
            cooldownMap[botKey(p.ticker, side)] = new Date().toISOString();
            // Flag matching live ledger entries so buy/pyramid skip them until settle.
            for (const entry of liveLedger) {
              if (entry.ticker === p.ticker && entry.side === side && !entry.concentration_capped) {
                entry.concentration_capped = true;
                await ledgerStore.setJSON(`${entry.betId}.json`, entry)
                  .catch(err => errors.push({ where: "concentration-flag", betId: entry.betId, err: String(err) }));
              }
            }
            // Update cached qty/exposure so downstream loops don't double-act.
            const newQty = side === "YES" ? p.qty - contractsToSell : p.qty + contractsToSell;
            p.exposure = Math.max(0, p.exposure * (1 - contractsToSell / qty));
            p.qty = newQty;
          }
        }
      }
      for (const p of positions) {
        if (p.qty === 0) continue;
        const ticker = p.ticker;
        const side = p.qty > 0 ? "YES" : "NO";
        // Orphan auto-heal (replaces the old "skip user-placed" safety check).
        // Memory: project_kalshi_account_state.md — account is 100% bot-driven since
        // 2026-05-13. Any Kalshi position with no matching ledger entry is a bot-caused
        // state-sync bug (over-sell auto-flip residual, deleted-then-reappearing entry,
        // or pre-2026-05-13 leftover that never settled). Write a synthetic ledger entry
        // inline so the sell loop proceeds; future cycles reconcile it normally.
        if (!botPlacedKeys.has(botKey(ticker, side))) {
          const contracts = Math.abs(p.qty);
          const avgEntry = contracts > 0 ? p.exposure / contracts : 0;
          const syntheticBetId = `${ticker}-${side}-orphan-${Date.now()}`;
          const syntheticEntry = {
            betId: syntheticBetId, ticker, side, contracts,
            price: avgEntry, stake_dollars: p.exposure,
            city: null, variable: null, bucket: null,  // discovered fresh from kalshiData below
            placedAtUTC: new Date().toISOString(),
            kalshiOrderId: null,
            orphanHealed: true,
          };
          await ledgerStore.setJSON(`${syntheticBetId}.json`, syntheticEntry)
            .catch(err => errors.push({ where: "orphan-heal-ledger-write",
                                        betId: syntheticBetId, err: String(err) }));
          botPlacedKeys.add(botKey(ticker, side));
        }
        // Eventual-consistency guard (added 2026-05-18 after KXHIGHDEN-26MAY18-T50 auto-flip).
        // The cooldown stamp set at line 904 after a successful sell was previously only
        // checked by the buy loop. Without a sell-side check, when Kalshi's positions
        // endpoint lagged the fill (~2 min), the next cycle re-issued the sell and
        // over-sold the position, auto-flipping it to the opposite side and orphaning
        // it from the ledger.
        if (cooldownMap[botKey(ticker, side)]) continue;
        // Find this market in our Kalshi snapshot to get current bid + model probability.
        let bucket = null, citySide = null, soldVariable = null;
        for (const c of kalshiData.cities) {
          for (const [varName, variant] of [["high", c.highBuckets], ["low", c.lowBuckets]]) {
            if (!variant) continue;
            // kalshi.js emits b.ticker as the FULL Kalshi market ticker (e.g.,
            // "KXHIGHTDC-26MAY13-B75.5"), not the short bucket code. The old
            // endsWith("-" + b.ticker) check assumed the short form and so
            // never matched — bucket was always null, sell loop silently
            // skipped every position. Fixed 2026-05-13.
            const found = variant.find(b => b.ticker === ticker);
            if (found) { bucket = found; citySide = c; soldVariable = varName; break; }
          }
          if (bucket) break;
        }
        if (!bucket) continue;
        const isYes = p.qty > 0;
        // kalshi.js writes the field as yes_bid/no_bid; the old kalshi_ prefix never
        // existed in the snapshot, so this resolved to undefined and the sell loop
        // skipped every position (silently no-op since the trader's birth). Fixed
        // 2026-05-13 — the 99¢ auto-close commit (e874773) surfaced the bug because
        // a DC NO position sitting at no_bid=0.99 should have closed and didn't.
        const sellPrice = isYes ? bucket.yes_bid : bucket.no_bid;
        if (sellPrice == null || sellPrice <= 0) continue;
        const pNow = isYes ? bucket.p_model : (1 - bucket.p_model);
        const contracts = Math.abs(p.qty);
        if (contracts <= 0) continue;
        // Avg entry = total exposure (dollars at risk) / contracts.
        const avgEntry = p.exposure / contracts;
        if (avgEntry <= 0) continue;
        const sellProceeds = contracts * sellPrice;     // dollars (1 contract = $1 max payout)
        const holdEV = contracts * pNow;
        // Auto-close: trigger off the MARKET'S implied probability our side wins,
        // not our own bid. Market-maker spread + Kalshi fee structure means a
        // genuinely near-certain market can sit with our bid at 96-97¢ while the
        // opposing side's ASK sits at 1-3¢. Reading "market thinks we win" from
        // (1 - opposing_ask) catches the auto-close trigger that "our bid ≥ 0.99"
        // missed. Execute at whatever bid is currently offered — small spread
        // give-up is worth the capital recycling. Sanity: only fire if our bid
        // is non-zero (we need SOMETHING to fill against).
        const opposingAsk = isYes ? bucket.no_ask : bucket.yes_ask;
        const marketImpliedOurSide = (opposingAsk != null) ? (1 - opposingAsk) : null;
        const autoClose = marketImpliedOurSide != null
                       && marketImpliedOurSide >= AUTO_CLOSE_AT_PRICE
                       && sellPrice > 0;
        // Forward-looking sell criterion. The original entry price is sunk cost
        // and must NOT enter this decision — anchoring on it caused the bot to keep
        // YES positions even after the model flipped to favor NO on the same market
        // (2026-05-05 user report). Sell when current market bid exceeds the model's
        // expected payout by enough to cover round-trip fees (10% hysteresis).
        if (!autoClose && holdEV >= sellProceeds * (1 - SELL_HYSTERESIS)) continue;
        // SELL. In dry-run, fake the order response.
        // On auto-close, post a limit at ≥ AUTO_CLOSE_MIN_SELL instead of crossing to
        // our (possibly low) bid — see AUTO_CLOSE_MIN_SELL. ev-flip exits still cross
        // the bid because the goal there is to exit now, not to hold for settlement.
        const effSellPrice = autoClose ? Math.max(sellPrice, AUTO_CLOSE_MIN_SELL) : sellPrice;
        const sellPriceCents = Math.max(1, Math.round(effSellPrice * 100));
        const res = isDryRun ? { ok: true, body: { dryRun: true } }
                             : await placeSellOrder(ticker, isYes ? "YES" : "NO", contracts, sellPriceCents);
        sales.push({ ticker, side: isYes ? "YES" : "NO", count: contracts, sellPriceCents,
                     reason: autoClose ? "auto-close" : "ev-flip",
                     marketImplied: marketImpliedOurSide != null ? Math.round(marketImpliedOurSide * 100) / 100 : null,
                     pNow: Number.isFinite(pNow) ? Math.round(pNow * 1000) / 1000 : null,
                     avgEntry: Math.round(avgEntry * 100) / 100,
                     dryRun: isDryRun, ok: res.ok });
        if (!res.ok) errors.push({ where: "sell", ticker, response: res.body });
        else if (!isDryRun) {
          cooldownMap[botKey(ticker, isYes ? "YES" : "NO")] = new Date().toISOString();
          // ALSO lock the (city, variable) so the buy loop later in this same run can't
          // re-enter the same event on a different strike/side. A sell driven by a model
          // flip is exactly when the model is most untrustworthy on this event — sit out
          // until the cooldown expires or new info arrives. Catches the SATX 2026-05-07
          // pattern where YES on B62.5 was sold mid-run, then NO on B60.5 was bought
          // immediately after on the same SATX-low event.
          // EXCEPTION: an auto-close is a profit-take-and-recycle (near-certain winner
          // sold at ~99¢), NOT a model flip — the model is not untrustworthy here. Locking
          // the city/variable would starve exactly the capital redeployment the 99¢
          // auto-close exists for, so skip the cv-lock on auto-close. (The ticker+side
          // cooldown above still applies, which is harmless — we wouldn't rebuy a ~99¢
          // bucket anyway.)
          if (!autoClose && citySide?.name && soldVariable) {
            cooldownMap[cityVarKey(citySide.name, soldVariable)] = new Date().toISOString();
          }
        }
      }
    }

    // 2b. Tail-obs-pyramid (2026-05-19). Mirror of AUTO_CLOSE_AT_PRICE: when a
    // position is post-extremum AND obs is past the bucket boundary in our favor
    // AND market still offers our side cheap, ADD contracts. Captures slow-market
    // mispricing on near-certain outcomes. See PYRAMID_* constants header for
    // trigger conditions and sizing. Bypasses cooldowns and already-held checks
    // (those guard against loss pyramids, not winning obs-arbs).
    const pyramids = [];
    let pyramidCommitted = 0;
    const cycleSellKeys = new Set();
    for (const s of sales) cycleSellKeys.add(botKey(s.ticker, s.side));
    if (!isPaper && kalshiData?.cities) {   // pyramid adds disabled in paper (buys-only)
      for (const p of positions) {
        if (p.qty === 0) continue;
        if (cashDollars - committed - pyramidCommitted < STAKE_FLOOR) break;
        const ticker = p.ticker;
        const side = p.qty > 0 ? "YES" : "NO";
        // Bot-placed only (orphan-heal would have written a ledger entry already).
        if (!botPlacedKeys.has(botKey(ticker, side))) continue;
        // Don't pyramid what we just sold this cycle — Kalshi eventual-consistency
        // could re-open the same flip the sell loop was trying to close.
        if (cycleSellKeys.has(botKey(ticker, side))) continue;
        // Concentration-cap: don't pyramid into a position that's been trimmed for
        // over-concentration ("not repurchased" — flag clears at settlement).
        if (liveLedger.some(e => e.ticker === ticker && e.side === side && e.concentration_capped)) continue;
        // Per-position pyramid-add cap (2026-05-29). Prior adds are persisted as
        // pyramidAdd ledger entries; count them and stop once we've added
        // PYRAMID_MAX_ADDS times to this (ticker, side). Prevents the unbounded
        // same-ticker stacking that produced the 2026-05-28 Chicago loss pile.
        const priorPyramidAdds = liveLedger.filter(
          e => e.ticker === ticker && e.side === side && e.pyramidAdd).length;
        if (priorPyramidAdds >= PYRAMID_MAX_ADDS) continue;

        // Find the bucket in kalshi snapshot for current ask + numeric bounds.
        let bucket = null, citySide = null, variable = null;
        for (const c of kalshiData.cities) {
          for (const [v, buckets] of [["high", c.highBuckets], ["low", c.lowBuckets]]) {
            if (!buckets) continue;
            const found = buckets.find(b => b.ticker === ticker);
            if (found) { bucket = found; citySide = c; variable = v; break; }
          }
          if (bucket) break;
        }
        if (!bucket || !citySide) continue;

        const cityWeather = (weatherData.cities || []).find(c => c.name === citySide.name);
        if (!cityWeather) continue;

        // Post-extremum only — pre-peak/trough the model is the better anchor.
        const hrs = variable === "high" ? cityWeather.hrsToPeak : cityWeather.hrsToTrough;
        if (hrs == null || hrs > 0.5) continue;

        // Obs-anchored posterior P(win) via σ_cooling. Handles T-tail buckets
        // (via tailBucketPosteriorP) and B-buckets (inline below). For B-buckets,
        // P(YES) = Φ((hi+0.5 − obs)/σ) − Φ((lo−0.5 − obs)/σ), and the relevant
        // margin = obs − nearer-bucket-edge in the NO-winning direction.
        const lo = bucket.loInt, hi = bucket.hiInt;
        const obs = variable === "high" ? cliMaxObs(cityWeather) : cliMinObs(cityWeather);
        if (obs == null) continue;
        let pWinObs, marginF, kind;
        if (Number.isFinite(lo) && Number.isFinite(hi)) {
          // B-bucket [lo, hi]
          const pYes = normCdf01((hi + 0.5 - obs) / SIGMA_COOLING_F)
                     - normCdf01((lo - 0.5 - obs) / SIGMA_COOLING_F);
          pWinObs = side === "YES" ? pYes : (1 - pYes);
          // NO-winning direction: obs above hi+0.5 OR below lo-0.5 (whichever it's near).
          // YES-winning direction: obs near the bucket center.
          if (side === "NO") {
            marginF = Math.max(obs - (hi + 0.5), (lo - 0.5) - obs);
          } else {
            // YES: margin = how far obs is from the nearer outside edge — we want
            // obs comfortably INSIDE the bucket. Negative if outside.
            marginF = Math.min(obs - (lo - 0.5), (hi + 0.5) - obs);
          }
          kind = "b-bucket";
        } else {
          const postP = tailBucketPosteriorP(
            { ...bucket, variable, side: side.toLowerCase() },
            cityWeather, SIGMA_COOLING_F);
          if (!postP) continue;
          pWinObs = postP.pWin;
          if (postP.kind === "cold-tail-high")      marginF = postP.boundary - postP.obs;
          else if (postP.kind === "hot-tail-high")  marginF = postP.obs - postP.boundary;
          else if (postP.kind === "cold-tail-low")  marginF = postP.boundary - postP.obs;
          else if (postP.kind === "hot-tail-low")   marginF = postP.obs - postP.boundary;
          else continue;
          if (side === "NO") marginF = -marginF;
          kind = postP.kind;
        }
        if (pWinObs < PYRAMID_PWIN_MIN) continue;
        if (marginF < PYRAMID_MARGIN_F) continue;

        // Our-side ask (cost to buy more). yes_ask for YES side, no_ask for NO.
        const ourAsk = side === "YES" ? bucket.yes_ask : bucket.no_ask;
        if (ourAsk == null || ourAsk <= 0.01 || ourAsk > PYRAMID_MAX_PRICE) continue;

        const budget = Math.min(PYRAMID_MAX_DOLLARS, cashDollars - committed - pyramidCommitted);
        if (budget < STAKE_FLOOR) continue;
        const contractsToAdd = Math.min(PYRAMID_MAX_CONTRACTS, Math.floor(budget / ourAsk));
        if (contractsToAdd < 1) continue;

        const askCents = Math.max(1, Math.min(99, Math.round(ourAsk * 100)));
        const res = isDryRun
          ? { ok: true, body: { dryRun: true, order: { client_order_id: `dryrun-pyramid-${Date.now()}` } } }
          : await placeBuyOrder(ticker, side, contractsToAdd, askCents);

        pyramids.push({
          ticker, side, count: contractsToAdd, priceCents: askCents,
          city: citySide.name, variable, kind,
          pWinPosterior: Math.round(pWinObs * 1000) / 1000,
          marginF: Math.round(marginF * 100) / 100,
          hrsToExtremum: hrs,
          stake_dollars: Math.round(contractsToAdd * ourAsk * 100) / 100,
          ok: res.ok, dryRun: isDryRun,
        });

        if (res.ok) {
          pyramidCommitted += contractsToAdd * ourAsk;
          if (!isDryRun) {
            const betId = res.body?.order?.client_order_id
                       || `${ticker}-${side}-pyramid-${Date.now()}`;
            await ledgerStore.setJSON(`${betId}.json`, {
              betId, ticker, side, contracts: contractsToAdd,
              price: ourAsk, stake_dollars: contractsToAdd * ourAsk,
              city: citySide.name, variable, bucket: bucket.label || null,
              placedAtUTC: new Date().toISOString(),
              kalshiOrderId: res.body?.order?.order_id || null,
              pyramidAdd: true,
            }).catch(err => errors.push({ where: "pyramid-ledger-write", err: String(err) }));
          }
        } else {
          errors.push({ where: "pyramid-buy", ticker, response: res.body });
        }
      }
      // Roll pyramidCommitted into committed so the buy loop sees the correct
      // remaining cash floor.
      committed += pyramidCommitted;
    }

    // 3. Place new bets.
    // Enter the loop even when spareCapacity === 0 so qualifying candidates get
    // an explicit "out-of-cash" skip entry (line 962). Without this, the buy
    // loop is bypassed silently and the dashboard's per-bet decision lookup
    // finds nothing, leaving every candidate stuck on "pending next cycle".
    if (kalshiData?.topBets) {
      const fr = kalshiData.freshness || {};
      const cityForecastAge = {};
      // cityInputAges feeds Bayesian work-order #6b: settled bets carry input ages
      // at bet time, so σ_age_i(age_i) per-source curves are fittable from the
      // existing settled-bet stream once ~80-150 bets accumulate. See
      // project_weatherbot_bayesian_workorder.md for the resume sequence.
      const cityInputAges = {};
      // σ_revision α (from logger.js auto-fit if present, seed otherwise). All
      // cities share the same fit object — read once from first city that has it.
      let alphasFromWeather = null;
      for (const c of (weatherData.cities || [])) {
        // Prefer server-computed dataAgeMin (weather.js): reflects the freshest of
        // ensemble + METAR + NWS grid, not just NWS's grid issue time. NWS grid often
        // sits 4-6h old for west-coast/quiet-regime cities while our ensemble + obs
        // are minutes old; gating on raw forecastUpdateTime over-skipped those.
        // Bug fix 2026-05-14 PM: dataAgeMin lives at c.inputAges.dataAgeMin (kalshi.js
        // nests it under inputAges, not top-level). Pre-fix lookup `c.dataAgeMin` was
        // always undefined, causing fall-through to the NWS-grid-only path — exactly
        // the failure mode the author's comment above warned against. Result: 7 of 12
        // candidates per cycle were being killed by forecast-stale on cities (Seattle,
        // LA, NY, DFW, etc.) where our ensemble + METAR data was minutes old.
        const composite = c.inputAges?.dataAgeMin ?? c.dataAgeMin;  // tolerate either path
        if (composite != null) cityForecastAge[c.name] = composite;
        else if (c.forecastUpdateTime) cityForecastAge[c.name] = (Date.now() - new Date(c.forecastUpdateTime).getTime()) / 60000;
        cityInputAges[c.name] = {
          nwsGridAgeMin: c.forecastUpdateTime
            ? Math.round((Date.now() - new Date(c.forecastUpdateTime).getTime()) / 60000) : null,
          metarAgeMin: c.lastMetarAgeMin ?? null,
          dataAgeMin: c.dataAgeMin ?? null,
          ensembleSourceCount: Array.isArray(c.ensembleSources) ? c.ensembleSources.length : null,
          oneMinAsosAgeMin: c.oneMinAsos?.ageMin ?? null,
          iemAgeMin: c.iemAgeMin ?? null,
          // currentTempSource feeds the 778326d forward-monitor: stratify settled-bet
          // residuals by whether currentTemp came from METAR or 1-min ASOS to validate
          // the "use 1-min when fresher" change without minute-resolution backtest data.
          currentTempSource: c.currentTempSource ?? null,
          currentTempAgeMin: c.currentTempAgeMin ?? null,
        };
        if (!alphasFromWeather && c.sigmaRevisionAlphas) {
          alphasFromWeather = c.sigmaRevisionAlphas;
        }
      }
      // Threshold gate: high-conviction floor on net edge AND halfKelly. Sorted by
      // halfKelly desc upstream, so iterating fills highest-conviction first.
      // Skip-reason log so we can see exactly how high vs low were weighed each run.
      // Listed in priority order matching the iteration below.
      const briefBet = b => ({ city: b.city, variable: b.variable || "high", bucket: b.bucket,
                               ticker: b.ticker, side: b.side,
                               ev: Math.round(b.ev*1000)/1000,
                               halfKelly: Math.round(b.halfKelly*1000)/1000,
                               pWin: b.p_model != null ? Math.round(b.p_model*1000)/1000 : null,
                               price: b.price });
      // Calibration-health pause: drop candidates on any side we can't certify as
      // calibrated, and surface exactly why in the skip log (so a dead loop is
      // visible immediately, not diagnosed weeks later from realized PnL).
      for (const v of ["high", "low"]) { const h = calHealthFor(v); if (!h.ok) calBlocked[v] = h.reason; }
      for (const b of (kalshiData.topBets || [])) {
        const h = calHealthFor(b.variable || "high");
        if (!h.ok) skipped.push({ ...briefBet(b), reason: h.reason });
      }
      // Liquidity gate: prefer 24h volume (the intended "traded recently" filter) but
      // fall back to lifetime volume when kalshi.js couldn't source a 24h figure — so a
      // missing field can never zero out the gate and halt trading. For the daily temp
      // markets (created fresh each morning) lifetime ≈ today's volume anyway; the 24h
      // figure only tightens genuinely multi-day/stale markets.
      const liq = (b) => (b.volume24h ?? b.volume);
      const qualifying = (kalshiData.topBets || []).filter(b =>
        b.ev >= minEdgeFor(b) && b.halfKelly >= MIN_HALF_KELLY && b.price >= MIN_PRICE
        && (liq(b) == null || liq(b) >= MIN_VOLUME)
        && calHealthFor(b.variable || "high").ok);
      let placed = 0;
      // `committed` is declared outside the buy loop (see line ~736) so the
      // pyramid loop (2b) can share the cash-budget accounting.
      // Track committed bets per event-ticker for tile-coverage checks across the run.
      const committedByEvent = {};
      // (city, variable) pairs that received a NEW buy this run. Cooldown set at the
      // END of the buy loop so multiple complementary bets in the same event are still
      // allowed within one run. Sells set the cooldown immediately (during sell loop)
      // because a sell-driven re-entry is the high-risk case we want to block.
      const boughtCityVarKeys = new Set();
      // Index every kalshi.js bucket by its bucket code (e.g. "T52" → {loInt:53,hiInt:null}),
      // grouped by event ticker. Used by the seed loop below to recover numeric bounds for
      // already-held positions whose botKey only carries the ticker code, not bucket bounds.
      // Without this, betWinsAt() falls back to bucketToRange() which can't disambiguate
      // T-less from T-greater buckets.
      const boundsByEvent = {};
      for (const c of (kalshiData?.cities || [])) {
        for (const variant of [["highEvent", "highBuckets"], ["lowEvent", "lowBuckets"]]) {
          const ev = c[variant[0]];
          const buckets = c[variant[1]];
          if (!ev || ev === "not found" || !Array.isArray(buckets)) continue;
          const idx = boundsByEvent[ev] ??= {};
          for (const bk of buckets) {
            const code = (bk.ticker || "").split("-").pop();
            if (code) idx[code] = { loInt: bk.loInt, hiInt: bk.hiInt };
          }
        }
      }
      // Seed from already-held positions so we don't add a tile-conflicting bet on top
      // of a position we already own from a prior run. botKey format is
      // "<eventTicker>-<bucketCode>-<SIDE>" where SIDE is "YES" or "NO" (suffix).
      // 2026-05-04 bug fix: previous version split on ":" but botKey uses "-".
      for (const heldKey_ of heldKey) {
        const m = heldKey_.match(/^(.+)-(YES|NO)$/);
        if (!m) continue;
        const held_full = m[1];     // e.g. "KXLOWTCHI-26MAY04-B48.5"
        const held_side = m[2];     // "YES" or "NO"
        const lastDash = held_full.lastIndexOf("-");
        if (lastDash < 0) continue;
        const ev = held_full.slice(0, lastDash);
        const bucketCode = held_full.slice(lastDash + 1);
        const bounds = boundsByEvent[ev]?.[bucketCode] || {};
        (committedByEvent[ev] ??= []).push({
          ticker: bucketCode, side: held_side.toLowerCase(),
          loInt: bounds.loInt, hiInt: bounds.hiInt,
          modelMean: NaN, modelStd: 1.0
        });
      }
      for (const b of qualifying) {
        // 20-bet cap removed 2026-05-13 — cash budget is the real constraint.
        if (cashDollars - committed < STAKE_FLOOR) { skipped.push({ ...briefBet(b), reason: "out-of-cash" }); continue; }
        if (b.variable === "low" && LOW_HARD_OFF) {
          skipped.push({ ...briefBet(b), reason: "low-hard-off-pending-backtest" });
          continue;
        }
        if (b.variable === "low" && LOW_PAUSED_CITIES.has(b.city)) {
          skipped.push({ ...briefBet(b), reason: "low-city-paused" });
          continue;
        }
        if (b.variable === "high" && HIGH_PAUSED_CITIES.has(b.city)) {
          skipped.push({ ...briefBet(b), reason: "high-city-paused" });
          continue;
        }
        const ageMin = cityForecastAge[b.city];
        if (ageMin != null && ageMin > PER_CITY_FRESHNESS_MAX_MIN) { skipped.push({ ...briefBet(b), reason: "forecast-stale", ageMin: Math.round(ageMin) }); continue; }
        // pWin cap (Bayesian humility, 2026-05-15): pWin > P_WIN_CAP is almost
        // always a model artifact — agreeing-but-stale ensemble runs collapse
        // σ_post to ~0, driving pWin to ~1.0 on a forecast that's structurally
        // due for revision. Empirical anchor: Chicago LOW T51 NO 2026-05-15 with
        // pWin=1.000 lost when actual landed +7°F warmer than the model μ. No
        // future temperature deserves >95% confidence at our σ_resolution scale.
        if (b.pWin != null && b.pWin > P_WIN_CAP) {
          skipped.push({ ...briefBet(b), reason: "pwin-cap-exceeded",
                         pWin: b.pWin, cap: P_WIN_CAP });
          continue;
        }
        // Resolve event ticker → full market ticker like KXHIGHNY-26MAY02-B65.5.
        const cityKalshi = (kalshiData.cities || []).find(c => c.name === b.city);
        if (!cityKalshi) { skipped.push({ ...briefBet(b), reason: "city-not-in-kalshi-data" }); continue; }
        const eventTicker = b.variable === "low" ? cityKalshi.lowEvent : cityKalshi.highEvent;
        if (!eventTicker || eventTicker === "not found") { skipped.push({ ...briefBet(b), reason: "event-not-listed-on-kalshi" }); continue; }
        const fullTicker = `${eventTicker}-${b.ticker}`;
        const dedupKey = botKey(fullTicker, b.side);
        if (heldKey.has(dedupKey)) { skipped.push({ ...briefBet(b), reason: "already-held" }); continue; }
        if (cooldownMap[dedupKey]) { skipped.push({ ...briefBet(b), reason: "in-cooldown" }); continue; }
        // Concentration-cap: don't re-buy a position that was trimmed for over-concentration.
        if (liveLedger.some(e => e.ticker === fullTicker && e.side === b.side && e.concentration_capped)) {
          skipped.push({ ...briefBet(b), reason: "concentration-capped" }); continue;
        }
        // Time gate (HIGH only): trade only in the validated NEAR-PEAK window.
        // Two-sided:
        //  - LATE cut (localHour >= 14, hp<=1): backtested -3.5% ROI vs +10.9% at noon
        //    (585-event sample) — by 2pm the market's posterior has converged (Brier
        //    0.072) and beats our overconfident-σ posterior at any σ. Abstain late
        //    instead of recalibrating σ (σ-tighten path refuted: +9.0% -> +4.0%).
        //  - EARLY cut (localHour < 11, hp>~4): 2026-06-02 — far-pre-peak bets are OFF
        //    the validated cell. The intraday-β correction decays toward morning
        //    (β 0.73 near peak -> 0.10 at hp8), so morning μ is inaccurate and σ_climb
        //    is wide; the pooled global calibration scale (~2.78) over-widens these into
        //    spurious 90%+ NO edges that lost live (project_weatherbot_backtest_vs_live_gap:
        //    49% backtest vs 18% live). backtest_tpred validates the NOON cell (hp~3-4,
        //    σ_eff~2.0) at +9-11% ROI — confine live to it. Window = localHour [11,14).
        //    Follow-up: hour-conditional calibration to re-admit far hours with honest σ.
        if ((b.variable || "high") === "high") {
          const _tz = CITY_TZ_FOR_PEAK.get(b.city);
          if (_tz) {
            const _h = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: _tz, hour: "numeric", hour12: false }).format(new Date()), 10) % 24;
            if (_h >= 14) { skipped.push({ ...briefBet(b), reason: "post-peak-window", localHour: _h, tz: _tz }); continue; }
            if (_h < HIGH_NEAR_PEAK_LOCAL_MIN) { skipped.push({ ...briefBet(b), reason: "pre-peak-window", localHour: _h, tz: _tz }); continue; }
          }
        }
        // Same-event-same-side stack cap: see heldEventSide construction above.
        const eventSideKey = `${eventTicker}:${b.side?.toLowerCase()}`;
        if (heldEventSide.has(eventSideKey)) {
          skipped.push({ ...briefBet(b), reason: "event-side-stack-cap", eventTicker, side: b.side });
          continue;
        }
        // City+variable buy-cooldown: blocks any further buys on the same (city, variable)
        // pair within BUY_CITYVAR_COOLDOWN_MIN of the last successful buy. Independent of
        // ticker/side, so it catches model-thrash patterns that would otherwise slip past
        // dedup (different strike) and tileConflict (state-store lag on prior position).
        const cvLockKey = cityVarKey(b.city, b.variable);
        if (cooldownMap[cvLockKey]) {
          skipped.push({ ...briefBet(b), reason: "city-var-cooldown",
                         lockedSince: cooldownMap[cvLockKey], lockKey: cvLockKey });
          continue;
        }
        // Tile-coverage check: skip if buying this on top of already-committed bets in the
        // same event would create a dual-loss zone inside ±1.5σ of model mean.
        const tile = tileConflict(b, committedByEvent[eventTicker]);
        if (!tile.ok) { skipped.push({ ...briefBet(b), reason: "tile-conflict", detail: tile.reason }); continue; }
        // Bucket-rounding-boundary margin: rejects B-bucket bets where the already-observed
        // extremum sits in a structurally dangerous region of the bucket. NO side requires
        // ≥0.6°F margin (METAR/CLI rounding upsets); YES side requires ≥1.5°F margin (frontal
        // drops past minSoFar — SATX 2026-05-07 lost B62.5 YES at minSoFar=62.6 when a cold
        // front pushed the low to 60.8°F).
        const cityWeather = (weatherData.cities || []).find(c => c.name === b.city);
        // LOW screening heuristics (lib/low_screen.js). Runs BEFORE the calibrated
        // margin/obs gates so undercut-live advisories are recorded even for bets
        // those gates go on to skip — that join is the evidence base for ever
        // relaxing them. Shadow mode records and never acts.
        const screenMode = b.variable === "low" ? LOW_SCREEN_MODE
                         : b.variable === "high" ? HIGH_SCREEN_MODE : "off";
        if (screenMode !== "off" && cityWeather?.surfaceObs) {
          const ls = b.variable === "low"
            ? lowScreenCheck(b, cityWeather, cliMinObs(cityWeather))
            : highScreenCheck(b, cityWeather, cliMaxObs(cityWeather));
          if (ls.skips.length || ls.advisories.length) {
            lowScreen.push({ ticker: b.ticker, city: b.city, side: b.side, variable: b.variable,
                             mode: screenMode, skips: ls.skips, advisories: ls.advisories });
          }
          if (screenMode === "enforce" && ls.skips.length) {
            skipped.push({ ...briefBet(b), reason: ls.skips[0].reason, lowScreenDetail: ls.skips[0] });
            continue;
          }
        }
        const margin = bucketBoundaryMargin(b, cityWeather);
        const marginThreshold = b.side?.toLowerCase() === "yes" ? BUCKET_YES_MARGIN_MIN_F : BUCKET_MARGIN_MIN_F;
        // Debug instrumentation: tag every B-bucket decision (YES or NO) with the margin
        // computation so we can see post-hoc whether the filter saw the right inputs.
        const marginDebug = b.ticker?.startsWith("B") ? {
          ticker: b.ticker, variable: b.variable, side: b.side,
          minSoFar: cityWeather?.minSoFar, maxSoFar: cityWeather?.maxSoFar,
          cityName: b.city, weatherCityFound: !!cityWeather,
          computedMargin: margin, threshold: marginThreshold
        } : null;
        if (margin != null && margin < marginThreshold) {
          skipped.push({ ...briefBet(b), reason: "bucket-margin-thin", marginF: margin.toFixed(2), thresholdF: marginThreshold, marginDebug });
          continue;
        }
        if (marginDebug) {
          // Attach debug to placement record so we can trace why the filter passed.
          b._marginDebug = marginDebug;
        }
        // Sigma-aware bucket-margin gate. SYMMETRIC across YES and NO (2026-05-26:
        // reverted the 2026-05-21 YES-only carve-out — history below). Skips B-bucket
        // bets where the model's μ sits closer than `sigmaBucketMarginZ` to either
        // bucket edge: μ that close to a boundary makes the outcome a posterior
        // coin-flip, and the apparent edge is an artifact of the wide unconditional
        // σ_eff used in the bucket-prob calc.
        //
        // Why NO is back in (2026-05-26): the 2026-05-21 carve-out assumed a NO bet
        // wins "anywhere else," so any one 1°F window is a uniform ~10-12% regardless
        // of which — i.e. μ-uncertainty shouldn't lower NO's win prob. That is FALSE
        // on accurate-forecast days: windows are NOT uniform; the modal window on μ
        // carries most of the mass, and conditional on a good forecast (MAE ~0.85°F)
        // the high reliably lands there — exactly the window a near-μ NO bet bets
        // against. The n=16 "B-bucket NO 56% / +$1.77" sample was noise. Full ledger
        // (n=124) shows B-bucket NO at 31% win / −$198, and re-applying this gate to
        // NO nets +$115 @ Z=0.5 / +$86 @ Z=0.3 (2026-05-26 sweep on the live jackson
        // ledger). 2026-05-25's four losses (PHX/BOS/LAX/DEN, all NO/high) had
        // σ-margin 0.07–0.14z and were placed only because of the YES-only gap.
        //
        // T-tail bets still bypass (boundary semantics differ; tail-posterior gate
        // already handles them).
        if (b.ticker?.startsWith("B")
            && Number.isFinite(b.loInt) && Number.isFinite(b.hiInt)
            && b.modelMean != null && b.modelStd != null) {
          const sigmaEff = Math.sqrt(b.modelStd ** 2 + SIGMA_IRREDUCIBLE_F ** 2);
          const contLo = b.loInt - 0.5;
          const contHi = b.hiInt + 0.5;
          const sigmaMargin = Math.min(
            Math.abs(b.modelMean - contLo) / sigmaEff,
            Math.abs(b.modelMean - contHi) / sigmaEff
          );
          if (sigmaMargin < sigmaBucketMarginZ) {
            skipped.push({ ...briefBet(b), reason: "sigma-margin-thin",
                           sigmaMargin: Math.round(sigmaMargin * 1000) / 1000,
                           thresholdZ: sigmaBucketMarginZ,
                           sigmaEff: Math.round(sigmaEff * 100) / 100 });
            continue;
          }
        }
        // Posterior tail gate (Bayes work order #2): replaces the old tail-obs-floor +
        // tail-obs-ceiling thresholds with a single π. Skip if P(win | obs, σ_cooling) < π.
        // Backtest A/B at σ_cooling=0.7, π=0.10: +$31 net vs +$28 for the °F-threshold gate.
        const postP = tailBucketPosteriorP(b, cityWeather, SIGMA_COOLING_F);
        if (postP && postP.pWin < PI_TAIL_SKIP) {
          skipped.push({ ...briefBet(b), reason: "tail-posterior-skip",
                         pWinPosterior: postP.pWin.toFixed(3),
                         pi: PI_TAIL_SKIP, sigmaCooling: SIGMA_COOLING_F,
                         tailDebug: { ...postP, ticker: b.ticker, cityName: b.city } });
          continue;
        }
        // σ_climb gate (2026-05-19): pre-peak, modelStd systematically understates
        // final-extremum uncertainty (n=406 snapshots: σ_pre 1.65 vs σ_post 0.75).
        // Inflate σ in quadrature, recompute pWin/EV/halfKelly, skip if below trader
        // minimums. Calibrated to catch the Houston T87 YES 2026-05-19 cluster.
        const hrsToExtremum = b.variable === "high" ? cityWeather?.hrsToPeak
                            : b.variable === "low"  ? cityWeather?.hrsToTrough : null;
        const sigmaClimb = sigmaClimbF(hrsToExtremum);
        if (sigmaClimb > 0 && b.modelStd != null && b.modelMean != null
            && (Number.isFinite(b.loInt) || Number.isFinite(b.hiInt))) {
          const sigmaEffClimb = Math.sqrt(b.modelStd ** 2 + sigmaClimb ** 2);
          const muClimb = muClimbF(hrsToExtremum, b.variable);
          const muShifted = b.modelMean + muClimb;
          let pYesClimb;
          if (b.loInt === -Infinity || b.loInt == null) {
            // Cold tail (high ≤ N or low ≤ N): P(YES) = Φ((hi+0.5 − μ)/σ)
            pYesClimb = normCdf01((b.hiInt + 0.5 - muShifted) / sigmaEffClimb);
          } else if (b.hiInt === Infinity || b.hiInt == null) {
            // Hot tail (high ≥ N or low ≥ N): P(YES) = 1 − Φ((lo−0.5 − μ)/σ)
            pYesClimb = 1 - normCdf01((b.loInt - 0.5 - muShifted) / sigmaEffClimb);
          } else {
            // B-bucket [lo, hi]: continuity-corrected window.
            pYesClimb = normCdf01((b.hiInt + 0.5 - muShifted) / sigmaEffClimb)
                      - normCdf01((b.loInt - 0.5 - muShifted) / sigmaEffClimb);
          }
          const pWinClimb = b.side?.toLowerCase() === "yes" ? pYesClimb : (1 - pYesClimb);
          const feeClimb = entryFee(b.price);
          const evClimb = (pWinClimb - b.price) - feeClimb;
          const halfKellyClimb = b.price < 1
            ? Math.max(0, (pWinClimb - b.price) / (1 - b.price)) / 2 : 0;
          if (evClimb < minEdgeFor(b) || halfKellyClimb < MIN_HALF_KELLY) {
            skipped.push({ ...briefBet(b), reason: "sigma-climb-thin",
                           sigmaClimb: sigmaClimb.toFixed(2),
                           muClimb: muClimb.toFixed(2),
                           sigmaEffClimb: sigmaEffClimb.toFixed(2),
                           muShifted: Math.round(muShifted * 100) / 100,
                           pWinClimb: Math.round(pWinClimb * 1000) / 1000,
                           evClimb: Math.round(evClimb * 1000) / 1000,
                           halfKellyClimb: Math.round(halfKellyClimb * 1000) / 1000,
                           hrsToExtremum: Math.round(hrsToExtremum * 100) / 100 });
            continue;
          }
        }
        // Kelly-LCB gate (Bayes work order #5): re-check EV/halfKelly using the lower
        // confidence bound on pWin. Catches "model very confident at the strike" cases
        // where σ is small and a tiny shift in μ flips the bet — exactly the SATX
        // 2026-05-06 T68 NO failure pattern. Calibrated z_α=0.5 against the 49-bet
        // sample (+$112 net in backtest_gates.js Kelly-LCB A/B).
        const lcb = kellyLcbAdjust(b, cityInputAges[b.city], alphasFromWeather);
        if (lcb) {
          const fee = entryFee(b.price);
          const evLCB = (lcb.pLCB - b.price) - fee;
          const halfKellyLCB = b.price < 1 ? Math.max(0, (lcb.pLCB - b.price) / (1 - b.price)) / 2 : 0;
          if (evLCB < minEdgeFor(b) || halfKellyLCB < MIN_HALF_KELLY) {
            skipped.push({ ...briefBet(b), reason: "kelly-lcb-shrink",
                           pHat: lcb.pHat.toFixed(3), pLCB: lcb.pLCB.toFixed(3),
                           sigmaP: lcb.sigmaP.toFixed(3),
                           evLCB: evLCB.toFixed(3),
                           halfKellyLCB: halfKellyLCB.toFixed(3) });
            continue;
          }
        }
        // LOW NO-near-strike gate (2026-05-11): for T-tail LOW NO bets, require model μ
        // safely below the boundary. Catches the "μ within 1°F of strike, σ wide, NO loses
        // when actual comes in slightly above strike" pattern that ran 8/10 losses across
        // PHX/SATX/HOU/DFW. Backtest A/B at thr=1.0°F: 6 TP / 1 FP, +$36.52 net.
        const noMargin = noStrikeMargin(b);
        if (noMargin != null && noMargin < NO_STRIKE_MARGIN_MIN_F) {
          skipped.push({ ...briefBet(b), reason: "no-strike-margin-thin",
                         marginF: noMargin.toFixed(2),
                         thresholdF: NO_STRIKE_MARGIN_MIN_F,
                         strikeDebug: { ticker: b.ticker, cityName: b.city,
                                        modelMean: b.modelMean, loInt: b.loInt } });
          continue;
        }
        // B-bucket "obs past bucket" gate: catches LOW YES on B-bucket where minSoFar is
        // already above the bucket's upper edge (or HIGH YES below maxSoFar). Existing
        // bucketBoundaryMargin defers to the model in this regime; the model's truncated
        // normal overweights diurnal-mode-passed cooling/warming. Stricter threshold than
        // the tail gate because B-buckets are width-bounded — the drop has to land in a
        // 1°F window, not just past a threshold.
        const bucketGap = bucketAboveObsGap(b, cityWeather);
        if (bucketGap && bucketGap.gapF > BUCKET_ABOVE_OBS_GAP_MAX_F) {
          skipped.push({ ...briefBet(b), reason: "bucket-above-obs",
                         gapF: bucketGap.gapF.toFixed(2),
                         thresholdF: BUCKET_ABOVE_OBS_GAP_MAX_F,
                         bucketDebug: { ...bucketGap, ticker: b.ticker, cityName: b.city,
                                        kind: bucketGap.kind } });
          continue;
        }
        // Synoptic coverage gate: when the settlement station's 1-min ASOS feed is
        // degraded, our maxSoFar/minSoFar can miss between-METAR spikes that still
        // affect CLI settlement. KNYC 2026-05-07 incident: station ran on hourly-only
        // Synoptic for hours; trader had no signal that its monitor was offline.
        // Coverage classes are produced by weather.js → computePrediction.
        //
        // 2026-05-21: pair with boost regime (paired with stakeBoosted flag). While
        // equity < STAKE_BOOST_EQUITY_THRESHOLD, treat 'none' coverage as 0.5 de-rate
        // (same as 'hourly-only') instead of hard-skip. Rationale: 'none' means the
        // Synoptic API responded but the station has no 1-min data right now —
        // monitoring is degraded but we're not flying blind on bad data. 'stalled'
        // (timestamps frozen, looks fresh but isn't) and undefined (pipeline failure)
        // remain hard-skip in all regimes because those are dangerous states, not
        // merely degraded ones. Auto-reverts to hard-skip on 'none' at equity ≥ $200.
        const cov = cityWeather?.synopticCoverage;
        let coverageDeRate = (cov === "1min" || cov === "5min") ? 1.0
                           : (cov === "hourly-only") ? 0.5
                           : 0.0;  // "stalled" / "none" / undefined → skip the bet
        if (coverageDeRate === 0.0 && stakeBoosted && cov === "none") {
          coverageDeRate = 0.5;
        }
        if (coverageDeRate === 0.0) {
          skipped.push({ ...briefBet(b), reason: "synoptic-coverage-degraded",
                         coverage: cov ?? "unknown" });
          continue;
        }
        // Conviction-weighted stake: halfKelly × bankroll, floored & capped, and
        // bounded by the cash actually still available after prior placements in this run.
        // Coverage de-rate scales the Kelly fraction (not the EV gate, not the price):
        // a 50% de-rate on hourly-only coverage means we bet half size, preserving the
        // edge but reducing variance from the unmonitored window. Soft-reopen de-rate
        // (see SOFT_REOPEN_DERATE) composes multiplicatively for cities mid-reopen.
        const softReopen = SOFT_REOPEN_DERATE.get(`${b.city}|${b.variable || "high"}`) ?? 1.0;
        const effectiveHalfKelly = b.halfKelly * coverageDeRate * softReopen;
        const remaining = cashDollars - committed;
        const stake_dollars = Math.max(STAKE_FLOOR,
          Math.min(stakeCeilDollars, effectiveHalfKelly * cashDollars, remaining,
                   CONCENTRATION_CAP * equityDollars));   // belt for concentration cap
        if (stake_dollars < STAKE_FLOOR) break;
        // Aggregate exposure cap: skip if adding this bet would push TOTAL open
        // exposure (already-held + this cycle's commits + new stake) over the cap.
        // Continue (not break) so subsequent smaller bets get a chance.
        if (currentExposureDollars + committed + stake_dollars > AGGREGATE_EXPOSURE_CAP * equityDollars) {
          skipped.push({ ...briefBet(b), reason: "aggregate-cap",
                         currentExposure: Math.round(currentExposureDollars * 100) / 100,
                         committed: Math.round(committed * 100) / 100,
                         capDollars: Math.round(AGGREGATE_EXPOSURE_CAP * equityDollars * 100) / 100 });
          continue;
        }
        // Variable-limit (maker) pricing — see VLIM_* config. LOW is armed (post a
        // liquidity-scaled limit BELOW the ask to capture spread); HIGH is held as taker
        // (crosses to the ask) until live data measures its adverse selection. b.price is
        // our-side ask; b.bid (from kalshi topBets) is our-side bid; b.p_model is win-prob
        // for this side. The would-be limit is computed for BOTH legs so the ledger can
        // later measure HIGH's AS — only the armed leg actually posts at it.
        const variable_ = b.variable || "high";
        const vlimArmed = (variable_ === "low") ? VLIM_ARM_LOW : VLIM_ARM_HIGH;
        const vlimPrice = (b.bid != null && b.bid > 0)
          ? variableLimitPrice(b.price, b.bid, b.p_model) : b.price;
        const orderPrice = vlimArmed ? vlimPrice : b.price;
        const contracts = Math.max(1, Math.floor(stake_dollars / orderPrice));
        const priceCents = Math.max(1, Math.min(99, Math.round(orderPrice * 100)));
        // Dry-run mode: skip Kalshi order submission, fake an "ok" response so the
        // placement is logged for instrumentation purposes.
        const res = noKalshi
          ? { ok: true, body: { order: { client_order_id: `${isPaper ? "paper" : "dryrun"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }, dryRun: !isPaper, paper: isPaper } }
          : await placeBuyOrder(fullTicker, b.side, contracts, priceCents);
        // Expected payout = contracts × $1 × p_winning (assuming win pays $1/contract).
        const pWin = b.p_model;  // p_model is set to pNo for NO side, p_yes for YES side
        const expectedPayout = contracts * (Number.isFinite(pWin) ? pWin : 0);
        placements.push({ ticker: fullTicker, side: b.side, count: contracts, priceCents,
                          city: b.city, variable: variable_,
                          bucket: b.bucket, bucketCode: b.ticker,
                          askPrice: b.price, bidPrice: (b.bid != null) ? b.bid : null,
                          vlimPrice: Math.round(vlimPrice * 1000) / 1000, vlimArmed,
                          stake_dollars: Math.round(stake_dollars * 100) / 100,
                          ev: b.ev, halfKelly: b.halfKelly,
                          softReopen: softReopen < 1.0 ? softReopen : null,
                          pWin: pWin != null ? Math.round(pWin * 1000) / 1000 : null,
                          expectedPayout: Math.round(expectedPayout * 100) / 100,
                          marginDebug: b._marginDebug,  // debug instrumentation
                          dryRun: isDryRun, paper: isPaper,
                          ok: res.ok });
        if (!res.ok) {
          errors.push({ where: "buy", ticker: fullTicker, response: res.body });
          skipped.push({ ...briefBet(b), reason: "kalshi-rejected", detail: res.body?.error?.code || res.body?.error?.message || "unknown" });
        } else {
          placed++;
          committed += stake_dollars;
          // Track for tile-coverage checks against subsequent candidates this run.
          // Use ticker code (e.g., "B48.5"), not human label. Carry numeric bounds so
          // betWinsAt() can resolve T-less vs T-greater without re-parsing the code.
          (committedByEvent[eventTicker] ??= []).push({
            ticker: b.ticker, side: b.side,
            loInt: b.loInt, hiInt: b.hiInt,
            modelMean: b.modelMean, modelStd: b.modelStd
          });
          // Mark the (city, variable) for end-of-run cv cooldown. We don't set it now
          // because intra-run we want to allow complementary bets in the same event
          // (e.g., NO on both B45 and B85 tails). The cv lock is a CROSS-RUN backstop;
          // sells set it immediately because a sell-driven flip is the dangerous case.
          if (!isDryRun || isPaper) boughtCityVarKeys.add(cvLockKey);
          // Track this placement in the intra-run heldEventSide set so a later
          // candidate in the same run with the same (event, side) gets the stack-cap
          // skip. The cross-run heldKey set already covers prior-run positions.
          heldEventSide.add(eventSideKey);
          // Save to bot ledger so future runs know we own this position. Skip in
          // pure dry-run (instrumentation only); paper DOES persist (it's a real
          // virtual position that must settle later).
          if (isDryRun && !isPaper) continue;
          const betId = res.body?.order?.client_order_id || `${fullTicker}-${b.side}-${Date.now()}`;
          await ledgerStore.setJSON(`${betId}.json`, {
            betId, ticker: fullTicker, side: b.side, contracts,
            price: orderPrice, stake_dollars,
            askPrice: b.price, bidPrice: (b.bid != null) ? b.bid : null,
            vlimPrice: Math.round(vlimPrice * 1000) / 1000, vlimArmed,
            city: b.city, variable: variable_,
            bucket: b.bucket, ev: b.ev, halfKelly: b.halfKelly,
            modelMean: b.modelMean, modelStd: b.modelStd,
            placedAtUTC: new Date().toISOString(),
            kalshiOrderId: res.body?.order?.order_id || null,
            // Bayesian #6b instrumentation — see cityInputAges block above.
            inputAgesAtBet: cityInputAges[b.city] || null,
          }).catch(err => errors.push({ where: "ledger-write", err: String(err) }));
        }
      }
      // End-of-buy-loop: stamp cv cooldown for every (city, variable) that received a
      // new buy this run. Blocks subsequent runs from re-entering the same event for
      // BUY_CITYVAR_COOLDOWN_MIN minutes regardless of whether the position is still
      // held, was sold, or settled.
      const cvStamp = new Date().toISOString();
      for (const k of boughtCityVarKeys) cooldownMap[k] = cvStamp;
    }
    // Persist updated cooldown map (sells written above; expired pruned at top).
    await cooldownStore.setJSON("map.json", cooldownMap)
      .catch(err => errors.push({ where: "cooldown-write", err: String(err) }));

    const ranAtUTC = new Date().toISOString();
    const stakeCeil = Math.round(stakeCeilDollars * 100) / 100;
    // Persist the paper bankroll (only settlements move it; placements just lock
    // cash via open stakes, which we recompute from the ledger next cycle).
    if (isPaper && paperState) {
      const newBankroll = Math.round((paperState.bankroll + paperRealizedDelta) * 100) / 100;
      await paperStateStore.setJSON("global", {
        ...paperState,
        bankroll: newBankroll,
        total_pnl: Math.round(((paperState.total_pnl || 0) + paperRealizedDelta) * 100) / 100,
        updated_at: ranAtUTC,
      }).catch(err => errors.push({ where: "paper-state-write", err: String(err) }));
    }
    const responseBody = {
      ok: true,
      mode: isPaper ? "paper" : (isDryRun ? "dryrun" : "live"),
      ranAtUTC,
      cashDollars: Math.round(cashDollars * 100) / 100,
      equityDollars: Math.round(equityDollars * 100) / 100,
      ...(isPaper ? { paper_bankroll: Math.round((paperState.bankroll + paperRealizedDelta) * 100) / 100,
                      paper_realized_delta: Math.round(paperRealizedDelta * 100) / 100 } : {}),
      stake_mode: stakeBoosted ? "boost" : "normal",
      sigma_margin_z: sigmaBucketMarginZ,
      botOpenCount, allOpenCount,
      spareCapacity,
      stake_floor: STAKE_FLOOR,
      stake_ceil_dollars: stakeCeil,
      cal_blocked: calBlocked, cal_age_min: calAgeMin,
      low_screen_mode: LOW_SCREEN_MODE, high_screen_mode: HIGH_SCREEN_MODE,
      sales, placements, pyramids, skipped, errors, lowScreen
    };

    // Write per-cycle structured log to trader_logs blob. Filename = ISO timestamp.
    // Tail (most recent ~200 entries) read via /api/trader_log.
    try {
      const logStore = getStore(isPaper ? "paper_trader_logs" : "trader_logs");
      await logStore.setJSON(`${ranAtUTC}.json`, {
        ranAtUTC, cashDollars,
        equityDollars: Math.round(equityDollars * 100) / 100,
        stake_mode: stakeBoosted ? "boost" : "normal",
        sigma_margin_z: sigmaBucketMarginZ,
        spareCapacity, stake_ceil: stakeCeil,
        cal_blocked: calBlocked, cal_age_min: calAgeMin,
        placements: placements.map(p => ({
          ticker: p.ticker, side: p.side, count: p.count, priceCents: p.priceCents,
          city: p.city, variable: p.variable, bucket: p.bucket, bucketCode: p.bucketCode,
          stake_dollars: p.stake_dollars, ev: p.ev, halfKelly: p.halfKelly,
          softReopen: p.softReopen,
          pWin: p.pWin, expectedPayout: p.expectedPayout, ok: p.ok
        })),
        sales: sales.map(s => ({ ticker: s.ticker, side: s.side, count: s.count,
                                   priceCents: s.sellPriceCents,
                                   reason: s.reason,
                                   marketImplied: s.marketImplied,
                                   pNow: s.pNow,
                                   avgEntry: s.avgEntry,
                                   ok: s.ok })),
        pyramids: pyramids.map(p => ({
          ticker: p.ticker, side: p.side, count: p.count, priceCents: p.priceCents,
          city: p.city, variable: p.variable,
          pWinPosterior: p.pWinPosterior, marginF: p.marginF,
          hrsToExtremum: p.hrsToExtremum,
          stake_dollars: p.stake_dollars, ok: p.ok
        })),
        skipped: skipped.slice(0, 30),  // cap to avoid huge blobs
        lowScreen: lowScreen.slice(0, 30),
        low_screen_mode: LOW_SCREEN_MODE, high_screen_mode: HIGH_SCREEN_MODE,
        errors: errors.slice(0, 10)
      });
    } catch (logErr) {
      // Don't fail the cycle if logging fails. Log error in errors array on next cycle if persistent.
    }

    return new Response(JSON.stringify(responseBody, null, 2), {
      status: 200, headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false, error: String(e), placements, sales, skipped, errors
    }), { status: 500, headers: { "content-type": "application/json" } });
  }
}

// Live scheduled entrypoint. Also kicks the PAPER shadow each cycle so it advances
// on this endpoint's reliable cron-job.org trigger (Netlify's own schedules are
// throttled to near-never — see project_weatherbot_cron). Bounded-await like the
// calibration self-kick: paper_trader runs as its own invocation with its own
// budget; if it exceeds the wait, the abort ends only OUR wait, not paper's run.
// Paper can never affect the live cycle (separate invocation, errors swallowed).
export default async () => {
  const live = await runTraderCycle(false);
  try {
    const _ac = new AbortController();
    const _t = setTimeout(() => _ac.abort(), 3000);
    await fetch(`${SITE_BASE}/.netlify/functions/paper_trader`, {
      headers: { authorization: "Basic " + btoa("internal:hydro") }, signal: _ac.signal
    }).finally(() => clearTimeout(_t));
  } catch { /* paper is best-effort; never block or fail the live cycle */ }
  return live;
};

// Will short-circuit if env vars missing / arm-switch off.
export const config = { schedule: "*/5 * * * *" };
