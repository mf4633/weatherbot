// pWin calibration fitter. Runs every 30 min.
//
// Fits a Platt-style logistic recalibration AND an isotonic regression
// from settled bets, persists both to the `pwin_calibration_state` blob.
//
// Inputs per settled bet: modelMean, modelStd, ticker, side, variable, outcome.
// We reconstruct raw pWin under N(modelMean, modelStd) using the ticker's
// bucket bounds. This mirrors backtest_pwin_cap.py exactly — produces the same
// pWin distribution we already used to set P_WIN_CAP=0.95.
//
// Calibration math:
//   raw_pWin → p_cal
//
//   Platt: p_cal = sigmoid(A · logit(p_hat) + B)
//     A=1, B=0 is the identity. A<1 pulls extremes toward 0.5 (overconfident
//     model). A>1 sharpens. B shifts the operating point.
//     Fit by Newton-Raphson on cross-entropy with Platt smoothing
//     (y_pos → (N_pos+1)/(N_pos+2), y_neg → 1/(N_neg+2)).
//
//   Isotonic (PAV — Pool Adjacent Violators): non-parametric monotonic step
//     function. Catches non-Platt-shaped calibration but can overfit at small n.
//
// Output: { platt: {A, B}, isotonic: [{from, to, pCal, n, wins}],
//           brier_uncal, brier_platt, brier_iso, n_bets, fitAtUTC }
//
// NOT WIRED INTO THE TRADER YET. The fit is data plumbing; the layer-in is a
// follow-up decision once we have ≥50 fresh post-σ_revision bets to validate
// against (calibration shape may shift materially as σ_post widens).

import { getStore } from "@netlify/blobs";

const SETTLED_STORE       = "jackson_settled_bets";
const CALIBRATION_STORE   = "pwin_calibration_state";
const CALIBRATION_KEY     = "current.json";

// Standard normal CDF via erf.
function Phi(z) {
  // Abramowitz & Stegun 7.1.26
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t*Math.exp(-x*x);
  return 0.5 * (1.0 + sign * y);
}
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function logitClamp(p) {
  const eps = 1e-6;
  const q = Math.min(1 - eps, Math.max(eps, p));
  return Math.log(q / (1 - q));
}

// Mirror of backtest_pwin_cap.py pwin().
function parseTickerTail(ticker) {
  const tail = ticker.split("-").pop();
  if (tail.startsWith("B")) {
    const c = parseFloat(tail.slice(1));
    return { kind: "B", lo: c - 0.5, hi: c + 0.5 };
  }
  if (tail.startsWith("T")) {
    return { kind: "T", thresh: parseFloat(tail.slice(1)) };
  }
  return { kind: null };
}
function reconstructPWin(bet) {
  const mu = bet.modelMean, sigma = bet.modelStd;
  if (!Number.isFinite(mu) || !Number.isFinite(sigma) || sigma <= 0) return null;
  const t = parseTickerTail(bet.ticker);
  if (!t.kind) return null;
  const side = bet.side, variable = bet.variable;
  if (t.kind === "B") {
    const pIn = Phi((t.hi - mu) / sigma) - Phi((t.lo - mu) / sigma);
    return side === "YES" ? pIn : 1 - pIn;
  }
  if (t.kind === "T") {
    const pAtOrBelow = Phi((t.thresh - mu) / sigma);
    const pYes = variable === "high" ? (1 - pAtOrBelow) : pAtOrBelow;
    return side === "YES" ? pYes : 1 - pYes;
  }
  return null;
}

// Platt fit via Newton-Raphson. Targets are Platt-smoothed labels.
// Loss: cross-entropy on smoothed targets, no L2 (small param count + smoothing handles).
function fitPlatt(samples) {
  const nPos = samples.filter(s => s.y === 1).length;
  const nNeg = samples.length - nPos;
  if (nPos === 0 || nNeg === 0) return { A: 1, B: 0, converged: false, reason: "single-class" };
  const tPos = (nPos + 1) / (nPos + 2);
  const tNeg = 1 / (nNeg + 2);
  const targets = samples.map(s => s.y === 1 ? tPos : tNeg);
  const x = samples.map(s => logitClamp(s.pHat));

  let A = 1, B = 0;
  const MAX_ITER = 100, TOL = 1e-7;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let g0 = 0, g1 = 0;          // gradient (∂/∂B, ∂/∂A)
    let h00 = 0, h01 = 0, h11 = 0;  // Hessian
    for (let i = 0; i < samples.length; i++) {
      const z = A * x[i] + B;
      const p = sigmoid(z);
      const r = p - targets[i];   // residual
      g0 += r;
      g1 += r * x[i];
      const w = p * (1 - p);
      h00 += w;
      h01 += w * x[i];
      h11 += w * x[i] * x[i];
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) return { A, B, converged: false, reason: "singular-hessian" };
    const dB = (h11 * g0 - h01 * g1) / det;
    const dA = (-h01 * g0 + h00 * g1) / det;
    A -= dA; B -= dB;
    if (Math.abs(dA) < TOL && Math.abs(dB) < TOL) return { A, B, converged: true, iter };
  }
  return { A, B, converged: false, reason: "max-iter" };
}

