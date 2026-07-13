// scoreboard.js — JS port of scoreboard.py's scoring. Given logged decision records
// (each with claude/bayes/market cards) + settlements, compute per-engine skill:
// MAE, RMSE, multi-bin Brier, integrated pinball (16/50/84 quantiles), and hit68
// (CI calibration). Kept in parity with scoreboard.py (test_scoreboard.js).

import { erf } from "../../../erf.js";

const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const flooredCdf = (x, mu, sigma, floor) => (x < floor ? 0 : phi((x - mu) / sigma));

// invert the floored normal by bisection
function quantile(p, mu, sigma, floor) {
  let lo = floor, hi = mu + 8 * sigma;
  if (flooredCdf(lo, mu, sigma, floor) >= p) return lo;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (flooredCdf(mid, mu, sigma, floor) < p) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}
const pinball = (truth, q, tau) => Math.max(tau * (truth - q), (tau - 1) * (truth - q));

// Parse a bin label ('<=82','83-84','>=91') against an integer CLI max.
function binHit(label, truth) {
  const t = Math.round(truth);
  label = label.replace(/°/g, "").trim();
  if (label.startsWith("<=")) return t <= parseInt(label.slice(2), 10);
  if (label.startsWith(">=")) return t >= parseInt(label.slice(2), 10);
  // 2026-07-09 bugsweep FIX 2: '-5--4' / '-1-0' (winter bins) must not be split
  // naively — regex handles signed endpoints.
  const r = label.match(/^(-?\d+)-(-?\d+)$/);
  if (r) return +r[1] <= t && t <= +r[2];
  return t === parseInt(label, 10);
}

function newScore() { return { n: 0, absErr: 0, sqErr: 0, brier: 0, brierN: 0, pinball: 0, in68: 0, ciN: 0 }; }

function addToScore(s, card, truth) {
  const mu = +card.point;
  s.n += 1; s.absErr += Math.abs(mu - truth); s.sqErr += (mu - truth) ** 2;
  const sigma = +(card.sigma || 0), floor = card.floor != null ? +card.floor : -Infinity;
  if (sigma > 0) for (const tau of [0.16, 0.50, 0.84]) s.pinball += pinball(truth, quantile(tau, mu, sigma, floor), tau);
  const ci = card.ci68;
  if (ci) { s.ciN += 1; if (ci[0] <= truth && truth <= ci[1]) s.in68 += 1; }
  const probs = card.bin_probs;
  if (probs && Object.keys(probs).length) {
    s.brierN += 1;
    s.brier += Object.entries(probs).reduce((a, [lbl, p]) => a + (p - (binHit(lbl, truth) ? 1 : 0)) ** 2, 0);
  }
}

export function marketPoint(probs) {
  let total = 0, acc = 0;
  for (let [lbl, p] of Object.entries(probs)) {
    lbl = lbl.replace(/°/g, "").trim();
    let mid;
    if (lbl.startsWith("<=")) mid = parseInt(lbl.slice(2), 10) - 1;
    else if (lbl.startsWith(">=")) mid = parseInt(lbl.slice(2), 10) + 1;
    else { const r = lbl.match(/^(-?\d+)-(-?\d+)$/);           // FIX 2: signed bins
           mid = r ? (+r[1] + +r[2]) / 2 : +lbl; }
    acc += p * mid; total += p;
  }
  return total ? acc / total : NaN;
}

// Pre-registered trading gate: is v3 (claude) beating the market OUT OF SAMPLE?
// Paired multi-bin Brier over settled city-days, using the LAST pre-settlement
// decision per city-day and only days where BOTH claude and the market posted a
// full book. Market probs are raw yes-ask prices (price/100) — so "beat market"
// here means beat the posted book NET OF SPREAD, the real bar. `passed` requires
// a lower claude Brier AND n >= nMin (default 30). Trading stays OFF until passed.
//
// pick:"first" evaluates at the FIRST logged decision per city-day instead — the
// tradeable window. Added 2026-07-13 after the first settled data showed the
// last-decision book is already ~99¢ on the winner (market Brier 0.001), making
// the original comparison fail-safe but uninformative about a morning edge. The
// original last-decision gate is unchanged and still governs; this is additive.
export function evaluateGate(records, { nMin = 30, pick = "last" } = {}) {
  const truths = {};
  for (const r of records) if (r.type === "settlement") truths[`${r.station}|${r.contract_date}`] = r.cli_max;
  const latest = {};
  for (const r of records) {
    if (r.type !== "decision") continue;
    const k = `${r.station}|${r.contract_date}`;
    if (!(k in truths)) continue;
    if (!latest[k] || (pick === "first" ? r.asof < latest[k].asof : r.asof > latest[k].asof)) latest[k] = r;
  }
  const brierOf = (probs, truth) =>
    Object.entries(probs).reduce((a, [lbl, p]) => a + (p - (binHit(lbl, truth) ? 1 : 0)) ** 2, 0);
  let n = 0, cSum = 0, mSum = 0;
  for (const k of Object.keys(latest)) {
    const r = latest[k], truth = truths[k];
    const cp = r.claude?.bin_probs;
    const mp = r.market ? Object.fromEntries(Object.entries(r.market).map(([kk, v]) => [kk, v / 100])) : null;
    if (!cp || !Object.keys(cp).length || !mp || !Object.keys(mp).length) continue;
    n++; cSum += brierOf(cp, truth); mSum += brierOf(mp, truth);
  }
  const claudeBrier = n ? cSum / n : null;
  const marketBrier = n ? mSum / n : null;
  const edge = (claudeBrier != null && marketBrier != null) ? marketBrier - claudeBrier : null;
  const passed = n >= nMin && claudeBrier != null && claudeBrier < marketBrier;
  const w = pick === "first" ? "first-decision" : "last-decision";
  const verdict = passed
    ? `PASS — v3 Brier ${claudeBrier.toFixed(3)} < market ${marketBrier.toFixed(3)} over ${n} ${w} city-days; sizing may be considered`
    : n < nMin
      ? `HOLD — ${n}/${nMin} paired settled city-days (${w}; need out-of-sample volume before any real money)`
      : `HOLD — v3 Brier ${claudeBrier.toFixed(3)} ≥ market ${marketBrier.toFixed(3)} over ${n} ${w} city-days (no demonstrated edge)`;
  return { nMin, n, pick, claudeBrier, marketBrier, edge, passed, verdict };
}

