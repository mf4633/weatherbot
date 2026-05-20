// Read endpoint for the combo_balance_history blob. Mirrors balance_history.js
// shape so the dashboard can use the same chart code. Also handles ?seed=1 and
// ?backfill=1 admin entry points (scheduled fn can't have a custom HTTP path).

import { getStore } from "@netlify/blobs";
import { takeComboSnapshot, backfillComboHistory } from "./combo_balance_snapshot.js";

export default async (req) => {
  if (req?.url) {
    try {
      const u = new URL(req.url);
      if (u.searchParams.get("seed") === "1") {
        const result = await takeComboSnapshot();
        return new Response(JSON.stringify({ ok: true, seeded: true, ...result }, null, 2),
          { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      if (u.searchParams.get("backfill") === "1") {
        const result = await backfillComboHistory();
        return new Response(JSON.stringify(result, null, 2),
          { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
        { status: 500, headers: { "content-type": "application/json" } });
    }
  }
  try {
    const store = getStore("combo_balance_history");
    const blob = await store.get("history.json", { type: "json" });
    const entries = blob?.entries || [];
    if (!entries.length) {
      return new Response(JSON.stringify({ ok: true, entries: [], rollup: null }),
        { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const values = entries.map(e => e.accountValueDollars ?? e.totalEquityDollars);
    const peak  = Math.max(...values);
    const first = values[0];
    const last  = values[values.length - 1];
    const drawdownDollars = peak - last;
    const drawdownPct     = peak > 0 ? drawdownDollars / peak : 0;
    const prev = values.length >= 2 ? values[values.length - 2] : last;
    const dayDelta   = last - prev;
    const totalDelta = last - first;

    const rollup = {
      daysRunning: entries.length,
      firstEquity: first,
      currentEquity: last,
      peakEquity: peak,
      drawdownDollars: Math.round(drawdownDollars * 100) / 100,
      drawdownPct:     Math.round(drawdownPct * 10000) / 100,
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

export const config = { path: "/api/combo_balance_history" };
