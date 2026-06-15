// Paper-account reset/seed. GET /api/paper_reset (Basic auth, same edge gate as
// the rest of the site) wipes the paper stores and seeds a fresh $100 bankroll.
// Use once to (re)start the paper diagnostic; the paper_trader cron takes over
// from there. Returns a small JSON summary of what was cleared.
//
//   curl -u cron:hydro https://weatherbot-mf.netlify.app/api/paper_reset
//
// Optional ?bankroll=NN overrides the seed amount (defaults to 100).
import { getStore } from "@netlify/blobs";
import { runTraderCycle } from "./jackson_trader.js";

const SEED_DEFAULT = 100;

async function wipeStore(name) {
  const st = getStore(name);
  const { blobs } = await st.list().catch(() => ({ blobs: [] }));
  await Promise.all(blobs.map(b => st.delete(b.key).catch(() => {})));
  return blobs.length;
}

export default async (req) => {
  let bankroll = SEED_DEFAULT, runNow = false;
  try {
    const sp = new URL(req.url).searchParams;
    const v = parseFloat(sp.get("bankroll"));
    if (Number.isFinite(v) && v > 0) bankroll = v;
    runNow = sp.get("run") === "1";
  } catch { /* default */ }

  // Stores the paper system owns. open_bets + settled_bets are read by /api/paper;
  // paper_cooldown + paper_trader_logs are written by runTraderCycle(true).
  const cleared = {};
  for (const name of ["open_bets", "settled_bets", "paper_cooldown", "paper_trader_logs"]) {
    cleared[name] = await wipeStore(name);
  }

  const seededAt = new Date().toISOString();
  await getStore("paper_state").setJSON("global", {
    bankroll,
    n_bets_total: 0, n_wins_total: 0, total_staked: 0, total_pnl: 0,
    win_rate: 0, roi: 0,
    seeded_at: seededAt, updated_at: seededAt,
  });

  // ?run=1 → fire one paper cycle immediately for end-to-end verification (the
  // */5 cron drives it thereafter). Safe even if the just-seeded state reads stale:
  // runTraderCycle defaults to a $100 bankroll when paper_state is absent.
  let firstCycle = null;
  if (runNow) {
    try {
      const resp = await runTraderCycle(true);
      firstCycle = await resp.json().catch(() => ({ note: "ran (non-JSON response)" }));
    } catch (e) {
      firstCycle = { error: String(e) };
    }
  }

  return new Response(JSON.stringify({
    ok: true, reset: true, bankroll, seededAt, cleared,
    firstCycle: firstCycle && {
      mode: firstCycle.mode, placements: (firstCycle.placements || []).length,
      skipped: (firstCycle.skipped || []).length, errors: firstCycle.errors,
      paper_bankroll: firstCycle.paper_bankroll, cashDollars: firstCycle.cashDollars
    },
    note: "Paper account re-seeded. paper_trader (*/5 cron) will keep placing virtual bets; view at /api/paper."
  }, null, 2), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
};

export const config = { path: "/api/paper_reset" };
