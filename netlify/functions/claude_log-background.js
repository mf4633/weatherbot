// claude_log-background.js — the RELIABLE logger for the Claude scoreboard.
// The `-background` suffix makes this a Netlify background function: returns 202
// immediately and runs up to 15 minutes, so it can finish the heavy predict path
// that the synchronous /api/claude times out on at ~10s. Writes a status blob
// (status/last_log.json) capturing what it did — readable via /api/claude?mode=status
// — so failures are observable without Netlify log access. The GitHub cron hits this
// hourly. Reads only; places no trades.

import { getStore } from "@netlify/blobs";
import { runPredict, runSettle, STORE } from "./lib/claude_engine.js";

export default async () => {
  const status = { ranAt: new Date().toISOString() };
  try {
    const pred = await runPredict(true);
    status.predict = { ok: pred.ok, cities: pred.count, logged: pred.logged, errors: (pred.errors || []).slice(0, 5), analog_starved: pred.analog_starved || [] };
  } catch (e) {
    status.predict = { ok: false, error: String(e?.message || e) };
  }
  try {
    const s = await runSettle();
    status.settle = { ok: s.ok, settled: s.settled?.length ?? 0 };
  } catch (e) {
    status.settle = { ok: false, error: String(e?.message || e) };
  }
  // Persist the outcome so we can read it back via ?mode=status (Netlify function
  // logs aren't reachable from the dev environment; a blob is).
  try { await getStore(STORE).setJSON("status/last_log.json", status); }
  catch (e) { status.statusWriteError = String(e?.message || e); }
  console.log("[claude-log-bg] " + JSON.stringify(status));
  return new Response("ok");
};
