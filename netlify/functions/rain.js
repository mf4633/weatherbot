// /api/rain — server-side proxy of rainbot's /api/markets, auth-gated by RAINBOT_BASIC_AUTH.
// Lets the weatherbot frontend display rainbot's edges without exposing the basic-auth
// password to the client. Returns rainbot's payload verbatim PLUS per-city gamma stats
// (mean/median/mode/sigma/CI68/CI95) computed from cities[].monthly.gamma so the dashboard
// can render a "rainfall outlook" section in the same shape as the temp HIGH/LOW cards.

const RAINBOT_BASE = process.env.RAINBOT_BASE_URL || "https://rainbot-mf.netlify.app";

// Wilson-Hilferty cube-root normal approximation: for X ~ Gamma(k, θ),
// (X/(kθ))^(1/3) is approximately N(1 - 1/(9k), 1/(9k)). Inverting gives
//   x_p ≈ kθ × (z_p × √(1/(9k)) + (1 - 1/(9k)))^3
// Accurate for k ≳ 1; rainbot's posteriors run k ≈ 3–6 so this is fine.
function gammaQuantile(shape, scale, p) {
  const z = INV_PHI[p];
  if (z == null) throw new Error(`gammaQuantile: no z-value for p=${p}`);
  const t = 1 - 1 / (9 * shape);
  const inner = z * Math.sqrt(1 / (9 * shape)) + t;
  const x = shape * scale * Math.pow(inner, 3);
  return Math.max(0, x);
}
// Standard normal inverse-CDF for the percentiles we need. Hard-coded so we
// don't pull in a numerics dep in a Netlify Function cold start.
const INV_PHI = {
  0.025: -1.959964,
  0.16:  -0.994458,
  0.5:    0,
  0.84:   0.994458,
  0.975:  1.959964
};

function gammaStats(shape, scale) {
  if (!Number.isFinite(shape) || !Number.isFinite(scale) || shape <= 0 || scale <= 0) return null;
  const mean = shape * scale;
  const std = scale * Math.sqrt(shape);
  // Mode of Gamma(k, θ) is (k-1)θ for k ≥ 1, else 0 (the density piles up at 0).
  const mode = shape >= 1 ? (shape - 1) * scale : 0;
  const median = gammaQuantile(shape, scale, 0.5);
  return {
    mean: round3(mean), median: round3(median), mode: round3(mode), std: round3(std),
    ci68: [round3(gammaQuantile(shape, scale, 0.16)),  round3(gammaQuantile(shape, scale, 0.84))],
    ci95: [round3(gammaQuantile(shape, scale, 0.025)), round3(gammaQuantile(shape, scale, 0.975))]
  };
}

function round3(x) { return Math.round(x * 1000) / 1000; }

export default async () => {
  const auth = process.env.RAINBOT_BASIC_AUTH;
  if (!auth) {
    return new Response(JSON.stringify({ error: "RAINBOT_BASIC_AUTH not set on weatherbot Netlify" }), {
      status: 503, headers: { "content-type": "application/json" }
    });
  }
  const headers = auth.startsWith("Basic ") ? { authorization: auth }
                                             : { authorization: `Basic ${auth}` };
  try {
    const r = await fetch(`${RAINBOT_BASE}/api/markets`, {
      headers, signal: AbortSignal.timeout(28_000)
    });
    if (!r.ok) {
      return new Response(JSON.stringify({ error: `rainbot upstream ${r.status}` }), {
        status: 502, headers: { "content-type": "application/json" }
      });
    }
    const j = await r.json();
    // Enrich each city with gamma stats. Posterior gamma(shape, scale) is rainbot's
    // monthly model; observedSoFar/forecastSum/meanTotal already populated upstream.
    for (const c of (j.cities || [])) {
      if (c?.monthly?.gamma) {
        c.monthly.stats = gammaStats(c.monthly.gamma.shape, c.monthly.gamma.scale);
      }
    }
    // Override rainbot's topBets (gated at 5¢ for rainbot's own dashboard) with a
    // 2¢ display gate to match the temp tables' threshold. This is purely cosmetic —
    // the trader's buy gate is 10¢ and lives in jackson_rain_trader.js, unaffected.
    // We sort by halfKelly desc to match the temp tables' ranking convention.
    //
    // We also attach `holdingDays` and `evPerDay` for time-value-of-money
    // normalization. A 5¢ edge held 30 days has a much lower per-day return rate
    // than a 5¢ edge held 1 day — `evPerDay` makes the apples-to-apples
    // comparison explicit so the dashboard can show both alongside the temp
    // table's identical fields.
    const now = new Date();
    // Settlement window heuristic: monthly markets pay ~5 days after end of month.
    // Daily binary settles next morning ≈ 1 day. Use these for evPerDay normalization.
    const MONTHLY_SETTLEMENT_DELAY_DAYS = 5;
    function holdingDaysFor(b) {
      if (b.kind === "daily-binary") return 1;
      if (b.kind === "monthly-tier") {
        // Parse month from eventTicker (e.g. "KXRAINNYCM-26MAY"). Default to current
        // month if parsing fails — accurate for the only markets rainbot serves.
        const m = (b.eventTicker || "").match(/-(\d{2})([A-Z]{3})$/);
        let target;
        if (m) {
          const yr = 2000 + parseInt(m[1], 10);
          const monIdx = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"].indexOf(m[2]);
          if (monIdx >= 0) target = new Date(Date.UTC(yr, monIdx + 1, 0));  // last day of target month
        }
        if (!target) target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
        target.setUTCDate(target.getUTCDate() + MONTHLY_SETTLEMENT_DELAY_DAYS);
        const days = (target - now) / (1000 * 60 * 60 * 24);
        return Math.max(1, Math.ceil(days));
      }
      return 1;
    }

    const DISPLAY_EDGE = 0.02;
    const PRICE_CEIL = 0.95;
    const allBets = [];
    for (const c of (j.cities || [])) {
      for (const sec of [c.daily, c.monthly]) {
        if (!sec?.bets) continue;
        for (const b of sec.bets) {
          b.holdingDays = holdingDaysFor(b);
          b.evPerDay = Math.round((b.ev_net / b.holdingDays) * 10000) / 10000;
          allBets.push(b);
        }
      }
    }
    j.topBets = allBets
      .filter(b => b && Number.isFinite(b.ev_net) && b.ev_net >= DISPLAY_EDGE && b.price <= PRICE_CEIL)
      .sort((a, b) => (b.halfKelly ?? 0) - (a.halfKelly ?? 0))
      .slice(0, 50);
    j.displayEdgeGate = DISPLAY_EDGE;
    return new Response(JSON.stringify(j), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: `rainbot fetch failed: ${String(e)}` }), {
      status: 502, headers: { "content-type": "application/json" }
    });
  }
};
