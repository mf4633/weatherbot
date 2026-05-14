// Jackson rain trader — REAL-money Kalshi orders against rainbot's single-leg edge
// signals. Sister to jackson_trader.js (temperature). Same Kalshi account, same
// safety guards (allowlist + denylist via jackson.js's kalshiAuthedFetch), but
// fully isolated state:
//   - Separate blob namespaces: jackson_rain_open_bets, jackson_rain_settled_bets,
//     jackson_rain_cooldown, jackson_rain_logs.
//   - Separate arm-switch: KALSHI_RAIN_TRADING_LIVE (independent of KALSHI_TRADING_LIVE).
//   - Bot ledger isolation: only sells positions it placed itself.
// Single-leg edges only — arbitrages are ignored for now (no track record yet).
//
// Candidate signal source: rainbot's /api/markets, gated by RAINBOT_BASIC_AUTH env
// var (rainbot's site is password-protected). Same plumbing as combo_trader.js.
//
// Schedule: */30 (offset to :07/:37) to match rainbot's QPF refresh cadence and to
// avoid colliding with the temp trader's */5 cycle on the same Kalshi balance.

import { kalshiAuthedFetch, getBalance, getPositions, getRecentFills, getMarketResult } from "./jackson.js";
import { getStore } from "@netlify/blobs";

const RAINBOT_BASE = process.env.RAINBOT_BASE_URL || "https://rainbot-mf.netlify.app";

const MAX_CONCURRENT = 30;
// Conservative gates while rain has zero real-money track record. Rainbot's
// model has more upstream uncertainty (QPF) than weatherbot's, but its EV
// distribution is also wider — so we let through anything that clears 10¢ net
// edge AND 5% half-Kelly. Tighten after a few weeks of settled outcomes.
const MIN_EDGE = 0.10;
const MIN_HALF_KELLY = 0.05;
// Cheap-tail price floor — same logic and value as jackson_trader.js (4¢).
// Same failure mode applies to rainbot's monthly-tier markets: early-month
// "≥7″" YES at 2¢ is the same lottery shape as a temp T93 YES at 1¢. No rain
// settlements yet to confirm empirically, but the structural argument and the
// temp audit are the strongest signals available.
const MIN_PRICE = 0.04;
// Volume floor — see jackson_trader.js for rationale. Same value (20) since rain
// daily/monthly markets sometimes have thin books, especially monthly tiers far
// from current observed accumulation.
const MIN_VOLUME = 20;
// Don't re-enter a (ticker, side) within this window after selling it. Same as
// temp trader — keeps the bot from oscillating on a noisy market.
const COOLDOWN_MIN = 60;
// Sell hysteresis: sell when forward EV falls below market bid by this fraction.
// Matches temp trader's 0.20 — clears round-trip Kalshi fees comfortably.
const SELL_HYSTERESIS = 0.20;
// Stake = halfKelly × bankroll, floored at $1, capped at 5% of bankroll. Half of
// the temp trader's 10% cap because rain has no validated track record yet.
// At ~$80 bankroll: per-bet stake $1–$4. Raise STAKE_CEIL_FRAC once we see results.
const STAKE_FLOOR = 1.0;
const STAKE_CEIL_FRAC = 0.05;
// Capital-day budget: Σ (stake × remaining_holding_days) ≤ bankroll × K.
// K=30 means roughly "the bankroll can sit fully deployed for one monthly cycle."
// Concretely: at ~$60 bankroll, budget = 1800 capital-dollar-days. A month-start
// $2 monthly bet (30d hold) costs 60 cap-days; a month-end $2 bet (8d hold) only 16.
// The budget self-relaxes as the month progresses — late-month trades fire freely
// even when early-month trades have eaten the static 40% cash-share cap that
// alternative would have imposed. Daily-binary (1d) and temp (1d) trades are
// trivially cheap on this metric.
const CAPITAL_DAYS_PER_BANKROLL = 30;

