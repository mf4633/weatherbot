// test_kalshi_orders.js — V2 order payloads (migration 2026-07-23).
// The point of this file is the direction truth table: on V2 every order is quoted on
// the YES leg, so a NO bet must flip BOTH the book side and the price. A regression here
// submits the opposite trade with real money, which is why it is pinned exhaustively.
import { bookSideFor, yesLegPriceCents, buildOrderBody, normalizeOrderResponse, V2_ORDERS_PATH }
  from "./netlify/functions/lib/kalshi_orders.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ---- direction truth table (all four combinations) ----
{
  ok("buy YES  → bid",  bookSideFor("buy", "yes") === "bid");
  ok("buy NO   → ask (selling YES is buying NO)", bookSideFor("buy", "no") === "ask");
  ok("sell YES → ask",  bookSideFor("sell", "yes") === "ask");
  ok("sell NO  → bid (buying YES closes a NO)",   bookSideFor("sell", "no") === "bid");
  ok("case-insensitive", bookSideFor("BUY", "YES") === "bid" && bookSideFor("Sell", "No") === "bid");
  ok("bad action throws", (() => { try { bookSideFor("hold", "yes"); return false; } catch { return true; } })());
  ok("bad side throws",   (() => { try { bookSideFor("buy", "maybe"); return false; } catch { return true; } })());
}

// ---- price is complemented for the NO leg, untouched for YES ----
{
  ok("YES 30¢ stays 30", yesLegPriceCents("yes", 30) === 30);
  ok("NO 30¢ → YES 70",  yesLegPriceCents("no", 30) === 70);
  ok("NO 99¢ → YES 1",   yesLegPriceCents("no", 99) === 1);
  ok("NO 1¢  → YES 99",  yesLegPriceCents("no", 1) === 99);
  ok("0¢ rejected",   (() => { try { yesLegPriceCents("yes", 0); return false; } catch { return true; } })());
  ok("100¢ rejected", (() => { try { yesLegPriceCents("yes", 100); return false; } catch { return true; } })());
}

// ---- full body: the exact wire shape ----
{
  const b = buildOrderBody({
    ticker: "KXHIGHDEN-26JUL23-B86.5", action: "buy", side: "no", count: 7,
    priceCents: 25, clientOrderId: "wb-test-1", expirySec: 900, nowMs: 1_753_000_000_000
  });
  ok("path constant", V2_ORDERS_PATH === "/trade-api/v2/portfolio/events/orders");
  ok("buy NO 25¢ → side ask", b.side === "ask");
  ok("buy NO 25¢ → price 0.7500", b.price === "0.7500");
  ok("count is 2-decimal string", b.count === "7.00");
  ok("time_in_force gtc", b.time_in_force === "good_till_canceled");
  ok("expiration_time = now+expiry (sec)", b.expiration_time === 1_753_000_000 + 900);
  ok("stp set", b.self_trade_prevention_type === "taker_at_cross");
  ok("client_order_id passed through", b.client_order_id === "wb-test-1");
  ok("no V1 fields leak", !("action" in b) && !("yes_price" in b) && !("no_price" in b) && !("type" in b) && !("expiration_ts" in b));

  const y = buildOrderBody({ ticker: "T", action: "buy", side: "yes", count: 1, priceCents: 56, clientOrderId: "c", nowMs: 0 });
  ok("buy YES 56¢ → bid @ 0.5600", y.side === "bid" && y.price === "0.5600");

  const s = buildOrderBody({ ticker: "T", action: "sell", side: "no", count: 3.4, priceCents: 92, clientOrderId: "c", nowMs: 0 });
  ok("sell NO 92¢ → bid @ 0.0800", s.side === "bid" && s.price === "0.0800");
  ok("count rounds", s.count === "3.00");

  ok("count floors at 1", buildOrderBody({ ticker: "T", action: "buy", side: "yes", count: 0, priceCents: 5, clientOrderId: "c", nowMs: 0 }).count === "1.00");
  ok("missing ticker throws", (() => { try { buildOrderBody({ action: "buy", side: "yes", count: 1, priceCents: 5 }); return false; } catch { return true; } })());
}

// ---- round trip: a NO buy must be economically identical to the V1 intent ----
{
  // V1: {action:"buy", side:"no", no_price:35} = pay 35¢ for a NO contract.
  // V2: sell YES at 65¢ = receive 65¢ against $1 collateral = pay 35¢. Same trade.
  const b = buildOrderBody({ ticker: "T", action: "buy", side: "no", count: 1, priceCents: 35, clientOrderId: "c", nowMs: 0 });
  const impliedNoCost = 100 - Math.round(parseFloat(b.price) * 100);
  ok("NO buy cost preserved (35¢)", b.side === "ask" && impliedNoCost === 35);
}

// ---- response normalization keeps the ledger's res.body.order.* contract ----
{
  const flat = { order_id: "abc", client_order_id: "wb-1", fill_count: "0.00", remaining_count: "7.00", ts_ms: 123 };
  const n = normalizeOrderResponse(flat);
  ok("flat V2 response re-nested under .order", n.order.order_id === "abc" && n.order.client_order_id === "wb-1");
  ok("fill fields preserved", n.order.fill_count === "0.00" && n.order.remaining_count === "7.00");
  ok("top-level fields kept", n.order_id === "abc");

  const wrapped = normalizeOrderResponse({ order: { order_id: "z", client_order_id: "w" } });
  ok("already-wrapped shape tolerated", wrapped.order.order_id === "z");

  const empty = normalizeOrderResponse({});
  ok("empty body → nulls, no throw", empty.order.order_id === null && empty.order.client_order_id === null);

  const err = normalizeOrderResponse({ error: { code: "insufficient_balance" } });
  ok("error body passes through", err.error.code === "insufficient_balance" && err.order.order_id === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
