# Strategy B2 — °C-rounding / settlement-mechanics precision. Pre-registration.

Written BEFORE pulling 5-min ASOS or looking at any join. The antidote to the
multiple-comparisons trap the postmortem proved we need.

## Hypothesis
A **mechanics-aware settlement model** — built from the realized 5-minute ASOS °C
peak + the exact CLI °C→°F rounding rule + the per-station CLI-gap distribution —
prices the settlement-integer bucket **sharper than the Kalshi book**, with no forecast.

## Predictor M (fixed now)
At an end-of-day decision (local hour ≥ 20, warming done — the pure-mechanics window):
1. `pkF = round(cPeakC * 1.8 + 32)` where `cPeakC` = the day's max 5-min ASOS temp (IEM
   report_type=3), the °C-derived value the crowd's METAR sources also see.
2. Settlement integer `S = pkF + g`, where `g` ~ the per-station empirical CLI-gap
   distribution (`CLI_final − pkF`) fit on the **train** days only.
3. Bucket prob = P(S ∈ [lo,hi]) under that gap distribution.

## Metrics (fixed now)
- **Primary:** model Brier vs **market Brier (raw yes-ask)** on the settlement integer,
  over the same bucket set, on the **test** split.
- **Secondary (trade):** buy the bucket where `M − yes_ask > 0.03`, cross the ask, pay
  `ceil(0.07·p·(1−p))` fee; report realized win%, net ROI, n — train and test.
- **Boundary subset:** days where `cPeakC·1.8+32` is within **0.35°F** of an integer
  (rounding direction genuinely ambiguous) — B2's edge, if any, lives here.

## Split
Train = earlier dates, Test = later dates, split at the median settled date. No peeking
at test outcomes while fitting the gap distribution.

## Kill rule (decided now, not after)
B2 is **CLOSED** if, on the TEST split, model Brier ≥ market Brier **or** the trade ROI
≤ 0 net of fills. One pass. No re-slicing to rescue it.

## Known prior (documented, not neutral)
Two independent signals say the market already prices mechanics well:
1. Aggregate CLI-gap buckets are efficient (last-snapshot check: +1 bucket ask 0.085 vs
   realized 0.076; +2 ask 0.024 vs 0.014 — market marginally rich, no edge).
2. On 2026-05-07 KNYC the Kalshi book led every DSM-blind source to the settlement value.
So the honest expectation is NO edge; the boundary-conditioned subset is the only place a
residual could hide, and public 5-min data may be too coarse (whole-°C, ±0.9°F) to resolve
the boundary the settlement source (0.1°C internal) actually rounds from.

---
## OUTCOME (2026-07-24) — B2 CLOSED

Pulled IEM 1-minute ASOS (`asos1min.py`, whole °F, per-minute) for all 13 settled-high
stations × 16 days; 167 station-days with a reasonably complete 1-min trace and a last
book snapshot at local hour ≥ 20. `research/b2_mechanics_test.py`.

**Two data-reality findings that sink the premise:**
1. Public high-frequency obs can't resolve the CLI rounding. The 1-min `tmpf` is whole °F,
   METAR-style *instantaneous* — it runs ~1°F HOT vs the CLI's 5-min-*average* settlement
   (`settle − peak1min = −1` on 79/167 days) and, worse, the feed is gappy: `peak1min`
   fell BELOW the shadow max by 2–22°F on ~40 station-days (dropouts missed the real peak).
   So it's a biased, noisy estimator of the settlement number — not a sharper one.
2. **By end of day the market book is already essentially perfect.** Market Brier on the
   settlement integer = **0.0001** (TEST). There is no mispricing left to take.

**Result (kill rule: TEST model Brier ≥ market Brier OR trade ROI ≤ 0):**
| split | model Brier | market Brier | trade ROI |
|---|---|---|---|
| TRAIN | 0.0299 | 0.0025 | −25.9% |
| TEST  | 0.0387 | 0.0001 | −100% (0% win) |

Both conditions tripped. **B2 is closed.** The market prices settlement mechanics at least
as well as any public feed — the only source with the resolving precision (0.1°C internal →
°F) is the CLI/DSM itself, which *is* the settlement, and the book already tracks it.
This also closes B3 (latency): a market Brier of ~0 leaves no latency to exploit.