// Monthly rain tickers carry a 2-segment date (e.g. KXRAINNYCM-26MAY-3); daily
// tickers carry a 3-segment date with day (e.g. KXRAINNYC-26MAY08). Used to
// gate monthly bets out of the rain trader entirely (bankroll-protection mode).
function isMonthlyRainTicker(ticker) {
  const parts = ticker.split("-");
  if (parts.length < 2) return false;
  return /^\d{2}[A-Z]{3}$/.test(parts[1]);
}

// Compute holding days for a rainbot candidate. Mirrors the helper in rain.js so
// the trader doesn't depend on the /api/rain proxy. Returns days from now until
// expected Kalshi settlement (5d after end-of-month for monthly tiers, 1d for
// daily binary).
function holdingDaysFor(bet, now = new Date()) {
  if (bet.kind === "daily-binary") return 1;
  if (bet.kind === "monthly-tier") {
    const m = (bet.eventTicker || "").match(/-(\d{2})([A-Z]{3})$/);
    let target;
    if (m) {
      const yr = 2000 + parseInt(m[1], 10);
      const monIdx = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"].indexOf(m[2]);
      if (monIdx >= 0) target = new Date(Date.UTC(yr, monIdx + 1, 0));
    }
    if (!target) target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    target.setUTCDate(target.getUTCDate() + 5);
    const days = (target - now) / (1000 * 60 * 60 * 24);
    return Math.max(1, Math.ceil(days));
  }
  return 1;
}

// Compute remaining days until settlement for a ledger entry. Prefer the persisted
// `settlementUTC` (exact); fall back to recomputing from kind + eventTicker for
// legacy entries written before this field existed.
function remainingHoldingDays(entry, now = new Date()) {
  if (entry.settlementUTC) {
    const ms = new Date(entry.settlementUTC).getTime() - now.getTime();
    return Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  }
  return holdingDaysFor(entry, now);
}

