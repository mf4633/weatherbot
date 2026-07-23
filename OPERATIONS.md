# weatherbot — operations

Deployment, monitoring, and safety procedures for running this in production.

---

## Site & repo

- **Live site**: https://weatherbot-mf.netlify.app
- **Netlify project**: `weatherbot-mf` under team `mf4633` (Team Hydro Complete)
- **GitHub repo**: https://github.com/mf4633/weatherbot (private)
- **HTTP Basic Auth**: any username, password = `hydro` (gated by edge function)
- **Real-money Kalshi account**: `royal.greyhound5665`

---

## Environment variables (Netlify, production scope)

| Var | Required for | Notes |
|---|---|---|
| `KALSHI_ACCESS_KEY_ID` | Real trading | UUID Key ID from Kalshi → Account → API Keys |
| `KALSHI_PRIVATE_KEY` | Real trading | RSA private key (PEM). The function tolerates escaped/stripped newlines (Netlify UI quirk). |
| `KALSHI_TRADING_LIVE` | Real trading arm-switch | Must be one of `true` / `1` / `yes` / `on` / `live`. Anything else keeps the trader paused even with creds set. |
| `KALSHI_API_KEY` | (unused) | Reserved for any future bearer-key path. |

Set with `netlify env:set NAME value --context production` or via the web UI:
https://app.netlify.com/projects/weatherbot-mf/configuration/env

Confirm with: `netlify env:list --context production --plain`

---

## Deploys

```
cd ~/Desktop/AI/weatherbot
netlify deploy --prod --dir=.
```

Schedules — both run every 5 minutes via Netlify scheduled functions (cron `*/5 * * * *`):
- `logger` — paper trading
- `jackson_trader` — real trading (no-op unless `KALSHI_TRADING_LIVE` is set)

Manually trigger by hitting the function URL with auth (works for dev/testing):
```
curl -u "x:hydro" "https://weatherbot-mf.netlify.app/.netlify/functions/jackson_trader"
```

---

## Safety architecture (real money)

Three layers protect the Kalshi account from any unauthorized money movement.

### Layer 1 — Endpoint allowlist (positive)

`netlify/functions/jackson.js` defines `ENDPOINT_ALLOWLIST`. Only these paths can be hit through `kalshiAuthedFetch`:

- `/trade-api/v2/portfolio/balance`
- `/trade-api/v2/portfolio/positions`
- `/trade-api/v2/portfolio/orders` (and `/orders/{id}`)
- `/trade-api/v2/portfolio/fills`
- `/trade-api/v2/markets` (and `/markets/{id}`)
- `/trade-api/v2/events`

Any other path throws `SAFETY: endpoint not on allowlist`.

### Layer 2 — Endpoint denylist (negative, defense in depth)

Even if the allowlist regex were buggy, `ENDPOINT_DENYLIST` blocks any path matching: `deposit`, `withdraw`, `transfer`, `bank`, `ach`, `wire`, `payout`, `payment` (case-insensitive).

### Layer 3 — Hard arm-switch

The trader's first action is `if (KALSHI_TRADING_LIVE !== "true") return paused`. Without that env var, no trades happen even with credentials present.

### Layer 4 — Bot ledger isolation

`jackson_trader.js` keeps a Netlify Blob ledger (`jackson_open_bets`) of positions it placed itself. The sell-loser logic only iterates that ledger — pre-existing user-placed positions are never sold by the bot.

### Layer 5 — Kalshi-side API key permissions

When generating the API key in Kalshi, you can scope it. Even if all our code were compromised, Kalshi rejects unauthorized actions for the key.

### Verification

Run the safety regression test:
```
node test_safety.js
```
12 cases, asserts deposits/withdrawals/transfers/bank/ach/wire are blocked at the function layer.

---

## Bankroll & sizing rules (paper + real)

- Starting bankroll: $20
- Max concurrent bets: 20
- Stake per bet: `max($1, bankroll/20)`
- Min edge to qualify: 5¢ **net of Kalshi fees** (fees subtracted from EV before threshold)
- Min half-Kelly to qualify: 2%
- Per-city forecast staleness: skip bets if that city's forecast is > 180 min old
- Sell trigger: position underwater AND model now expects net loss

Examples:
- $20 bankroll → $1/bet, 20 concurrent
- $10 bankroll → $1/bet, 10 concurrent
- $40 bankroll → $2/bet, 20 concurrent
- $100 bankroll → $5/bet, 20 concurrent

---

## Daily monitoring

Refresh https://weatherbot-mf.netlify.app and check:

1. **Phase 0 paper section** — open positions, recent settled, bankroll trajectory
2. **Andrew Jackson section** — cash, capital at risk, unrealized + realized P&L, account value
3. **Kalshi edges section** — freshness banner is green
4. **Per-city section** — no city losing systematically (suggests bug or model drift)

Settlements roll in at each city's local 7 AM (Eastern: ~11 UTC, Pacific: ~14 UTC). Bot's open count drops as positions close.

---

## Re-running validation

If you want to refresh the backtest data (e.g., after a few months):

```
node research/fetch_data.js              # 1-year obs
node research/fetch_models.js            # 5-year obs + 5 NWP models (~5-10 min, may rate-limit)
node research/analyze_5yr.js             # tune biasW + per-city offsets (HIGH)
node research/analyze_low.js             # tune for LOW
node research/analyze_sigma.js           # tune σ formula
node research/analyze_ensemble.js        # test alternative ensemble blends
node research/replay_backtest.js         # simulated paper-trade across the trading layer
```

Results will print to stdout; weights are saved to `weights_high.json` / `weights_low.json` for inspection.

---

## Incident response

### "Lost cash unexpectedly"

1. Check `/api/jackson` → `fills` for recent buy orders
2. Cross-reference against `jackson_open_bets` ledger
3. If discrepancy: probably a Kalshi API issue or a bug. **First action: set `KALSHI_TRADING_LIVE` to anything other than `true`** to stop further trading. Then investigate.

### "Bot is firing too aggressively"

- `KALSHI_TRADING_LIVE` to `false` immediately stops new orders (sell logic also pauses)
- Increase `MIN_EDGE` in `jackson_trader.js` from 0.05 to 0.10 for stricter filtering

### "Bot stopped firing"

- Check `/api/kalshi` freshness banner — if red (cache or all forecasts stale), bot pauses by design
- Check `/api/jackson` configured/dormant flags
- Pull function logs: https://app.netlify.com/projects/weatherbot-mf/logs/functions

### "Account shows positions I didn't authorize"

The bot's allowlist physically can't deposit/withdraw. If you see a position you didn't expect, the most likely cause is a bot-placed +EV trade. Confirm by checking the ticker against `/api/jackson` `markToMarket` (bot positions show city/variable/bucket; pre-existing positions show `—`).

---

## Future work (open ideas)

- **Conformal prediction CIs** instead of parametric Gaussian + grid-tuned σ
- **Per-city ensemble weights** with statistical significance gating (5-year data fetched; analysis script ready as `research/analyze_percity_weights.js`)
- **Real-station mesonet integration** (Iowa State ASOS endpoint verified working)
- **Limit-order execution** vs current market-at-ask
- **Bot-only P&L attribution** (separate ledger of bot fills vs user-placed positions in real account)
- **Kalshi monthly markets**: rain (KXRAIN*M), snow (KX*SNOWM) — different distributional problem
- **Cross-market portfolio**: dedup near-identical bets (B65.5 YES ≈ T64 NO)
