// Daily balance snapshot — scheduled at 00:00 UTC. Writes a row to the
// `balance_history` blob each tick with cash, portfolio value, total equity, and
// derived stats (hit-rate, ROI, realized P&L, fees) computed from settled bets.
// Idempotent within a UTC day — if already snapshotted today, overwrites that
// day's row rather than appending.
//
// NOTE: Netlify scheduled functions cannot also have a custom HTTP path
// (https://ntl.fyi/custom-path-scheduled-functions), so the core logic is
// exported as takeBalanceSnapshot() and re-used by balance_history.js when
// invoked with `?seed=1` for manual first-run seeding.

import { getStore } from "@netlify/blobs";
import { getBalance } from "./jackson.js";

const HISTORY_KEY = "history.json";
const TRIM_DAYS = 730;  // ~2 years; cheap.

function todayUtcKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function loadSettledStats() {
  // Mirror jackson_audit's load — settled bets live in jackson_settled_bets.
  const store = getStore("jackson_settled_bets");
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  const entries = await Promise.all(
    blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null))
  );
  const settled = entries.filter(Boolean);
  let wins = 0, losses = 0, pnl = 0, fees = 0, stake = 0;
  for (const b of settled) {
    if (b.outcome === "WIN")  wins++;
    if (b.outcome === "LOSS") losses++;
    pnl   += b.realized_pnl ?? 0;
    fees  += b.fees_paid    ?? 0;
    stake += b.stake_dollars ?? 0;
  }
  const decided = wins + losses;
  return {
    settledBets: settled.length,
    wins, losses,
    hitRate: decided ? wins / decided : 0,
    realizedPnl: Math.round(pnl   * 100) / 100,
    feesPaid:    Math.round(fees  * 100) / 100,
    stakeTotal:  Math.round(stake * 100) / 100,
    roi: stake > 0 ? Math.round((pnl / stake) * 1000) / 1000 : 0,
  };
}

export async function takeBalanceSnapshot() {
  const now = new Date();
  const dateKey = todayUtcKey(now);
  const bal = await getBalance();
  // balance API returns { balance: <cents> } per Kalshi docs; portfolio_value
  // shows mark-to-market open positions value.
  const cashCents = bal.balance ?? 0;
  const portfolioValueCents = bal.portfolio_value ?? 0;
  const totalEquityCents = cashCents + portfolioValueCents;

  const settledStats = await loadSettledStats();

  const store = getStore("balance_history");
  const existing = (await store.get(HISTORY_KEY, { type: "json" })) || { entries: [] };
  // Idempotent within a UTC day: replace today's entry if it exists.
  const filtered = (existing.entries || []).filter(e => e.dateUtc !== dateKey);
  filtered.push({
    dateUtc: dateKey,
    tsUTC: now.toISOString(),
    cashCents,
    portfolioValueCents,
    totalEquityCents,
    cashDollars:           Math.round(cashCents) / 100,
    portfolioValueDollars: Math.round(portfolioValueCents) / 100,
    totalEquityDollars:    Math.round(totalEquityCents) / 100,
    settledStats,
  });
  filtered.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
  const trimmed = filtered.slice(-TRIM_DAYS);
  await store.setJSON(HISTORY_KEY, { entries: trimmed, updatedAt: now.toISOString() });

  return { dateUtc: dateKey, totalEquityDollars: totalEquityCents / 100,
           settledStats, entries: trimmed.length };
}

export default async () => {
  try {
    const result = await takeBalanceSnapshot();
    return new Response(JSON.stringify({ ok: true, ...result }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
      { status: 500, headers: { "content-type": "application/json" } });
  }
};

export const config = { schedule: "0 0 * * *" };
