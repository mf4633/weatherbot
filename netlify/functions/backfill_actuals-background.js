// Fill missing actualHigh / actualLow on prediction records, from the IEM CLI archive.
//
// TWO PROBLEMS, ONE JOB.
//
// 1. The historical gap. logger.js only began writing `pred.actualLow` on 2026-06-01 and
//    May was never backfilled: 404 records carry actualHigh with actualLow null, all in
//    2026-05. Because 40 of 42 settled LOW bets were placed in May, the calibration join
//    stayed at n=1 — which published predictive_nu=5, a Student-t on FIVE degrees of
//    freedom derived from a single observation, into every LOW bucket probability in
//    kalshi.js. Fat tails there are the measured loss mechanism.
//
// 2. The ongoing hole. logger.js runSettle looks ONLY at `yesterday` and bails when the
//    CLI is unavailable or partial at that hour; it also skips anything already flagged
//    `settled`. So a transient CLI miss is permanent (DEN 05-13/21/22/24, SAT+AUS 05-22
//    are exactly this), and a record settled before the actualLow line existed can never
//    be revisited. Widening runSettle's window alone would NOT fix it, because
//    fetchLatestCLI only ever returns the CURRENT product — day-2 lookups always miss.
//
// The fix for both is a source with HISTORY. IEM's CLI archive is exactly that, and it is
// the authoritative one: measured against NWS CLI over 2026-06-01..07-22 across seven
// stations, IEM's daily value equalled the settled CLI high on 364/364 station-days
// (analyze_cli_gap.js). Free, public, no key.
//
// Idempotent and additive: only ever fills a NULL field, never overwrites an existing
// actual, and never clears `settled`. Safe to re-run.
//
// Trigger: POST /api/backfill_actuals (background fn — returns 202, has 15 min).
//   ?days=N   lookback window, default 120
//   ?dry=1    report what it would write, write nothing

import { getStore } from "@netlify/blobs";

const PREDICTIONS_STORE = "predictions";
const UA = "weatherbot-backfill-actuals (github.com/mf4633/weatherbot)";
const DEFAULT_DAYS = 120;
// Skip today and yesterday — the CLI for those may still be preliminary, and runSettle
// owns the fresh end. This job is strictly a repairer of history.
const MIN_AGE_DAYS = 2;

// Keys are `${cli}/${date}` — CLI FIRST. Sorting raw keys orders by CITY, the bug that
// cost the calibration join 50 matches. Always split.
const keyCli  = (k) => { const s = String(k); const i = s.indexOf("/"); return i < 0 ? null : s.slice(0, i); };
const keyDate = (k) => { const s = String(k); const i = s.indexOf("/"); return (i < 0 ? s : s.slice(i + 1)).replace(/\.json$/, ""); };

// One fetch per station-year, cached for the invocation.
const cliCache = new Map();
async function cliArchive(cli, year) {
  const ck = `${cli}/${year}`;
  if (cliCache.has(ck)) return cliCache.get(ck);
  let byDate = null;
  try {
    const r = await fetch(
      `https://mesonet.agron.iastate.edu/json/cli.py?station=K${encodeURIComponent(cli)}&year=${year}`,
      { headers: { "User-Agent": UA, accept: "application/json" } });
    if (r.ok) {
      const j = await r.json();
      byDate = {};
      for (const rec of j?.results || []) {
        if (!rec?.valid) continue;
        const hi = rec.high, lo = rec.low;
        byDate[rec.valid] = {
          high: typeof hi === "number" ? hi : null,
          low:  typeof lo === "number" ? lo : null,
        };
      }
    } else {
      console.error(`[backfill-actuals] IEM CLI ${cli} ${year} → HTTP ${r.status}`);
    }
  } catch (e) {
    console.error(`[backfill-actuals] IEM CLI ${cli} ${year} threw: ${e?.message}`);
  }
  cliCache.set(ck, byDate);
  return byDate;
}

export default async (req) => {
  const url = new URL(req.url);
  const days = Math.max(1, Math.min(400, Number(url.searchParams.get("days") || DEFAULT_DAYS)));
  const dry = url.searchParams.get("dry") === "1";

  const store = getStore(PREDICTIONS_STORE);
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  const keys = (blobs || []).map(b => b.key);

  const today = new Date();
  const cutoffOld = new Date(today.getTime() - days * 86400_000).toISOString().slice(0, 10);
  const cutoffNew = new Date(today.getTime() - MIN_AGE_DAYS * 86400_000).toISOString().slice(0, 10);

  const candidates = keys.filter(k => {
    const d = keyDate(k);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= cutoffOld && d <= cutoffNew && keyCli(k);
  });

  const res = { scanned: 0, already_complete: 0, filled_high: 0, filled_low: 0,
                written: 0, no_cli_record: 0, cli_null_field: 0, errors: 0, examples: [] };

  for (const key of candidates) {
    let rec;
    try { rec = await store.get(key, { type: "json" }); }
    catch { res.errors++; continue; }
    if (!rec) { res.errors++; continue; }
    res.scanned++;

    const needHigh = rec.actualHigh == null;
    const needLow  = rec.actualLow == null;
    if (!needHigh && !needLow) { res.already_complete++; continue; }

    const cli = keyCli(key), date = keyDate(key);
    const arch = await cliArchive(cli, date.slice(0, 4));
    const day = arch?.[date];
    if (!day) { res.no_cli_record++; continue; }

    let changed = false;
    if (needHigh && day.high != null) { rec.actualHigh = day.high; res.filled_high++; changed = true; }
    if (needLow  && day.low  != null) { rec.actualLow  = day.low;  res.filled_low++;  changed = true; }
    if (!changed) { res.cli_null_field++; continue; }

    // Derived residual, matching runSettle's sign convention (predicted − actual).
    if (rec.predHigh != null && rec.actualHigh != null && rec.residual == null)
      rec.residual = rec.predHigh - rec.actualHigh;

    if (res.examples.length < 8)
      res.examples.push(`${key} high=${rec.actualHigh ?? "-"} low=${rec.actualLow ?? "-"}`);

    if (!dry) {
      try { await store.setJSON(key, rec); res.written++; }
      catch (e) { res.errors++; console.error(`[backfill-actuals] write ${key}: ${e?.message}`); }
    }
  }

  console.log(`[backfill-actuals] ${dry ? "DRY " : ""}scanned=${res.scanned} `
    + `filled_high=${res.filled_high} filled_low=${res.filled_low} written=${res.written} `
    + `no_cli=${res.no_cli_record} errors=${res.errors}`);

  return new Response(JSON.stringify({
    ok: true, dry, days, candidates: candidates.length, ...res,
    note: "Only fills NULL fields; never overwrites an existing actual or clears `settled`.",
    asof: new Date().toISOString(),
  }, null, 2), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
};
