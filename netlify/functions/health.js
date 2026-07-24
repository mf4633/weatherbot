// Liveness invariants for every pipeline in this system — the thing that was missing.
//
// WHY THIS EXISTS. On 2026-07-23/24 a single session found FIVE independent silent
// failures, every one of which had been running broken for days or weeks with nothing
// anywhere reporting it:
//   - Synoptic 1-minute feed returning HTTP 403 for all 28 stations; fetch1MinObs
//     swallowed it with `return null` and the dashboard implied sub-hourly precision.
//   - The settled-bet ↔ actuals join degraded to 17% (HIGH) / 2% (LOW). The file's own
//     "eligible ≫ matched ⇒ broken pipe" criterion was TRUE and only written to a log.
//   - logger.js stopped writing pred.actualLow before 2026-06-01 and May was never
//     backfilled, capping LOW calibration at n=1.
//   - /api/claude?mode=export began timing out 2026-07-19, so scoreboard-snapshot.yml
//     silently no-op'd for four days while its header says Blobs is the only copy.
//   - The paper shadow's kick URL 404'd every cycle for 37 days after seeding.
// Plus: Netlify auto-deploy failing at exit 2 while the site happily served stale code.
//
// The common shape is not a bug class, it is a REPORTING class: every one of these
// returned null / 202 / [] / stale-but-valid, and nothing asserted otherwise.
//
// DESIGN
//   - Reads BLOB STORES ONLY. /api/weather and /api/kalshi take 60-120s; a health check
//     that can itself time out is theatre. Endpoint liveness is the cron's job.
//   - Every check declares an explicit budget and reports the MEASURED value, so the
//     alarm says "cal_age 76min > 45min budget", never just "unhealthy".
//   - FAILS CLOSED. A check that cannot determine its answer returns "fail", not "pass".
//     Fail-open guards are exactly how the DSM staleness bug survived a guard written
//     specifically to catch it.
//   - Never throws. One broken store degrades one check, not the whole board.

import { getStore } from "@netlify/blobs";

const MIN = 60_000;

// Budgets. Each is the age/level at which the pipeline is no longer doing its job —
// deliberately looser than the nominal cadence so ordinary jitter doesn't cry wolf.
const BUDGETS = {
  calibrationAgeMin: 90,      // cron is */30; the trader's own stale-gate is 45
  marketSnapshotAgeMin: 240,  // declared */15, Netlify throttles it to ~107 median
  paperCycleAgeMin: 60,       // paper trader runs every ~5 min
  predictionAgeH: 30,         // logger writes daily per city
  joinRateMin: 0.50,          // "eligible >> matched" broken-pipe criterion
  actualLowRecentMin: 0.50,   // share of recent settled records carrying actualLow
};

const ok   = (name, detail, measured, budget) => ({ name, status: "pass", detail, measured, budget });
const warn = (name, detail, measured, budget) => ({ name, status: "warn", detail, measured, budget });
const bad  = (name, detail, measured, budget) => ({ name, status: "fail", detail, measured, budget });

const ageMin = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? (Date.now() - t) / MIN : null;
};
// Prediction/snapshot keys are `${cli}/${date}` — CLI FIRST. Sorting raw keys orders by
// CITY, which is precisely the bug that cost the calibration join 50 matches.
const keyDate = (k) => { const s = String(k); const i = s.indexOf("/"); return (i < 0 ? s : s.slice(i + 1)).replace(/\.json$/, ""); };

async function listKeys(store) {
  const { blobs } = await getStore(store).list();
  return (blobs || []).map(b => b.key);
}

// --- checks -----------------------------------------------------------------

async function checkCalibration() {
  const out = [];
  const blob = await getStore("calibration_state").get("current.json", { type: "json" });
  if (!blob) return [bad("calibration_state", "blob missing entirely", null, "present")];

  const age = ageMin(blob.updated_at);
  out.push(age == null
    ? bad("calibration_age", "no updated_at timestamp", null, `<= ${BUDGETS.calibrationAgeMin}min`)
    : (age > BUDGETS.calibrationAgeMin
        ? bad("calibration_age", "calibration cron is not completing", `${Math.round(age)}min`, `<= ${BUDGETS.calibrationAgeMin}min`)
        : ok("calibration_age", "fresh", `${Math.round(age)}min`, `<= ${BUDGETS.calibrationAgeMin}min`)));

  // The broken-pipe criterion, promoted from a log line to an assertion.
  for (const side of ["high", "low"]) {
    const jr = blob?.[side]?.join_rate;
    if (jr == null) { out.push(bad(`join_rate_${side}`, "not reported", null, `>= ${BUDGETS.joinRateMin}`)); continue; }
    out.push(jr < BUDGETS.joinRateMin
      ? bad(`join_rate_${side}`, "settled-bet ↔ actuals join degraded", jr, `>= ${BUDGETS.joinRateMin}`)
      : ok(`join_rate_${side}`, "join healthy", jr, `>= ${BUDGETS.joinRateMin}`));
  }
  return out;
}

