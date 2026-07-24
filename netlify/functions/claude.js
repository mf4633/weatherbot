// /api/claude — Claude-method obs-analog engine, read/query surface. Modes (?mode=):
//   predict  (default) — recompute + return cards (heavy; may time out — the hourly
//                        LOGGING is done by claude_log-background.js, not here)
//   settle             — fetch CLI max per pending day, write settlements
//   scoreboard         — score all logged decisions vs settlements (+ trading gate)
//   latest             — FAST: newest logged decision per station (dashboard cards)
//   nofloor            — FAST: sell-the-floor board — bottom-bucket NO bets across
//                        cities that clear >=20% return with near-certain early exit
//                        (?min_return= & ?min_win= override the gates)
//   nofloor_report     — score logged floor picks vs settles (hit rate + realized %)
//   export             — full dataset dump for the durability snapshot
// Places no trades. Heavy predict/settle work lives in lib/claude_engine.js so the
// background function can run it within the 15-min limit.

import { getStore } from "@netlify/blobs";
import { score, evaluateGate } from "./lib/scoreboard.js";
import { runPredict, runSettle, runAccuReport, runNoFloor, runNoFloorReport, STORE, round1 } from "./lib/claude_engine.js";

// Re-export so test_claude.js (and anything else) can import the CLI parser here.
export { parseCliProduct } from "./lib/claude_engine.js";

// Historical backtest results written by backtest-background.js (analog vs NWS
// guidance vs persistence vs blend, scored on IEM CLI truth).
async function runBacktest() {
  const store = getStore(STORE);
  const results = await store.get("backtest/results.json", { type: "json" }).catch(() => null);
  return { ok: true, mode: "backtest", results };
}

// Last background-logger outcome (what it predicted/logged/errored) — for diagnosing
// why the store might be empty without Netlify function-log access.
async function runStatus() {
  const store = getStore(STORE);
  const st = await store.get("status/last_log.json", { type: "json" }).catch(() => null);
  return { ok: true, mode: "status", last_log: st };
}

