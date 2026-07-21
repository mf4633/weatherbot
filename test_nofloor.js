// test_nofloor.js — the sell-the-floor strategy: scan gates, monotonic lock, scorer.
import { scanNoFloor, scoreNoFloor, noAskOf, MIN_RETURN, MIN_WIN_PROB }
  from "./netlify/functions/lib/nofloor.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };
const approx = (a, b, tol = 0.01) => a != null && Math.abs(a - b) <= tol;

// A five-bucket ladder: <=88, 89-90, 91-92, 93-94, >=95.
const ladder = (over = {}) => ({
  "<=88":  { loInt: null, hiInt: 88, no_ask: 0.80, yes_bid: 0.18, ...(over["<=88"] || {}) },
  "89-90": { loInt: 89, hiInt: 90, no_ask: 0.70, yes_bid: 0.28, ...(over["89-90"] || {}) },
  "91-92": { loInt: 91, hiInt: 92, no_ask: 0.55, yes_bid: 0.44, ...(over["91-92"] || {}) },
  "93-94": { loInt: 93, hiInt: 94, no_ask: 0.72, yes_bid: 0.26, ...(over["93-94"] || {}) },
  ">=95":  { loInt: 95, hiInt: null, no_ask: 0.90, yes_bid: 0.09, ...(over[">=95"] || {}) },
});
// Model: the day is clearly warm — the bottom bucket is nearly dead.
const probs = { "<=88": 0.03, "89-90": 0.12, "91-92": 0.45, "93-94": 0.30, ">=95": 0.10 };

// ---- noAskOf: prefer the book's NO, else derive from YES bid ----
{
  ok("noAsk: direct no_ask wins", noAskOf({ no_ask: 0.8, yes_bid: 0.1 }) === 0.8);
  ok("noAsk: derive 1 - yes_bid", approx(noAskOf({ yes_bid: 0.18 }), 0.82));
  ok("noAsk: neither → null", noAskOf({}) === null);
}

// ---- core scan: bottom bucket is the pure floor, gates on p_lock + return ----
{
  const { candidates, evaluated } = scanNoFloor(ladder(), probs, 82);
  const bottom = evaluated.find(e => e.label === "<=88");
  ok("scan: bottom bucket flagged pure_floor", bottom.pure_floor === true);
  ok("scan: lock_temp = ceiling + 1", bottom.lock_temp === 89);
  ok("scan: p_win == p_lock for the open bottom bucket", approx(bottom.p_win, bottom.p_lock) && approx(bottom.p_win, 0.97));
  ok("scan: return on NO 0.80 is 25%", approx(bottom.return_pct, 25, 0.1));
  ok("scan: bottom bucket is a candidate (97% win, 25% return)", bottom.candidate === true);
  ok("scan: candidates ranked by ev_profit", candidates.length && candidates[0].ev_profit >= candidates[candidates.length - 1].ev_profit);
}

// ---- p_lock excludes the cold tail on a MIDDLE bucket ----
{
  const { evaluated } = scanNoFloor(ladder(), probs, 82);
  const mid = evaluated.find(e => e.label === "89-90");   // ceiling 90, lock 91
  // p_win = 1 - 0.12 = 0.88 (includes the 0.03 cold tail below). p_lock = P(high>90)
  // = 0.45+0.30+0.10 = 0.85 (excludes the cold tail — only the early-exit path).
  ok("scan: middle p_win includes cold tail (0.88)", approx(mid.p_win, 0.88));
  ok("scan: middle p_lock excludes cold tail (0.85)", approx(mid.p_lock, 0.85));
  ok("scan: p_win > p_lock on a middle bucket", mid.p_win > mid.p_lock);
}