async function fetchRainbotMarkets() {
  const auth = process.env.RAINBOT_BASIC_AUTH;
  if (!auth) {
    return { error: "RAINBOT_BASIC_AUTH env var not set — rain signals unavailable" };
  }
  const headers = auth.startsWith("Basic ") ? { authorization: auth }
                                             : { authorization: `Basic ${auth}` };
  try {
    const r = await fetch(`${RAINBOT_BASE}/api/markets`, {
      headers, signal: AbortSignal.timeout(28_000)
    });
    if (!r.ok) return { error: `rainbot markets ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: `rainbot fetch failed: ${String(e)}` };
  }
}

// Build fullTicker → { yes_bid, no_bid, p_yes_model } lookup from rainbot's
// cities[].daily.bets and cities[].monthly.bets arrays. Used by the sell loop
// to mark-to-market each bot-placed position.
function buildRainSnapshot(rainData) {
  const lookup = {};
  if (!rainData?.cities) return lookup;
  for (const c of rainData.cities) {
    for (const sec of [c.daily, c.monthly]) {
      if (!sec?.bets) continue;
      for (const b of sec.bets) {
        if (!b.ticker) continue;
        const e = lookup[b.ticker] ??= {};
        e.yes_bid = b.yes_bid; e.no_bid = b.no_bid;
        if (b.side === "YES") e.p_yes_model = b.p_model;
        else if (b.side === "NO" && e.p_yes_model == null) e.p_yes_model = 1 - b.p_model;
      }
    }
  }
  return lookup;
}

async function placeBuyOrder(ticker, side, count, priceCents) {
  const body = {
    action: "buy",
    side: side.toLowerCase(),
    ticker,
    count: Math.max(1, Math.round(count)),
    type: "limit",
    [side.toLowerCase() === "yes" ? "yes_price" : "no_price"]: priceCents,
    expiration_ts: Math.floor(Date.now() / 1000) + 60 * 15,
    client_order_id: `wbr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
  const r = await kalshiAuthedFetch("POST", "/trade-api/v2/portfolio/orders", body);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

async function placeSellOrder(ticker, side, count, priceCents) {
  const body = {
    action: "sell",
    side: side.toLowerCase(),
    ticker,
    count: Math.max(1, Math.round(count)),
    type: "limit",
    [side.toLowerCase() === "yes" ? "yes_price" : "no_price"]: priceCents,
    expiration_ts: Math.floor(Date.now() / 1000) + 60 * 15,
    client_order_id: `wbr-sell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
  const r = await kalshiAuthedFetch("POST", "/trade-api/v2/portfolio/orders", body);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

export default async () => {
  if (!process.env.KALSHI_ACCESS_KEY_ID || !process.env.KALSHI_PRIVATE_KEY) {
    return new Response(JSON.stringify({ ok: true, dormant: true,
      message: "Rain trader dormant: KALSHI_ACCESS_KEY_ID/KALSHI_PRIVATE_KEY not set" }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
  const liveFlag = (process.env.KALSHI_RAIN_TRADING_LIVE || "").trim().toLowerCase();
  const isLive = ["true", "1", "yes", "on", "live"].includes(liveFlag);
  const isDryRun = !isLive && ["dryrun", "dry-run", "shadow"].includes(liveFlag);
  if (!isLive && !isDryRun) {
    return new Response(JSON.stringify({ ok: true, paused: true,
      flagValueSeen: liveFlag ? "(non-empty but not truthy)" : "(empty/unset)",
      message: "Rain trader paused: KALSHI_RAIN_TRADING_LIVE must be 'true' (or 1/yes/on/live). Set to 'dryrun' for instrumentation-only mode." }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }

  const placements = [], sales = [], errors = [], skipped = [];
  const ledgerStore   = getStore("jackson_rain_open_bets");
  const settledStore  = getStore("jackson_rain_settled_bets");
  const cooldownStore = getStore("jackson_rain_cooldown");

  try {
    // 1. Read live state from Kalshi + bot ledger + cooldown map + rain snapshot.
    const [balance, positionsResp, rainResp, { blobs: ledgerBlobs }, cooldownRaw] = await Promise.all([
      getBalance(),
      getPositions(),
      fetchRainbotMarkets(),
      ledgerStore.list().catch(() => ({ blobs: [] })),
      cooldownStore.get("map.json", { type: "json" }).catch(() => ({}))
    ]);
    if (rainResp?.error) {
      // Hard fail this cycle — without rain signals there's nothing to do.
      return new Response(JSON.stringify({ ok: false, error: rainResp.error,
        message: "Rain signals unavailable; cycle aborted (no orders placed)" }), {
        status: 502, headers: { "content-type": "application/json" }
      });
    }

    // Prune expired cooldown entries.
    const cooldownMap = cooldownRaw || {};
    const nowMs = Date.now();
    const cooldownMs = COOLDOWN_MIN * 60 * 1000;
    for (const k of Object.keys(cooldownMap)) {
      if (nowMs - new Date(cooldownMap[k]).getTime() > cooldownMs) delete cooldownMap[k];
    }

    const cashCents = balance.balance ?? 0;
    const cashDollars = cashCents / 100;
    const positions = (positionsResp.market_positions || []).map(p => ({
      ...p,
      qty: parseFloat(p.position_fp || "0"),
      exposure: parseFloat(p.market_exposure_dollars || "0"),
      realizedPnl: parseFloat(p.realized_pnl_dollars || "0")
    }));

    // Bot ledger: rain entries we placed. Sell-loser logic ONLY iterates these.
    // User's pre-existing positions and the temp trader's positions are off-limits.
    const ledger = (await Promise.all(
      ledgerBlobs.map(b => ledgerStore.get(b.key, { type: "json" }).catch(() => null))
    )).filter(Boolean);
    const botKey = (ticker, side) => `${ticker}-${side}`;

    // Reconcile: ledger entries no longer held by Kalshi are settled or fully sold.
    const heldByKalshi = new Set();
    for (const p of positions) {
      if (p.qty > 0) heldByKalshi.add(botKey(p.ticker, "YES"));
      if (p.qty < 0) heldByKalshi.add(botKey(p.ticker, "NO"));
    }
    const liveLedger = [];
    const settlingEntries = [];
    for (const entry of ledger) {
      const key = botKey(entry.ticker, entry.side);
      if (heldByKalshi.has(key)) liveLedger.push(entry);
      else settlingEntries.push(entry);
    }
    if (settlingEntries.length > 0) {
      let fillsByTicker = {};
      try {
        const fillsResp = await getRecentFills(200);
        for (const f of (fillsResp.fills || [])) {
          (fillsByTicker[f.ticker] ??= []).push(f);
        }
      } catch (e) {
        errors.push({ where: "fills-fetch", err: String(e) });
      }
      const results = await Promise.all(settlingEntries.map(e => getMarketResult(e.ticker)));
      for (let i = 0; i < settlingEntries.length; i++) {
        const entry = settlingEntries[i];
        const result = results[i];
        const fills = fillsByTicker[entry.ticker] || [];
        const sideLower = (entry.side || "").toLowerCase();
        const matchingFills = fills.filter(f => f.side === sideLower);
        const totalFees = matchingFills.reduce((s, f) => s + parseFloat(f.fee_cost || "0"), 0);

        let realized = null, outcome = "UNKNOWN";
        if (result === "yes" || result === "no") {
          const won = (sideLower === result);
          realized = (won ? 1.0 : 0.0) * (entry.contracts || 0) - (entry.stake_dollars || 0);
          outcome = won ? "WIN" : "LOSS";
        } else {
          const sellFills = matchingFills.filter(f => f.action === "sell");
          if (sellFills.length > 0) {
            const proceeds = sellFills.reduce((s, f) => {
              const price = parseFloat((f.side === "yes" ? f.yes_price_dollars : f.no_price_dollars) || "0");
              const count = parseFloat(f.count_fp || "0");
              return s + price * count;
            }, 0);
            realized = proceeds - (entry.stake_dollars || 0);
            outcome = "SOLD";
          }
        }

        // Phantom-or-pending guard — see jackson_trader.js for rationale. Same fix:
        // recent UNKNOWNs are restored to liveLedger for next-cycle retry; old
        // UNKNOWNs (>1h) are treated as phantoms and deleted without polluting
        // settledStore.
        const PHANTOM_GRACE_MS = 60 * 60 * 1000;
        if (outcome === "UNKNOWN") {
          const placedAt = entry.placedAtUTC ? new Date(entry.placedAtUTC).getTime() : 0;
          const ageMs = Date.now() - placedAt;
          if (ageMs < PHANTOM_GRACE_MS) {
            liveLedger.push(entry);
            continue;
          }
          await ledgerStore.delete(`${entry.betId}.json`).catch(() => {});
          continue;
        }

        const settledRecord = {
          ...entry,
          settledAtUTC: new Date().toISOString(),
          realized_pnl: realized != null ? Math.round(realized * 100) / 100 : null,
          fees_paid: Math.round(totalFees * 100) / 100,
          outcome,
          marketResult: result
        };
        await settledStore.setJSON(`${entry.betId}.json`, settledRecord)
          .catch(err => errors.push({ where: "settled-write", betId: entry.betId, err: String(err) }));
        await ledgerStore.delete(`${entry.betId}.json`).catch(() => {});
      }
    }
    const botPlacedKeys = new Set(liveLedger.map(e => botKey(e.ticker, e.side)));
    const botOpenCount = liveLedger.length;
    const spareCapacity = Math.max(0, MAX_CONCURRENT - botOpenCount);

    // Capital-day budget: sum (stake × remaining_days) across the live ledger so we
    // know how much "duration-weighted capital" is already deployed. The budget is
    // bankroll × K. New placements add stake × candidate_holding_days; if that pushes
    // total over budget, the placement is skipped with reason "cap-days-budget".
    // Late-month monthly bets cost few cap-days (e.g. 8d × $2 = 16) and fire freely;
    // early-month monthly bets cost many (30d × $2 = 60) and are throttled. This is
    // the duration-weighted analog of the cash-share cap we rejected.
    const nowDate = new Date();
    const capDaysBudget = cashDollars * CAPITAL_DAYS_PER_BANKROLL;
    let capDaysCommitted = liveLedger.reduce((sum, entry) => {
      const remDays = remainingHoldingDays(entry, nowDate);
      return sum + (entry.stake_dollars || 0) * remDays;
    }, 0);

    // Buy dedup: union of blob ledger AND Kalshi-side held positions. Same
    // double-buy guard as temp trader. SELL safety: only botPlacedKeys is read
    // by the sell loop, so user/temp-trader positions remain off-limits.
    const heldKey = new Set(botPlacedKeys);
    for (const p of positions) {
      if (p.qty > 0) heldKey.add(botKey(p.ticker, "YES"));
      if (p.qty < 0) heldKey.add(botKey(p.ticker, "NO"));
    }

    // 2. Sell positions where forward EV diverges from current bid by more than
    // SELL_HYSTERESIS. ONLY among bot-placed rain positions.
    // Monthly positions are force-sold regardless of EV: same-day rain only.
    const snapshot = buildRainSnapshot(rainResp);
    for (const p of positions) {
      if (p.qty === 0) continue;
      const ticker = p.ticker;
      const side = p.qty > 0 ? "YES" : "NO";
      if (!botPlacedKeys.has(botKey(ticker, side))) continue;  // SAFETY: skip non-rain / user-placed
      const m = snapshot[ticker];
      const isYes = side === "YES";
      const contracts = Math.abs(p.qty);
      if (contracts <= 0) continue;
      const isMonthly = isMonthlyRainTicker(ticker);
      // Force-sell monthly: dump at the bid regardless of EV.
      if (isMonthly) {
        const sellPrice = m ? (isYes ? m.yes_bid : m.no_bid) : null;
        if (sellPrice == null || sellPrice <= 0) continue;
        const sellPriceCents = Math.max(1, Math.round(sellPrice * 100));
        const res = isDryRun ? { ok: true, body: { dryRun: true } }
                             : await placeSellOrder(ticker, side, contracts, sellPriceCents);
        sales.push({ ticker, side, count: contracts, sellPriceCents,
                     dryRun: isDryRun, ok: res.ok, reason: "force-sell-monthly" });
        if (!res.ok) errors.push({ where: "sell-monthly", ticker, response: res.body });
        else if (!isDryRun) cooldownMap[botKey(ticker, side)] = new Date().toISOString();
        continue;
      }
      if (!m) continue;
      const sellPrice = isYes ? m.yes_bid : m.no_bid;
      if (sellPrice == null || sellPrice <= 0) continue;
      if (m.p_yes_model == null) continue;
      const pNow = isYes ? m.p_yes_model : (1 - m.p_yes_model);
      const sellProceeds = contracts * sellPrice;
      const holdEV = contracts * pNow;
      if (holdEV >= sellProceeds * (1 - SELL_HYSTERESIS)) continue;
      const sellPriceCents = Math.max(1, Math.round(sellPrice * 100));
      const res = isDryRun ? { ok: true, body: { dryRun: true } }
                           : await placeSellOrder(ticker, side, contracts, sellPriceCents);
      sales.push({ ticker, side, count: contracts, sellPriceCents, dryRun: isDryRun, ok: res.ok });
      if (!res.ok) errors.push({ where: "sell", ticker, response: res.body });
      else if (!isDryRun) cooldownMap[botKey(ticker, side)] = new Date().toISOString();
    }

    // 3. Place new bets from rainbot topBets, ranked by halfKelly desc.
    // Bankroll-protection: same-day rain only. Monthly tiers have 5–30 day holds
    // that lock capital while the bot is operating below sustainable equity.
    if (rainResp?.topBets && spareCapacity > 0) {
      const qualifying = rainResp.topBets
        .filter(b => Number.isFinite(b.ev_net) && Number.isFinite(b.halfKelly))
        .filter(b => b.kind === "daily-binary")
        .filter(b => b.ev_net >= MIN_EDGE && b.halfKelly >= MIN_HALF_KELLY
                  && b.price >= MIN_PRICE
                  && (b.volume == null || b.volume >= MIN_VOLUME))
        .sort((a, b) => b.halfKelly - a.halfKelly);

      const briefBet = b => ({ city: b.city, kind: b.kind, bucket: b.bucket,
                               ticker: b.ticker, side: b.side,
                               ev: Math.round(b.ev_net * 1000) / 1000,
                               halfKelly: Math.round(b.halfKelly * 1000) / 1000,
                               pWin: b.p_model != null ? Math.round(b.p_model * 1000) / 1000 : null,
                               price: b.price });

      let placed = 0;
      let committed = 0;
      for (const b of qualifying) {
        if (placed >= spareCapacity) { skipped.push({ ...briefBet(b), reason: "no-spare-capacity" }); continue; }
        if (cashDollars - committed < STAKE_FLOOR) { skipped.push({ ...briefBet(b), reason: "out-of-cash" }); continue; }
        const fullTicker = b.ticker;       // rainbot already returns full Kalshi ticker
        const dedupKey = botKey(fullTicker, b.side);
        if (heldKey.has(dedupKey)) { skipped.push({ ...briefBet(b), reason: "already-held" }); continue; }
        if (cooldownMap[dedupKey]) { skipped.push({ ...briefBet(b), reason: "in-cooldown" }); continue; }
        // City+kind cooldown: blocks any further buys on the same (city, kind) pair within
        // COOLDOWN_MIN of the last successful buy. Independent of ticker/side, so it catches
        // model-thrash patterns that would otherwise slip past dedup (different strike, same
        // city/kind). Mirrors jackson_trader's BUY_CITYVAR_COOLDOWN_MIN guard. Added 2026-05-08
        // after porting the same defense to combo_trader; rain uses (city, kind) rather than
        // (city, variable) since "kind" (daily-binary vs monthly-tier) is the analogous split.
        const cvLockKey = `cv:${b.city}:${b.kind}`;
        if (cooldownMap[cvLockKey]) {
          skipped.push({ ...briefBet(b), reason: "city-kind-cooldown",
                         lockedSince: cooldownMap[cvLockKey], lockKey: cvLockKey });
          continue;
        }

        const remaining = cashDollars - committed;
        const stake_dollars = Math.max(STAKE_FLOOR,
          Math.min(cashDollars * STAKE_CEIL_FRAC, b.halfKelly * cashDollars, remaining));
        if (stake_dollars < STAKE_FLOOR) break;

        // Capital-day budget check. Skip placement if it'd push total
        // duration-weighted commitment over budget. Cheap (1d) bets always fire;
        // expensive (30d) bets get rationed when budget is tight.
        const candHoldingDays = holdingDaysFor(b, nowDate);
        const candCapDays = stake_dollars * candHoldingDays;
        if (capDaysCommitted + candCapDays > capDaysBudget) {
          skipped.push({ ...briefBet(b),
            reason: "cap-days-budget",
            holdingDays: candHoldingDays,
            wouldAdd: Math.round(candCapDays),
            committed: Math.round(capDaysCommitted),
            budget: Math.round(capDaysBudget) });
          continue;
        }

        const contracts = Math.max(1, Math.floor(stake_dollars / b.price));
        const priceCents = Math.max(1, Math.min(99, Math.round(b.price * 100)));

        const res = isDryRun ? { ok: true, body: { order: { client_order_id: `dryrun-${Date.now()}` }, dryRun: true } }
                             : await placeBuyOrder(fullTicker, b.side, contracts, priceCents);
        const pWin = b.p_model;
        const expectedPayout = contracts * (Number.isFinite(pWin) ? pWin : 0);
        placements.push({ ticker: fullTicker, side: b.side, count: contracts, priceCents,
                          stake_dollars: Math.round(stake_dollars * 100) / 100,
                          ev: b.ev_net, halfKelly: b.halfKelly,
                          pWin: pWin != null ? Math.round(pWin * 1000) / 1000 : null,
                          expectedPayout: Math.round(expectedPayout * 100) / 100,
                          dryRun: isDryRun, ok: res.ok });
        if (!res.ok) {
          errors.push({ where: "buy", ticker: fullTicker, response: res.body });
          skipped.push({ ...briefBet(b), reason: "kalshi-rejected", detail: res.body?.error?.code || res.body?.error?.message || "unknown" });
        } else {
          placed++;
          committed += stake_dollars;
          capDaysCommitted += candCapDays;
          heldKey.add(dedupKey);
          // Stamp city+kind cooldown so subsequent runs (or later iterations within the
          // budget loop) don't compound model-thrash on the same (city, kind) within 60 min.
          if (!isDryRun) cooldownMap[`cv:${b.city}:${b.kind}`] = new Date().toISOString();
          if (isDryRun) continue;
          const betId = res.body?.order?.client_order_id || `${fullTicker}-${b.side}-${Date.now()}`;
          // Persist eventTicker + holdingDaysAtPlace + settlementUTC so the
          // remainingHoldingDays() computation in future cycles is exact (no need
          // to re-parse the ticker every cycle).
          const placedAtUTC = new Date().toISOString();
          const settlementUTC = new Date(nowDate.getTime() + candHoldingDays * 86400000).toISOString();
          await ledgerStore.setJSON(`${betId}.json`, {
            betId, ticker: fullTicker, side: b.side, contracts,
            price: b.price, stake_dollars,
            city: b.city, kind: b.kind, bucket: b.bucket, threshold: b.threshold,
            eventTicker: b.eventTicker || null,
            ev: b.ev_net, halfKelly: b.halfKelly,
            holdingDaysAtPlace: candHoldingDays,
            settlementUTC,
            p_model_at_entry: b.p_model,
            placedAtUTC,
            kalshiOrderId: res.body?.order?.order_id || null
          }).catch(err => errors.push({ where: "ledger-write", err: String(err) }));
        }
      }
    }

    await cooldownStore.setJSON("map.json", cooldownMap)
      .catch(err => errors.push({ where: "cooldown-write", err: String(err) }));

    const ranAtUTC = new Date().toISOString();
    const stakeCeil = Math.round(cashDollars * STAKE_CEIL_FRAC * 100) / 100;
    const responseBody = {
      ok: true,
      mode: isLive ? "LIVE" : "DRYRUN",
      ranAtUTC,
      cashDollars,
      botOpenCount,
      spareCapacity,
      stake_floor: STAKE_FLOOR,
      stake_ceil_dollars: stakeCeil,
      capitalDays: {
        committed: Math.round(capDaysCommitted),
        budget: Math.round(capDaysBudget),
        utilization: capDaysBudget > 0 ? Math.round(capDaysCommitted / capDaysBudget * 100) : null
      },
      candCount: rainResp?.topBets?.length || 0,
      sales, placements, skipped, errors
    };

    try {
      const logStore = getStore("jackson_rain_logs");
      await logStore.setJSON(`${ranAtUTC}.json`, {
        ranAtUTC, mode: responseBody.mode, cashDollars, spareCapacity, stake_ceil: stakeCeil,
        placements: placements.map(p => ({
          ticker: p.ticker, side: p.side, count: p.count, priceCents: p.priceCents,
          stake_dollars: p.stake_dollars, ev: p.ev, halfKelly: p.halfKelly,
          pWin: p.pWin, expectedPayout: p.expectedPayout, ok: p.ok
        })),
        sales: sales.map(s => ({ ticker: s.ticker, side: s.side, count: s.count,
                                  priceCents: s.priceCents, ok: s.ok })),
        skipped: skipped.slice(0, 30),
        errors: errors.slice(0, 10)
      });
    } catch (logErr) { /* don't fail the cycle on log write */ }

    return new Response(JSON.stringify(responseBody, null, 2), {
      status: 200, headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false, error: String(e), placements, sales, skipped, errors
    }), { status: 500, headers: { "content-type": "application/json" } });
  }
};

// Every 30 min at :07 / :37 — offset from temp trader's */5 cadence so the two
// cycles don't read the same Kalshi balance at the same moment. Matches rainbot's
// upstream QPF refresh rate.
export const config = { schedule: "7,37 * * * *" };