// PAV isotonic regression. Returns array of {from, to, pCal, n, wins} sorted by from.
function fitIsotonic(samples) {
  const sorted = [...samples].sort((a, b) => a.pHat - b.pHat);
  // Each point starts as its own block
  const blocks = sorted.map(s => ({ from: s.pHat, to: s.pHat, sum: s.y, n: 1 }));
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].sum / blocks[i].n > blocks[i+1].sum / blocks[i+1].n) {
      blocks[i].to = blocks[i+1].to;
      blocks[i].sum += blocks[i+1].sum;
      blocks[i].n += blocks[i+1].n;
      blocks.splice(i+1, 1);
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  return blocks.map(b => ({
    from: Math.round(b.from * 1000) / 1000,
    to: Math.round(b.to * 1000) / 1000,
    pCal: Math.round((b.sum / b.n) * 1000) / 1000,
    n: b.n,
    wins: b.sum
  }));
}

function brier(predictions, ys) {
  let s = 0;
  for (let i = 0; i < predictions.length; i++) {
    s += (predictions[i] - ys[i]) ** 2;
  }
  return predictions.length ? s / predictions.length : null;
}

function applyPlatt(pHat, A, B) {
  return sigmoid(A * logitClamp(pHat) + B);
}
function applyIsotonic(pHat, iso) {
  for (const b of iso) if (pHat >= b.from && pHat <= b.to) return b.pCal;
  if (pHat < iso[0].from) return iso[0].pCal;
  return iso[iso.length - 1].pCal;
}

async function loadAllBets() {
  const store = getStore(SETTLED_STORE);
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  const entries = await Promise.all(
    blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null))
  );
  return entries.filter(Boolean);
}

async function computeCalibration() {
  const bets = await loadAllBets();
  const samples = [];
  let skipped = 0;
  for (const b of bets) {
    if (!b || !b.outcome || (b.outcome !== "WIN" && b.outcome !== "LOSS")) { skipped++; continue; }
    const pHat = reconstructPWin(b);
    if (pHat == null || !Number.isFinite(pHat)) { skipped++; continue; }
    samples.push({ pHat, y: b.outcome === "WIN" ? 1 : 0, variable: b.variable });
  }
  if (samples.length < 20) {
    return {
      fit: false, reason: `n=${samples.length} < 20 minimum`,
      n_bets: samples.length, skipped, fitAtUTC: new Date().toISOString()
    };
  }
  const platt = fitPlatt(samples);
  const isotonic = fitIsotonic(samples);
  const ys = samples.map(s => s.y);
  const pHats = samples.map(s => s.pHat);
  const pCalPlatt = pHats.map(p => applyPlatt(p, platt.A, platt.B));
  const pCalIso   = pHats.map(p => applyIsotonic(p, isotonic));
  const brierUncal = brier(pHats, ys);
  const brierPlatt = brier(pCalPlatt, ys);
  const brierIso   = brier(pCalIso, ys);

  // Per-variable Platt fits (HIGH and LOW often have different calibration shapes).
  const samplesHigh = samples.filter(s => s.variable === "high");
  const samplesLow  = samples.filter(s => s.variable === "low");
  const plattHigh = samplesHigh.length >= 20 ? fitPlatt(samplesHigh) : null;
  const plattLow  = samplesLow.length  >= 20 ? fitPlatt(samplesLow)  : null;

  return {
    fit: true,
    n_bets: samples.length,
    skipped,
    platt: { A: Math.round(platt.A * 1000) / 1000, B: Math.round(platt.B * 1000) / 1000,
             converged: platt.converged, reason: platt.reason || null },
    platt_high: plattHigh ? { A: Math.round(plattHigh.A * 1000) / 1000, B: Math.round(plattHigh.B * 1000) / 1000,
                              n: samplesHigh.length, converged: plattHigh.converged } : null,
    platt_low:  plattLow  ? { A: Math.round(plattLow.A * 1000) / 1000, B: Math.round(plattLow.B * 1000) / 1000,
                              n: samplesLow.length, converged: plattLow.converged } : null,
    isotonic,
    brier_uncal: Math.round(brierUncal * 1e4) / 1e4,
    brier_platt: Math.round(brierPlatt * 1e4) / 1e4,
    brier_iso:   Math.round(brierIso   * 1e4) / 1e4,
    fitAtUTC: new Date().toISOString(),
    notes: "Fit only — not wired into the trader. Recalibration layer-in is gated "
         + "on ≥50 fresh post-σ_revision bets (deploy 48339d0) to validate that "
         + "calibration shape stays stable after the σ posterior widens."
  };
}

export default async () => {
  try {
    const state = await computeCalibration();
    const store = getStore(CALIBRATION_STORE);
    await store.setJSON(CALIBRATION_KEY, state);
    return new Response(JSON.stringify({ ok: true, ...state }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }),
      { status: 500, headers: { "content-type": "application/json" } });
  }
};

export const config = { schedule: "*/30 * * * *" };
