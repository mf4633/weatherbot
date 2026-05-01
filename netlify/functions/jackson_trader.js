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
import { getStore } from "@netlify/blobs";

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
  const liveFlag = (process.env.KALSHI_TRADING_LIVE || "").trim().toLowerCase();
  if (!["true", "1", "yes", "on", "live"].includes(liveFlag)) {
    return new Response(JSON.stringify({ ok: true, paused: true,
      flagValueSeen: liveFlag ? "(non-empty but not truthy)" : "(empty/unset)",
      message: "Real-trader paused: KALSHI_TRADING_LIVE must be 'true' (or 1/yes/on/live)." }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }

  const placements = [], sales = [], errors = [];
  const ledgerStore = getStore("jackson_open_bets");
  try {
    // 1. Read live state from Kalshi + bot ledger.
    const [balance, positionsResp, kalshiData, weatherData, { blobs: ledgerBlobs }] = await Promise.all([
      getBalance(),
      getPositions(),
      fetchInternal("/api/kalshi"),
      fetchInternal("/api/weather"),
      ledgerStore.list().catch(() => ({ blobs: [] }))
    ]);

    const cashCents = balance.balance ?? 0;          // Kalshi returns balance in cents
    const cashDollars = cashCents / 100;
    // Normalize Kalshi position fields. Real fields: position_fp (string of float;
    // sign = direction), market_exposure_dollars (string), realized_pnl_dollars (string).
    const positions = (positionsResp.market_positions || []).map(p => ({
      ...p,
      qty: parseFloat(p.position_fp || "0"),
      exposure: parseFloat(p.market_exposure_dollars || "0"),
      realizedPnl: parseFloat(p.realized_pnl_dollars || "0")
    }));
    const allOpenCount = positions.filter(p => p.qty !== 0).length;

    // Bot ledger: entries we placed. Sell-loser logic ONLY iterates these.
    // User's pre-existing positions are off-limits.
    const ledger = (await Promise.all(
      ledgerBlobs.map(b => ledgerStore.get(b.key, { type: "json" }).catch(() => null))
    )).filter(Boolean);
    const botKey = (ticker, side) => `${ticker}-${side}`;

    // Reconcile: remove ledger entries for positions Kalshi no longer has (settled/sold).
    const heldByKalshi = new Set();
    for (const p of positions) {
      if (p.qty > 0) heldByKalshi.add(botKey(p.ticker, "YES"));
      if (p.qty < 0) heldByKalshi.add(botKey(p.ticker, "NO"));
    }
    const liveLedger = [];
    for (const entry of ledger) {
      const key = botKey(entry.ticker, entry.side);
      if (heldByKalshi.has(key)) liveLedger.push(entry);
      else await ledgerStore.delete(`${entry.betId}.json`).catch(() => {});
    }
    const botPlacedKeys = new Set(liveLedger.map(e => botKey(e.ticker, e.side)));
    const botOpenCount = liveLedger.length;

    // Sizing: stake = max($1, bankroll/20). Bot's max concurrent = 20.
    const stake_dollars = Math.max(1, cashDollars / 20);
    const spareCapacity = Math.max(0, MAX_CONCURRENT - botOpenCount);

    // Buy dedup: against ALL Kalshi positions (don't double-down on user's manual ones either).
    const heldKey = heldByKalshi;

    // 2. Sell would-be losers — ONLY among bot-placed positions.
    if (kalshiData?.cities) {
      const cityIndex = Object.fromEntries(kalshiData.cities.map(c => [c.name, c]));
      for (const p of positions) {
        if (p.qty === 0) continue;
        const ticker = p.ticker;
        const side = p.qty > 0 ? "YES" : "NO";
        if (!botPlacedKeys.has(botKey(ticker, side))) continue;  // SAFETY: skip user-placed
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
        const isYes = p.qty > 0;
        const sellPrice = isYes ? bucket.kalshi_yes_bid : bucket.kalshi_no_bid;
        if (sellPrice == null || sellPrice <= 0) continue;
        const pNow = isYes ? bucket.p_model : (1 - bucket.p_model);
        const contracts = Math.abs(p.qty);
        if (contracts <= 0) continue;
        // Avg entry = total exposure (dollars at risk) / contracts.
        const avgEntry = p.exposure / contracts;
        if (avgEntry <= 0) continue;
        const sellProceeds = contracts * sellPrice;     // dollars (1 contract = $1 max payout)
        const stakePaid = p.exposure;
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
        if (!res.ok) {
          errors.push({ where: "buy", ticker: fullTicker, response: res.body });
        } else {
          placed++;
          // Save to bot ledger so future runs know we own this position.
          const betId = res.body?.order?.client_order_id || `${fullTicker}-${b.side}-${Date.now()}`;
          await ledgerStore.setJSON(`${betId}.json`, {
            betId, ticker: fullTicker, side: b.side, contracts,
            price: b.price, stake_dollars,
            city: b.city, variable: b.variable || "high",
            bucket: b.bucket, ev: b.ev, halfKelly: b.halfKelly,
            modelMean: b.modelMean, modelStd: b.modelStd,
            placedAtUTC: new Date().toISOString(),
            kalshiOrderId: res.body?.order?.order_id || null
          }).catch(err => errors.push({ where: "ledger-write", err: String(err) }));
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      ranAtUTC: new Date().toISOString(),
      cashDollars,
      botOpenCount, allOpenCount,
      spareCapacity,
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
