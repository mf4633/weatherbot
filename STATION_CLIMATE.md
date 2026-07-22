# Station climate knowledge base

Encoded 2026-07-22 from live trading sessions (LAX/BOS/HOU/AUS/NYC day) plus
station climatology. The machine-readable version lives in
`netlify/functions/lib/station_climate.js` (`STATION_CLIMATE` + `adviseClimate`),
surfaces as `city.climate` on `/api/weather`, and renders as the "regime" line on
the dashboard card. Everything here is **context for reading the models — never
an input to the scored predictions.**

## The cross-cutting concepts

**Gain compression** — the afternoon temperature *rise* shrinks when (a) the day
starts near its airmass ceiling (curves converge as the boundary layer deepens),
or (b) high dewpoints divert solar energy into evaporation instead of heating
(the *humid tax* — Bowen ratio). Flags: `humid-tax`, `monsoon-surge`. A +5°F
morning lead over yesterday usually does NOT survive to the peak intact — but on
clear compressional days (Houston 7/22) it can *widen* instead. Check which
regime you're in before assuming convergence.

**Compressional (downslope/offshore) flow** — descending air warms ~5.5°F/1000 ft
and dries as it warms. This is the anti-marine regime: coastal stations spike
(SFO 7/21: north wind all day → afternoon lull → 79→92 in 25 min, dew 63→38),
plains stations chinook (DEN), Texas stations bake under NW flow (AUS 7/22:
105–106 vs a grid that verified 3°F cold). Flag: `offshore-compressional`.
**One spike day poisons obs-anchored models for days** — trust the current
wind regime, not yesterday's max.

**The marine/lake thermostat** — at true breeze stations (LAX, SFO, SAN, SEA,
MIA, TPA, MDW-lake, BOS-east-wind) the onshore wind strengthens *with* the
heating that drives it (inland thermal low deepens → gradient steepens), so
sunny afternoons self-cap: LAX 7/22 sat pinned at 75 through a fully cleared
sky with 13 mph onshore. Burn-off TIME sets the ceiling: clear-by-9 vs clearing-
at-noon is worth 5–8°F at LAX. Watch the coastal/inland PWS gradient — the
inland sentinel leads by 30–45 min, and the gradient *compressing seaward*
means the breeze is winning.

**Partial-marine trap** — flow that crosses a little water (Boston SSW over the
harbor) *delays* but does not cap: Logan 7/22 plateaued at 82 for 95 minutes,
then stair-stepped to 84 and on to 86–87. Only the true onshore sector caps.

**Momentum vs. plateau** — hourly deltas ≥ +1.5°F/hr with hours to peak = the
peak is NOT in (NYC 7/22: +3/hr at 11 AM → settled 4–5°F higher). But at
thermostat stations a 60+ minute 5-minute-obs plateau under full sun IS
meaningful. The difference is mechanism: a plateau needs a *reason* (breeze,
deck, outflow) to be trusted; without one it's a stair-step landing.

**Settlement (CLI) quirks** — Kalshi settles on the CLI daily max, which uses
continuous/1-min data: it beat the METAR max on 18/30 LAX days (+1.7°F vs the
hourly-PWS interpolated peak — backtested, now printed by `run_lax.py`) and
9/14 HOU days (~+1.2°F). Observed 76.5+ can print 77. Verify station identity
from settled markets, not series names: Houston = HOBBY, Austin = BERGSTROM.

## Per-station one-liners

| Station | Regime engine | The one thing to know |
|---|---|---|
| KLAX | marine layer + sea breeze | burn-off time sets the high; W 260–280 = mature cap; N/E = Santa Ana spike |
| KSFO | strongest marine thermostat | offshore-flush spike mode: N wind + afternoon lull → +15°F in minutes |
| KSAN | gentle marine | 72–79 most summer days; Santa Ana (NE) is the only hot path |
| KSJC | valley, late marine intrusion | burns off early, runs 8–15°F over SFO; NW breeze caps the tail |
| KSEA | onshore mild / offshore hot | big positive anomaly ≈ Cascade-gap offshore flow (heat-dome mechanism) |
| KHOU | Gulf onshore vs W-flow bake | W/NW + falling dew = 100s; CLI runs high of METARs; = Hobby, not IAH |
| KMSY | permanent humid tax | dew 74–78 + pulse storms cap 91–95 |
| KMIA | ocean breeze metronome | 89–93 nearly always; high lands late morning |
| KTPA | bay breeze + daily storms | max typically before 2 PM |
| KJAX | late sea breeze | mid-90s under W flow before the breeze/storms arrive |
| KAUS | NW compressional vs SE Gulf | NW light flow = hottest; stratus mornings gain +9–11 after burn-off; = Bergstrom |
| KSAT | as Austin | frontal passages cause the B-bucket busts |
| KDFW | continental, dryline west | late peak (5–6 PM); W flow mixes dew down and bakes |
| KPHX | monsoon switch | dew ≥ 55 = surge, 3–8°F off the ceiling; outflow can lock the max mid-afternoon |
| KLAS | drier PHX | monsoon rule at dew ≥ 50 |
| KDEN | chinook vs upslope | W = compressional warm, E/NE = upslope cap; convection locks maxes; PWS run COOL of DIA |
| KBOS | true sea breeze = E only | SSW harbor flow delays, doesn't cap (stair-steps through); dew ≥ 70 taxes the last degrees |
| KNYC | no reliable cap | :51 METAR = preceding-hour max (unique quirk); momentum days run through the harbor breeze |
| KPHL | continental-humid | humid tax is the main cap |
| KDCA | urban riverside | runs hot of the metro; smoke (VV) events cut 1–3°F |
| KMDW | lake breeze NE–E | breeze arrival time is the whole question; cold-pool mornings mix out hotter than obs-anchored models say |
| KCMH/KIND | continental | airmass + cloud; no thermostat |
| KCLT | piedmont | small SW downslope kick on hot days |
| KAVL | mountain valley | inversion burn-off late; convection ends heating early |

## Trading heuristics validated 2026-07-22

- **NWS grid bias-correction**: compare the grid's current-hour forecast to the
  actual ob; shift the forecast peak by the error. Called Austin (grid 103,
  corrected 105–106, market center 103–104) and LAX (grid 82, corrected ~78,
  crowd at 79–80) correctly the same day. Now partially encoded as the NWS-base
  morning blend in the Claude card.
- **PWS fleets lead the official ASOS by 30–45 minutes** (Boston breakout,
  Houston stair-step, LAX coastal stall). The interpolators' real edge is the
  morning open and regime turns, not midday confirmation.
- **Cheap-tail discipline**: buy mechanism-backed tails (marine cap at a
  thermostat station) at single-digit cents; skip mechanism-free ones (Austin
  101–102 at 2¢ had no capping mechanism — correctly priced). A price is only
  "wrong" when you can name the physical process the crowd is missing.
