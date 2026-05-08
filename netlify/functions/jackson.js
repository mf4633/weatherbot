// "Andrew Jackson" — REAL-money Kalshi trading endpoint, account royal.greyhound5665.
// Reads live balance + positions + fills from Kalshi. Surfaces them for the dashboard.
//
// Authentication: RSA-PSS-SHA256 signed requests using credentials in env:
//   KALSHI_ACCESS_KEY_ID         — UUID of API key created in Kalshi web UI
//   KALSHI_PRIVATE_KEY    — RSA private key (PEM), shown once at API key creation
//
// SAFETY GUARDRAIL:
//   The Kalshi API client has a hard ENDPOINT ALLOWLIST. Any attempt to call a
//   deposit/withdrawal/transfer endpoint throws an error. Trading endpoints only.
//   This is enforced regardless of caller intent.

import { createSign, constants } from "node:crypto";
import { getStore } from "@netlify/blobs";

const KALSHI_API_BASE = "https://api.elections.kalshi.com";
const ACCOUNT_NAME = "royal.greyhound5665";

// Endpoints we WILL use. Anything not matching this list throws.
const ENDPOINT_ALLOWLIST = [
  /^\/trade-api\/v2\/portfolio\/balance$/,
  /^\/trade-api\/v2\/portfolio\/positions(\?.*)?$/,
  /^\/trade-api\/v2\/portfolio\/orders(\?.*)?$/,
  /^\/trade-api\/v2\/portfolio\/orders\/[\w-]+$/,
  /^\/trade-api\/v2\/portfolio\/fills(\?.*)?$/,
  /^\/trade-api\/v2\/markets(\?.*)?$/,
  /^\/trade-api\/v2\/markets\/[\w.\-]+$/,
  /^\/trade-api\/v2\/events(\?.*)?$/
];

// Endpoints we EXPLICITLY refuse (never call). Defense in depth — even if the
// allowlist regex were buggy, this denies anything that looks like a money-mover.
const ENDPOINT_DENYLIST = [
  /deposit/i, /withdraw/i, /transfer/i, /bank/i, /ach/i, /wire/i, /payout/i, /payment/i
];

// Normalize the PEM in case Netlify's env var UI stripped/escaped newlines.
// Accepts: actual multi-line PEM, single-line PEM with "\n" sequences, or single-line
// no-newlines (just header/footer + base64). Returns a properly-formatted PEM string.
function normalizePEM(raw) {
  let s = (raw || "").trim();
  // Replace literal "\n" sequences with real newlines.
  if (!s.includes("\n") && s.includes("\\n")) s = s.replace(/\\n/g, "\n");
  // If it's all on one line, reinsert newlines around the BEGIN/END markers and
  // every 64 chars of the body.
  if (!s.includes("\n")) {
    const m = s.match(/^(-----BEGIN [^-]+-----)(.*?)(-----END [^-]+-----)$/);
    if (m) {
      const body = m[2].replace(/\s+/g, "");
      const wrapped = body.match(/.{1,64}/g)?.join("\n") || "";
      s = `${m[1]}\n${wrapped}\n${m[3]}`;
    }
  }
  return s;
}

export function kalshiSign(privateKeyPEM, method, path, timestamp) {
  const message = `${timestamp}${method}${path}`;
  const signer = createSign("sha256");
  signer.update(message);
  signer.end();
  return signer.sign({
    key: normalizePEM(privateKeyPEM),
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32
  }).toString("base64");
}

