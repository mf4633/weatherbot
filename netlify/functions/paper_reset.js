// Paper-account reset/seed. GET /api/paper_reset (Basic auth, same edge gate as
// the rest of the site) wipes the paper stores and seeds a fresh $100 bankroll.
// Use once to (re)start the paper diagnostic; the paper_trader cron takes over
// from there. Returns a small JSON summary of what was cleared.
//
//   curl -u cron:hydro https://weatherbot-mf.netlify.app/api/paper_reset
//
// Optional ?bankroll=NN overrides the seed amount (defaults to 100).
import { getStore } from "@netlify/blobs";

const SEED_DEFAULT = 100;

async function wipeStore(name) {
  const st = getStore(name);
  const { blobs } = await st.list().catch(() => ({ blobs: [] }));
  await Promise.all(blobs.map(b => st.delete(b.key).catch(() => {})));
  return blobs.length;
}

export default async (req) => {
  let bankroll = SEED_DEFAULT;
  try {
    const v = parseFloat(new URL(req.url).searchParams.get("bankroll"));
    if (Number.isFinite(v) && v > 0) bankroll = v;
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

  return new Response(JSON.stringify({
    ok: true, reset: true, bankroll, seededAt, cleared,
    note: "Paper account re-seeded. paper_trader (*/5 cron) will begin placing virtual bets next cycle; view at /api/paper."
  }, null, 2), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
};

export const config = { path: "/api/paper_reset" };