// ---- monotonic early-exit: once maxSoFar clears lock_temp, no return left ----
{
  const { evaluated } = scanNoFloor(ladder(), probs, 91);  // already 91: <=88 and 89-90 are locked
  const b88 = evaluated.find(e => e.label === "<=88");
  const b90 = evaluated.find(e => e.label === "89-90");
  ok("lock: <=88 already_locked at maxSoFar 91", b88.already_locked === true && b88.candidate === false);
  ok("lock: 89-90 already_locked at maxSoFar 91 (>=91)", b90.already_locked === true);
  ok("lock: locked bucket p_win forced to 1", b88.p_win === 1);
  const b92 = evaluated.find(e => e.label === "91-92");   // ceiling 92, lock 93, not yet locked
  ok("lock: 91-92 not yet locked at 91 (needs 93)", b92.already_locked === false && b92.deg_to_lock === 2);
}

// ---- return gate: a NO priced too rich (99c) fails 20% even at 99% win ----
{
  const rich = ladder({ "<=88": { no_ask: 0.99, yes_bid: 0.01 } });
  const { evaluated } = scanNoFloor(rich, { ...probs, "<=88": 0.01 }, 82);
  const b = evaluated.find(e => e.label === "<=88");
  ok("gate: 99c NO → ~1% return, fails the 20% floor despite 99% win", approx(b.return_pct, 1.01, 0.1) && b.candidate === false);
}

// ---- win gate: cheap NO on a bucket that might actually hit is NOT near-guaranteed ----
{
  // Cool, uncertain day: the bottom bucket carries real probability.
  const uncertain = { "<=88": 0.30, "89-90": 0.30, "91-92": 0.25, "93-94": 0.12, ">=95": 0.03 };
  const { evaluated } = scanNoFloor(ladder(), uncertain, 80);
  const b = evaluated.find(e => e.label === "<=88");
  ok("gate: 70% win fails the 93% near-guaranteed floor", approx(b.p_lock, 0.70) && b.candidate === false);
}

// ---- threshold overrides ----
{
  const b = scanNoFloor(ladder(), probs, 82, { minReturn: 0.30 }).evaluated.find(e => e.label === "<=88");
  ok("override: 25% return fails a 30% floor", b.candidate === false);
  const c = scanNoFloor(ladder(), probs, 82, { minReturn: 0.10 }).evaluated.find(e => e.label === "89-90");
  ok("override: 89-90 (43% return, 85% lock) passes a 10%/93%... still needs 93% win", c.return_pct >= 10);
}

// ---- scorer: hit rate + realized return vs settles ----
{
  const picks = [
    { station: "KDEN", contract_date: "2026-07-20", lock_temp: 89, no_ask: 0.80 }, // settle 93 → win, +25%
    { station: "KPHX", contract_date: "2026-07-20", lock_temp: 91, no_ask: 0.75 }, // settle 102 → win, +33%
    { station: "KNYC", contract_date: "2026-07-20", lock_temp: 81, no_ask: 0.83 }, // settle 78 → LOSS, -100%
  ];
  const cli = { "KDEN|2026-07-20": 93, "KPHX|2026-07-20": 102, "KNYC|2026-07-20": 78 };
  const r = scoreNoFloor(picks, cli);
  ok("score: 2 of 3 win", r.n === 3 && r.wins === 2 && r.losses === 1);
  ok("score: hit rate 66.7%", approx(r.hit_rate, 66.7, 0.1));
  ok("score: the NYC undercut is captured as a loss", r.loss_detail[0].station === "KNYC" && r.loss_detail[0].cli_max === 78);
  // mean stake return: (+0.25 + 0.333 - 1)/3 = -0.139
  ok("score: mean return reflects the one -100% loss", r.mean_return_pct < 0 && approx(r.mean_return_pct, -13.9, 0.5));
  ok("score: picks without a settle are skipped", scoreNoFloor(picks, { "KDEN|2026-07-20": 93 }).n === 1);
}

// ---- defaults are sane ----
ok("defaults: 20% return / 93% win", MIN_RETURN === 0.20 && MIN_WIN_PROB === 0.93);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
