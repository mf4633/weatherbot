// Parity test: lib/scoreboard.js must reproduce scoreboard.py's self-test numbers.
import { score, evaluateGate, marketPoint } from "./netlify/functions/lib/scoreboard.js";

let pass = 0, fail = 0;
const approx = (a, b, t = 0.01) => a != null && Math.abs(a - b) <= t;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

const claude = { point: 89.4, sigma: 3.39, floor: 79.0, ci68: [86.0, 92.8],
  bin_probs: { "<=82": 0.022, "83-84": 0.054, "85-86": 0.124, "87-88": 0.200, "89-90": 0.232, ">=91": 0.368 } };
const bayes = { point: 84.8, sigma: 5.49, floor: 79.0, ci68: [79.3, 90.3] };
const market = { "<=82": 22, "83-84": 59, "85-86": 28, "87-88": 3, "89-90": 1, ">=91": 1 };
const decision = { type: "decision", station: "KNYC", contract_date: "2026-07-09", asof: "2026-07-09T09:51", claude, bayes, market };

function at(cliMax) {
  return score([decision, { type: "settlement", station: "KNYC", contract_date: "2026-07-09", cli_max: cliMax }]);
}

// vs scoreboard.py: cli=90 → claude MAE 0.60 Brier 0.784; bayes MAE 5.20; market MAE 6.26 Brier 1.456
const s90 = at(90);
ok("cli90 claude MAE 0.60", approx(s90.claude.mae, 0.60));
ok("cli90 claude Brier 0.784", approx(s90.claude.brier, 0.784));
ok("cli90 claude pinball 1.379", approx(s90.claude.pinball, 1.379, 0.01));
ok("cli90 claude hit68 100%", s90.claude.hit68 === 1);
ok("cli90 bayes MAE 5.20", approx(s90.bayes.mae, 5.20));
ok("cli90 market MAE 6.26", approx(s90.market.mae, 6.26));
ok("cli90 market Brier 1.456", approx(s90.market.brier, 1.456));

// vs scoreboard.py: cli=83 → claude MAE 6.40 Brier 1.140 hit68 0%; bayes MAE 1.80 hit68 100%; market MAE 0.74 Brier 0.296
const s83 = at(83);
ok("cli83 claude MAE 6.40", approx(s83.claude.mae, 6.40));
ok("cli83 claude Brier 1.140", approx(s83.claude.brier, 1.140));
ok("cli83 claude hit68 0%", s83.claude.hit68 === 0);
ok("cli83 bayes MAE 1.80", approx(s83.bayes.mae, 1.80));
ok("cli83 bayes hit68 100%", s83.bayes.hit68 === 1);
ok("cli83 market MAE 0.74", approx(s83.market.mae, 0.74));
ok("cli83 market Brier 0.296", approx(s83.market.brier, 0.296));

// ---- pre-registered trading gate (evaluateGate) ----
const bins2 = { "<=82": 0.1, "83-84": 0.7, "85-86": 0.2 };        // sharp, right (truth 83)
const mktSoft = { "<=82": 30, "83-84": 40, "85-86": 30 };         // yes-ask cents, diffuse
function gday(i, truth, claudeProbs, market) {
  return [
    { type: "decision", station: `K${i}`, contract_date: "2026-07-01", asof: "t2", claude: { bin_probs: claudeProbs }, market },
    { type: "settlement", station: `K${i}`, contract_date: "2026-07-01", cli_max: truth },
  ];
}
const gFew = evaluateGate([].concat(...Array.from({ length: 5 }, (_, i) => gday(i, 83, bins2, mktSoft))));
ok("gate HOLD below nMin (n=5)", gFew.passed === false && gFew.n === 5 && /HOLD/.test(gFew.verdict));
const gMany = evaluateGate([].concat(...Array.from({ length: 30 }, (_, i) => gday(i, 83, bins2, mktSoft))));
ok("gate n counts 30 paired city-days", gMany.n === 30);
ok("gate PASS when claude Brier < market over ≥30", gMany.passed === true && gMany.edge > 0);
ok("gate claude Brier < market Brier", gMany.claudeBrier < gMany.marketBrier);
const flat = { "<=82": 0.33, "83-84": 0.34, "85-86": 0.33 };
const gBad = evaluateGate([].concat(...Array.from({ length: 30 }, (_, i) => gday(i, 85, flat, { "<=82": 5, "83-84": 5, "85-86": 90 }))));
ok("gate HOLD when claude no better than market", gBad.passed === false && gBad.n === 30);
ok("gate excludes days with no market book", evaluateGate([].concat(...Array.from({ length: 40 }, (_, i) => gday(i, 83, bins2, null)))).n === 0);

