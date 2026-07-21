// nofloor.js — the "sell the floor" strategy (2026-07-21 reorientation).
//
// Chasing the upside tail (96-97, 84-85) is a mug's game: those buckets are cheap
// because they're genuinely unlikely, and the week proved the edge sits ONE bucket
// below the moonshot, not on it. This module inverts the whole approach. A daily
// HIGH is MONOTONIC — once the observed temperature clears a bucket's ceiling, a NO
// on that bucket is mathematically won and can never reverse. So instead of betting
// a rare high happens, we bet a rare LOW *doesn't*: buy NO on a bottom bucket the
// model says the day clears with near-certainty, and exit the instant the trace
// prints past the lock temperature — hours before settle, capital freed, gain banked.
//
// Two gates, both must clear:
//   1. p_lock >= MIN_WIN_PROB — the model's probability the high EXCEEDS the ceiling
//      (the monotonic early-exit path, not the cold tail). "Near guaranteed."
//   2. return_pct >= MIN_RETURN — (1 - no_ask)/no_ask, the payout on the NO. The
//      whole point of the floor is that early in an uncertain morning the bottom
//      bucket still carries enough YES premium to pay 20%+ even though the physics
//      says it's nearly dead.
// A NO priced 83c pays (1-.83)/.83 = 20.5%. The sweet spot is a bucket the crowd
// prices at 15-20c YES that our delta/airmass read retires with confidence.

export const MIN_RETURN = 0.20;    // >= 20% payout on the NO
export const MIN_WIN_PROB = 0.93;  // "near guaranteed" the high clears the ceiling

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

// no_ask, preferring the book's direct NO ask; else derive from the YES bid
// (buying NO ~ selling YES: no_ask ≈ 1 - yes_bid). Returns null if neither is priced.
export function noAskOf(book) {
  if (book?.no_ask != null) return book.no_ask;
  if (book?.yes_bid != null) return +(1 - book.yes_bid).toFixed(4);
  return null;
}

// books: { label: { loInt, hiInt, yes_ask, yes_bid, no_ask, no_bid } }  (all buckets)
// binProbs: { label: p_yes }  (model probability the high lands IN each bucket)
// maxSoFarF: highest temp already observed today (the monotonic floor), or null.
export function scanNoFloor(books, binProbs, maxSoFarF, opts = {}) {
  const minReturn = opts.minReturn ?? MIN_RETURN;
  const minWin = opts.minWinProb ?? MIN_WIN_PROB;
  const entries = Object.entries(books || {}).map(([label, b]) => ({ label, ...b }));

  // P(high <= ceiling): sum of bin probs over buckets whose finite ceiling is at or
  // below this one. The top ">=Z" bucket (hiInt null) is never "at or below", so the
  // complement P(high > ceiling) correctly includes it — that's the lock path.
  const pAtOrBelow = (ceiling) => entries.reduce((s, b) =>
    s + (Number.isFinite(b.hiInt) && b.hiInt <= ceiling ? (binProbs?.[b.label] || 0) : 0), 0);

  const rows = entries
    .filter(b => Number.isFinite(b.hiInt))   // a floor bet needs a finite ceiling
    .sort((a, b) => a.hiInt - b.hiInt);

  const out = rows.map((b) => {
    const ceiling = b.hiInt;
    const lockTemp = ceiling + 1;             // high must reach this for the NO to lock
    const pYes = binProbs?.[b.label] ?? null;
    const alreadyLocked = maxSoFarF != null && maxSoFarF >= lockTemp;
    // p_win = NO wins by settle (includes the cold tail below a middle bucket).
    // p_lock = NO wins via the MONOTONIC early-exit path (high clears the ceiling).
    // For the bottom open bucket (loInt null) there is no cold tail: p_lock == p_win.
    const pWin = alreadyLocked ? 1 : (pYes != null ? 1 - pYes : null);
    const pLock = alreadyLocked ? 1 : 1 - pAtOrBelow(ceiling);
    const noAsk = noAskOf(b);
    const returnPct = noAsk != null && noAsk > 0 && noAsk < 1 ? (1 - noAsk) / noAsk : null;
    const evProfit = pWin != null && noAsk != null ? pWin - noAsk : null;
    const degToLock = maxSoFarF != null ? +(lockTemp - maxSoFarF).toFixed(1) : null;
    // Gate on p_lock (not p_win): the early exit — the entire reason for this
    // strategy — only fires via the lock path. A middle bucket that "wins" only
    // because it might come in cold does not give an early exit and is not a floor.
    const candidate = !alreadyLocked && pLock != null && returnPct != null &&
      pLock >= minWin && returnPct >= minReturn;
    return {
      label: b.label, pure_floor: b.loInt == null, ceiling, lock_temp: lockTemp,
      p_yes: r3(pYes), p_win: r3(pWin), p_lock: r3(pLock),
      no_ask: noAsk, return_pct: returnPct == null ? null : Math.round(returnPct * 1000) / 10,
      ev_profit: r3(evProfit), deg_to_lock: degToLock, already_locked: alreadyLocked, candidate,
    };
  });

  const candidates = out.filter(o => o.candidate)
    .sort((a, b) => (b.ev_profit ?? -1) - (a.ev_profit ?? -1));
  return { candidates, evaluated: out };
}

// ---- scoring the logged floor picks against CLI settles ------------------------
// A pick WON if the settled high cleared the lock temperature. Realized return is
// the NO payout (1 - no_ask)/no_ask on a win, -1 (lost the stake) on a loss. Reports
// hit rate and mean realized return so "near guaranteed 20%" is a measured claim,
// not a promise.
export function scoreNoFloor(picks, cliMaxByKey) {
  let n = 0, wins = 0, sumRet = 0, sumStakeRet = 0;
  const losses = [];
  for (const p of picks) {
    const cliMax = cliMaxByKey[`${p.station}|${p.contract_date}`];
    if (cliMax == null || p.no_ask == null) continue;
    n++;
    const won = cliMax >= p.lock_temp;
    const ret = won ? (1 - p.no_ask) / p.no_ask : -1;   // return on stake
    if (won) wins++; else losses.push({ ...p, cli_max: cliMax });
    sumRet += ret;
    sumStakeRet += won ? (1 - p.no_ask) : -p.no_ask;    // profit per $1 face
  }
  return {
    n, wins, losses: losses.length,
    hit_rate: n ? Math.round((wins / n) * 1000) / 10 : null,
    mean_return_pct: n ? Math.round((sumRet / n) * 1000) / 10 : null,
    mean_profit_per_contract: n ? r3(sumStakeRet / n) : null,
    loss_detail: losses.slice(0, 10),
  };
}
