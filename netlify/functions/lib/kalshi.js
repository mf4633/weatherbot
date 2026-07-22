// kalshi.js — turn Kalshi daily-high-temperature markets into the { label: {loInt,
// hiInt, no_ask, yes_bid} } board shape the floor-scan consumes (2026-07-22).
//
// Pure parsing only — the HTTP fetch lives in the function so this stays unit-testable
// offline (the sandbox can't reach Kalshi). Defensive by design: prefer Kalshi's
// structured strike fields, fall back to parsing the human subtitle, so it survives
// the exact-field-shape guesses until a live run confirms them.
//
// Kalshi market fields used: quote prices (see the schema note below),
// floor_strike/cap_strike (numbers), strike_type ("between"|"less…"|"greater…"),
// subtitle/yes_sub_title/title (e.g. "89° to 90°", "97° or below", "106° or above").
//
// SCHEMA CHANGE (2026-07): Kalshi replaced the integer-cent quote fields
// (yes_bid/yes_ask/no_bid/no_ask, 0-100) with dollar-string fields
// (yes_bid_dollars/…/no_ask_dollars, e.g. "0.0100" = 1¢). Reading the old field now
// yields undefined → every price came back null → the floor-scan gates silently failed
// and candidate generation returned nothing. Fix: read the new *_dollars field first,
// fall back to the old integer-cent field, so the parser survives either schema.

// Resolve a Kalshi quote to a fraction-of-a-dollar in [0,1), preferring the new
// "_dollars" string ("0.0100" → 0.01) and falling back to the old integer cents (1 → 0.01).
const toDollars = (dollarStr, cents) => {
  if (dollarStr != null && dollarStr !== "") {
    const d = parseFloat(dollarStr);
    if (Number.isFinite(d)) return d;
  }
  if (Number.isFinite(cents)) return cents / 100;
  return null;
};
// An ask of 0/absent means "no offers" on Kalshi, so treat it as null and let the caller
// derive NO from the YES bid. A bid of 0 is a real resting state, so keep it.
const askDollars = (dollarStr, cents) => { const d = toDollars(dollarStr, cents); return d != null && d > 0 && d < 1 ? d : null; };
const bidDollars = (dollarStr, cents) => { const d = toDollars(dollarStr, cents); return d != null && d >= 0 && d < 1 ? d : null; };

// One market → a book row, or null if it carries no usable bucket.
export function parseMarketToBook(m) {
  if (!m) return null;
  const st = String(m.strike_type || "").toLowerCase();
  const floor = Number.isFinite(m.floor_strike) ? Math.round(m.floor_strike) : null;
  const cap = Number.isFinite(m.cap_strike) ? Math.round(m.cap_strike) : null;

  let loInt = null, hiInt = null;
  if (floor != null && cap != null) { loInt = floor; hiInt = cap; }          // between
  else if (st.includes("less") || st.includes("below")) { hiInt = cap ?? floor; }   // ≤X
  else if (st.includes("greater") || st.includes("above")) { loInt = floor ?? cap; } // ≥X
  else if (floor != null) { loInt = floor; }
  else if (cap != null) { hiInt = cap; }

  const sub = String(m.subtitle || m.yes_sub_title || m.title || "");
  if (loInt == null && hiInt == null) {                                       // subtitle fallback
    const two = sub.match(/(\d+)\D+(\d+)/);
    const one = sub.match(/(\d+)/);
    const below = /below|or less|less/i.test(sub);
    const above = /above|or more|greater/i.test(sub);
    if (two && !below && !above) { loInt = +two[1]; hiInt = +two[2]; }
    else if (below && one) { hiInt = +one[1]; }
    else if (above && one) { loInt = +one[1]; }
  }
  if (loInt == null && hiInt == null) return null;

  return {
    label: sub || m.ticker || "?", ticker: m.ticker || null,
    loInt, hiInt,
    no_ask: askDollars(m.no_ask_dollars, m.no_ask), yes_bid: bidDollars(m.yes_bid_dollars, m.yes_bid),
    yes_ask: askDollars(m.yes_ask_dollars, m.yes_ask), no_bid: bidDollars(m.no_bid_dollars, m.no_bid),
  };
}

// A list of markets → the board map, keyed by label. Skips markets that don't parse.
export function booksFromMarkets(markets) {
  const out = {};
  for (const m of markets || []) {
    const b = parseMarketToBook(m);
    if (b) out[b.label] = b;
  }
  return out;
}

// Kalshi encodes the settlement day in the ticker as YYMONDD (e.g. "26JUL22"). Build
// today's code in a given tz so a series with several open events can be filtered to
// today's board.
export function eventDateCode(tz, nowMs) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "2-digit", month: "short", day: "2-digit" })
    .formatToParts(new Date(nowMs));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}${g("month").toUpperCase()}${g("day")}`;
}

// Keep only markets whose ticker/event_ticker carries today's date code.
export function marketsForDay(markets, dateCode) {
  return (markets || []).filter((m) =>
    String(m.ticker || "").includes(dateCode) || String(m.event_ticker || "").includes(dateCode));
}
