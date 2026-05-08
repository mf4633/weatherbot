// "Andrew Jackson" REACT trader — fast sell-only loop, runs every minute.
//
// Phase 1 of the speed-improvement plan (see project_jackson_react memory). The 5-min
// jackson_trader does buys + sells on a slow cycle; between cycles, a snap-loser can
// trade for several minutes before our next sell pass fires. This function mirrors
// jackson_trader's sell-loser logic exactly but on a 1-min cron, so we hit the bid
// before the market collapses to 1¢.
//
// SCOPE: SELL ONLY. No buy logic. No tile-conflict, no bucket gates, no candidate
// scanning. The 5-min jackson_trader still owns:
//   - All buying decisions
//   - Settlement reconcile (positions Kalshi has resolved → ledger cleanup)
//   - Cooldown grooming (eviction of expired entries)
//
// SAFETY: only sells positions in the bot's own ledger (botPlacedKeys). User-placed
// positions are never touched, same invariant as jackson_trader.
//
// CONFLICT TOLERANCE: if both this and jackson_trader run within seconds of each other
// (impossible on standard 1m + 5m crons unless one runs long), Kalshi rejects the
// duplicate sell with a clear error and we log it. Safe by API contract, no double-sell.

import { kalshiAuthedFetch, getPositions } from "./jackson.js";
import { getStore } from "@netlify/blobs";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
// Mirror jackson_trader's hysteresis exactly. Fast cycle, same threshold — we want to
// fire on the same kind of EV-divergence signal, just sooner.
const SELL_HYSTERESIS = 0.20;
// Per-ticker cooldown after a sell, mirrored from jackson_trader. Prevents both this
// fast loop and the 5-min trader from re-entering on the same tick.
const COOLDOWN_MIN = 60;
const BUY_CITYVAR_COOLDOWN_MIN = 60;

const botKey      = (ticker, side) => `${ticker}-${side}`;
const cityVarKey  = (city, variable) => `cv:${city}:${variable || "high"}`;

