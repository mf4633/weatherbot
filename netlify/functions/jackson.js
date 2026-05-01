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
  /^\/trade-api\/v2\/markets\/[\w-]+$/,
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

export async function getPositions() {
  const r = await kalshiAuthedFetch("GET", "/trade-api/v2/portfolio/positions?limit=200");
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

// Fetch current Kalshi market state from our internal /api/kalshi.
async function fetchMarketSnapshot() {
  try {
    const auth = "Basic " + btoa("internal:hydro");
    const r = await fetch("https://weatherbot-mf.netlify.app/api/kalshi", { headers: { authorization: auth } });
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
  "KXHIGHHOU":    { city: "Houston",           variable: "high" },
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
  "KXLOWTBOS":    { city: "Boston",            variable: "low"  }
};

// Parse a Kalshi market ticker like "KXLOWTCHI-26MAY01-B36.5" into its parts.
function parseKalshiTicker(ticker) {
  const parts = ticker.split("-");
  if (parts.length < 3) return { series: ticker, eventDate: null, bucketTicker: null };
  return { series: parts[0], eventDate: parts[1], bucketTicker: parts.slice(2).join("-") };
}

// Mark-to-market + enrichment. For each Kalshi position, find current bid, model context,
// and human-readable city/variable/bucket. Returns per-ticker enrichment.
function enrichPositions(positions, kalshi) {
  const result = {};
  let totalUnrealized = 0;
  if (!kalshi?.cities) return { byTicker: result, totalUnrealized: 0 };

  // Build per-bucket lookup keyed by ticker suffix, with city/variable context.
  const bucketByCityKey = {};  // "<cityName>-<variable>-<bucketTicker>" → bucket
  const cityByName = {};
  for (const c of kalshi.cities) {
    cityByName[c.name] = c;
    for (const [variant, list] of [["high", c.highBuckets], ["low", c.lowBuckets]]) {
      if (!list) continue;
      for (const b of list) bucketByCityKey[`${c.name}-${variant}-${b.ticker}`] = b;
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
    const cityModel = cityName ? cityByName[cityName]?.model : null;
    const bucket = (cityName && variable && bucketTicker)
      ? bucketByCityKey[`${cityName}-${variable}-${bucketTicker}`]
      : null;
    const isYes = qty > 0;
    const sellPrice = bucket
      ? (isYes ? bucket.kalshi_yes_bid : bucket.kalshi_no_bid)
      : null;
    let unrealized = null, sellProceeds = null;
    if (sellPrice != null) {
      sellProceeds = Math.abs(qty) * sellPrice;
      unrealized = sellProceeds - exposure;
      totalUnrealized += unrealized;
    }
    const modelMean = (variable === "high") ? cityModel?.highMean
                    : (variable === "low")  ? cityModel?.lowMean : null;
    const modelStd  = (variable === "high") ? cityModel?.highStd
                    : (variable === "low")  ? cityModel?.lowStd  : null;
    result[p.ticker] = {
      city: cityName, variable, bucket: bucket?.bucket || bucketTicker,
      modelMean, modelStd,
      sellPrice,
      sellProceeds: sellProceeds != null ? Math.round(sellProceeds * 100) / 100 : null,
      unrealized_pnl: unrealized != null ? Math.round(unrealized * 100) / 100 : null
    };
  }
  return { byTicker: result, totalUnrealized: Math.round(totalUnrealized * 100) / 100 };
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
    const [bal, pos, fills, orders, kalshi] = await Promise.allSettled([
      getBalance(), getPositions(), getRecentFills(50), getOpenOrders(), fetchMarketSnapshot()
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
      if (kalshi.status === "fulfilled") {
        const enr = enrichPositions(out.positions.market_positions, kalshi.value);
        out.markToMarket = enr.byTicker;
        out.totalUnrealizedPnl = enr.totalUnrealized;
      } else {
        out.totalUnrealizedPnl = 0;
        out.markToMarket = {};
      }
      out.totalPnl = Math.round((totalRealized + (out.totalUnrealizedPnl || 0)) * 100) / 100;
    }
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
