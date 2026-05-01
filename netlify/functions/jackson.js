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

// Mark-to-market: for each Kalshi position, find current bid and compute unrealized P&L.
function markToMarket(positions, kalshi) {
  if (!kalshi?.cities) return { byTicker: {}, totalUnrealized: 0 };
  // Build ticker → bucket lookup. Kalshi position tickers look like KXHIGHNY-26MAY02-B65.5;
  // our buckets are stored by their suffix (B65.5 etc).
  const byTicker = {};
  for (const c of kalshi.cities) {
    for (const arr of [c.highBuckets, c.lowBuckets]) {
      if (!arr) continue;
      for (const b of arr) byTicker[b.ticker] = b;
    }
  }
  let totalUnrealized = 0;
  const result = {};
  for (const p of positions) {
    const qty = parseFloat(p.position_fp || "0");
    if (qty === 0) continue;
    const exposure = parseFloat(p.market_exposure_dollars || "0");
    const tickerSuffix = p.ticker.split("-").pop();
    const bucket = byTicker[tickerSuffix];
    if (!bucket) continue;
    const isYes = qty > 0;
    const sellPrice = isYes ? bucket.kalshi_yes_bid : bucket.kalshi_no_bid;
    if (sellPrice == null) continue;
    const sellProceeds = Math.abs(qty) * sellPrice;
    const unrealized = sellProceeds - exposure;
    result[p.ticker] = {
      sellPrice,
      sellProceeds: Math.round(sellProceeds * 100) / 100,
      unrealized_pnl: Math.round(unrealized * 100) / 100
    };
    totalUnrealized += unrealized;
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
    // Compute unrealized P&L using current Kalshi bid prices.
    if (out.positions?.market_positions && kalshi.status === "fulfilled") {
      const mtm = markToMarket(out.positions.market_positions, kalshi.value);
      out.markToMarket = mtm.byTicker;
      out.totalUnrealizedPnl = mtm.totalUnrealized;
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