async function checkPredictions() {
  const keys = await listKeys("predictions");
  if (!keys.length) return [bad("predictions_store", "store empty", 0, "> 0")];

  const dates = keys.map(keyDate).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const newest = dates[dates.length - 1];
  const ageH = newest ? (Date.now() - Date.parse(newest + "T12:00:00Z")) / 3_600_000 : null;
  const out = [ageH == null || ageH > BUDGETS.predictionAgeH
    ? bad("predictions_fresh", "logger is not writing prediction records", newest ?? "none", `<= ${BUDGETS.predictionAgeH}h old`)
    : ok("predictions_fresh", "logger writing", newest, `<= ${BUDGETS.predictionAgeH}h old`)];

  // actualHigh/actualLow write-through. logger.js runSettle silently stopped writing
  // actualLow before 2026-06-01; nothing noticed until the LOW calibration was n=1.
  const recent = keys.filter(k => keyDate(k) >= (dates[Math.max(0, dates.length - 60)] ?? "")).slice(0, 60);
  const store = getStore("predictions");
  const recs = (await Promise.all(recent.map(k => store.get(k, { type: "json" }).catch(() => null)))).filter(Boolean);
  const settled = recs.filter(r => r?.actualHigh != null);
  if (settled.length < 5) {
    out.push(warn("actuals_write_through", "too few recently-settled records to judge", settled.length, ">= 5"));
  } else {
    const withLow = settled.filter(r => r?.actualLow != null).length;
    const share = withLow / settled.length;
    out.push(share < BUDGETS.actualLowRecentMin
      ? bad("actuals_write_through", "records carry actualHigh but NOT actualLow", `${withLow}/${settled.length}`, `>= ${BUDGETS.actualLowRecentMin}`)
      : ok("actuals_write_through", "both extremes written", `${withLow}/${settled.length}`, `>= ${BUDGETS.actualLowRecentMin}`));
  }
  return out;
}

async function checkStoreFreshness(store, name, budgetMin, detail) {
  const keys = await listKeys(store);
  if (!keys.length) return bad(name, `${store} is empty`, 0, `<= ${budgetMin}min`);
  // These stores are date/ISO-keyed newest-last after a plain sort.
  const newest = keys.sort()[keys.length - 1];
  const stamp = (newest.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/) || [])[0]
    ?? (newest.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
  const age = stamp ? ageMin(stamp.length > 10 ? stamp : stamp + "T23:59:59Z") : null;
  if (age == null) return bad(name, `cannot parse a timestamp from key "${newest}"`, newest, `<= ${budgetMin}min`);
  return age > budgetMin
    ? bad(name, detail, `${Math.round(age)}min`, `<= ${budgetMin}min`)
    : ok(name, "fresh", `${Math.round(age)}min`, `<= ${budgetMin}min`);
}

async function checkPaper() {
  const keys = await listKeys("paper_trader_logs");
  if (!keys.length) return bad("paper_shadow", "no cycles logged — the shadow is not running", 0, `<= ${BUDGETS.paperCycleAgeMin}min`);
  const store = getStore("paper_trader_logs");
  const newest = keys.sort()[keys.length - 1];
  const rec = await store.get(newest, { type: "json" }).catch(() => null);
  const age = ageMin(rec?.ranAtUTC);
  if (age == null) return bad("paper_shadow", "latest cycle has no ranAtUTC", newest, `<= ${BUDGETS.paperCycleAgeMin}min`);
  return age > BUDGETS.paperCycleAgeMin
    ? bad("paper_shadow", "paper trader cron is not firing", `${Math.round(age)}min`, `<= ${BUDGETS.paperCycleAgeMin}min`)
    : ok("paper_shadow", "cycling", `${Math.round(age)}min`, `<= ${BUDGETS.paperCycleAgeMin}min`);
}

async function checkCompare() {
  const keys = await listKeys("compare");
  return keys.length
    ? ok("compare_store", "populated", keys.length, "> 0")
    : bad("compare_store", "bot-vs-NWS comparison store is empty — compare_log is not writing", 0, "> 0");
}

export default async () => {
  const settled = await Promise.allSettled([
    checkCalibration(),
    checkPredictions(),
    checkStoreFreshness("market_snapshots", "market_logger", BUDGETS.marketSnapshotAgeMin,
      "book snapshots are not being recorded (Netlify throttles the */15 schedule)"),
    checkPaper(),
    checkCompare(),
  ]);

  const checks = [];
  for (const r of settled) {
    if (r.status === "fulfilled") checks.push(...[].concat(r.value));
    // A check that threw is a FAILED check, never an absent one.
    else checks.push(bad("check_error", `a health check threw: ${String(r.reason?.message ?? r.reason)}`, null, "no throw"));
  }

  const failed = checks.filter(c => c.status === "fail");
  const warned = checks.filter(c => c.status === "warn");
  const status = failed.length ? "FAILED" : warned.length ? "DEGRADED" : "OK";

  return new Response(JSON.stringify({
    status,
    summary: `${checks.length - failed.length - warned.length} pass / ${warned.length} warn / ${failed.length} fail`,
    failed: failed.map(c => `${c.name}: ${c.detail} (measured ${c.measured}, budget ${c.budget})`),
    // Netlify injects COMMIT_REF at build time. The cron compares it to origin/master to
    // catch a failed auto-deploy — the site serves the LAST GOOD build indefinitely and
    // otherwise looks perfectly healthy.
    deployed_commit: process.env.COMMIT_REF ?? null,
    checks,
    asof: new Date().toISOString(),
  }, null, 2), {
    // Always 200 so the cron can read the body and report specifics; the cron decides
    // whether to fail the build. A non-200 here would itself be an opaque failure.
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

export const config = { path: "/api/health" };
