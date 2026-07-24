# book_poller — 60-second Kalshi book collector

The measurement instrument for the one edge hypothesis that hasn't been disproven.

## Why

Forecast skill is dead as an edge: over 12,264 real opportunities the market is calibrated
(Brier **0.064**) where the model is not (**0.105**), with no mispriced slice by hour, price,
or distance-from-observation (`diagnose_edge.js`). Replaying the live entry rule against 14
days of real books returned **−6.8% ROI on 462 bets, 20.8% realized against 71.2% claimed**,
and tightening the edge gate made it monotonically *worse* — the model's confidence is
negatively predictive (`replay_trader.js`). That independently reproduces
`TRADING_POSTMORTEM.md`.

What remains is **latency**: knowing the realized max before the market reprices. Testing it
needs sub-hourly sampling, and the existing collector cannot provide it. `market_logger`
declares `*/15` in `netlify.toml`, but Netlify throttles scheduled functions — measured over
195 city-days the real cadence is:

```
median gap 107 min    minimum 56 min    11 snapshots/city-day
```

A latency edge lives in the 5–45 minute band. That instrument samples ~20× too slowly;
`measure_reprice_timing.js` cannot populate a single bin on it. GitHub Actions is no better —
this repo's own workflow comments record crons firing 4–5 h late.

## What it answers

> Does the market reprice on the hourly METAR (`:51`–`:53`), or continuously?

- **Concentrated just after `:53`** → the market is METAR-driven, and a sub-hourly
  observation (PWS via `interpolatornyc`) has a real window to lead it.
- **Flat across the hour** → the market already watches 1-minute ASOS. A PWS proxy would be
  *inferring* what the market *observes directly*, and there is no lead to trade. Restoring
  the dead Synoptic feed would buy parity, not an edge.

Either answer is worth having. The second one closes the last hypothesis cheaply.

## Safety

Kalshi market data is public. This process holds **no credentials**, imports no trader, and
has no code path that can place an order. It reads and appends, nothing else. The Fly config
deliberately has no `[http_service]` — it serves nothing and is not reachable.

## Run

Locally (start collecting immediately, no infra):

```bash
node tools/book_poller.js                     # → ./data/ticks/ticks-YYYY-MM-DD.jsonl
SERIES=KXHIGHNY,KXHIGHLAX node tools/book_poller.js
```

On Fly (survives your machine sleeping — uniform sampling is the whole point):

```bash
cd tools
fly launch --no-deploy --name weatherbot-poller
fly volumes create poller_data --size 1 --region ewr
fly deploy
fly ssh sftp get /data/ticks/ticks-2026-07-24.jsonl
```

~50k rows/day ≈ 12 MB/day. A 1 GB volume holds months.

## Then

```bash
SNAPSHOTS=... node measure_reprice_timing.js
```

It refuses to render a verdict on under-sampled data — it needs ≥30 pairs in each of the four
minute-of-hour bins and otherwise prints `INSUFFICIENT DATA`. (The first version reported
"repricing is FLAT" off *zero* pairs, because `Math.max`/`Math.min` over an empty array gives
`NaN` and the comparison fell through to the else branch. That would have been a confident
false negative on the last live hypothesis.)

Give it ~3–5 days before reading anything into it.
