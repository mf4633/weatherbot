// Read-only viewer for prediction_snapshots blob. Returns settled snapshots
// (with actualHigh/actualLow + residuals backfilled by logger.js runSnapshotSettle).
// Optional query: ?city=Chicago to filter, ?limit=N to cap.

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const cityFilter = url.searchParams.get("city");
  const cliFilter = url.searchParams.get("cli");
  const limit = Math.max(1, Math.min(5000, parseInt(url.searchParams.get("limit") || "2000", 10)));
  const settledOnly = url.searchParams.get("settled") !== "0";
  try {
    const store = getStore("prediction_snapshots");
    const { blobs } = await store.list();
    let keys = (blobs || []).map(b => b.key);
    if (cliFilter) keys = keys.filter(k => k.startsWith(`${cliFilter}/`));
    keys.sort().reverse();   // newest local-date first
    keys = keys.slice(0, limit);
    const records = (await Promise.all(
      keys.map(k => store.get(k, { type: "json" }).catch(() => null))
    )).filter(Boolean);
    let out = records;
    if (settledOnly) out = out.filter(r => r.settled);
    if (cityFilter) out = out.filter(r => r.name === cityFilter);
    return new Response(JSON.stringify({
      total_in_store: blobs?.length ?? 0,
      returned: out.length,
      filter: { city: cityFilter, cli: cliFilter, settledOnly },
      records: out
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

export const config = { path: "/api/snapshots" };
