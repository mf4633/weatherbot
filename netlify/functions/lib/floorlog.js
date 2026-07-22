// floorlog.js — the closed loop that turns the floor-scan from a recommender into a
// MEASURED strategy (2026-07-22). The whole thesis is "near-guaranteed 20% on the
// low-tail NO"; that's only a claim until picks are logged when made and scored against
// the CLI settlement. This module is the pure logic: normalize a scan candidate into a
// logged pick, dedupe to the morning capture, and score a log against settled highs
// (reusing nofloor.scoreNoFloor for the win/return math, adding a per-city breakdown).

import { scoreNoFloor } from "./nofloor.js";

// A scan candidate (+ its city/station/date context) → a flat, storable pick record.
export function normalizePick({ city, station, contractDate, candidate, predicted, loggedAtMs }) {
  if (!candidate) return null;
  return {
    city, station, contract_date: contractDate,
    label: candidate.label, ceiling: candidate.ceiling, lock_temp: candidate.lock_temp,
    no_ask: candidate.no_ask, return_pct: candidate.return_pct, p_lock: candidate.p_lock,
    deg_to_lock: candidate.deg_to_lock, predicted: predicted ?? null, logged_at: loggedAtMs ?? null,
  };
}

// First pick per (city, contract_date) wins — we want the MORNING price (the mispricing
// window), so a later, repriced run must never overwrite the morning capture.
export function dedupePicks(existing, incoming) {
  const byKey = new Map();
  for (const p of [...(existing || []), ...(incoming || [])]) {
    if (!p || !p.city || !p.contract_date) continue;
    const k = `${p.city}|${p.contract_date}`;
    if (!byKey.has(k)) byKey.set(k, p);
  }
  return [...byKey.values()];
}

// Score a pick log against settled highs. cliMaxByKey: {"STATION|YYYY-MM-DD": high}.
// Returns nofloor's aggregate (hit rate, mean realized return, loss detail) plus a
// per-city breakdown — so "near-guaranteed 20%" becomes a number, per market.
export function scoreFloorLog(picks, cliMaxByKey) {
  const base = scoreNoFloor(picks || [], cliMaxByKey || {});
  const byCity = {};
  for (const p of picks || []) {
    const cli = cliMaxByKey?.[`${p.station}|${p.contract_date}`];
    if (cli == null || p.no_ask == null) continue;
    const won = cli >= p.lock_temp;
    const c = (byCity[p.city] = byCity[p.city] || { n: 0, wins: 0, sumRet: 0 });
    c.n++; if (won) c.wins++;
    c.sumRet += won ? (1 - p.no_ask) / p.no_ask : -1;
  }
  const by_city = {};
  for (const [city, c] of Object.entries(byCity)) {
    by_city[city] = {
      n: c.n, wins: c.wins,
      hit_rate: Math.round((c.wins / c.n) * 1000) / 10,
      mean_return_pct: Math.round((c.sumRet / c.n) * 1000) / 10,
    };
  }
  return { ...base, by_city };
}
