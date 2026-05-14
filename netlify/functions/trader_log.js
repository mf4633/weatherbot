// Read-only viewer for trader_logs blob store.
// Returns the most recent N (default 50) cycles, newest first.
// Each entry has placements/sales/skipped detail with pWin and expected payout.

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") || "50", 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
  const filter = url.searchParams.get("filter");  // "placed" | "skipped" | null
  try {
    const store = getStore("trader_logs");
    const list = await store.list();
    // Keys are ISO timestamps; lexical sort puts newest last → reverse.
    const allKeys = (list.blobs || []).map(b => b.key).sort().reverse();
    const totalAvailable = allKeys.length;
    const keys = allKeys.slice(offset, offset + limit);
    const entries = (await Promise.all(
      keys.map(k => store.get(k, { type: "json" }).catch(() => null))
    )).filter(Boolean);

    // Optional filter to only show cycles with placements or skipped activity.
    const filtered = filter === "placed" ? entries.filter(e => (e.placements || []).length > 0)
                   : filter === "skipped" ? entries.filter(e => (e.skipped || []).length > 0)
                   : entries;

    return new Response(JSON.stringify({
      total_cycles_in_store: totalAvailable,
      offset, limit,
      returned: filtered.length,
      filter,
      entries: filtered
    }, null, 2), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }
};

export const config = { path: "/api/trader_log" };