const summarize = (s) => s.n === 0 ? { n: 0 } : {
  n: s.n, mae: s.absErr / s.n, rmse: Math.sqrt(s.sqErr / s.n),
  brier: s.brierN ? s.brier / s.brierN : null,
  pinball: s.pinball ? s.pinball / s.n : null,
  hit68: s.ciN ? s.in68 / s.ciN : null,
};

// Parse a bin label into inclusive integer bounds (shares binHit's conventions).
export function labelBounds(label) {
  label = label.replace(/°/g, "").trim();
  if (label.startsWith("<=")) return { lo: -Infinity, hi: parseInt(label.slice(2), 10) };
  if (label.startsWith(">=")) return { lo: parseInt(label.slice(2), 10), hi: Infinity };
  const r = label.match(/^(-?\d+)-(-?\d+)$/);
  if (r) return { lo: +r[1], hi: +r[2] };
  const n = parseInt(label, 10);
  return Number.isFinite(n) ? { lo: n, hi: n } : null;
}

// Bin probabilities implied by a floored normal (point, sigma, floor) over the same
// labels the Claude card used — lets the Bayesian (and the blend) be Brier-scored on
// identical bins instead of point-error only.
function derivedBinProbs(labels, mu, sigma, floor) {
  if (!(sigma > 0)) return null;
  const out = {};
  for (const lbl of labels) {
    const b = labelBounds(lbl);
    if (!b) return null;
    const a = b.lo === -Infinity ? -Infinity : b.lo - 0.5;
    const c = b.hi === Infinity ? Infinity : b.hi + 0.5;
    const pa = a === -Infinity ? 0 : flooredCdf(a, mu, sigma, floor);
    const pb = c === Infinity ? 1 : flooredCdf(c, mu, sigma, floor);
    out[lbl] = Math.max(0, pb - pa);
  }
  const s = Object.values(out).reduce((x, y) => x + y, 0);
  if (s > 0) for (const k of Object.keys(out)) out[k] /= s;
  return out;
}

// records: [{type:'decision', station, contract_date, asof, claude, bayes?, market?, nws?}]
//        ∪ [{type:'settlement', station, contract_date, cli_max}]
// market cards are {label: yes_price_cents}; scored as implied probs (price/100).
// Engines scored: claude, bayes, market, nws (raw NWS daily-high point), and
// blend (equal-weight average of the Claude and Bayesian points + bin probs) —
// the "is the average better than either alone" question, answered continuously.
export function score(records, { lastObOnly = false } = {}) {
  const truths = {};
  for (const r of records) if (r.type === "settlement") truths[`${r.station}|${r.contract_date}`] = r.cli_max;
  let decisions = records.filter(r => r.type === "decision" && `${r.station}|${r.contract_date}` in truths);
  if (lastObOnly) {
    const latest = {};
    for (const r of decisions) { const k = `${r.station}|${r.contract_date}`; if (!latest[k] || r.asof > latest[k].asof) latest[k] = r; }
    decisions = Object.values(latest);
  }
  const scores = { claude: newScore(), bayes: newScore(), market: newScore(), nws: newScore(), blend: newScore() };
  for (const r of decisions) {
    const truth = truths[`${r.station}|${r.contract_date}`];
    const labels = r.claude?.bin_probs && Object.keys(r.claude.bin_probs).length ? Object.keys(r.claude.bin_probs) : null;
    if (r.claude) addToScore(scores.claude, r.claude, truth);
    let bayesProbs = null;
    if (r.bayes) {
      bayesProbs = labels ? derivedBinProbs(labels, +r.bayes.point, +(r.bayes.sigma || 0), r.bayes.floor != null ? +r.bayes.floor : -Infinity) : null;
      addToScore(scores.bayes, bayesProbs ? { ...r.bayes, bin_probs: bayesProbs } : r.bayes, truth);
    }
    if (r.claude && r.bayes && r.claude.point != null && r.bayes.point != null) {
      // Blend uses the thin-analog-guarded point when logged — the zero-ramp
      // degeneracy made pure-model mornings unusable (retro: blend MAE 4.45→2.07).
      const cPoint = r.claude.guarded_point != null ? +r.claude.guarded_point : +r.claude.point;
      const blend = { point: (cPoint + +r.bayes.point) / 2 };
      if (labels && bayesProbs) {
        blend.bin_probs = {};
        for (const k of labels) blend.bin_probs[k] = ((r.claude.bin_probs[k] || 0) + (bayesProbs[k] || 0)) / 2;
      }
      addToScore(scores.blend, blend, truth);
    }
    if (r.nws != null && Number.isFinite(+r.nws)) addToScore(scores.nws, { point: +r.nws }, truth);
    if (r.market) {
      const probs = Object.fromEntries(Object.entries(r.market).map(([k, v]) => [k, v / 100]));
      addToScore(scores.market, { point: marketPoint(probs), bin_probs: probs }, truth);
    }
  }
  return { claude: summarize(scores.claude), bayes: summarize(scores.bayes), market: summarize(scores.market),
           nws: summarize(scores.nws), blend: summarize(scores.blend) };
}
