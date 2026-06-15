// Paper trader — faithful $100 virtual shadow of the live "Andrew Jackson" trader.
// Runs the IDENTICAL entry engine (model signal + full gate stack + Kelly sizing)
// via runTraderCycle(true), but never touches Kalshi: bankroll/positions come from
// the paper blob stores (open_bets / settled_bets / paper_state — the ones
// /api/paper reads), it's buys-only, and it holds every position to settlement.
// Purpose: measure the live-vs-backtest edge gap on a clean, no-money book.
//
// Own */5 cron (same cadence as the live trader). Seed/reset via /api/paper_reset.
import { runTraderCycle } from "./jackson_trader.js";

export default async () => runTraderCycle(true);

export const config = { schedule: "*/5 * * * *" };
