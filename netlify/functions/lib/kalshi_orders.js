// kalshi_orders.js — Kalshi V2 order-payload construction (migration 2026-07-23).
//
// WHY THIS EXISTS
// Kalshi retired POST /trade-api/v2/portfolio/orders. Since 2026-07-09 it answers
// 410 Gone with {error:{code:"deprecated_v1_order_endpoint"}} — that error is the last
// thing the live trader ever logged (a concentration-trim sell on KXHIGHDEN-26JUL09-B88.5).
// Order writes now go to POST /trade-api/v2/portfolio/events/orders. Reads are unaffected:
// GET /portfolio/{orders,fills,positions,balance} all still answer (probed 2026-07-23).
//
// THE CHANGE THAT CAN LOSE MONEY
// V1 addressed either leg directly: {action:"buy"|"sell", side:"yes"|"no", yes_price|no_price}.
// V2 has NO "no" side. Every order is quoted on the YES leg:
//     side "bid" = buy YES        side "ask" = sell YES
// and buying NO at p is expressed as SELLING YES at (1 - p). So both the book side AND
// the price change when the bet is a NO — invert one but not the other and you submit a
// trade in the opposite direction at a nonsense price. That mapping is isolated here as a
// pure function and pinned by a truth table in test_kalshi_orders.js.
//
// Prices stay integer cents (1-99) at every call site — the old interface — and are
// converted to V2's dollar strings only at the boundary, so no caller math changes.

export const V2_ORDERS_PATH = "/trade-api/v2/portfolio/events/orders";

// Book side for an (action, leg) pair, on the YES leg only.
//   buy  yes -> bid   (buy YES)
//   buy  no  -> ask   (sell YES == buy NO)
//   sell yes -> ask   (sell YES)
//   sell no  -> bid   (buy YES == close a NO)
export function bookSideFor(action, side) {
  const a = String(action).toLowerCase(), s = String(side).toLowerCase();
  if (a !== "buy" && a !== "sell") throw new Error(`kalshi_orders: bad action ${action}`);
  if (s !== "yes" && s !== "no") throw new Error(`kalshi_orders: bad side ${side}`);
  return (a === "buy") === (s === "yes") ? "bid" : "ask";
}

// Price on the YES leg, in cents. A NO price of p is a YES price of 100 - p.
export function yesLegPriceCents(side, priceCents) {
  const s = String(side).toLowerCase();
  const p = Math.round(Number(priceCents));
  if (!Number.isFinite(p) || p < 1 || p > 99) {
    throw new Error(`kalshi_orders: price out of range (1-99 cents): ${priceCents}`);
  }
  return s === "yes" ? p : 100 - p;
}

// Build the V2 request body. `side`/`priceCents` describe OUR leg exactly as V1 did.
// expirySec: seconds the order may rest (V1 used expiration_ts; V2 pairs
// good_till_canceled with an absolute expiration_time).
export function buildOrderBody({ ticker, action, side, count, priceCents, clientOrderId, expirySec = 900, nowMs = Date.now() }) {
  if (!ticker) throw new Error("kalshi_orders: ticker required");
  const n = Math.max(1, Math.round(Number(count)));
  if (!Number.isFinite(n)) throw new Error(`kalshi_orders: bad count ${count}`);
  const yesCents = yesLegPriceCents(side, priceCents);
  return {
    ticker,
    side: bookSideFor(action, side),
    count: n.toFixed(2),                      // V2 wants a 2-decimal string
    price: (yesCents / 100).toFixed(4),       // dollars, e.g. 70 -> "0.7000"
    time_in_force: "good_till_canceled",
    expiration_time: Math.floor(nowMs / 1000) + expirySec,
    self_trade_prevention_type: "taker_at_cross",
    client_order_id: clientOrderId
  };
}

// V2 returns the order fields flat (order_id, fill_count, …); V1 nested them under
// `order`. Every ledger call site reads res.body?.order?.{order_id,client_order_id},
// so re-nest rather than touch that bookkeeping. Tolerates a wrapped shape too, in case
// Kalshi normalizes later.
export function normalizeOrderResponse(j) {
  const o = (j && typeof j === "object" && j.order && typeof j.order === "object") ? j.order : (j || {});
  return {
    ...j,
    order: {
      order_id: o.order_id ?? null,
      client_order_id: o.client_order_id ?? null,
      status: o.status ?? null,
      fill_count: o.fill_count ?? null,
      remaining_count: o.remaining_count ?? null,
      average_fill_price: o.average_fill_price ?? null,
      average_fee_paid: o.average_fee_paid ?? null,
      ts_ms: o.ts_ms ?? null
    }
  };
}
