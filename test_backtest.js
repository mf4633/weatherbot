// Tests for lib/backtest_core.js (IEM tdf parse, historical replay, aggregation).
// No network. Run: node test_backtest.js
import { parseAsosTdf, replayStation, aggregate } from "./netlify/functions/lib/backtest_core.js";

let pass = 0, fail = 0;
const approx = (a, b, t = 0.05) => a != null && Math.abs(a - b) <= t;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// ---- parseAsosTdf ----
const tdf = [
  "station\tvalid\tmetar",
  "NYC\t2026-07-08 14:51\tKNYC 081451Z 22006KT 10SM CLR 28/17 A3001 RMK AO2 SLP160 T02780172",
  "NYC\t2026-07-08 15:51\tKNYC 081551Z 22006KT 10SM CLR 29/17 A3000 RMK AO2 SLP158 T02890172",
  "NYC\tbogus\tKNYC 081651Z ...",
].join("\n");
const obs = parseAsosTdf(tdf);
ok("tdf: parses 2 valid rows, drops header + bad ts", obs.length === 2);
ok("tdf: UTC timestamp", obs[0].ts.getUTCHours() === 14 && obs[0].ts.getUTCMinutes() === 51);
ok("tdf: metar text intact", /^KNYC 081451Z/.test(obs[0].metar));

// ---- replayStation on a synthetic 3-day history ----
// Build hourly METARs for 3 days: each day climbs 66→(88,90,?) with the decision at 15Z.
function dayObs(dd, maxC) {
  const rows = [];
  for (let h = 6; h <= 23; h++) {
    // simple ramp peaking at 20Z
    const frac = h <= 20 ? (h - 6) / 14 : (23 - h) / 6;
    const tC = Math.round(10 + (maxC - 10) * Math.max(0, Math.min(1, frac)));
    const hh = String(h).padStart(2, "0");
    rows.push({ ts: new Date(`2026-07-${String(dd).padStart(2, "0")}T${hh}:51:00Z`),
      metar: `KNYC ${String(dd).padStart(2, "0")}${hh}51Z 22006KT 10SM CLR ${String(tC).padStart(2, "0")}/12 A3001 RMK AO2 SLP160` });
  }
  return rows;
}
const allObs = [...dayObs(6, 31), ...dayObs(7, 31), ...dayObs(8, 32)];
const truths = { "2026-07-07": 88, "2026-07-08": 90 };
const rows = replayStation({ station: "KNYC", tz: "America/New_York", obs: allObs, truthByDate: truths,
                             nwsByDate: { "2026-07-08": 89 } });
ok("replay: produces a row for each truth day with enough obs", rows.length === 2);
const r8 = rows.find(r => r.date === "2026-07-08");
ok("replay: analog present and plausible (75–95)", r8 && r8.analog > 75 && r8.analog < 95);
ok("replay: persistence = yesterday's truth (88)", r8 && r8.persistence === 88);
ok("replay: nws attached (89)", r8 && r8.nws === 89);
ok("replay: no persistence for first day", rows.find(r => r.date === "2026-07-07").persistence === null);

// ---- aggregate ----
const agg = aggregate([
  { date: "a", truth: 90, analog: 88, persistence: 85, nws: 92 },   // analog err 2, nws 2, blend (90) 0
  { date: "b", truth: 80, analog: 81, persistence: 84, nws: 77 },   // analog 1, nws 3, blend (79) 1
  { date: "c", truth: 70, analog: 72, persistence: null, nws: null },
]);
ok("agg: analog n=3 MAE (2+1+2)/3", agg.analog.n === 3 && approx(agg.analog.mae, 5 / 3));
ok("agg: nws n=2 MAE 2.5", agg.nws.n === 2 && approx(agg.nws.mae, 2.5));
ok("agg: blend n=2 MAE 0.5", agg.blend.n === 2 && approx(agg.blend.mae, 0.5));
ok("agg: persistence n=2", agg.persistence.n === 2);
ok("agg: blend_vs_nws head-to-head counted", agg.blend_vs_nws.n === 2 && agg.blend_vs_nws.winPct === 100);
ok("agg: analog_vs_nws ties are not wins", agg.analog_vs_nws.n === 2 && agg.analog_vs_nws.winPct === 50);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
