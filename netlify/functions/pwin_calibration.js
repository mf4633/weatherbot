// Read endpoint for pWin calibration state. Pattern mirrors calibration_state.js.
// GET /api/pwin_calibration            — current state
// GET /api/pwin_calibration?seed=1    — force a fit run (admin/debug)

import { getStore } from "@netlify/blobs";

const CALIBRATION_STORE = "pwin_calibration_state";
const CALIBRATION_KEY   = "current.json";

export default async (req) => {
  if (req?.url) {
    try {
      const u = new URL(req.url);
      if (u.searchParams.get("seed") === "1") {
        const mod = await import("./pwin_calibration_fit.js");
        return mod.default();
      }
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
        { status: 500, headers: { "content-type": "application/json" } });
    }
  }
  try {
    const store = getStore(CALIBRATION_STORE);
    const blob = await store.get(CALIBRATION_KEY, { type: "json" });
    if (!blob) {
      return new Response(JSON.stringify({ ok: true, seeded: false,
        message: "No fit yet — GET /api/pwin_calibration?seed=1 or wait for the cron." }),
        { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    return new Response(JSON.stringify({ ok: true, ...blob }, null, 2),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
      { status: 500, headers: { "content-type": "application/json" } });
  }
};

export const config = { path: "/api/pwin_calibration" };
