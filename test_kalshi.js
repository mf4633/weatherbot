// test_kalshi.js — parse Kalshi daily-high markets → floor-scan board rows.
import { parseMarketToBook, booksFromMarkets, eventDateCode, marketsForDay }
  from "./netlify/functions/lib/kalshi.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ---- structured strikes ----
{
  const between = parseMarketToBook({ subtitle: "89° to 90°", strike_type: "between", floor_strike: 89, cap_strike: 90, no_ask: 99, yes_bid: 2 });
  ok("between: loInt/hiInt from strikes", between.loInt === 89 && between.hiInt === 90);
  ok("between: cents → dollars", between.no_ask === 0.99 && between.yes_bid === 0.02);

  const below = parseMarketToBook({ subtitle: "88° or below", strike_type: "less_or_equal", cap_strike: 88, no_ask: 99, yes_bid: 1 });
  ok("below: open bottom bucket (loInt null, hiInt=cap)", below.loInt === null && below.hiInt === 88);

  const above = parseMarketToBook({ subtitle: "97° or above", strike_type: "greater_or_equal", floor_strike: 97, no_ask: 98, yes_bid: 3 });
  ok("above: open top bucket (loInt=floor, hiInt null)", above.loInt === 97 && above.hiInt === null);
}

// ---- subtitle fallback when strikes are absent ----
{
  const b = parseMarketToBook({ subtitle: "91° to 92°", no_ask: 92, yes_bid: 9 });
  ok("fallback: 'X to Y' → [X,Y]", b.loInt === 91 && b.hiInt === 92);
  const lo = parseMarketToBook({ subtitle: "97° or below", yes_bid: 13, no_ask: 90 });
  ok("fallback: 'X or below' → hiInt X", lo.loInt === null && lo.hiInt === 97);
  const hi = parseMarketToBook({ title: "106° or above", yes_bid: 1 });
  ok("fallback: 'X or above' → loInt X", hi.loInt === 106 && hi.hiInt === null);
  ok("fallback: no numbers → null", parseMarketToBook({ subtitle: "Scores" }) === null);
}

// ---- ask 0/absent → null, so the scan derives NO from the YES bid ----
{
  const noOffers = parseMarketToBook({ subtitle: "89° to 90°", floor_strike: 89, cap_strike: 90, no_ask: 0, yes_bid: 4 });
  ok("no offers: no_ask 0 → null (derive from yes_bid)", noOffers.no_ask === null && noOffers.yes_bid === 0.04);
}

// ---- booksFromMarkets: assemble a board, skip junk ----
{
  const board = booksFromMarkets([
    { subtitle: "88° or below", strike_type: "less", cap_strike: 88, no_ask: 99, yes_bid: 1 },
    { subtitle: "89° to 90°", floor_strike: 89, cap_strike: 90, no_ask: 99, yes_bid: 2 },
    { subtitle: "Not a bucket" },
  ]);
  ok("booksFromMarkets: keeps valid buckets", Object.keys(board).length === 2);
  ok("booksFromMarkets: keyed by label", board["88° or below"].hiInt === 88);
}

// ---- day filtering ----
{
  const code = eventDateCode("America/Denver", Date.UTC(2026, 6, 22, 18, 0)); // Jul 22 2026, noon MDT
  ok("eventDateCode: YYMONDD", code === "26JUL22");
  const kept = marketsForDay(
    [{ ticker: "KXHIGHDEN-26JUL22-B89" }, { ticker: "KXHIGHDEN-26JUL23-B89" }, { event_ticker: "KXHIGHDEN-26JUL22" }],
    "26JUL22");
  ok("marketsForDay: keeps today, drops tomorrow", kept.length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
