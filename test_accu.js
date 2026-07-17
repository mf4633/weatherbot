// test_accu.js — AccuWeather forward-log leg: implied high, quota, scorer.
import { impliedHighFromHourly, accuQuotaTake, accuCityAllowed, accuHourAllowed,
         scoreAccuDecisions, ACCU_DAILY_BUDGET } from "./netlify/functions/lib/accuweather.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// In-memory store mock (get/setJSON subset used by the module).
function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: async (k) => m.get(k) ?? null, setJSON: async (k, v) => { m.set(k, v); }, _m: m };
}

// ---- impliedHighFromHourly: tomorrow's hours can't print in today's CLI ----
{
  // 6pm Phoenix fetch: 12 hours spanning midnight — only the 6 pre-midnight hours count.
  const mk = (iso, f) => ({ DateTime: iso, Temperature: { Value: f, Unit: "F" } });
  const hours = [
    mk("2026-07-17T18:00:00-07:00", 95), mk("2026-07-17T19:00:00-07:00", 93),
    mk("2026-07-17T20:00:00-07:00", 91), mk("2026-07-17T21:00:00-07:00", 89),
    mk("2026-07-17T22:00:00-07:00", 87), mk("2026-07-17T23:00:00-07:00", 85),
    mk("2026-07-18T00:00:00-07:00", 84), mk("2026-07-18T01:00:00-07:00", 102), // tomorrow — must be excluded
  ];
  const r = impliedHighFromHourly(hours, "America/Phoenix", 90, "2026-07-17");
  ok("implied: max over today's remaining hours", r.fx_max_remaining === 95 && r.hours_in_day === 6);
  ok("implied: tomorrow's 102 excluded", r.implied_high === 95);
  const r2 = impliedHighFromHourly(hours, "America/Phoenix", 97, "2026-07-17");
  ok("implied: floored at banked max (97 > fx 95)", r2.implied_high === 97);
  const r3 = impliedHighFromHourly([mk("2026-07-18T00:00:00-07:00", 84)], "America/Phoenix", 96, "2026-07-17");
  ok("implied: all-tomorrow feed falls back to banked max", r3.implied_high === 96 && r3.fx_max_remaining === null);
  ok("implied: nothing at all → null", impliedHighFromHourly([], "America/Phoenix", null, "2026-07-17") === null);
}

// ---- quota: hard stop at the budget ----
{
  const s = memStore();
  let took = 0;
  for (let i = 0; i < ACCU_DAILY_BUDGET + 10; i++) { /* eslint-disable no-await-in-loop */ }
  const run = async () => { for (let i = 0; i < ACCU_DAILY_BUDGET + 10; i++) if (await accuQuotaTake(s)) took++; };
  await run();
  ok(`quota: exactly ${ACCU_DAILY_BUDGET} calls granted, rest refused`, took === ACCU_DAILY_BUDGET);
}

// ---- gates ----
{
  ok("gate: default city list includes Denver", accuCityAllowed("Denver", {}));
  ok("gate: default list excludes Tampa", !accuCityAllowed("Tampa", {}));
  ok("gate: ACCU_CITIES override wins", accuCityAllowed("Tampa", { ACCU_CITIES: "Tampa, Miami" }) && !accuCityAllowed("Denver", { ACCU_CITIES: "Tampa" }));
  ok("gate: hour 12 logs, hour 13 doesn't", accuHourAllowed(12) && !accuHourAllowed(13));
}

// ---- scorer: matched-pair residuals + recommendation thresholds ----
{
  const dec = (station, date, accu, bayes, claude, nws) => ({
    city: "Denver", station, contract_date: date,
    accu: { implied_high: accu }, bayes: { point: bayes }, claude: { guarded_point: claude }, nws,
  });
  // settle 94: accu misses by 1, bayes by 3 → blend misses by 2
  const one = scoreAccuDecisions([dec("KDEN", "2026-07-16", 93, 91, 92, 93)], { "KDEN|2026-07-16": 94 });
  ok("score: accu MAE 1, bayes 3, blend 2", one.overall.accu.mae === 1 && one.overall.bayes.mae === 3 && one.overall.accu_blend.mae === 2);
  ok("score: small sample → keep logging", /KEEP LOGGING/.test(one.recommendation));
  // 50 identical decisions where the blend clearly beats bayes → INCORPORATE
  const many = Array.from({ length: 50 }, (_, i) => dec("KDEN", `2026-06-${String((i % 28) + 1).padStart(2, "0")}`, 94, 91, 92, 93));
  const cli = Object.fromEntries(many.map(d => [`${d.station}|${d.contract_date}`, 94]));
  const big = scoreAccuDecisions(many, cli);
  ok("score: n>=40 with blend edge → INCORPORATE", /^INCORPORATE/.test(big.recommendation));
  // decisions without an accu leg are skipped entirely (no unfair partial pairs)
  const skip = scoreAccuDecisions([{ city: "Denver", station: "KDEN", contract_date: "2026-07-16", bayes: { point: 91 } }], { "KDEN|2026-07-16": 94 });
  ok("score: records without accu leg skipped", skip.overall.bayes.n === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
