// Parity test: lib/scoreboard.js must reproduce scoreboard.py's self-test numbers.
import { score } from "./netlify/functions/lib/scoreboard.js";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
