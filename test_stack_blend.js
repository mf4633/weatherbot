// Pins the FITTED base blend that replaced the hand-tuned NWS ramp (2026-07-23).
// No network.
//
// Why this exists: the served Claude-card point was `w_nws = clamp((h-2)/10, 0, 0.7)`
// toward the NWS grid — a ramp nobody fit. research/analyze_stack.js stacked all
// three independent daily-high estimators (obs-analog / 6-model Bayesian ensemble /
// raw NWS grid) against settled CLI truth on 4,414 matched-pair logged decisions
// (363 settled station-days, 28 stations, 2026-07-10..22), simplex-constrained
// weights fit on TRAIN and scored on a held-out TEST window. Findings:
//
//   · the NWS grid earns w = 0.00 at EVERY hour once the ensemble is present
//     (residual corr 0.91-0.97 — it IS an ensemble member), so the old base was
//     the redundant leg;
//   · the analog's fitted weight FALLS with hours-to-peak (0.30 / 0.12 / 0.05),
//     the opposite of the old ramp, which gave it 100% at peak and 30% at 9h out.
//
// Held out (train <=07-19, test 07-20..22, n=1215 / 83 station-days): served-point
// RMSE 3.19 -> 1.60°F, coverage under the card's own σ 0.66/0.88 -> 0.88/0.97,
// day-block bootstrap of the delta -1.60°F with 90% CI [-1.81, -1.31].
//
// The invariants below are the ones that must not silently regress:
//   1. the weight schedule itself (it is a FIT, not a preference);
//   2. monotone non-increasing in hours-to-peak;
//   3. the base is the Bayesian point when there is one, the NWS grid only as a
//      fallback — a regression to an NWS-anchored blend costs ~0.2°F held out;
//   4. the observed-max floor still binds (the served number can never sit under
//      a temperature that has already printed);
//   5. a missing base degrades to the pure analog rather than to NaN;
//   6. the 2026-07-22 KSEA-style failure — mid-afternoon Pacific, analog reading
//      several degrees under a grid the trace agrees with — is bounded now.

import { analogWeight, baseBlend, ANALOG_W } from "./netlify/functions/lib/claude_analog_v3.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); }
                             else { fail++; console.log(`  ✗ ${name}`); } };
const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

console.log("\nanalogWeight — the fitted schedule");
ok("hrs 0 → 0.30 (at peak, the trace is direct evidence)", analogWeight(0) === 0.30);
ok("hrs 1 → 0.30", analogWeight(1) === 0.30);
ok("hrs 1.5 → 0.12 (fractional hours land in the right step)", analogWeight(1.5) === 0.12);
ok("hrs 3 → 0.12", analogWeight(3) === 0.12);
ok("hrs 4 → 0.05", analogWeight(4) === 0.05);
ok("hrs 9 → 0.05 (morning: the analog knows almost nothing yet)", analogWeight(9) === 0.05);
ok("negative hours clamp to the peak step", analogWeight(-3) === 0.30);
ok("null / NaN hours → the peak step, never NaN",
   analogWeight(null) === 0.30 && analogWeight(undefined) === 0.30 && analogWeight(NaN) === 0.30);

// Monotonicity: the analog's information about today's max can only decay as the
// clock moves away from peak. A schedule that rises with hours-to-peak would be
// the old (unfit) ramp sneaking back in.
let mono = true;
for (let h = 0; h <= 14; h += 0.25) if (analogWeight(h) > analogWeight(Math.max(0, h - 0.25))) mono = false;
ok("weight is monotone non-increasing in hours-to-peak", mono);
ok("every step is a convex weight in [0,1]", ANALOG_W.every(s => s.w >= 0 && s.w <= 1));
ok("schedule ends in a catch-all step", ANALOG_W[ANALOG_W.length - 1].maxHrs === Infinity);

