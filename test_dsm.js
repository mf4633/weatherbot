// parseDsmLine: DSM daily-extremes parsing incl. the MM/DD the summary covers.
// The date matters: a DSM issued around local midnight summarizes YESTERDAY, and
// folding yesterday's max into today's running max gave KSAT a floor of 95 at 1am
// on a day that settled 86 (2026-07-11 ledger).
import { parseDsmLine } from "./netlify/functions/lib/dsm.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

const p = parseDsmLine("KNYC DS 1500 07/05 641434/ 490625// 64/ 49//9751459/");
ok("parses dailyMaxF 64", p && p.dailyMaxF === 64);
ok("parses maxTimeLocal 1434", p && p.maxTimeLocal === "1434");
ok("parses dailyMinF 49", p && p.dailyMinF === 49);
ok("parses minTimeLocal 0625", p && p.minTimeLocal === "0625");
ok("captures coversMonthDay 07/05", p && p.coversMonthDay === "07/05");

// 3-digit temps (Phoenix summer) and a different date
const q = parseDsmLine("KPHX DS 0005 07/12 1091612/ 840512// 109/ 84//");
ok("3-digit max 109", q && q.dailyMaxF === 109);
ok("midnight-issued DSM still covers 07/12", q && q.coversMonthDay === "07/12");

ok("garbage line → null", parseDsmLine("KNYC not a dsm line") === null);
ok("missing temps (M sentinels) → null", parseDsmLine("KNYC DS 1500 07/05 M/ M//") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
