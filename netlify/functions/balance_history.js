// Read endpoint for the balance_history blob. Returns entries + derived
// rollups (peak equity, current drawdown, daily Δ, days running).

import { getStore } from "@netlify/blobs";
import { takeBalanceSnapshot } from "./balance_snapshot.js";

export default async (req) => {
  // Manual seed entry point — Netlify scheduled functions can't have a custom
  // HTTP path, so seeding before the first 00:00 UTC tick goes through here.
  if (req?.url) {
    try {
      const u = new URL(req.url);
      if (u.searchParams.get("seed") === "1") {
        const result = await takeBalanceSnapshot();
        return new Response(JSON.stringify({ ok: true, seeded: true, ...result }, null, 2),
          { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, seeded: true, error: String(e?.message || e) }),
        { status: 500, headers: { "content-type": "application/json" } });
    }
  }
  try {
    const store = getStore("balance_history");
    const blob = await store.get("history.json", { type: "json" });
    const entries = blob?.entries || [];
    if (!entries.length) {
      return new Response(JSON.stringify({ ok: true, entries: [], rollup: null }),
        { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const equities = entries.map(e => e.totalEquityDollars);
    const peak = Math.max(...equities);
    const first = entries[0].totalEquityDollars;
    const last  = entries[entries.length - 1].totalEquityDollars;
    const drawdownDollars = peak - last;
    const drawdownPct     = peak > 0 ? drawdownDollars / peak : 0;
    const prev = entries.length >= 2 ? entries[entries.length - 2].totalEquityDollars : last;
    const dayDelta = last - prev;
    const totalDelta = last - first;

    const rollup = {
      daysRunning: entries.length,
      firstEquity: first,
      currentEquity: last,
      peakEquity: peak,
      drawdownDollars: Math.round(drawdownDollars * 100) / 100,
      drawdownPct:     Math.round(drawdownPct * 10000) / 100,  // as %
      lastDayDelta:    Math.round(dayDelta * 100) / 100,
      totalDelta:      Math.round(totalDelta * 100) / 100,
      avgDailyDelta:   entries.length >= 2 ? Math.round((totalDelta / (entries.length - 1)) * 100) / 100 : 0,
      latest:          entries[entries.length - 1],
    };
    return new Response(JSON.stringify({ ok: true, rollup, entries }, null, 2),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
      { status: 500, headers: { "content-type": "application/json" } });
  }
};

export const config = { path: "/api/balance_history" };
