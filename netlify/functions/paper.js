// Paper-trading dashboard endpoint. Aggregates settled paper bets and returns rolling stats.
// No real money — purely for validating whether our +EV signals translate to actual P&L.

import { getStore } from "@netlify/blobs";

export default async () => {
  const settleStore = getStore("paper_settlements");
  const stateStore = getStore("paper_state");
  const betsStore = getStore("paper_bets");

  const state = await stateStore.get("global", { type: "json" }).catch(() => null);

  // List all settlements + open bets (placed, not yet settled).
  const [{ blobs: settledList }, { blobs: betList }] = await Promise.all([
    settleStore.list().catch(() => ({ blobs: [] })),
    betsStore.list().catch(() => ({ blobs: [] }))
  ]);
  const settledKeys = new Set(settledList.map(b => b.key));
  const openBets = betList.filter(b => !settledKeys.has(b.key));

  const settlements = (await Promise.all(
    settledList.map(b => settleStore.get(b.key, { type: "json" }).catch(() => null))
  )).filter(Boolean).sort((a, b) => (a.localDate < b.localDate ? 1 : -1));

  const open = (await Promise.all(
    openBets.map(b => betsStore.get(b.key, { type: "json" }).catch(() => null))
  )).filter(Boolean).sort((a, b) => (a.localDate < b.localDate ? 1 : -1));

  // Per-city aggregate.
  const byCity = {};
  for (const s of settlements) {
    if (!byCity[s.cli]) byCity[s.cli] = { cli: s.cli, name: s.name, n: 0, wins: 0, staked: 0, pnl: 0 };
    byCity[s.cli].n += s.n_bets;
    byCity[s.cli].wins += s.settlements.filter(x => x.outcome === "WIN").length;
    byCity[s.cli].staked += s.totalStake_dollars;
    byCity[s.cli].pnl += s.totalPnl_dollars;
  }
  const cityAgg = Object.values(byCity).map(c => ({
    ...c,
    win_rate: c.n ? Math.round(c.wins / c.n * 1000) / 10 : 0,
    roi: c.staked ? Math.round(c.pnl / c.staked * 1000) / 10 : 0
  })).sort((a, b) => b.pnl - a.pnl);

  return new Response(JSON.stringify({
    state: state || { n_bets: 0, n_wins: 0, total_staked: 0, total_pnl: 0, win_rate: 0, roi: 0 },
    n_open_days: open.length,
    n_settled_days: settlements.length,
    by_city: cityAgg,
    open_bet_days: open.slice(0, 30),
    recent_settlements: settlements.slice(0, 30)
  }, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=120" }
  });
};

export const config = { path: "/api/paper" };
