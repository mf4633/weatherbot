// Combo bot — read endpoint /api/combo.
// Returns paper-trading state, open positions (with mark-to-market for weather signals
// where we have current Kalshi bids in our snapshot), recent settled, and per-source
// aggregate. Also fetches both weatherbot and rainbot's own paper bankrolls so the UI
// can render a 3-way leaderboard.

import { getStore } from "@netlify/blobs";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const RAINBOT_BASE = process.env.RAINBOT_BASE_URL || "https://rainbot-mf.netlify.app";
const STARTING_BANKROLL = 100;

async function fetchInternalKalshi() {
  try {
    const auth = "Basic " + btoa("internal:hydro");
    const r = await fetch(`${SITE_BASE}/api/kalshi`, { headers: { authorization: auth } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function fetchSelfPaper() {
  try {
    const auth = "Basic " + btoa("internal:hydro");
    const r = await fetch(`${SITE_BASE}/api/paper`, { headers: { authorization: auth } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function fetchRainbotPaper() {
  const auth = process.env.RAINBOT_BASIC_AUTH;
  if (!auth) return { error: "RAINBOT_BASIC_AUTH not set" };
  const headers = auth.startsWith("Basic ") ? { authorization: auth }
                                             : { authorization: `Basic ${auth}` };
  try {
    const r = await fetch(`${RAINBOT_BASE}/api/paper`, { headers });
    if (!r.ok) return { error: `rainbot paper ${r.status}` };
    return await r.json();
  } catch (e) { return { error: String(e) }; }
}

export default async () => {
  const stateStore   = getStore("combo_state");
  const openStore    = getStore("combo_open_bets");
  const settledStore = getStore("combo_settled_bets");

  const [state, { blobs: openBlobs }, { blobs: settledBlobs }, kalshi, weatherPaper, rainPaper] =
    await Promise.all([
      stateStore.get("global", { type: "json" }).catch(() => null),
      openStore.list().catch(() => ({ blobs: [] })),
      settledStore.list().catch(() => ({ blobs: [] })),
      fetchInternalKalshi(),
      fetchSelfPaper(),
      fetchRainbotPaper()
    ]);

  const open = (await Promise.all(
    openBlobs.map(b => openStore.get(b.key, { type: "json" }).catch(() => null))
  )).filter(Boolean).sort((a, b) => (a.placedAtUTC < b.placedAtUTC ? 1 : -1));

  const settled = (await Promise.all(
    settledBlobs.map(b => settledStore.get(b.key, { type: "json" }).catch(() => null))
  )).filter(Boolean).sort((a, b) => (a.settledAtUTC < b.settledAtUTC ? 1 : -1));

  // Mark-to-market for weatherbot-sourced positions where we have a current bid.
  // Rainbot positions don't appear in /api/kalshi so we can't MTM them here without
  // also fetching rainbot's markets — leave them at entry price.
  let unrealizedPnl = 0;
  if (kalshi?.cities) {
    const bucketByTicker = {};
    for (const c of kalshi.cities) {
      for (const arr of [c.highBuckets, c.lowBuckets]) {
        if (!arr) continue;
        for (const b of arr) bucketByTicker[b.ticker] = b;
      }
    }
    for (const bet of open) {
      if (bet.source !== "weather") continue;
      const bucket = bucketByTicker[bet.fullTicker];
      if (!bucket) continue;
      const sellPrice = bet.side === "YES" ? bucket.yes_bid : bucket.no_bid;
      if (sellPrice == null) continue;
      const contracts = bet.price > 0 ? bet.stake_dollars / bet.price : 0;
      const sellProceeds = contracts * sellPrice;
      bet.markToMarket = {
        sellPrice,
        sellProceeds: Math.round(sellProceeds * 100) / 100,
        unrealized_pnl: Math.round((sellProceeds - bet.stake_dollars) * 100) / 100
      };
      unrealizedPnl += sellProceeds - bet.stake_dollars;
    }
  }

  // Per-source aggregation over settled bets.
  const bySource = { weather: { n: 0, wins: 0, staked: 0, pnl: 0 },
                     rain:    { n: 0, wins: 0, staked: 0, pnl: 0 } };
  for (const s of settled) {
    const k = s.source === "rain" ? "rain" : "weather";
    bySource[k].n += 1;
    if (s.outcome === "WIN") bySource[k].wins += 1;
    bySource[k].staked += s.stake_dollars || 0;
    bySource[k].pnl += s.pnl_dollars || 0;
  }
  const sourceAgg = Object.entries(bySource).map(([source, a]) => ({
    source,
    n: a.n, wins: a.wins,
    win_rate_pct: a.n ? Math.round(a.wins / a.n * 1000) / 10 : 0,
    staked: Math.round(a.staked * 100) / 100,
    pnl: Math.round(a.pnl * 100) / 100,
    roi_pct: a.staked ? Math.round(a.pnl / a.staked * 1000) / 10 : 0
  }));

  // Derive aggregates from blob storage rather than the (denormalized, drift-prone) state
  // counter. Discovered 2026-05-08: trader runs were timing out before reaching the final
  // stateStore.setJSON("global", state), leaving state stuck at the May-6 init values
  // (bankroll: 50, n_bets_total: 0) even though settlements were persisting fine to
  // settledStore. Computing from settled+open is self-healing — a failed cycle only loses
  // its own work, not the running totals. State store is now used only for started_at.
  const openStake = open.reduce((a, b) => a + (b.stake_dollars || 0), 0);
  const settledPnl = settled.reduce((a, s) => a + (s.pnl_dollars || 0), 0);
  const settledStaked = settled.reduce((a, s) => a + (s.stake_dollars || 0), 0);
  const settledWins = settled.reduce((a, s) => a + (s.outcome === "WIN" ? 1 : 0), 0);
  // Cash free = starting bankroll + realized P&L on closed positions − stake locked in opens.
  const bankroll = Math.round((STARTING_BANKROLL + settledPnl - openStake) * 100) / 100;
  const totalPnl = settledPnl;
  const nBets = settled.length;
  const nWins = settledWins;
  const totalStaked = settledStaked + openStake;

  // Leaderboard: 3 paper accounts side-by-side.
  const leaderboard = [
    {
      name: "weatherbot",
      bankroll: weatherPaper?.state?.bankroll ?? null,
      mtm: weatherPaper?.state?.bankroll_mtm ?? null,
      n_bets: weatherPaper?.state?.n_bets_total ?? null,
      win_rate: weatherPaper?.state?.win_rate ?? null
    },
    {
      name: "rainbot",
      bankroll: rainPaper?.bankroll ?? null,
      mtm: null,  // rainbot's /api/paper doesn't surface MTM
      n_bets: rainPaper?.closedCount ?? null,
      win_rate: rainPaper?.hitRate ?? null,
      error: rainPaper?.error ?? null
    },
    {
      name: "combo",
      bankroll,
      mtm: Math.round((bankroll + openStake + unrealizedPnl) * 100) / 100,
      n_bets: nBets,
      win_rate: nBets ? nWins / nBets : null
    }
  ];

  // Milestone chronicle: record the first time combo overtakes each of the others
  // (and the first time it's ahead of both at once). Using MTM where available,
  // bankroll otherwise — same metric the dashboard ranks by. Stored in a single
  // blob so it survives across cycles. Side-effect write-on-read: combo.js is a
  // read endpoint but milestone capture wants to fire whenever a read shows a new
  // crossing, so we accept the tiny REST violation here.
  const valOf = p => p.mtm ?? p.bankroll;
  const wb = leaderboard.find(l => l.name === "weatherbot");
  const rb = leaderboard.find(l => l.name === "rainbot");
  const cb = leaderboard.find(l => l.name === "combo");
  const wbVal = valOf(wb), rbVal = valOf(rb), cbVal = valOf(cb);
  const milestoneStore = getStore("combo_milestones");
  const milestones = await milestoneStore.get("global", { type: "json" }).catch(() => null) || {};
  let milestonesChanged = false;
  const nowIso = new Date().toISOString();
  if (wbVal != null && cbVal != null && cbVal > wbVal && !milestones.first_overtook_weatherbot) {
    milestones.first_overtook_weatherbot = { at: nowIso, comboValue: cbVal, weatherbotValue: wbVal };
    milestonesChanged = true;
  }
  if (rbVal != null && cbVal != null && cbVal > rbVal && !milestones.first_overtook_rainbot) {
    milestones.first_overtook_rainbot = { at: nowIso, comboValue: cbVal, rainbotValue: rbVal };
    milestonesChanged = true;
  }
  const isComboLeading = cbVal != null
    && (wbVal == null || cbVal > wbVal)
    && (rbVal == null || cbVal > rbVal);
  if (isComboLeading && wbVal != null && rbVal != null && !milestones.first_leading_both) {
    milestones.first_leading_both = { at: nowIso, comboValue: cbVal,
                                       weatherbotValue: wbVal, rainbotValue: rbVal };
    milestonesChanged = true;
  }
  if (milestonesChanged) {
    await milestoneStore.setJSON("global", milestones).catch(() => {});
  }

  return new Response(JSON.stringify({
    currency: "dollar-bucks",
    starting_bankroll: STARTING_BANKROLL,
    state: {
      bankroll: Math.round(bankroll * 100) / 100,
      open_count: open.length,
      open_stake: Math.round(openStake * 100) / 100,
      cash_free: Math.round((bankroll) * 100) / 100,  // bankroll already excludes reserved stakes
      account_value: Math.round((bankroll + openStake + unrealizedPnl) * 100) / 100,
      unrealized_pnl: Math.round(unrealizedPnl * 100) / 100,
      total_pnl: Math.round(totalPnl * 100) / 100,
      n_bets_total: nBets,
      n_wins_total: nWins,
      win_rate: nBets ? Math.round(nWins / nBets * 1000) / 10 : 0,
      total_staked: Math.round(totalStaked * 100) / 100,
      roi_pct: totalStaked ? Math.round(totalPnl / totalStaked * 1000) / 10 : 0,
      max_concurrent: 20,
      started_at: state?.started_at ?? null
    },
    by_source: sourceAgg,
    leaderboard,
    is_combo_leading: isComboLeading,
    milestones,
    open_bets: open,
    recent_settled: settled.slice(0, 30),
    rainbot_link_status: rainPaper?.error ? rainPaper.error : "ok"
  }, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
  });
};

export const config = { path: "/api/combo" };
