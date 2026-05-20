// Daily snapshot for the combo paper bot. Mirrors balance_snapshot.js but
// derives account_value from combo_open_bets + combo_settled_bets blobs
// (combo has no real Kalshi account — it's $100 paper). Same dead-binding
// workaround as the main snapshot: schedule + GH Actions fallback hitting
// /.netlify/functions/combo_balance_snapshot directly.

import { getStore } from "@netlify/blobs";

const HISTORY_KEY = "history.json";
const TRIM_DAYS = 730;
const STARTING_BANKROLL = 100;

function todayUtcKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function loadAll(storeName) {
  const store = getStore(storeName);
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  const entries = await Promise.all(
    blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null))
  );
  return entries.filter(Boolean);
}

function aggregate(bets) {
  let wins = 0, losses = 0, pnl = 0, stake = 0;
  for (const b of bets) {
    if (b.outcome === "WIN")  wins++;
    if (b.outcome === "LOSS") losses++;
    pnl   += b.pnl_dollars   ?? 0;
    stake += b.stake_dollars ?? 0;
  }
  const decided = wins + losses;
  return {
    settledBets: bets.length,
    wins, losses,
    hitRate: decided ? wins / decided : 0,
    pnl:        Math.round(pnl   * 100) / 100,
    stakeTotal: Math.round(stake * 100) / 100,
    roi: stake > 0 ? Math.round((pnl / stake) * 1000) / 1000 : 0,
  };
}

export async function takeComboSnapshot() {
  const now = new Date();
  const dateKey = todayUtcKey(now);

  const [openBets, settledBets] = await Promise.all([
    loadAll("combo_open_bets"),
    loadAll("combo_settled_bets"),
  ]);

  const openStake = openBets.reduce((s, b) => s + (b.stake_dollars || 0), 0);
  const settledPnl = settledBets.reduce((s, b) => s + (b.pnl_dollars || 0), 0);
  // Bankroll = cash free for staking. Open positions are held at cost (paper has
  // no MTM — combo doesn't read live Kalshi prices for open tickers).
  const bankroll = STARTING_BANKROLL + settledPnl - openStake;
  const accountValueAtCost = bankroll + openStake;  // == STARTING_BANKROLL + settledPnl

  const weather = settledBets.filter(b => b.source === "weather");
  const rain    = settledBets.filter(b => b.source === "rain");

  const settledStats = {
    ...aggregate(settledBets),
    bySource: {
      weather: aggregate(weather),
      rain:    aggregate(rain),
    },
  };

  const entry = {
    dateUtc: dateKey,
    tsUTC: now.toISOString(),
    bankrollDollars:           Math.round(bankroll * 100) / 100,
    openStakeDollars:          Math.round(openStake * 100) / 100,
    openCount:                 openBets.length,
    accountValueDollars:       Math.round(accountValueAtCost * 100) / 100,
    totalEquityDollars:        Math.round(accountValueAtCost * 100) / 100,  // alias for shared chart code
    settledStats,
  };

  const store = getStore("combo_balance_history");
  const existing = (await store.get(HISTORY_KEY, { type: "json" })) || { entries: [] };
  const filtered = (existing.entries || []).filter(e => e.dateUtc !== dateKey);
  filtered.push(entry);
  filtered.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
  const trimmed = filtered.slice(-TRIM_DAYS);
  await store.setJSON(HISTORY_KEY, { entries: trimmed, updatedAt: now.toISOString() });

  return { dateUtc: dateKey, accountValueDollars: entry.accountValueDollars, entries: trimmed.length, settledStats };
}

// Backfill missing days from settled-bet cash flow alone — combo is paper, has
// no MTM drift, so reconstruction is exact (modulo bets that opened+closed
// entirely within the gap, which contribute net pnl directly).
export async function backfillComboHistory() {
  const store = getStore("combo_balance_history");
  const existing = (await store.get(HISTORY_KEY, { type: "json" })) || { entries: [] };
  const real = (existing.entries || []).filter(e => !e.backfilled);
  if (real.length < 1) {
    return { ok: false, reason: "Need >= 1 real entry to anchor", realCount: real.length };
  }
  real.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
  const startEntry = real[0];
  const today = todayUtcKey();

  const gapDates = [];
  const cur = new Date(startEntry.dateUtc + "T00:00:00Z");
  cur.setUTCDate(cur.getUTCDate() + 1);
  const endDate = new Date(today + "T00:00:00Z");
  while (cur < endDate) {
    gapDates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  if (gapDates.length === 0) return { ok: true, gap: 0, filled: 0 };

  const settledBets = await loadAll("combo_settled_bets");
  const flowByDate = {};
  for (const b of settledBets) {
    const d = b.settledAtUTC?.slice(0, 10);
    if (!d) continue;
    flowByDate[d] = flowByDate[d] || { pnl: 0, count: 0 };
    flowByDate[d].pnl   += b.pnl_dollars ?? 0;
    flowByDate[d].count += 1;
  }

  let running = startEntry.accountValueDollars ?? startEntry.totalEquityDollars;
  const filled = [];
  const realByDate = Object.fromEntries((existing.entries || []).map(e => [e.dateUtc, e]));
  for (const d of gapDates) {
    const f = flowByDate[d] || { pnl: 0, count: 0 };
    running += f.pnl;
    if (realByDate[d]) continue;
    filled.push({
      dateUtc: d,
      tsUTC: d + "T00:00:00.000Z",
      accountValueDollars: Math.round(running * 100) / 100,
      totalEquityDollars:  Math.round(running * 100) / 100,
      settledStats: { settledBets: f.count, pnl: Math.round(f.pnl * 100) / 100 },
      backfilled: true,
    });
  }

  const merged = [...(existing.entries || []), ...filled];
  merged.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
  await store.setJSON(HISTORY_KEY, { entries: merged, updatedAt: new Date().toISOString() });

  return { ok: true, gapDays: gapDates.length, filled: filled.length, anchor: { date: startEntry.dateUtc, value: startEntry.accountValueDollars ?? startEntry.totalEquityDollars } };
}

export default async () => {
  try {
    const result = await takeComboSnapshot();
    return new Response(JSON.stringify({ ok: true, ...result }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
      { status: 500, headers: { "content-type": "application/json" } });
  }
};

export const config = { schedule: "0 0 * * *" };
