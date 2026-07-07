// Gauss error function, Abramowitz & Stegun 7.1.26 (max error ~1.5e-7).
// Extracted from the backtest scripts that each carried an identical copy
// (backtest_obs_disagreement.js, backtest_sigma_irred.js, backtest_gates.js,
// backtest_adaptive_damping.js). normCdf(z) = 0.5*(1 + erf(z/√2)).
export function erf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
