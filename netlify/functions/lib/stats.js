// Shared standard-normal helpers, extracted from the four production functions
// that each carried their own copy (weather.js `_Phi`, kalshi.js `normCdf`,
// jackson_trader.js / combo_trader.js `normCdf01`).
//
// Two DIFFERENT approximations are kept as separate exports on purpose. They
// return slightly different values (~1e-7), and the live pWin/EV math was tuned
// against the specific one each caller used — so every caller imports the exact
// function it had before. Do NOT collapse these into one.

// Standard normal CDF, Abramowitz & Stegun 26.2.17 (~7-decimal accuracy).
// Callers: weather.js (as `_Phi`), kalshi.js (as `normCdf`).
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Standard normal CDF, Abramowitz & Stegun 7.1.26 (erf form, max error ~1.5e-7).
// Callers: jackson_trader.js / combo_trader.js tail-bucket posterior gate.
export function normCdf01(z) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1; const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}