async function runScoreboard() {
  const store = getStore(STORE);
  const { blobs } = await store.list();
  const records = (await Promise.all((blobs || []).map(b => store.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
  return { ok: true, mode: "scoreboard", n_records: records.length,
           all: score(records), lastObOnly: score(records, { lastObOnly: true }),
           gate: evaluateGate(records), gateFirst: evaluateGate(records, { pick: "first" }) };
}

// Fast read for the dashboard cards: newest logged decision per station, straight
// from the blob store — NO external fetches or recompute. Keyed by station.
async function runLatest() {
  const store = getStore(STORE);
  const { blobs } = await store.list({ prefix: "dec/" });
  const best = {};  // station -> { key, sort } where sort = "YYYY-MM-DD HH"
  for (const b of blobs || []) {
    const parts = b.key.split("/");            // dec / station / date / hour.json
    if (parts.length < 4) continue;
    const [, station, date, hourFile] = parts;
    const sort = `${date} ${hourFile.replace(".json", "")}`;
    if (!best[station] || sort > best[station].sort) best[station] = { key: b.key, sort };
  }
  let asof = null;
  const recs = (await Promise.all(Object.values(best).map(({ key }) => store.get(key, { type: "json" }).catch(() => null)))).filter(Boolean);
  const cities = [], byStation = {};
  for (const rec of recs) {
    if (!rec.claude) continue;
    if (rec.asof && (!asof || rec.asof > asof)) asof = rec.asof;
    byStation[rec.station] = rec.claude;
    // Divergence is the INDEPENDENT analog read against the Bayesian, so it uses the
    // PURE (guarded) point, not the served blend. Since 2026-07-23 the served point
    // is anchored ON the Bayesian at fitted weights, so blend-minus-bayes would be
    // ~0 by construction and the panel would report agreement that means nothing.
    const divergence = rec.bayes ? round1((rec.claude.guarded_point ?? rec.claude.point) - rec.bayes.point) : null;
    cities.push({ city: rec.city || rec.station, station: rec.station, claude: rec.claude, bayes: rec.bayes || null, market: rec.market || null, divergence, nofloor: rec.nofloor || null });
  }
  cities.sort((a, b) => a.city.localeCompare(b.city));
  return { ok: true, mode: "latest", asof, count: cities.length, byStation, cities };
}

// Full dataset dump for off-platform durability (the daily snapshot workflow pulls this).
async function runExport() {
  const store = getStore(STORE);
  const { blobs } = await store.list();
  const records = (await Promise.all((blobs || []).map(b => store.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
  const decisions = records.filter(r => r.type === "decision").length;
  const settlements = records.filter(r => r.type === "settlement").length;
  return { ok: true, mode: "export", exported_at: new Date().toISOString(),
           count: records.length, decisions, settlements,
           gate: evaluateGate(records), gateFirst: evaluateGate(records, { pick: "first" }), records };
}

// Slim, date-filtered decision export. The full runExport() GETs every blob in the
// store in one edge invocation and now TIMES OUT (thousands of dec/ + settle/ keys).
// This projects only the fields an intraday-edge scan needs and, given ?date=, GETs
// only that local date's decisions + settlements — a few hundred blobs, well under the
// edge timeout. Client loops the dates. Isolates the Claude v3 card (nws base + physical
// modifiers) from the Bayesian layer: `point` = pure obs-analog mean, `blend` = the
// served NWS-base blend, `sigma`, `nws`, `market_pt`; joinable to the market_logger
// book export on (cli, date, hour).
async function runExportSlim(dateFilter) {
  const store = getStore(STORE);
  const { blobs } = await store.list();
  const decKeys = [], setKeys = [];
  for (const b of (blobs || [])) {
    if (b.key.startsWith("dec/")) {
      const p = b.key.split("/");                       // dec / station / date / HH.json
      if (!dateFilter || p[2] === dateFilter) decKeys.push({ key: b.key, station: p[1], date: p[2], hour: +(p[3] || "").replace(".json", "") });
    } else if (b.key.startsWith("settle/")) {
      const p = b.key.split("/");                       // settle / station / date.json
      const date = (p[2] || "").replace(".json", "");
      if (!dateFilter || date === dateFilter) setKeys.push({ key: b.key, station: p[1], date });
    }
  }
  const decs = (await Promise.all(decKeys.map(async d => {
    const r = await store.get(d.key, { type: "json" }).catch(() => null);
    if (!r) return null;
    const c = r.claude || {};
    return { station: d.station, cli: r.cli || null, city: r.city || null, date: d.date, hour: d.hour,
             point: c.point ?? null, blend: c.point_blend ?? null, guarded: c.guarded_point ?? null,
             sigma: c.sigma ?? null, nws: r.nws ?? c.nws_base ?? null, market_pt: c.market_pt ?? null,
             components: c.components ?? null };
  }))).filter(Boolean);
  const settles = (await Promise.all(setKeys.map(async s => {
    const r = await store.get(s.key, { type: "json" }).catch(() => null);
    return r ? { station: r.station, date: r.contract_date, cli_max: r.cli_max ?? null } : null;
  }))).filter(Boolean);
  return { ok: true, mode: "export_slim", date: dateFilter || "all", nDec: decs.length, nSettle: settles.length, decs, settles };
}

const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const mode = new URL(req.url).searchParams.get("mode") || "predict";
  try {
    if (mode === "settle") return json(await runSettle());
    if (mode === "scoreboard") return json(await runScoreboard());
    if (mode === "export") return json(await runExport());
    if (mode === "export_slim") return json(await runExportSlim(new URL(req.url).searchParams.get("date") || null));
    if (mode === "latest") return json(await runLatest());
    if (mode === "status") return json(await runStatus());
    if (mode === "backtest") return json(await runBacktest());
    if (mode === "accu_report") return json(await runAccuReport(+(new URL(req.url).searchParams.get("days") || 14)));
    if (mode === "nofloor") {
      const sp = new URL(req.url).searchParams;
      return json(await runNoFloor({
        minReturn: sp.get("min_return") != null ? +sp.get("min_return") : undefined,
        minWinProb: sp.get("min_win") != null ? +sp.get("min_win") : undefined,
      }));
    }
    if (mode === "nofloor_report") return json(await runNoFloorReport(+(new URL(req.url).searchParams.get("days") || 21)));
    // Heavy: recompute + (optionally) log. Prefer claude_log-background.js for logging.
    return json(await runPredict(new URL(req.url).searchParams.get("log") !== "0"));
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
};
