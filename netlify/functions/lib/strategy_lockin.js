// Strategy A — observation lock-in. Given one city/variable market snapshot (the raw
// order book + current observations), emit only bets whose outcome is physically LOCKED
// by observations already in hand (see diurnal.js) AND that the market still misprices.
// No forecast model is consulted. Fills are REALISTIC: we cross the spread (pay the ask)
// and pay the confirmed Kalshi per-contract fee. This is deliberately conservative — it
// abstains on anything not near-certain.

import { extremumBounds, lockinDecision } from "./diurnal.js";

// Confirmed true Kalshi per-contract fee (validated against real fees_paid).
export const feePerContract = (price) => Math.ceil(0.07 * price * (1 - price) * 100) / 100;

// Minimum net edge (after fee) to bother — covers residual settlement risk + latency slippage.
export const DEFAULT_MIN_EDGE = 0.03;

// snapshot: { variable, obs: {maxSoFar,minSoFar,currentTemp,localHour},
//             buckets: [{ticker, loInt, hiInt, yes_ask, yes_bid, no_ask, no_bid, ...}] }
// Returns [{ ticker, side, price, edge, reason }] — buys at the ask (realistic fill).
export function lockinBets(snapshot, opts = {}) {
  const minEdge = opts.minEdge ?? DEFAULT_MIN_EDGE;
  const bounds = extremumBounds(snapshot.variable, snapshot.obs);
  if (!bounds) return [];               // obs can't lock the outcome yet → abstain
  const out = [];
  for (const b of snapshot.buckets || []) {
    for (const side of ["YES", "NO"]) {
      const dec = lockinDecision(side, b.loInt, b.hiInt, bounds);
      if (dec.certain !== "win") continue;           // only bet locked winners
      const ask = side === "YES" ? b.yes_ask : b.no_ask;
      if (ask == null || ask <= 0 || ask >= 1) continue;
      const edge = 1 - ask - feePerContract(ask);     // certain win pays $1
      if (edge < minEdge) continue;                   // market already (near-)fairly priced
      out.push({ ticker: b.ticker, side, price: ask, edge: Math.round(edge * 1000) / 1000,
                 reason: `obs-lock ${snapshot.variable} [${bounds.floor.toFixed(1)},${bounds.ceil.toFixed(1)}]` });
    }
  }
  return out;
}
