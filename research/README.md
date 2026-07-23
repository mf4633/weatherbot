# research/

One-off analysis, backtest and data-fetch scripts. Nothing in here runs in
production, on a cron, or in `npm test` — the deploy never touches this directory.
It is kept because most of these scripts encode a **result**, and several of those
results are negative ("do not ship"), which is exactly the kind of finding that is
cheap to store and expensive to rediscover. `EDGE_AUDIT.md`, `STRATEGY.md`,
`OPERATIONS.md` and `TRADING_POSTMORTEM.md` cite scripts in here by path.

## Running them

**Run from the repository root**, not from inside this directory:

```sh
node research/backtest_yr.js
node research/eval_strategy.mjs
```

Data files are read by bare relative path (`data.json`, `data_models.json`,
`per_city_kalman_params.json`, …), so they resolve against the working directory.
Running from inside `research/` will fail to find them. Most of those inputs are
gitignored and regenerated with `node research/fetch_data.js` and friends.

## What stayed at the repo root, and why

- `cities.js` — imported by `netlify/functions/jackson.js` **and** `app.v4.js`
- `erf.js` — imported by `netlify/functions/lib/claude_analog_v2.js` and `scoreboard.js`
- `claude_ui.js`, `ui_nav.js` — loaded directly by `index.html` as `/claude_ui.js`, `/ui_nav.js`
- `test_*.js` — wired into `npm test`
- `app.v4.js`, `submit-indexnow.js`, `eslint.config.mjs` — dashboard, SEO ping, lint config

Moving any of those breaks production or the dashboard.
