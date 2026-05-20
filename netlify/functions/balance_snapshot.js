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

async function loadAllFromStore(storeName, source) {
  const store = getStore(storeName);
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  const entries = await Promise.all(
    blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null))
  );
  return entries.filter(Boolean).map(b => ({ ...b, _source: source }));
}

function aggregate(bets) {
  let wins = 0, losses = 0, pnl = 0, fees = 0, stake = 0;
  for (const b of bets) {
    if (b.outcome === "WIN")  wins++;
    if (b.outcome === "LOSS") losses++;
    pnl   += b.realized_pnl ?? 0;
    fees  += b.fees_paid    ?? 0;
    stake += b.stake_dollars ?? 0;
  }
  const decided = wins + losses;
  return {
    settledBets: bets.length,
    wins, losses,
    hitRate: decided ? wins / decided : 0,
    realizedPnl: Math.round(pnl   * 100) / 100,
    feesPaid:    Math.round(fees  * 100) / 100,
    stakeTotal:  Math.round(stake * 100) / 100,
    roi: stake > 0 ? Math.round((pnl / stake) * 1000) / 1000 : 0,
  };
}

async function loadSettledStats() {
  // Weather (jackson_trader) + rain (jackson_rain_trader) share one Kalshi account,
  // so total-equity snapshot needs both. Stats include a per-source breakdown for
  // attribution; bySource['weather'].realizedPnl + bySource['rain'].realizedPnl
  // should reconcile to total.realizedPnl modulo rounding.
  const [weather, rain] = await Promise.all([
    loadAllFromStore("jackson_settled_bets",      "weather"),
    loadAllFromStore("jackson_rain_settled_bets", "rain"),
  ]);
  const all = [...weather, ...rain];
  return {
    ...aggregate(all),
    bySource: {
      weather: aggregate(weather),
      rain:    aggregate(rain),
    },
  };
}

// One-shot backfill for days the Netlify scheduled binding silently missed
// (see .github/workflows/balance-snapshot-cron.yml for the live fix). Anchors
// at first + last real entries; walks settled-bet cash flow forward for the
// shape; spreads the residual (open-position MTM drift over the gap) linearly
// across the gap days. Entries are tagged `backfilled: true` and never
// overwrite real snapshots.
export async function backfillEquityHistory() {
  const store = getStore("balance_history");
  const existing = (await store.get(HISTORY_KEY, { type: "json" })) || { entries: [] };
  const real = (existing.entries || []).filter(e => !e.backfilled);
  if (real.length < 2) {
    return { ok: false, reason: "Need >= 2 real entries (start + end) to anchor backfill", realCount: real.length };
  }
  real.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
  const startEntry = real[0];
  const endEntry   = real[real.length - 1];

  const gapDates = [];
  const cur = new Date(startEntry.dateUtc + "T00:00:00Z");
  cur.setUTCDate(cur.getUTCDate() + 1);
  const endDate = new Date(endEntry.dateUtc + "T00:00:00Z");
  while (cur < endDate) {
    gapDates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  if (gapDates.length === 0) {
    return { ok: true, gap: 0, filled: 0, reason: "No gap between anchors" };
  }

  const settledStore = getStore("jackson_settled_bets");
  const { blobs } = await settledStore.list().catch(() => ({ blobs: [] }));
  const bets = (await Promise.all(
    blobs.map(b => settledStore.get(b.key, { type: "json" }).catch(() => null))
  )).filter(Boolean);
  const flowByDate = {};
  for (const bet of bets) {
    const d = bet.settledAtUTC?.slice(0, 10);
    if (!d) continue;
    flowByDate[d] = flowByDate[d] || { pnl: 0, fees: 0, count: 0 };
    flowByDate[d].pnl   += bet.realized_pnl ?? 0;
    flowByDate[d].fees  += bet.fees_paid    ?? 0;
    flowByDate[d].count += 1;
  }

  let running = startEntry.totalEquityDollars;
  const rawByDate = {};
  for (const d of [...gapDates, endEntry.dateUtc]) {
    const f = flowByDate[d] || { pnl: 0, fees: 0 };
    running += (f.pnl - f.fees);
    rawByDate[d] = running;
  }
  const residual = endEntry.totalEquityDollars - rawByDate[endEntry.dateUtc];
  const perDayCorrection = residual / (gapDates.length + 1);

  const filled = [];
  for (let i = 0; i < gapDates.length; i++) {
    const d = gapDates[i];
    const corrected = rawByDate[d] + perDayCorrection * (i + 1);
    const f = flowByDate[d] || { pnl: 0, fees: 0, count: 0 };
    filled.push({
      dateUtc: d,
      tsUTC: d + "T00:00:00.000Z",
      cashCents: null,
      portfolioValueCents: null,
      totalEquityCents: Math.round(corrected * 100),
      cashDollars: null,
      portfolioValueDollars: null,
      totalEquityDollars: Math.round(corrected * 100) / 100,
      settledStats: {
        settledBets: f.count,
        realizedPnl: Math.round(f.pnl * 100) / 100,
        feesPaid:    Math.round(f.fees * 100) / 100,
      },
      backfilled: true,
    });
  }

  const realByDate = Object.fromEntries((existing.entries || []).map(e => [e.dateUtc, e]));
  const merged = [...(existing.entries || [])];
  for (const f of filled) {
    if (!realByDate[f.dateUtc]) merged.push(f);
  }
  merged.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
  await store.setJSON(HISTORY_KEY, { entries: merged, updatedAt: new Date().toISOString() });

  return {
    ok: true,
    gapDays: gapDates.length,
    filled: filled.length,
    anchorStart: { date: startEntry.dateUtc, equity: startEntry.totalEquityDollars },
    anchorEnd:   { date: endEntry.dateUtc,   equity: endEntry.totalEquityDollars },
    residualDollars: Math.round(residual * 100) / 100,
    perDayCorrection: Math.round(perDayCorrection * 100) / 100,
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
