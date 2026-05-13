// Read endpoint for calibration_state blob. Also seeds via ?seed=1 since
// calibration_update is scheduled-only (no custom HTTP path allowed).

import { getStore } from "@netlify/blobs";

export default async (req) => {
  // Manual seed entry point — mirrors balance_history.js pattern.
  if (req?.url) {
    try {
      const u = new URL(req.url);
      if (u.searchParams.get("seed") === "1") {
        const mod = await import("./calibration_update.js");
        return mod.default();
      }
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
        { status: 500, headers: { "content-type": "application/json" } });
    }
  }
  try {
    const store = getStore("calibration_state");
    const blob = await store.get("current.json", { type: "json" });
    if (!blob) {
      return new Response(JSON.stringify({ ok: true, seeded: false,
        message: "No calibration yet — POST /api/calibration_state?seed=1 or wait for the cron." }),
        { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    return new Response(JSON.stringify({ ok: true, ...blob }, null, 2),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
      { status: 500, headers: { "content-type": "application/json" } });
  }
};

export const config = { path: "/api/calibration_state" };
