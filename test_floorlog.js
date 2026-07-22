// test_floorlog.js — the pick log + settlement scoring loop.
import { normalizePick, dedupePicks, scoreFloorLog } from "./netlify/functions/lib/floorlog.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };
const approx = (a, b, tol = 0.1) => a != null && Math.abs(a - b) <= tol;

// ---- normalizePick: candidate + context → storable record ----
{
  const p = normalizePick({
    city: "DEN", station: "KDEN", contractDate: "2026-07-20", predicted: 99, loggedAtMs: 123,
    candidate: { label: "88 or below", ceiling: 88, lock_temp: 89, no_ask: 0.80, return_pct: 25, p_lock: 0.97, deg_to_lock: 7 },
  });
  ok("normalize: carries station/date/lock_temp/no_ask", p.station === "KDEN" && p.contract_date === "2026-07-20" && p.lock_temp === 89 && p.no_ask === 0.80);
  ok("normalize: keeps label + predicted + logged_at", p.label === "88 or below" && p.predicted === 99 && p.logged_at === 123);
  ok("normalize: null candidate → null", normalizePick({ city: "X" }) === null);
}

// ---- dedupePicks: first (morning) capture per city/day wins ----
{
  const morning = [{ city: "DEN", contract_date: "2026-07-22", no_ask: 0.80 }];
  const afternoon = [{ city: "DEN", contract_date: "2026-07-22", no_ask: 0.70 }, { city: "HOU", contract_date: "2026-07-22", no_ask: 0.85 }];
  const merged = dedupePicks(morning, afternoon);
  ok("dedupe: one row per city/day", merged.length === 2);
  ok("dedupe: DEN keeps the morning 0.80, not the repriced 0.70", merged.find((p) => p.city === "DEN").no_ask === 0.80);
  ok("dedupe: a new city is added", merged.some((p) => p.city === "HOU"));
}

// ---- scoreFloorLog: hit rate + realized return, overall and per city ----
{
  const picks = [
    { city: "DEN", station: "KDEN", contract_date: "2026-07-20", lock_temp: 89, no_ask: 0.80 }, // settle 100 → win +25%
    { city: "PHX", station: "KPHX", contract_date: "2026-07-20", lock_temp: 102, no_ask: 0.75 }, // settle 108 → win +33%
    { city: "NYC", station: "KNYC", contract_date: "2026-07-20", lock_temp: 79, no_ask: 0.83 }, // settle 78 → LOSS -100%
  ];
  const cli = { "KDEN|2026-07-20": 100, "KPHX|2026-07-20": 108, "KNYC|2026-07-20": 78 };
  const r = scoreFloorLog(picks, cli);
  ok("score: 3 graded, 2 wins", r.n === 3 && r.wins === 2);
  ok("score: hit rate 66.7%", approx(r.hit_rate, 66.7));
  ok("score: mean return reflects the -100% loss", r.mean_return_pct < 0 && approx(r.mean_return_pct, -13.9, 0.5));
  ok("score: per-city DEN won +25%", r.by_city.DEN.hit_rate === 100 && approx(r.by_city.DEN.mean_return_pct, 25, 0.2));
  ok("score: per-city NYC lost", r.by_city.NYC.hit_rate === 0 && approx(r.by_city.NYC.mean_return_pct, -100, 0.2));
  ok("score: unsettled picks skipped", scoreFloorLog(picks, { "KDEN|2026-07-20": 100 }).n === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
