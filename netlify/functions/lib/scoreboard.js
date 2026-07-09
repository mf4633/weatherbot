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
  if (label.includes("-")) { const [lo, hi] = label.split("-"); return +lo <= t && t <= +hi; }
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
    else if (lbl.includes("-")) { const [lo, hi] = lbl.split("-"); mid = (+lo + +hi) / 2; }
    else mid = +lbl;
    acc += p * mid; total += p;
  }
  return total ? acc / total : NaN;
}

const summarize = (s) => s.n === 0 ? { n: 0 } : {
  n: s.n, mae: s.absErr / s.n, rmse: Math.sqrt(s.sqErr / s.n),
  brier: s.brierN ? s.brier / s.brierN : null,
  pinball: s.pinball ? s.pinball / s.n : null,
  hit68: s.ciN ? s.in68 / s.ciN : null,
};

// records: [{type:'decision', station, contract_date, asof, claude, bayes?, market?}]
//        ∪ [{type:'settlement', station, contract_date, cli_max}]
// market cards are {label: yes_price_cents}; scored as implied probs (price/100).
export function score(records, { lastObOnly = false } = {}) {
  const truths = {};
  for (const r of records) if (r.type === "settlement") truths[`${r.station}|${r.contract_date}`] = r.cli_max;
  let decisions = records.filter(r => r.type === "decision" && `${r.station}|${r.contract_date}` in truths);
  if (lastObOnly) {
    const latest = {};
    for (const r of decisions) { const k = `${r.station}|${r.contract_date}`; if (!latest[k] || r.asof > latest[k].asof) latest[k] = r; }
    decisions = Object.values(latest);
  }
  const scores = { claude: newScore(), bayes: newScore(), market: newScore() };
  for (const r of decisions) {
    const truth = truths[`${r.station}|${r.contract_date}`];
    if (r.claude) addToScore(scores.claude, r.claude, truth);
    if (r.bayes) addToScore(scores.bayes, r.bayes, truth);
    if (r.market) {
      const probs = Object.fromEntries(Object.entries(r.market).map(([k, v]) => [k, v / 100]));
      addToScore(scores.market, { point: marketPoint(probs), bin_probs: probs }, truth);
    }
  }
  return { claude: summarize(scores.claude), bayes: summarize(scores.bayes), market: summarize(scores.market) };
}
