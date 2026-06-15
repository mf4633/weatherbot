// /api/jackson_audit — raw settled-bet dump for ad-hoc analysis. Returns every entry
// in jackson_settled_bets + jackson_rain_settled_bets so the dashboard / scripts can
// compute hit-rate-by-price-band, edge-vs-outcome scatter, etc.
//
// /api/jackson_audit?fix=unknowns — destructively cleans up UNKNOWN entries:
//   - For each UNKNOWN settled bet, queries Kalshi /markets/{ticker}
//   - If market now finalized (result=yes|no): recompute outcome + realized_pnl
//     and update the settledStore record
//   - If market still active: it was a premature reconcile (phantom or
//     positions-endpoint lag); delete the record entirely so it doesn't
//     pollute the audit
// Returns a summary of changes.

import { getStore } from "@netlify/blobs";

const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

async function loadAll(storeName) {
  const store = getStore(storeName);
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  const entries = await Promise.all(
    blobs.map(async b => {
      const v = await store.get(b.key, { type: "json" }).catch(() => null);
      return v ? { _key: b.key, _entry: v } : null;
    })
  );
  return entries.filter(Boolean);
}

// Public Kalshi market lookup — no auth needed for read. Returns the raw market
// object so callers can read both `result` and `status`.
async function getMarketPublic(ticker) {
  try {
    const r = await fetch(`${KALSHI_API}/markets/${ticker}`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000)
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.market || null;
  } catch (e) { return null; }
}

async function fixUnknownsInStore(storeName) {
  const store = getStore(storeName);
  const wrapped = await loadAll(storeName);
  const unknowns = wrapped.filter(w => w._entry?.outcome === "UNKNOWN");
  const result = { storeName, totalUnknowns: unknowns.length, resolved: [], deleted: [], stillUnknown: [] };
  // Query Kalshi for each ticker in parallel.
  const markets = await Promise.all(unknowns.map(w => getMarketPublic(w._entry.ticker)));
  for (let i = 0; i < unknowns.length; i++) {
    const w = unknowns[i];
    const entry = w._entry;
    const market = markets[i];
    const res = market?.result;
    if (res === "yes" || res === "no") {
      const sideLower = (entry.side || "").toLowerCase();
      const won = (sideLower === res);
      const realized = (won ? 1.0 : 0.0) * (entry.contracts || 0) - (entry.stake_dollars || 0);
      const updated = {
        ...entry,
        outcome: won ? "WIN" : "LOSS",
        realized_pnl: Math.round(realized * 100) / 100,
        marketResult: res,
        reconciledLateAtUTC: new Date().toISOString()
      };
      await store.setJSON(w._key, updated).catch(() => {});
      result.resolved.push({ key: w._key, ticker: entry.ticker, side: entry.side,
                              outcome: updated.outcome, pnl: updated.realized_pnl });
    } else if (market && market.status === "active") {
      // Market still trading → this was a premature reconcile. Delete to clean up.
      await store.delete(w._key).catch(() => {});
      result.deleted.push({ key: w._key, ticker: entry.ticker, side: entry.side,
                             reason: "market-still-active (premature reconcile)" });
    } else {
      // Couldn't fetch market or unexpected status. Leave alone.
      result.stillUnknown.push({ key: w._key, ticker: entry.ticker,
                                  reason: market ? `status=${market.status}` : "fetch-failed" });
    }
  }
  return result;
}

export default async (req) => {
  const url = new URL(req.url);
  const fix = url.searchParams.get("fix");

  if (fix === "unknowns") {
    const [tempFix, rainFix] = await Promise.all([
      fixUnknownsInStore("jackson_settled_bets"),
      fixUnknownsInStore("jackson_rain_settled_bets")
    ]);
    return new Response(JSON.stringify({
      mode: "fix-unknowns",
      ranAtUTC: new Date().toISOString(),
      temp: tempFix,
      rain: rainFix
    }, null, 2), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }

  // Default: read-only dump.
  const [temp, rain] = await Promise.all([
    loadAll("jackson_settled_bets"),
    loadAll("jackson_rain_settled_bets")
  ]);
  const tempEntries = temp.map(w => w._entry);
  const rainEntries = rain.map(w => w._entry);
  const out = {
    counts: { temp: tempEntries.length, rain: rainEntries.length,
              total: tempEntries.length + rainEntries.length },
    temp: tempEntries, rain: rainEntries
  };
  // Include current live sigma/posterior from calibration_state for easy checking
  // against the ~2.5 assumption in backtests (e.g. the +9.3% edge-sweep result).
  // This closes the gap for ongoing "is live sigma holding the validated cell?" checks.
  try {
    const calStore = getStore("calibration_state");
    const cal = await calStore.get("current.json", { type: "json" }).catch(() => null);
    if (cal) {
      out.calibration = {
        sigma_high: cal.sigma_high,
        sigma_low: cal.sigma_low,
        sigma_high_posterior: cal.sigma_high_posterior,
        sigma_low_posterior: cal.sigma_low_posterior,
        high_n: cal.high_n,
        low_n: cal.low_n,
        updated_at: cal.updated_at || cal.last_update
      };
    }
  } catch (e) {
    out.calibration_error = e.message;
  }
  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
