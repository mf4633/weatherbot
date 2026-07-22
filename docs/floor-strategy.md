# Sell-the-floor: the low-tail NO strategy

The edge is **not** forecasting the exact daily high (a losing game — see the
2026-07-21 KDEN miss). It's the **monotonic low-tail NO**: a NO on a bottom
temperature bucket is *won the instant the observed temp clears that bucket's
ceiling* — hours before settle, capital freed, gain banked, and it can never
reverse. The catch is that a dead-obvious floor is priced to ~1%; the money is
in the narrow **cold-pool-morning window** where the crowd sees a cool morning
and underprices the low buckets while the airmass is about to mix out hot.

## The pieces (all unit-tested)

| Module | Job |
|--------|-----|
| `lib/highpredict.js` | daily-high predictor + hour-conditional rise-to-peak calibration; **anchor-anomaly detection** (flags cold-pool mornings, widens the range, `low_confidence`) |
| `lib/floorscan.js` | fuses the predictor's peak distribution into the `nofloor` gates (p_lock ≥ 0.93, return ≥ 20%); surfaces the cold-pool **floor tailwind** |
| `lib/kalshi.js` | Kalshi daily-high markets → the floor-scan board shape |
| `lib/floorlog.js` | log picks + score them against CLI settlement (hit rate, realized return, per city) |
| `lib/nofloor.js` | the monotonic-lock + return gates (with the null-prob safety guard) |

## Endpoints

- **`GET /api/predicthigh?city=DEN`** — settlement-high prediction + a walk-forward
  backtest. `POST {board:…}` to also get the floor-scan for that board.
- **`GET /api/floorsweep`** — the daily driver. Fetches every city's Kalshi board +
  trace, runs the scan, returns `best_low_tail_no` (qualifying floors ranked by
  payout across all cities), `tailwind_cities` (cold-pool mornings to lean into), and
  `failed[]` (wrong-ticker cities to fix). Logs the top pick per city (first-per-day).
  - `?city=DEN` one city · `?min_return=0.15` / `?min_win=0.90` loosen the gates · `?nolog=1` skip logging.
- **`GET /api/floorsweep?mode=report`** — scores the logged picks against CLI
  settlement: `hit_rate`, `mean_return_pct`, overall and `by_city`. This is the proof
  the "near-guaranteed 20%" claim rests on.

## Automation

`.github/workflows/floorsweep-cron.yml` runs the sweep every 2h across US mornings
(the Netlify scheduler stalls, so this is the external backstop) to capture each
city's floor pick in its cheap-morning window. `?mode=report` reads the accrued log
whenever you want the scorecard.

## How to read a sweep

1. **`best_low_tail_no`** — top-to-bottom, the floors that are near-locked *and*
   paying ≥ 20%. These are the trades. Take them; exit the instant `max_so_far`
   clears the `lock_temp`.
2. **`tailwind_cities`** — even with no ranked candidate, a tailwind means the raw
   `p_lock` *understates* the floor (cold-pool morning). Go look at that board and
   lean in below the gate.
3. **`failed[]`** — a `kalshi … HTTP 404` just means that city's series ticker in
   `CITIES` is wrong; fix it from the error and redeploy.
