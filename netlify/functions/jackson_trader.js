// "Andrew Jackson" trader — places REAL Kalshi orders matching the paper-trade rules.
// Runs every 5 min. Dormant if Kalshi env vars not set.
//
// Logic mirror of the paper trader (logger.js):
//   - Read live balance + open positions from Kalshi
//   - Sell positions whose model has flipped negative (would-be losers)
//   - Place new buys for top Kelly-ranked +EV bets, deduped against already-open positions
//   - Bankroll = real Kalshi balance; max 20 concurrent; stake = max($1, balance/20)
//
// Same SAFETY guards as jackson.js: allowlist + denylist on Kalshi endpoints.
// No deposits, withdrawals, or transfers under any circumstance.

import { kalshiAuthedFetch, getBalance, getPositions } from "./jackson.js";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const MAX_CONCURRENT = 20;
const MIN_EDGE = 0.05;
const MIN_HALF_KELLY = 0.02;
const PER_CITY_FRESHNESS_MAX_MIN = 180;

async function fetchInternal(path) {
  const auth = "Basic " + btoa("internal:hydro");
  const r = await fetch(`${SITE_BASE}${path}`, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return await r.json();
}

// Place a buy order via Kalshi. Returns the order response.
// Kalshi prices are integer cents 1-99. Stake comes through `count` (number of contracts).
async function placeBuyOrder(ticker, side, count, priceCents) {
  const body = {
    action: "buy",
    side: side.toLowerCase(),       // "yes" or "no"
    ticker,
    count: Math.max(1, Math.round(count)),
    type: "limit",
    [side.toLowerCase() === "yes" ? "yes_price" : "no_price"]: priceCents,
    expiration_ts: Math.floor(Date.now() / 1000) + 60 * 5,  // 5-minute IOC-ish
    client_order_id: `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
  const r = await kalshiAuthedFetch("POST", "/trade-api/v2/portfolio/orders", body);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

// Place a sell order to close an existing position.
async function placeSellOrder(ticker, side, count, priceCents) {
  const body = {
    action: "sell",
    side: side.toLowerCase(),
    ticker,
    count: Math.max(1, Math.round(count)),
    type: "limit",
    [side.toLowerCase() === "yes" ? "yes_price" : "no_price"]: priceCents,
    expiration_ts: Math.floor(Date.now() / 1000) + 60 * 5,
    client_order_id: `wb-sell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
  const r = await kalshiAuthedFetch("POST", "/trade-api/v2/portfolio/orders", body);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

export default async () => {
  if (!process.env.KALSHI_ACCESS_KEY_ID || !process.env.KALSHI_PRIVATE_KEY) {
    return new Response(JSON.stringify({ ok: true, dormant: true,
      message: "Real-trader dormant: KALSHI_ACCESS_KEY_ID/KALSHI_PRIVATE_KEY not set" }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
  // Hard arm-switch: real trading only fires when KALSHI_TRADING_LIVE === "true".
  // Without this, the trader is paused even if creds are present. Lets us land
  // safety changes without immediately firing real orders.
  if (process.env.KALSHI_TRADING_LIVE !== "true") {
    return new Response(JSON.stringify({ ok: true, paused: true,
      message: "Real-trader paused: set KALSHI_TRADING_LIVE=true env var to arm. Currently observing only." }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }

  const placements = [], sales = [], errors = [];
  try {
    // 1. Read live state from Kalshi.
    const [balance, positionsResp, kalshiData, weatherData] = await Promise.all([
      getBalance(),
      getPositions(),
      fetchInternal("/api/kalshi"),
      fetchInternal("/api/weather")
    ]);

    const cashCents = balance.balance ?? 0;          // Kalshi returns balance in cents
    const cashDollars = cashCents / 100;
    const positions = positionsResp.market_positions || [];
    const openCount = positions.filter(p => p.position !== 0).length;

    // Match paper-trade sizing: stake = max($1, bankroll/20), capped at 20 concurrent.
    const stake_dollars = Math.max(1, cashDollars / 20);
    const stake_contracts_at_avg_price = Math.max(1, Math.round(stake_dollars * 2));  // rough; adjusted per-bet below
    const spareCapacity = Math.max(0, MAX_CONCURRENT - openCount);

    // Map Kalshi positions by (ticker, side) so we can dedup.
    const heldKey = new Set();
    for (const p of positions) {
      if (p.position > 0) heldKey.add(`${p.ticker}-YES`);
      if (p.position < 0) heldKey.add(`${p.ticker}-NO`);  // Kalshi negative position = NO holding
    }

    // 2. Sell would-be losers.
    if (kalshiData?.cities) {
      const cityIndex = Object.fromEntries(kalshiData.cities.map(c => [c.name, c]));
      for (const p of positions) {
        if (p.position === 0) continue;
        const ticker = p.ticker;
        // Find this market in our Kalshi snapshot to get current bid + model probability.
        let bucket = null, citySide = null;
        for (const c of kalshiData.cities) {
          for (const variant of [c.highBuckets, c.lowBuckets]) {
            if (!variant) continue;
            const found = variant.find(b => ticker.endsWith("-" + b.ticker));
            if (found) { bucket = found; citySide = c; break; }
          }
          if (bucket) break;
        }
        if (!bucket) continue;
        const isYes = p.position > 0;
        const sellPrice = isYes ? bucket.kalshi_yes_bid : bucket.kalshi_no_bid;
        if (sellPrice == null || sellPrice <= 0) continue;
        const pNow = isYes ? bucket.p_model : (1 - bucket.p_model);
        const avgEntryCents = Math.abs(p.average_buy_cost ?? 0);  // cents per contract
        const avgEntry = avgEntryCents / 100;
        if (avgEntry <= 0) continue;
        const contracts = Math.abs(p.position);
        const sellProceeds = contracts * sellPrice;     // dollars (1 contract = $1 max payout)
        const stakePaid = contracts * avgEntry;
        const holdEV = contracts * pNow;
        if (sellProceeds >= stakePaid) continue;        // winning, hold
        if (holdEV >= stakePaid) continue;              // model still positive, hold
        // SELL.
        const sellPriceCents = Math.max(1, Math.round(sellPrice * 100));
        const res = await placeSellOrder(ticker, isYes ? "YES" : "NO", contracts, sellPriceCents);
        sales.push({ ticker, side: isYes ? "YES" : "NO", count: contracts, sellPriceCents, ok: res.ok });
        if (!res.ok) errors.push({ where: "sell", ticker, response: res.body });
      }
    }

    // 3. Place new bets.
    if (kalshiData?.topBets && spareCapacity > 0) {
      const fr = kalshiData.freshness || {};
      const cityForecastAge = {};
      for (const c of (weatherData.cities || [])) {
        if (c.forecastUpdateTime) cityForecastAge[c.name] = (Date.now() - new Date(c.forecastUpdateTime).getTime()) / 60000;
      }
      const qualifying = (kalshiData.topBets || []).filter(b => b.ev >= MIN_EDGE && b.halfKelly >= MIN_HALF_KELLY);
      let placed = 0;
      for (const b of qualifying) {
        if (placed >= spareCapacity) break;
        const ageMin = cityForecastAge[b.city];
        if (ageMin != null && ageMin > PER_CITY_FRESHNESS_MAX_MIN) continue;
        // Resolve event ticker → full market ticker like KXHIGHNY-26MAY02-B65.5.
        const cityKalshi = (kalshiData.cities || []).find(c => c.name === b.city);
        if (!cityKalshi) continue;
        const eventTicker = b.variable === "low" ? cityKalshi.lowEvent : cityKalshi.highEvent;
        if (!eventTicker || eventTicker === "not found") continue;
        const fullTicker = `${eventTicker}-${b.ticker}`;
        const dedupKey = `${fullTicker}-${b.side}`;
        if (heldKey.has(dedupKey)) continue;          // already long the same market+side
        // Stake → contracts. count = floor(stake_dollars / price_paid).
        const contracts = Math.max(1, Math.floor(stake_dollars / b.price));
        const priceCents = Math.max(1, Math.min(99, Math.round(b.price * 100)));
        const res = await placeBuyOrder(fullTicker, b.side, contracts, priceCents);
        placements.push({ ticker: fullTicker, side: b.side, count: contracts, priceCents,
                          ev: b.ev, halfKelly: b.halfKelly, ok: res.ok });
        if (!res.ok) errors.push({ where: "buy", ticker: fullTicker, response: res.body });
        else placed++;
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      ranAtUTC: new Date().toISOString(),
      cashDollars, openCount, spareCapacity,
      stake_dollars: Math.round(stake_dollars * 100) / 100,
      sales, placements, errors
    }, null, 2), {
      status: 200, headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false, error: String(e), placements, sales, errors
    }), { status: 500, headers: { "content-type": "application/json" } });
  }
};

// Same 5-min schedule as paper trader. Will short-circuit if env vars missing.
export const config = { schedule: "*/5 * * * *" };
