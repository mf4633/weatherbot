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
const MIN_EDGE_HIGH = 0.17;
const MIN_EDGE_LOW  = 0.25;
function minEdgeFor(b) { return b.variable === "low" ? MIN_EDGE_LOW : MIN_EDGE_HIGH; }
// 2026-05-13: MIN_HALF_KELLY raised from 0.10 → 0.15. n=138 sweep: tightening to 0.15
// rejected 4 bets (0W/4L), recouped $44 with zero wins forgone — clean Pareto win.
// 0.20 would recoup $152 but rejects 27 bets including 2 wins (risk of overfit on n=138).
const MIN_HALF_KELLY = 0.15;
// Cheap-tail floor: 2026-05-13 sweep on n=138 — bets at price ≤ 0.10 were 26/26
// LOSSES, -$218 net. Raising 0.04 → 0.10 recoups $202 with ZERO wins forgone on
// the existing population. The cleanest signal in the entire sweep. Cheap tails
// continue to be a graveyard because the model can't price left-tail outcomes
// accurately at sub-10¢ resolution — the EV calc bakes in pWin estimates that
// settled-bet history shows are systematically too high in this band.
const MIN_PRICE = 0.10;
// Volume floor: skip orders on markets with paper-thin orderbook depth. Daily
// volume is a proxy for liquidity (true book-depth isn't in our snapshot).
// 20 contracts traded today = at least minimal interest; below that, partial
// fills become probable. SATX bet on 2026-05-06 hit this exact pattern: 7-contract
// intent at 63¢, 1-share fill, 6 contracts canceled at expiration.
const MIN_VOLUME = 20;
const PER_CITY_FRESHNESS_MAX_MIN = 180;
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
// Stake = halfKelly × bankroll, floored at $1 and capped at 10% of bankroll.
// At $20 bankroll: stake range $1–$2. At $200: $1–$20. Conviction-weighted.
const STAKE_FLOOR = 1.0;
const STAKE_CEIL_FRAC = 0.10;
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
const LOW_PAUSED_CITIES = new Set(["San Antonio", "Phoenix"]);

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
  ["Los Angeles|high", 0.5],
  // 2026-05-14 PM: Houston LOW. Lifetime 1W/3L is too thin to justify a hard
  // pause; half size lets the sample grow toward unpause-decision power.
  // Promote to 1.0 once 6+ fresh LOW settled bets at non-negative cumulative
  // P&L, OR per_city_residual_mean_7d_low |<1.0°F|.
  ["Houston|low", 0.5]
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
function normCdf01(z) {
  // Abramowitz–Stegun 7.1.26 approximation; max error ~1.5e-7.
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = z < 0 ? -1 : 1; const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1) * t * Math.exp(-x*x);
  return 0.5 * (1 + sign * y);
}
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
  return null;
}
const SIGMA_COOLING_F = 0.7;     // residual extremum noise given running min/max
const PI_TAIL_SKIP    = 0.10;    // skip when posterior P(win) < this

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
const SIGMA_FORECAST_REVISION_F = 0.5;  // σ_μ — revision of model mean over short horizon
const KELLY_LCB_Z = 0.5;                // 0.5σ lower bound (mild); 1.0/1.65 more aggressive
function kellyLcbAdjust(b) {
  const σ = b.modelStd, μ = b.modelMean;
  if (!Number.isFinite(σ) || σ <= 0 || !Number.isFinite(μ)) return null;
  const lo = b.loInt, hi = b.hiInt;
  const zLo = (lo == null || lo === -Infinity) ? null : (lo - 0.5 - μ) / σ;
  const zHi = (hi == null || hi === Infinity)  ? null : (hi + 0.5 - μ) / σ;
  const phi = z => Math.exp(-z*z/2) / Math.sqrt(2*Math.PI);
  const phiLo = zLo == null ? 0 : phi(zLo);
  const phiHi = zHi == null ? 0 : phi(zHi);
  const dPdMu = Math.abs(phiLo - phiHi) / σ;
  const sigmaP = dPdMu * SIGMA_FORECAST_REVISION_F;
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

// Place a buy order via Kalshi. Returns the order response.
// Kalshi prices are integer cents 1-99. Stake comes through `count` (number of contracts).
async function placeBuyOrder(ticker, side, count, priceCents) {
  const body = {
    action: "buy",
    side: side.toLowerCase(),       // "yes" or "no"
    ticker,
    count: Math.max(1, Math.round(count)),
    type: "limit",
    [side.toLowerCase() === "yes" ? "yes_price" : "no_price"]: priceCents,
    // 15-min expiration (extended from 5-min on 2026-05-07): on illiquid temp
    // markets the 5-min window often expired with partial or zero fills (SATX
    // 7-contract intent → 1-share fill). 15 min lets resting orders catch new
    // offers as they post. Phantom-grace reconcile (jackson_trader.js) keeps
    // ledger entries alive within 1h, so the longer expiration doesn't cause
    // double-buys on the next 5-min cycle.
    expiration_ts: Math.floor(Date.now() / 1000) + 60 * 15,
    client_order_id: `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
  const r = await kalshiAuthedFetch("POST", "/trade-api/v2/portfolio/orders", body);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

// Place a sell order to close an existing position.
async function placeSellOrder(ticker, side, count, priceCents) {
  const body = {
    action: "sell",
    side: side.toLowerCase(),
    ticker,
    count: Math.max(1, Math.round(count)),
    type: "limit",
    [side.toLowerCase() === "yes" ? "yes_price" : "no_price"]: priceCents,
    expiration_ts: Math.floor(Date.now() / 1000) + 60 * 15,
    client_order_id: `wb-sell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
  const r = await kalshiAuthedFetch("POST", "/trade-api/v2/portfolio/orders", body);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

export default async () => {
  if (!process.env.KALSHI_ACCESS_KEY_ID || !process.env.KALSHI_PRIVATE_KEY) {
    return new Response(JSON.stringify({ ok: true, dormant: true,
      message: "Real-trader dormant: KALSHI_ACCESS_KEY_ID/KALSHI_PRIVATE_KEY not set" }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
  // Hard arm-switch: real trading only fires when KALSHI_TRADING_LIVE === "true".
  // Without this, the trader is paused even if creds are present. Lets us land
  // safety changes without immediately firing real orders.
  const liveFlag = (process.env.KALSHI_TRADING_LIVE || "").trim().toLowerCase();
  // Distinguish "paused" (kill switch off) from "dry-run" mode. In dry-run we still execute
  // the placement loop (computing all skip/place decisions) but don't call Kalshi to actually
  // submit orders. This lets us instrument the bucket-margin filter etc. without trading.
  const isLive = ["true", "1", "yes", "on", "live"].includes(liveFlag);
  const isDryRun = !isLive && ["dryrun", "dry-run", "shadow"].includes(liveFlag);
  if (!isLive && !isDryRun) {
    return new Response(JSON.stringify({ ok: true, paused: true,
      flagValueSeen: liveFlag ? "(non-empty but not truthy)" : "(empty/unset)",
      message: "Real-trader paused: KALSHI_TRADING_LIVE must be 'true' (or 1/yes/on/live). Set to 'dryrun' for instrumentation-only mode." }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }

  const placements = [], sales = [], errors = [], skipped = [];
  const ledgerStore = getStore("jackson_open_bets");
  const settledStore = getStore("jackson_settled_bets");
  const cooldownStore = getStore("jackson_cooldown");
  try {
    // 1. Read live state from Kalshi + bot ledger + cooldown map.
    const [balance, positionsResp, kalshiData, weatherData, { blobs: ledgerBlobs }, cooldownRaw] = await Promise.all([
      getBalance(),
      getPositions(),
      fetchInternal("/api/kalshi"),
      fetchInternal("/api/weather"),
      ledgerStore.list().catch(() => ({ blobs: [] })),
      cooldownStore.get("map.json", { type: "json" }).catch(() => ({}))
    ]);
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

    const cashCents = balance.balance ?? 0;          // Kalshi returns balance in cents
    const cashDollars = cashCents / 100;
    // Normalize Kalshi position fields. Real fields: position_fp (string of float;
    // sign = direction), market_exposure_dollars (string), realized_pnl_dollars (string).
    const positions = (positionsResp.market_positions || []).map(p => ({
      ...p,
      qty: parseFloat(p.position_fp || "0"),
      exposure: parseFloat(p.market_exposure_dollars || "0"),
      realizedPnl: parseFloat(p.realized_pnl_dollars || "0")
    }));
    const allOpenCount = positions.filter(p => p.qty !== 0).length;

    // Bot ledger: entries we placed. Sell-loser logic ONLY iterates these.
    // User's pre-existing positions are off-limits.
    const ledger = (await Promise.all(
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
    if (settlingEntries.length > 0) {
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
      }
    }
    const botPlacedKeys = new Set(liveLedger.map(e => botKey(e.ticker, e.side)));
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
    // winners). ONLY among bot-placed positions.
    if (kalshiData?.cities) {
      const cityIndex = Object.fromEntries(kalshiData.cities.map(c => [c.name, c]));
      for (const p of positions) {
        if (p.qty === 0) continue;
        const ticker = p.ticker;
        const side = p.qty > 0 ? "YES" : "NO";
        if (!botPlacedKeys.has(botKey(ticker, side))) continue;  // SAFETY: skip user-placed
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
        const sellPriceCents = Math.max(1, Math.round(sellPrice * 100));
        const res = isDryRun ? { ok: true, body: { dryRun: true } }
                             : await placeSellOrder(ticker, isYes ? "YES" : "NO", contracts, sellPriceCents);
        sales.push({ ticker, side: isYes ? "YES" : "NO", count: contracts, sellPriceCents,
                     reason: autoClose ? "auto-close" : "ev-flip",
                     marketImplied: marketImpliedOurSide != null ? Math.round(marketImpliedOurSide * 100) / 100 : null,
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
          if (citySide?.name && soldVariable) {
            cooldownMap[cityVarKey(citySide.name, soldVariable)] = new Date().toISOString();
          }
        }
      }
    }

    // 3. Place new bets.
    if (kalshiData?.topBets && spareCapacity > 0) {
      const fr = kalshiData.freshness || {};
      const cityForecastAge = {};
      // cityInputAges feeds Bayesian work-order #6b: settled bets carry input ages
      // at bet time, so σ_age_i(age_i) per-source curves are fittable from the
      // existing settled-bet stream once ~80-150 bets accumulate. See
      // project_weatherbot_bayesian_workorder.md for the resume sequence.
      const cityInputAges = {};
      for (const c of (weatherData.cities || [])) {
        // Prefer server-computed dataAgeMin (weather.js): reflects the freshest of
        // ensemble + METAR + NWS grid, not just NWS's grid issue time. NWS grid often
        // sits 4-6h old for west-coast/quiet-regime cities while our ensemble + obs
        // are minutes old; gating on raw forecastUpdateTime over-skipped those.
        if (c.dataAgeMin != null) cityForecastAge[c.name] = c.dataAgeMin;
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
      }
      // Threshold gate: high-conviction floor on net edge AND halfKelly. Sorted by
      // halfKelly desc upstream, so iterating fills highest-conviction first.
      const qualifying = (kalshiData.topBets || []).filter(b =>
        b.ev >= minEdgeFor(b) && b.halfKelly >= MIN_HALF_KELLY && b.price >= MIN_PRICE
        && (b.volume == null || b.volume >= MIN_VOLUME));
      // Skip-reason log so we can see exactly how high vs low were weighed each run.
      // Listed in priority order matching the iteration below.
      const briefBet = b => ({ city: b.city, variable: b.variable || "high", bucket: b.bucket,
                               ticker: b.ticker, side: b.side,
                               ev: Math.round(b.ev*1000)/1000,
                               halfKelly: Math.round(b.halfKelly*1000)/1000,
                               pWin: b.p_model != null ? Math.round(b.p_model*1000)/1000 : null,
                               price: b.price });
      let placed = 0;
      let committed = 0;
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
        // Resolve event ticker → full market ticker like KXHIGHNY-26MAY02-B65.5.
        const cityKalshi = (kalshiData.cities || []).find(c => c.name === b.city);
        if (!cityKalshi) { skipped.push({ ...briefBet(b), reason: "city-not-in-kalshi-data" }); continue; }
        const eventTicker = b.variable === "low" ? cityKalshi.lowEvent : cityKalshi.highEvent;
        if (!eventTicker || eventTicker === "not found") { skipped.push({ ...briefBet(b), reason: "event-not-listed-on-kalshi" }); continue; }
        const fullTicker = `${eventTicker}-${b.ticker}`;
        const dedupKey = botKey(fullTicker, b.side);
        if (heldKey.has(dedupKey)) { skipped.push({ ...briefBet(b), reason: "already-held" }); continue; }
        if (cooldownMap[dedupKey]) { skipped.push({ ...briefBet(b), reason: "in-cooldown" }); continue; }
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
        // Sigma-aware bucket-margin gate. Independent of obs (the absolute-°F
        // gate above is obs-based: maxSoFar/minSoFar vs bucket edge). This gate
        // is model-based: how many σ_eff away is the model μ from the bucket
        // boundaries? Skips B-bucket bets where the model's prediction sits
        // closer than 0.5σ_eff to either edge — those are coin-flips in posterior
        // terms regardless of how confident the EV calc looks. T-tail bets bypass
        // (boundary semantics differ; tail-posterior gate already handles them).
        if (b.ticker?.startsWith("B") && Number.isFinite(b.loInt) && Number.isFinite(b.hiInt)
            && b.modelMean != null && b.modelStd != null) {
          const sigmaEff = Math.sqrt(b.modelStd ** 2 + SIGMA_IRREDUCIBLE_F ** 2);
          const contLo = b.loInt - 0.5;
          const contHi = b.hiInt + 0.5;
          const sigmaMargin = Math.min(
            Math.abs(b.modelMean - contLo) / sigmaEff,
            Math.abs(b.modelMean - contHi) / sigmaEff
          );
          if (sigmaMargin < SIGMA_BUCKET_MARGIN_Z) {
            skipped.push({ ...briefBet(b), reason: "sigma-margin-thin",
                           sigmaMargin: Math.round(sigmaMargin * 1000) / 1000,
                           thresholdZ: SIGMA_BUCKET_MARGIN_Z,
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
        // Kelly-LCB gate (Bayes work order #5): re-check EV/halfKelly using the lower
        // confidence bound on pWin. Catches "model very confident at the strike" cases
        // where σ is small and a tiny shift in μ flips the bet — exactly the SATX
        // 2026-05-06 T68 NO failure pattern. Calibrated z_α=0.5 against the 49-bet
        // sample (+$112 net in backtest_gates.js Kelly-LCB A/B).
        const lcb = kellyLcbAdjust(b);
        if (lcb) {
          const fee = 0.07 * (1 - b.price);
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
        const cov = cityWeather?.synopticCoverage;
        const coverageDeRate = (cov === "1min" || cov === "5min") ? 1.0
                             : (cov === "hourly-only") ? 0.5
                             : 0.0;  // "stalled" / "none" / undefined → skip the bet
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
          Math.min(cashDollars * STAKE_CEIL_FRAC, effectiveHalfKelly * cashDollars, remaining));
        if (stake_dollars < STAKE_FLOOR) break;
        const contracts = Math.max(1, Math.floor(stake_dollars / b.price));
        const priceCents = Math.max(1, Math.min(99, Math.round(b.price * 100)));
        // Dry-run mode: skip Kalshi order submission, fake an "ok" response so the
        // placement is logged for instrumentation purposes.
        const res = isDryRun ? { ok: true, body: { order: { client_order_id: `dryrun-${Date.now()}` }, dryRun: true } }
                             : await placeBuyOrder(fullTicker, b.side, contracts, priceCents);
        // Expected payout = contracts × $1 × p_winning (assuming win pays $1/contract).
        const pWin = b.p_model;  // p_model is set to pNo for NO side, p_yes for YES side
        const expectedPayout = contracts * (Number.isFinite(pWin) ? pWin : 0);
        placements.push({ ticker: fullTicker, side: b.side, count: contracts, priceCents,
                          city: b.city, variable: b.variable || "high",
                          bucket: b.bucket, bucketCode: b.ticker,
                          stake_dollars: Math.round(stake_dollars * 100) / 100,
                          ev: b.ev, halfKelly: b.halfKelly,
                          softReopen: softReopen < 1.0 ? softReopen : null,
                          pWin: pWin != null ? Math.round(pWin * 1000) / 1000 : null,
                          expectedPayout: Math.round(expectedPayout * 100) / 100,
                          marginDebug: b._marginDebug,  // debug instrumentation
                          dryRun: isDryRun,
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
          if (!isDryRun) boughtCityVarKeys.add(cvLockKey);
          // Track this placement in the intra-run heldEventSide set so a later
          // candidate in the same run with the same (event, side) gets the stack-cap
          // skip. The cross-run heldKey set already covers prior-run positions.
          heldEventSide.add(eventSideKey);
          // Save to bot ledger so future runs know we own this position. Skip in dry-run.
          if (isDryRun) continue;
          const betId = res.body?.order?.client_order_id || `${fullTicker}-${b.side}-${Date.now()}`;
          await ledgerStore.setJSON(`${betId}.json`, {
            betId, ticker: fullTicker, side: b.side, contracts,
            price: b.price, stake_dollars,
            city: b.city, variable: b.variable || "high",
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
    const stakeCeil = Math.round(cashDollars * STAKE_CEIL_FRAC * 100) / 100;
    const responseBody = {
      ok: true,
      ranAtUTC,
      cashDollars,
      botOpenCount, allOpenCount,
      spareCapacity,
      stake_floor: STAKE_FLOOR,
      stake_ceil_dollars: stakeCeil,
      sales, placements, skipped, errors
    };

    // Write per-cycle structured log to trader_logs blob. Filename = ISO timestamp.
    // Tail (most recent ~200 entries) read via /api/trader_log.
    try {
      const logStore = getStore("trader_logs");
      await logStore.setJSON(`${ranAtUTC}.json`, {
        ranAtUTC, cashDollars, spareCapacity, stake_ceil: stakeCeil,
        placements: placements.map(p => ({
          ticker: p.ticker, side: p.side, count: p.count, priceCents: p.priceCents,
          city: p.city, variable: p.variable, bucket: p.bucket, bucketCode: p.bucketCode,
          stake_dollars: p.stake_dollars, ev: p.ev, halfKelly: p.halfKelly,
          softReopen: p.softReopen,
          pWin: p.pWin, expectedPayout: p.expectedPayout, ok: p.ok
        })),
        sales: sales.map(s => ({ ticker: s.ticker, side: s.side, count: s.count,
                                   priceCents: s.priceCents, ok: s.ok })),
        skipped: skipped.slice(0, 30),  // cap to avoid huge blobs
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
};

// Same 5-min schedule as paper trader. Will short-circuit if env vars missing.
export const config = { schedule: "*/5 * * * *" };
