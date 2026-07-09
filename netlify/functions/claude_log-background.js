// claude_log-background.js — the RELIABLE logger for the Claude scoreboard.
// The `-background` suffix makes this a Netlify background function: it returns 202
// immediately and runs up to 15 minutes, so it can finish the heavy predict path
// (two self-HTTP calls + a 78-station METAR fetch + per-city compute) that the
// synchronous /api/claude times out on at ~10s — which is why the store was empty.
// The GitHub cron hits this hourly. Reads only; places no trades.

import { runPredict, runSettle } from "./lib/claude_engine.js";

export default async () => {
  const pred = await runPredict(true).catch(e => ({ ok: false, error: String(e?.message || e) }));
  const settle = await runSettle().catch(e => ({ ok: false, error: String(e?.message || e) }));
  // Background responses are ignored by the caller; this line is for the function log.
  console.log("[claude-log-bg] " + JSON.stringify({
    predicted: pred.count ?? null, logged: pred.logged ?? null,
    predictErrors: pred.errors?.length ?? (pred.error ? [pred.error] : 0),
    settled: settle.settled?.length ?? null, settleError: settle.error ?? null,
  }));
  return new Response("ok");
};