// pick:"first" scores the FIRST logged decision per city-day (tradeable window),
// pick:"last" (default) the last. Two decisions on one city-day: the early one is
// sharp+right, the late one flat — so the two windows disagree on claude's Brier.
{
  const sharp = { "<=82": 0.0, "83-84": 1.0, "85-86": 0.0 };
  const recs = [
    { type: "decision", station: "KF", contract_date: "d", asof: "2026-07-01T09:00", claude: { bin_probs: sharp }, market: mktSoft },
    { type: "decision", station: "KF", contract_date: "d", asof: "2026-07-01T15:00", claude: { bin_probs: flat }, market: mktSoft },
    { type: "settlement", station: "KF", contract_date: "d", cli_max: 83 },
  ];
  const gF = evaluateGate(recs, { pick: "first" }), gL = evaluateGate(recs);
  ok("pick:first uses earliest decision (Brier 0)", gF.n === 1 && approx(gF.claudeBrier, 0));
  ok("default pick:last uses latest decision (flat Brier)", gL.n === 1 && gL.claudeBrier > 0.5);
  ok("gateFirst tagged with pick + window verdict", gF.pick === "first" && /first-decision/.test(gF.verdict));
}

// ---- bugsweep FIX 2: signed winter bins (regression) ----
ok("signed bins: marketPoint -5--4 = -4.5", Math.abs(marketPoint({ "-5--4": 100 }) + 4.5) < 1e-9);
ok("signed bins: marketPoint -1-0 & 1-2 = 0.5", Math.abs(marketPoint({ "-1-0": 50, "1-2": 50 }) - 0.5) < 1e-9);
{
  const recs = [
    { type: "decision", station: "KMSP", contract_date: "2026-01-15", asof: "t",
      claude: { point: -4, sigma: 1, floor: -20, ci68: [-6, -2], bin_probs: { "-5--4": 1.0, "-3--2": 0.0 } } },
    { type: "settlement", station: "KMSP", contract_date: "2026-01-15", cli_max: -4 },
  ];
  ok("signed bins: Brier 0 when truth -4 hits certain -5--4", score(recs).claude.brier === 0);
}

// ---- nws + blend engines (2026-07-10: "are we more accurate than NWS?") ----
{
  const recs = [
    { type: "decision", station: "KX", contract_date: "d", asof: "t",
      claude: { point: 80, sigma: 2, floor: 70, ci68: [78, 82], bin_probs: { "<=79": 0.4, "80-81": 0.4, ">=82": 0.2 } },
      bayes: { point: 84, sigma: 2, floor: 70, ci68: [82, 86] }, nws: 86 },
    { type: "settlement", station: "KX", contract_date: "d", cli_max: 82 },
  ];
  const s = score(recs);
  ok("nws scored as point engine (MAE 4)", s.nws.n === 1 && approx(s.nws.mae, 4));
  ok("blend point = avg(80,84)=82 → MAE 0", s.blend.n === 1 && approx(s.blend.mae, 0));
  ok("bayes gains a derived Brier (floored normal over claude bins)", s.bayes.brier != null);
  ok("blend gains a Brier (avg probs)", s.blend.brier != null);
  // decision without nws/bayes contributes nothing to those engines
  const s2 = score([{ type: "decision", station: "KX", contract_date: "d", asof: "t",
    claude: { point: 80, sigma: 2, floor: 70, bin_probs: { "<=81": 0.6, ">=82": 0.4 } } },
    { type: "settlement", station: "KX", contract_date: "d", cli_max: 82 }]);
  ok("no bayes/nws → engines stay n=0", s2.nws.n === 0 && s2.blend.n === 0);
  // blend prefers the thin-analog-guarded point when present: pure 70 (degenerate),
  // guarded 80 → blend avg(80, 84) = 82 = truth → MAE 0.
  const s3 = score([{ type: "decision", station: "KX", contract_date: "d", asof: "t",
    claude: { point: 70, guarded_point: 80, guarded: true, sigma: 2, floor: 68 },
    bayes: { point: 84, sigma: 2, floor: 68 } },
    { type: "settlement", station: "KX", contract_date: "d", cli_max: 82 }]);
  ok("blend uses guarded_point (MAE 0, not 5)", s3.blend.n === 1 && approx(s3.blend.mae, 0));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