console.log("\nbaseBlend — anchoring");
// Bayesian base, 9h to peak: analog 5°F low against the ensemble → served point
// should sit within ~0.25°F of the ensemble, not split the difference.
{
  const b = baseBlend(80, 85, 9, 70);
  ok("far from peak: 5% analog / 95% base", approx(b.point, 0.05 * 80 + 0.95 * 85));
  ok("far from peak: reported w = 0.05", b.w === 0.05);
  ok("far from peak: served lands within 0.25°F of the base", Math.abs(b.point - 85) <= 0.25);
}
// Near peak the analog is a direct read of the trace and earns real weight.
{
  const b = baseBlend(92, 89, 0.5, 88);
  ok("near peak: 30% analog / 70% base", approx(b.point, 0.30 * 92 + 0.70 * 89));
  ok("near peak: analog visibly moves the served number", b.point - 89 > 0.5);
}

console.log("\nbaseBlend — floor, degradation, ordering");
ok("observed max floors the blend (89.5 blend under a 91 printed max → 91)",
   baseBlend(88, 90, 9, 91).point === 91);
ok("floor applies to the pure-analog fallback too",
   baseBlend(84, null, 9, 88).point === 88);
ok("no base → pure analog, w = 1 (not NaN, not 0)",
   baseBlend(84, null, 9, 70).point === 84 && baseBlend(84, null, 9, 70).w === 1);
ok("non-finite base → pure analog",
   baseBlend(84, NaN, 5, 70).point === 84 && baseBlend(84, "x", 5, 70).point === 84);
ok("non-finite maxSoFar → no floor, no NaN",
   approx(baseBlend(80, 85, 9, null).point, 0.05 * 80 + 0.95 * 85));
ok("string base is coerced, not concatenated", approx(baseBlend(80, "85", 9, null).point, 84.75));

console.log("\nregression: the failure modes this replaced");
// 2026-07-22, KSEA-style. Old ramp at hrs≈2.5: w_nws = 0.05, so the served point
// was 95% pure analog and printed ~74°F against a grid of 79°F that the trace
// went on to verify. Under the fit the analog is capped at 12% there.
{
  const analog = 74.1, bayes = 78.6, nwsGrid = 79, maxSoFar = 73;
  const oldRamp = (h) => Math.min(0.7, Math.max(0, (h - 2) / 10));
  const oldPoint = Math.max(oldRamp(2.5) * nwsGrid + (1 - oldRamp(2.5)) * analog, maxSoFar);
  const now = baseBlend(analog, bayes, 2.5, maxSoFar);
  ok(`old ramp served ${oldPoint.toFixed(1)}°F, ~5°F under the verifying grid`, oldPoint < 75);
  ok(`fitted blend serves ${now.point.toFixed(1)}°F, within 1°F of the ensemble`,
     Math.abs(now.point - bayes) <= 1.0);
}
// The morning failure the old ramp was introduced for (analog 2-7°F low) must stay
// closed: at 9h out the old ramp left 30% analog, the fit leaves 5%.
{
  const analog = 82, bayes = 89, maxSoFar = 74;
  const oldPoint = 0.7 * 89 + 0.3 * analog;          // old ramp used the NWS grid ≈ 89
  const now = baseBlend(analog, bayes, 9, maxSoFar).point;
  ok(`morning: old ${oldPoint.toFixed(1)}°F → fitted ${now.toFixed(1)}°F, closer to the ensemble`,
     Math.abs(now - bayes) < Math.abs(oldPoint - bayes));
}
// Ordering invariant: the served point always lies between the analog and the base
// (or on the floor). It is a convex combination — never an extrapolation.
{
  let convex = true;
  for (const a of [60, 75, 88, 101]) for (const b of [60, 75, 88, 101]) for (const h of [0, 2, 5, 11]) {
    const p = baseBlend(a, b, h, -Infinity).point;
    if (p < Math.min(a, b) - 1e-9 || p > Math.max(a, b) + 1e-9) convex = false;
  }
  ok("served point is always a convex combination of analog and base", convex);
}
// The NWS grid must never be preferred over the Bayesian ensemble as the base: it
// is an ensemble member (residual corr 0.91-0.97) and earned w=0.00 in the fit.
{
  const analog = 80, bayes = 88, nws = 84;
  const onBayes = baseBlend(analog, bayes, 9, -Infinity).point;
  const onNws = baseBlend(analog, nws, 9, -Infinity).point;
  ok("base choice is what moves the number, not the analog weight",
     Math.abs(onBayes - onNws) > 3 && Math.abs(onBayes - bayes) < 0.5);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
