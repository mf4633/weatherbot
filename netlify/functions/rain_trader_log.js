// Read-only viewer for jackson_rain_logs blob store.
// Mirror of trader_log.js but for the rain trader's cycle log.

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") || "50", 10)));
  const filter = url.searchParams.get("filter");  // "placed" | "skipped" | null
  try {
    const store = getStore("jackson_rain_logs");
    const list = await store.list();
    const keys = (list.blobs || []).map(b => b.key).sort().reverse().slice(0, limit);
    const entries = (await Promise.all(
      keys.map(k => store.get(k, { type: "json" }).catch(() => null))
    )).filter(Boolean);

    const filtered = filter === "placed" ? entries.filter(e => (e.placements || []).length > 0)
                   : filter === "skipped" ? entries.filter(e => (e.skipped || []).length > 0)
                   : entries;

    return new Response(JSON.stringify({
      total_cycles_in_store: keys.length,
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

export const config = { path: "/api/rain_trader_log" };