export async function kalshiAuthedFetch(method, path, body = null) {
  const keyId = process.env.KALSHI_ACCESS_KEY_ID;
  const privKey = process.env.KALSHI_PRIVATE_KEY;
  if (!keyId || !privKey) {
    const err = new Error("Kalshi credentials not configured (env KALSHI_ACCESS_KEY_ID, KALSHI_PRIVATE_KEY)");
    err.code = "NOT_CONFIGURED";
    throw err;
  }
  // Allowlist + denylist guard.
  if (!ENDPOINT_ALLOWLIST.some(re => re.test(path))) {
    throw new Error(`SAFETY: endpoint not on allowlist: ${path}`);
  }
  if (ENDPOINT_DENYLIST.some(re => re.test(path))) {
    throw new Error(`SAFETY: endpoint matches denylist (transfer-like): ${path}`);
  }
  const ts = Date.now().toString();
  // Kalshi signs the path WITHOUT query string (only the path-part of the URL).
  const pathForSig = path.split("?")[0];
  const sig = kalshiSign(privKey, method, pathForSig, ts);
  const r = await fetch(`${KALSHI_API_BASE}${path}`, {
    method,
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-SIGNATURE": sig,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "Accept": "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return r;
}

export async function getBalance() {
  const r = await kalshiAuthedFetch("GET", "/trade-api/v2/portfolio/balance");
  if (!r.ok) throw new Error(`balance ${r.status}: ${await r.text()}`);
  return await r.json();
}

// settlement_status=all includes closed (qty=0) positions with their final
// realized_pnl_dollars + fees_paid_dollars. Default is "unsettled" which hides
// every settled position — that breaks both the dashboard's realized P&L line
// and jackson_trader's settled-store capture, which keys off this response.
export async function getPositions() {
  const r = await kalshiAuthedFetch("GET", "/trade-api/v2/portfolio/positions?limit=200&settlement_status=all");
  if (!r.ok) throw new Error(`positions ${r.status}: ${await r.text()}`);
  return await r.json();
}

export async function getRecentFills(limit = 50) {
  const r = await kalshiAuthedFetch("GET", `/trade-api/v2/portfolio/fills?limit=${limit}`);
  if (!r.ok) throw new Error(`fills ${r.status}: ${await r.text()}`);
  return await r.json();
}

export async function getOpenOrders() {
  const r = await kalshiAuthedFetch("GET", "/trade-api/v2/portfolio/orders?status=resting&limit=200");
  if (!r.ok) throw new Error(`orders ${r.status}: ${await r.text()}`);
  return await r.json();
}

// Lookup a single Kalshi market's settlement state. Returns "yes" / "no" if the
// market resolved, null if still open or on lookup error. Used by jackson_trader
// at reconcile time to compute realized P&L for ledger entries that left the
// open-position list (Kalshi's /portfolio/positions does not return closed rows
// even with settlement_status=all on the elections API).
export async function getMarketResult(ticker) {
  try {
    const r = await kalshiAuthedFetch("GET", `/trade-api/v2/markets/${ticker}`);
    if (!r.ok) return null;
    const j = await r.json();
    const result = j?.market?.result;
    return (result === "yes" || result === "no") ? result : null;
  } catch (e) {
    return null;
  }
}

// Fetch current Kalshi market state from our internal /api/kalshi.
async function fetchMarketSnapshot() {
  try {
    const auth = "Basic " + btoa("internal:hydro");
    const r = await fetch("https://weatherbot-mf.netlify.app/api/kalshi", { headers: { authorization: auth } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// Fetch rainbot's /api/markets directly (not via our /api/rain proxy — the proxy
// requires the same RAINBOT_BASIC_AUTH and would just add an extra hop). Returns
// null on any error so enrichPositions degrades gracefully (rain entries get
// city/variable but null sellPrice/unrealized, same as before this change).
async function fetchRainSnapshot() {
  const auth = process.env.RAINBOT_BASIC_AUTH;
  if (!auth) return null;
  const headers = auth.startsWith("Basic ") ? { authorization: auth }
                                             : { authorization: `Basic ${auth}` };
  try {
    const base = process.env.RAINBOT_BASE_URL || "https://rainbot-mf.netlify.app";
    const r = await fetch(`${base}/api/markets`, {
      headers, signal: AbortSignal.timeout(20_000)
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// Build a reverse lookup from Kalshi series ticker → {city, variable}.
// Mirror of CITY_TO_KALSHI in kalshi.js. Kept in sync manually for now.
const SERIES_LOOKUP = {
  "KXHIGHNY":     { city: "New York",          variable: "high" },
  "KXLOWNY":      { city: "New York",          variable: "low"  },
  "KXHIGHLAX":    { city: "Los Angeles",       variable: "high" },
  "KXLOWLAX":     { city: "Los Angeles",       variable: "low"  },
  "KXHIGHCHI":    { city: "Chicago",           variable: "high" },
  "KXLOWTCHI":    { city: "Chicago",           variable: "low"  },
  // Houston HIGH was renamed KXHIGHHOU → KXHIGHTHOU (per ticker audit, see
  // feedback_weatherbot_kalshi_ticker_audit). Keep the legacy key so historical
  // ledger entries on the old series still resolve.
  "KXHIGHHOU":    { city: "Houston",           variable: "high" },
  "KXHIGHTHOU":   { city: "Houston",           variable: "high" },
  "KXLOWTHOU":    { city: "Houston",           variable: "low"  },
  "KXHIGHTPHX":   { city: "Phoenix",           variable: "high" },
  "KXLOWTPHX":    { city: "Phoenix",           variable: "low"  },
  "KXHIGHPHIL":   { city: "Philadelphia",      variable: "high" },
  "KXLOWPHIL":    { city: "Philadelphia",      variable: "low"  },
  "KXHIGHTSATX":  { city: "San Antonio",       variable: "high" },
  "KXLOWTSATX":   { city: "San Antonio",       variable: "low"  },
  "KXHIGHTDAL":   { city: "Dallas-Fort Worth", variable: "high" },
  "KXLOWTDAL":    { city: "Dallas-Fort Worth", variable: "low"  },
  "KXHIGHAUS":    { city: "Austin",            variable: "high" },
  "KXLOWAUS":     { city: "Austin",            variable: "low"  },
  "KXHIGHTSEA":   { city: "Seattle",           variable: "high" },
  "KXLOWTSEA":    { city: "Seattle",           variable: "low"  },
  "KXHIGHDEN":    { city: "Denver",            variable: "high" },
  "KXLOWDEN":     { city: "Denver",            variable: "low"  },
  "KXHIGHTDC":    { city: "Washington DC",     variable: "high" },
  "KXHIGHTBOS":   { city: "Boston",            variable: "high" },
  "KXLOWTBOS":    { city: "Boston",            variable: "low"  },
  // Rain series (jackson_rain_trader). Mirror of CITIES in rainbot/lib/cities.js.
  // KXRAIN<code>  = daily binary "any rain"; KXRAIN<code>M = monthly tiered totals.
  "KXRAINNYC":    { city: "New York",          variable: "rain" },
  "KXRAINNYCM":   { city: "New York",          variable: "rain" },
  "KXRAINHOUM":   { city: "Houston",           variable: "rain" },
  "KXRAINMIAM":   { city: "Miami",             variable: "rain" },
  "KXRAINSEAM":   { city: "Seattle",           variable: "rain" },
  "KXRAINCHIM":   { city: "Chicago",           variable: "rain" },
  "KXRAINLAXM":   { city: "Los Angeles",       variable: "rain" },
  "KXRAINDALM":   { city: "Dallas-Fort Worth", variable: "rain" },
  "KXRAINAUSM":   { city: "Austin",            variable: "rain" },
  "KXRAINDENM":   { city: "Denver",            variable: "rain" },
  "KXRAINSFOM":   { city: "San Francisco",     variable: "rain" }
};

// Parse a Kalshi market ticker like "KXLOWTCHI-26MAY01-B36.5" into its parts.
function parseKalshiTicker(ticker) {
  const parts = ticker.split("-");
  if (parts.length < 3) return { series: ticker, eventDate: null, bucketTicker: null };
  return { series: parts[0], eventDate: parts[1], bucketTicker: parts.slice(2).join("-") };
}

// Mark-to-market + enrichment. For each Kalshi position, find current bid, model context,
// and human-readable city/variable/bucket. Returns per-ticker enrichment.
// Accepts an optional `rain` payload (rainbot's /api/markets shape) for rain-ticker support.
function enrichPositions(positions, kalshi, rain) {
  const result = {};
  let totalUnrealized = 0;
  if (!kalshi?.cities) return { byTicker: result, totalUnrealized: 0 };

  // Build per-bucket lookup keyed by ticker suffix, with city/variable context.
  // kalshi.js sets b.ticker to the FULL Kalshi ticker (e.g., "KXHIGHNY-26MAY05-B79.5"),
  // but parseKalshiTicker below extracts the SHORT bucket code ("B79.5") for the lookup.
  // Index by the short code on both sides so the lookup actually hits.
  const bucketByCityKey = {};  // "<cityName>-<variable>-<bucketCode>" → bucket
  const cityByName = {};
  for (const c of kalshi.cities) {
    cityByName[c.name] = c;
    for (const [variant, list] of [["high", c.highBuckets], ["low", c.lowBuckets]]) {
      if (!list) continue;
      for (const b of list) {
        const code = (b.ticker || "").split("-").pop();
        if (code) bucketByCityKey[`${c.name}-${variant}-${code}`] = b;
      }
    }
  }

  // Build a rain-side lookup: full Kalshi ticker → { yes_bid, no_bid, p_yes_model, gamma }.
  // rainbot returns full tickers in cities[].daily.bets / cities[].monthly.bets[*].ticker,
  // and gamma posterior at cities[].monthly.gamma. We carry gamma separately so the
  // per-position enrichment can surface modelMean/modelStd (= total monthly rainfall
  // posterior, not bucket-specific — rain is tiered, not bucketed).
  const rainByTicker = {};
  const rainGammaBySeries = {};   // series prefix (e.g. "KXRAINNYCM") → gamma {shape, scale}
  if (rain?.cities) {
    for (const c of rain.cities) {
      const gamma = c?.monthly?.gamma;
      // Map gamma onto the series prefix. eventTicker is shaped like
      // "KXRAINNYCM-26MAY" — we want only the series part ("KXRAINNYCM") because
      // parseKalshiTicker splits a full market ticker into series + eventDate +
      // bucketTicker, and `series` here is what we look up against.
      if (gamma && c?.monthly?.eventTicker) {
        const seriesPrefix = c.monthly.eventTicker.split("-")[0];
        rainGammaBySeries[seriesPrefix] = gamma;
      }
      for (const sec of [c.daily, c.monthly]) {
        if (!sec?.bets) continue;
        for (const b of sec.bets) {
          if (!b.ticker) continue;
          const e = rainByTicker[b.ticker] ??= { city: c.code, kind: sec === c.daily ? "daily" : "monthly" };
          e.yes_bid = b.yes_bid; e.no_bid = b.no_bid;
          e.threshold = b.threshold;
          if (b.side === "YES") e.p_yes_model = b.p_model;
          else if (b.side === "NO" && e.p_yes_model == null) e.p_yes_model = 1 - b.p_model;
        }
      }
    }
  }

  for (const p of positions) {
    const qty = parseFloat(p.position_fp || "0");
    if (qty === 0) continue;
    const exposure = parseFloat(p.market_exposure_dollars || "0");
    const { series, bucketTicker } = parseKalshiTicker(p.ticker);
    const seriesInfo = SERIES_LOOKUP[series];
    const cityName = seriesInfo?.city || null;
    const variable = seriesInfo?.variable || null;
    const isYes = qty > 0;

    let sellPrice = null, sellProceeds = null, unrealized = null;
    let modelMean = null, modelStd = null;
    let bucketLabel = bucketTicker;

    if (variable === "rain") {
      // Rain branch: bid/p come from rainbot's full-ticker lookup. modelMean/modelStd
      // are the gamma posterior's mean/std for total monthly rainfall in that city —
      // NOT bucket-specific (rain is tiered, so a single posterior covers all strikes).
      const rainEntry = rainByTicker[p.ticker];
      if (rainEntry) {
        sellPrice = isYes ? rainEntry.yes_bid : rainEntry.no_bid;
        if (rainEntry.threshold != null) {
          bucketLabel = `≥ ${rainEntry.threshold}″`;
        }
      }
      const gamma = rainGammaBySeries[series];
      if (gamma) {
        modelMean = gamma.shape * gamma.scale;
        modelStd = gamma.scale * Math.sqrt(gamma.shape);
      }
    } else {
      // Temperature branch (HIGH/LOW): existing logic against kalshi.js bucket data.
      const cityModel = cityName ? cityByName[cityName]?.model : null;
      const bucket = (cityName && variable && bucketTicker)
        ? bucketByCityKey[`${cityName}-${variable}-${bucketTicker}`]
        : null;
      // Field names on the kalshi.js bucket object are yes_bid / no_bid (not
      // kalshi_yes_bid / kalshi_no_bid — that older name never existed). Reading
      // the wrong key returned undefined and silently zeroed totalUnrealizedPnl.
      sellPrice = bucket ? (isYes ? bucket.yes_bid : bucket.no_bid) : null;
      bucketLabel = bucket?.bucket || bucketTicker;
      modelMean = (variable === "high") ? cityModel?.highMean
                : (variable === "low")  ? cityModel?.lowMean  : null;
      modelStd  = (variable === "high") ? cityModel?.highStd
                : (variable === "low")  ? cityModel?.lowStd   : null;
    }

    if (sellPrice != null) {
      sellProceeds = Math.abs(qty) * sellPrice;
      unrealized = sellProceeds - exposure;
      totalUnrealized += unrealized;
    }
    result[p.ticker] = {
      city: cityName, variable, bucket: bucketLabel,
      modelMean: modelMean != null ? Math.round(modelMean * 100) / 100 : null,
      modelStd:  modelStd  != null ? Math.round(modelStd  * 100) / 100 : null,
      sellPrice,
      sellProceeds: sellProceeds != null ? Math.round(sellProceeds * 100) / 100 : null,
      unrealized_pnl: unrealized != null ? Math.round(unrealized * 100) / 100 : null
    };
  }
  return { byTicker: result, totalUnrealized: Math.round(totalUnrealized * 100) / 100 };
}

// Aggregate per-city performance. Settled rows come from the persistent
// jackson_settled_bets blob store (written by jackson_trader on reconcile);
// unrealized rows come from the live mark-to-market computed above.
// Returns an array sorted by total P&L descending.
async function aggregateByCity(markToMarket) {
  const store = getStore("jackson_settled_bets");
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  const settled = (await Promise.all(
    blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null))
  )).filter(Boolean);

  const agg = {};
  for (const s of settled) {
    const city = s.city || "Unknown";
    const a = agg[city] ??= {
      city, n_settled: 0, wins: 0, losses: 0, sold: 0, unknown: 0,
      realized_pnl: 0, fees_paid: 0, total_staked: 0,
      open_count: 0, unrealized_pnl: 0
    };
    a.n_settled += 1;
    if (s.outcome === "WIN") a.wins += 1;
    else if (s.outcome === "LOSS") a.losses += 1;
    else if (s.outcome === "SOLD") a.sold += 1;
    else a.unknown += 1;
    if (s.realized_pnl != null) a.realized_pnl += s.realized_pnl;
    a.fees_paid += s.fees_paid || 0;
    a.total_staked += s.stake_dollars || 0;
  }
  for (const ticker of Object.keys(markToMarket || {})) {
    const m = markToMarket[ticker];
    const city = m.city || "Unknown";
    const a = agg[city] ??= {
      city, n_settled: 0, wins: 0, losses: 0, sold: 0, unknown: 0,
      realized_pnl: 0, fees_paid: 0, total_staked: 0,
      open_count: 0, unrealized_pnl: 0
    };
    a.open_count += 1;
    a.unrealized_pnl += m.unrealized_pnl || 0;
  }
  const round2 = v => Math.round(v * 100) / 100;
  return Object.values(agg).map(a => {
    const decided = a.wins + a.losses;  // exclude SOLD/UNKNOWN from win-rate denominator
    return {
      city: a.city,
      n_settled: a.n_settled,
      wins: a.wins, losses: a.losses, sold: a.sold, unknown: a.unknown,
      open_count: a.open_count,
      realized_pnl: round2(a.realized_pnl),
      unrealized_pnl: round2(a.unrealized_pnl),
      total_pnl: round2(a.realized_pnl + a.unrealized_pnl),
      fees_paid: round2(a.fees_paid),
      total_staked: round2(a.total_staked),
      win_rate_pct: decided ? Math.round(a.wins / decided * 1000) / 10 : 0,
      roi_pct: a.total_staked ? Math.round(a.realized_pnl / a.total_staked * 1000) / 10 : 0
    };
  }).sort((a, b) => b.total_pnl - a.total_pnl);
}

// Public read endpoint for dashboard. Returns a snapshot of the real account state.
export default async () => {
  const out = { account: ACCOUNT_NAME, configured: false };
  if (!process.env.KALSHI_ACCESS_KEY_ID || !process.env.KALSHI_PRIVATE_KEY) {
    return new Response(JSON.stringify({
      ...out,
      message: "Kalshi credentials not yet configured. Set KALSHI_ACCESS_KEY_ID and KALSHI_PRIVATE_KEY env vars to activate."
    }, null, 2), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
    });
  }
  out.configured = true;
  try {
    const [bal, pos, fills, orders, kalshi, rain] = await Promise.allSettled([
      getBalance(), getPositions(), getRecentFills(50), getOpenOrders(),
      fetchMarketSnapshot(), fetchRainSnapshot()
    ]);
    out.balance = bal.status === "fulfilled" ? bal.value : { error: String(bal.reason) };
    out.positions = pos.status === "fulfilled" ? pos.value : { error: String(pos.reason) };
    out.fills = fills.status === "fulfilled" ? fills.value : { error: String(fills.reason) };
    out.orders = orders.status === "fulfilled" ? orders.value : { error: String(orders.reason) };
    // Compute unrealized + realized P&L using current Kalshi bid prices.
    if (out.positions?.market_positions) {
      // Realized P&L (per-position, summed). Includes closed positions still in the response.
      let totalRealized = 0, totalFees = 0;
      for (const p of out.positions.market_positions) {
        totalRealized += parseFloat(p.realized_pnl_dollars || "0");
        totalFees += parseFloat(p.fees_paid_dollars || "0");
      }
      out.totalRealizedPnl = Math.round(totalRealized * 100) / 100;
      out.totalFeesPaid = Math.round(totalFees * 100) / 100;
      // Unrealized P&L from market quotes + per-position enrichment (city/variable/bucket/model).
      // Rain snapshot (rainbot /api/markets) provides bid/ask + gamma posterior for rain
      // tickers; falls back to null gracefully if the rain fetch failed or is unavailable.
      if (kalshi.status === "fulfilled") {
        const rainPayload = rain.status === "fulfilled" ? rain.value : null;
        const enr = enrichPositions(out.positions.market_positions, kalshi.value, rainPayload);
        out.markToMarket = enr.byTicker;
        out.totalUnrealizedPnl = enr.totalUnrealized;
      } else {
        out.totalUnrealizedPnl = 0;
        out.markToMarket = {};
      }
      out.totalPnl = Math.round((totalRealized + (out.totalUnrealizedPnl || 0)) * 100) / 100;
    }
    out.byCity = await aggregateByCity(out.markToMarket || {});
    out.fetchedAtUTC = new Date().toISOString();
    return new Response(JSON.stringify(out, null, 2), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ...out, error: String(e) }, null, 2), {
      status: 502,
      headers: { "content-type": "application/json" }
    });
  }
};

export const config = { path: "/api/jackson" };
