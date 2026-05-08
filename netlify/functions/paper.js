// Paper-trading dashboard. Returns: bankroll, open bets, settled bets, unrealized P&L,
// rolling stats. Mark-to-market open positions using current Kalshi bid prices.

import { getStore } from "@netlify/blobs";

const SITE_BASE = "https://weatherbot-mf.netlify.app";

async function fetchKalshiSnapshot() {
  try {
    const auth = "Basic " + btoa("internal:hydro");
    const r = await fetch(`${SITE_BASE}/api/kalshi`, { headers: { authorization: auth } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

export default async () => {
  const stateStore = getStore("paper_state");
  const openStore = getStore("open_bets");
  const settledStore = getStore("settled_bets");

  const state = await stateStore.get("global", { type: "json" }).catch(() => null) || {
    bankroll: 100, n_bets_total: 0, n_wins_total: 0, total_staked: 0, total_pnl: 0,
    win_rate: 0, roi: 0
  };

  const [{ blobs: openBlobs }, { blobs: settledBlobs }, kalshi] = await Promise.all([
    openStore.list().catch(() => ({ blobs: [] })),
    settledStore.list().catch(() => ({ blobs: [] })),
    fetchKalshiSnapshot()
  ]);
  let open = (await Promise.all(
    openBlobs.map(b => openStore.get(b.key, { type: "json" }).catch(() => null))
  )).filter(Boolean).sort((a, b) => (a.placedAtUTC < b.placedAtUTC ? 1 : -1));
  const settled = (await Promise.all(
    settledBlobs.map(b => settledStore.get(b.key, { type: "json" }).catch(() => null))
  )).filter(Boolean).sort((a, b) => (a.settledAtUTC < b.settledAtUTC ? 1 : -1));

  // Mark-to-market: for each open bet, find its current Kalshi bid and compute unrealized P&L.
  // kalshi.js b.ticker is the FULL Kalshi ticker; bet.ticker (from logger) is the short
  // bucket code. Index by the short code on both sides so the lookup hits.
  if (kalshi?.cities) {
    const bucketByTicker = {};
    for (const c of kalshi.cities) {
      for (const arr of [c.highBuckets, c.lowBuckets]) {
        if (!arr) continue;
        for (const b of arr) {
          const code = (b.ticker || "").split("-").pop();
          if (code) bucketByTicker[`${c.name}-${code}`] = b;
        }
      }
    }
    for (const bet of open) {
      const betCode = (bet.ticker || "").split("-").pop();
      const key = `${bet.city}-${betCode}`;
      const bucket = bucketByTicker[key];
      if (!bucket) continue;
      // Field names on the kalshi.js bucket object are yes_bid / no_bid (not
      // kalshi_yes_bid / kalshi_no_bid).
      const sellPrice = bet.side === "YES" ? bucket.yes_bid : bucket.no_bid;
      if (sellPrice == null) continue;
      const contracts = bet.stake_dollars / bet.price;
      const sellProceeds = contracts * sellPrice;
      bet.markToMarket = {
        sellPrice,
        sellProceeds: Math.round(sellProceeds * 100) / 100,
        unrealized_pnl: Math.round((sellProceeds - bet.stake_dollars) * 100) / 100
      };
    }
  }
  const unrealizedPnl = open.reduce((a, b) => a + (b.markToMarket?.unrealized_pnl || 0), 0);

  const bet_size = Math.max(1, state.bankroll / 20);
  const max_concurrent = Math.min(20, Math.floor(state.bankroll / bet_size));
  const openStake = open.reduce((a, b) => a + (b.stake_dollars || 0), 0);

  const byCity = {};
  for (const s of settled) {
    if (!byCity[s.targetCli]) byCity[s.targetCli] = { cli: s.targetCli, city: s.city, n: 0, wins: 0, sold: 0, staked: 0, pnl: 0 };
    byCity[s.targetCli].n += 1;
    if (s.outcome === "WIN") byCity[s.targetCli].wins += 1;
    if (s.outcome === "SOLD") byCity[s.targetCli].sold += 1;
    byCity[s.targetCli].staked += s.stake_dollars;
    byCity[s.targetCli].pnl += s.pnl_dollars;
  }
  const cityAgg = Object.values(byCity).map(c => ({
    ...c,
    win_rate_pct: c.n ? Math.round(c.wins / c.n * 1000) / 10 : 0,
    roi_pct: c.staked ? Math.round(c.pnl / c.staked * 1000) / 10 : 0
  })).sort((a, b) => b.pnl - a.pnl);

  const totalSold = settled.filter(s => s.outcome === "SOLD").length;

  return new Response(JSON.stringify({
    currency: "dollar-bucks",
    state: {
      ...state,
      bet_size_dollars: Math.round(bet_size * 100) / 100,
      max_concurrent,
      open_count: open.length,
      open_stake_dollars: Math.round(openStake * 100) / 100,
      cash_free: Math.round((state.bankroll - openStake) * 100) / 100,
      n_sold_total: totalSold,
      unrealized_pnl: Math.round(unrealizedPnl * 100) / 100,
      bankroll_mtm: Math.round((state.bankroll + unrealizedPnl) * 100) / 100
    },
    by_city: cityAgg,
    open_bets: open,
    recent_settled: settled.slice(0, 50)
  }, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
  });
};

export const config = { path: "/api/paper" };