async function fetchInternal(path) {
  const auth = "Basic " + btoa("internal:hydro");
  const r = await fetch(`${SITE_BASE}${path}`, { headers: { authorization: auth },
                                                  signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return await r.json();
}

async function placeSellOrder(ticker, side, count, priceCents) {
  const body = {
    action: "sell",
    side: side.toLowerCase(),
    ticker,
    count: Math.max(1, Math.round(count)),
    type: "limit",
    [side.toLowerCase() === "yes" ? "yes_price" : "no_price"]: priceCents,
    // Short expiration (3 min) on the React sell. Different from jackson_trader's 15-min
    // because this fires every minute — if the order doesn't fill within 3 min, the next
    // React cycle will re-evaluate and resubmit at a fresher price.
    expiration_ts: Math.floor(Date.now() / 1000) + 60 * 3,
    client_order_id: `wb-react-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
  const r = await kalshiAuthedFetch("POST", "/trade-api/v2/portfolio/orders", body);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

export default async () => {
  // Same arm-switch model as jackson_trader: dormant if creds missing, paused unless
  // KALSHI_TRADING_LIVE === "true". A 1-min sell loop would be especially nasty if
  // accidentally armed, so this is non-optional.
  if (!process.env.KALSHI_ACCESS_KEY_ID || !process.env.KALSHI_PRIVATE_KEY) {
    return new Response(JSON.stringify({ ok: true, dormant: true,
      message: "React-trader dormant: KALSHI_ACCESS_KEY_ID/KALSHI_PRIVATE_KEY not set" }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
  const liveFlag = (process.env.KALSHI_TRADING_LIVE || "").trim().toLowerCase();
  const isLive   = ["true", "1", "yes", "on", "live"].includes(liveFlag);
  const isDryRun = !isLive && ["dryrun", "dry-run", "shadow"].includes(liveFlag);
  if (!isLive && !isDryRun) {
    return new Response(JSON.stringify({ ok: true, paused: true,
      flagValueSeen: liveFlag ? "(non-empty but not truthy)" : "(empty/unset)",
      message: "React-trader paused: KALSHI_TRADING_LIVE must be 'true' (or 1/yes/on/live)." }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }

  const sales = [], errors = [];
  const ledgerStore   = getStore("jackson_open_bets");
  const cooldownStore = getStore("jackson_cooldown");

  try {
    // Pull state in parallel: positions (authoritative qty/exposure), kalshi snapshot
    // (current bids + p_model), bot ledger (only-sell-ours invariant), cooldown map.
    const [positionsResp, kalshiData, { blobs: ledgerBlobs }, cooldownRaw] = await Promise.all([
      getPositions(),
      fetchInternal("/api/kalshi"),
      ledgerStore.list().catch(() => ({ blobs: [] })),
      cooldownStore.get("map.json", { type: "json" }).catch(() => null)
    ]);
    const positions = (positionsResp?.market_positions || []).map(p => ({
      ticker: p.ticker,
      qty: parseFloat(p.position_fp || p.position || 0),
      exposure: parseFloat(p.market_exposure_dollars || p.market_exposure || 0)
    }));
    const cooldownMap = cooldownRaw || {};

    // Hydrate ledger so we know which positions are bot-placed (only those are sellable).
    const ledger = (await Promise.all(
      ledgerBlobs.map(b => ledgerStore.get(b.key, { type: "json" }).catch(() => null))
    )).filter(Boolean);
    const botPlacedKeys = new Set(ledger.map(e => botKey(e.ticker, e.side)));

    // Same sell logic as jackson_trader.js, lifted verbatim. See comments there for
    // the design rationale (forward-EV-only criterion, sunk-cost rejection).
    if (kalshiData?.cities) {
      for (const p of positions) {
        if (p.qty === 0) continue;
        const ticker = p.ticker;
        const side = p.qty > 0 ? "YES" : "NO";
        if (!botPlacedKeys.has(botKey(ticker, side))) continue;  // SAFETY: skip user-placed

        // Locate this market in our snapshot.
        let bucket = null, citySide = null, soldVariable = null;
        for (const c of kalshiData.cities) {
          for (const [varName, variant] of [["high", c.highBuckets], ["low", c.lowBuckets]]) {
            if (!variant) continue;
            const found = variant.find(b => ticker.endsWith("-" + b.ticker));
            if (found) { bucket = found; citySide = c; soldVariable = varName; break; }
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
        const sellProceeds = contracts * sellPrice;
        const holdEV = contracts * pNow;
        if (holdEV >= sellProceeds * (1 - SELL_HYSTERESIS)) continue;

        // SELL.
        const sellPriceCents = Math.max(1, Math.round(sellPrice * 100));
        const res = isDryRun ? { ok: true, body: { dryRun: true } }
                             : await placeSellOrder(ticker, isYes ? "YES" : "NO", contracts, sellPriceCents);
        sales.push({
          ticker, side: isYes ? "YES" : "NO", count: contracts, sellPriceCents,
          holdEV: Math.round(holdEV * 100) / 100,
          sellProceeds: Math.round(sellProceeds * 100) / 100,
          dryRun: isDryRun, ok: res.ok
        });
        if (!res.ok) {
          errors.push({ where: "sell", ticker, response: res.body });
        } else if (!isDryRun) {
          // Stamp the same cooldowns the 5-min trader does, so neither fast nor slow loop
          // re-enters this position before COOLDOWN_MIN.
          cooldownMap[botKey(ticker, isYes ? "YES" : "NO")] = new Date().toISOString();
          if (citySide?.name && soldVariable) {
            cooldownMap[cityVarKey(citySide.name, soldVariable)] = new Date().toISOString();
          }
        }
      }
    }

    if (sales.length > 0) {
      await cooldownStore.setJSON("map.json", cooldownMap)
        .catch(err => errors.push({ where: "cooldown-write", err: String(err) }));
    }
  } catch (e) {
    errors.push({ where: "react-cycle", err: String(e) });
  }

  return new Response(JSON.stringify({
    ok: true,
    ranAtUTC: new Date().toISOString(),
    saleCount: sales.length,
    sales,
    errors
  }, null, 2), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};

// 1-minute cron — the whole point of this function.
export const config = { schedule: "*/1 * * * *" };
