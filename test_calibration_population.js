// Pins the posterior-predictive (ν, scale) population choice. No network.
//
// Regression origin (2026-07-24): predictive() sets nu = PRIOR_DOF + n, so ν is a direct
// function of SAMPLE SIZE. It was fed the settled-bet population, which is both
// selection-biased and starving — with the trader halted nothing new settles. The actuals
// join had degraded to 30/176 HIGH and 1/42 LOW, so LOW was publishing ν=5 (Student-t on
// five dof, from ONE observation) into every LOW bucket probability in kalshi.js. Fat tails
// there are expensive: buckets priced under 5¢ realize 0.6% against 1.0% priced (z=−5.5).
//
// Fix: fit on the unselected prediction population (n=566/416) when it is materially
// larger, using the served posterior σ as the z denominator.

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); }
                             else { fail++; console.log(`  ✗ ${name}`); } };

const PRIOR_DOF = 4;
const POP_MIN_N = 50;

// Mirrors calibration_update-background.js.
const predictive = (zs) => {
  const n = zs.length;
  const sumZ2 = zs.reduce((a, z) => a + z * z, 0);
  return { nu: PRIOR_DOF + n, scale: Math.round(Math.sqrt((PRIOR_DOF + sumZ2) / (PRIOR_DOF + n)) * 1000) / 1000 };
};
const popZ = (errs, sigma) =>
  (Number.isFinite(sigma) && sigma > 0) ? errs.map(e => e / sigma).filter(Number.isFinite) : [];

function choose(zBet, errs, sigma) {
  const zPop = popZ(errs, sigma);
  const use = zPop.length >= POP_MIN_N && zPop.length > zBet.length;
  return { use, p: predictive(use ? zPop : zBet), n: use ? zPop.length : zBet.length };
}

// Deterministic pseudo-residuals (no Math.random — reproducible).
const errs = (n, amp) => Array.from({ length: n }, (_, i) => amp * Math.sin(i * 2.399) );

// --- the live 2026-07-24 shapes ---
const lowBet = [0.42];                       // n=1, the single matched LOW bet
const lowPop = errs(416, 1.4);
const low = choose(lowBet, lowPop, 1.5);
ok("LOW switches to the unselected population", low.use === true);
ok("LOW ν rises off the n=1 value of 5", low.p.nu > 5 && low.p.nu === PRIOR_DOF + 416);
ok("LOW ν is now effectively normal, not fat-tailed (>= 100)", low.p.nu >= 100);

const highBet = errs(30, 1.2);
const highPop = errs(566, 2.1);
const high = choose(highBet, highPop, 2.139);
ok("HIGH switches to the unselected population", high.use === true);
ok("HIGH ν = 4 + 566", high.p.nu === PRIOR_DOF + 566);

// --- fallback: never worse than before on a cold start ---
const coldPop = errs(10, 1.0);
const coldBet = errs(30, 1.0);
const cold = choose(coldBet, coldPop, 2.0);
ok("population below POP_MIN_N → falls back to bet-matched", cold.use === false);
ok("fallback ν matches the bet-matched fit", cold.p.nu === PRIOR_DOF + 30);

const emptyBoth = choose([], [], 2.0);
ok("both empty → prior-only ν = PRIOR_DOF", emptyBoth.p.nu === PRIOR_DOF);
ok("prior-only scale = 1", emptyBoth.p.scale === 1);

// --- guards ---
ok("sigma <= 0 yields no population z (no divide-by-zero)", popZ(errs(100, 1), 0).length === 0);
ok("sigma null yields no population z", popZ(errs(100, 1), null).length === 0);
ok("non-finite residuals are dropped", popZ([1, NaN, 2, Infinity], 2).length === 2);

// --- the core property: ν must track sample size, so a starved population can never
//     produce fat tails on a well-populated side ---
ok("larger population ⇒ larger ν (thinner tails)",
   predictive(errs(500, 1)).nu > predictive(errs(50, 1)).nu);
ok("a single observation would give ν=5 — the bug being fixed",
   predictive([0.42]).nu === 5);

// --- scale stays sane when residuals are consistent with the served sigma ---
const zUnit = errs(400, 1.0);                       // |z| ~ 1 scale
const pUnit = predictive(zUnit);
ok("scale near 1 when residuals match served sigma", pUnit.scale > 0.5 && pUnit.scale < 1.5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
