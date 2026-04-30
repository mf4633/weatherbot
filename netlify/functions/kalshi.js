// Cross-references our weatherbot predictions with Kalshi daily-high markets.
// For each market bucket, computes P(actual high in bucket) under our normal model and
// compares to the market's mid-price. Returns a sorted "best bets" list by expected value.
//
// EV per dollar (YES contract): p_model - yes_ask  (positive = +EV)
// EV per dollar (NO contract):  (1 - p_model) - no_ask
//
// All Kalshi prices are in dollars (0.01–0.99 for active markets).

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

// Map our city display name → Kalshi series ticker (today, Apr 2026).
// 7 of 20 cities don't have Kalshi markets and are skipped: SAN, JAX, TPA, SJC, CMH, CLT, IND.
const CITY_TO_KALSHI_SERIES = {
  "New York":          "KXHIGHNY",
  "Los Angeles":       "KXHIGHLAX",
  "Chicago":           "KXHIGHCHI",
  "Houston":           "KXHIGHHOU",
  "Phoenix":           "KXHIGHTPHX",
  "Philadelphia":      "KXHIGHPHIL",
  "San Antonio":       "KXHIGHTSATX",
  "Dallas-Fort Worth": "KXHIGHTDAL",
  "Austin":            "KXHIGHAUS",
  "Seattle":           "KXHIGHTSEA",
  "Denver":            "KXHIGHDEN",
  "Washington DC":     "KXHIGHTDC",
  "Boston":            "KXHIGHTBOS"
};

// Standard normal CDF (Abramowitz & Stegun 26.2.17, ~7-decimal accuracy).
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Format today's local date in MMMddyy → kalshi event suffix "26APR30".
// We use the city's local date because the Kalshi event closes at midnight local.
function kalshiDateSuffix(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "2-digit", month: "short", day: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}${parts.month.toUpperCase()}${parts.day}`;
}

async function fetchPredictions() {
  const r = await fetch(`${SITE_BASE}/api/weather`);
  if (!r.ok) throw new Error(`weather API ${r.status}`);
  return await r.json();
}

async function fetchKalshiMarkets(eventTicker) {
  const r = await fetch(`${KALSHI_API}/markets?event_ticker=${eventTicker}&limit=50`);
  if (!r.ok) return null;
  return await r.json();
}

// Parse a market's bucket boundaries. Returns { loInt, hiInt } where bucket means high ∈ [loInt, hiInt]
// (inclusive of integer-degree highs). For tail buckets, use ±Infinity.
function bucketBounds(market) {
  const t = market.ticker.split("-").pop();
  const fs = market.floor_strike;
  const cs = market.cap_strike;
  if (t.startsWith("T")) {
    // Tail: T<n> can mean either "<= n-1" (low tail) or ">= n+1" (high tail).
    // The strike_type and floor/cap fields disambiguate.
    if (market.strike_type === "less" || (cs != null && fs == null)) {
      return { loInt: -Infinity, hiInt: cs };  // <= cs
    }
    if (market.strike_type === "greater" || (fs != null && cs == null)) {
      return { loInt: fs, hiInt: Infinity };   // >= fs
    }
    // Fallback: parse from subtitle.
    const sub = market.subtitle || "";
    if (sub.includes("below") || sub.includes("or less")) return { loInt: -Infinity, hiInt: parseInt(sub) };
    if (sub.includes("above") || sub.includes("or more")) return { loInt: parseInt(sub), hiInt: Infinity };
  }
  // Between bucket: floor_strike to cap_strike inclusive of integer highs.
  return { loInt: fs, hiInt: cs };
}

// P(high in [loInt, hiInt]) under N(mean, std), with integer-degree quantization (high is reported as int).
// We use continuity correction: bucket [a, b] integer ↔ (a-0.5, b+0.5) on the continuous distribution.
// Truncate at maxSoFar (today's high cannot be < what's already observed).
function bucketProb(mean, std, loInt, hiInt, maxSoFar) {
  // Effective lower bound for the bucket (after truncation).
  let effLo = loInt === -Infinity ? -Infinity : loInt - 0.5;
  let effHi = hiInt === Infinity ? Infinity : hiInt + 0.5;
  if (maxSoFar != null) {
    // Bucket entirely below maxSoFar: impossible.
    if (effHi < maxSoFar) return 0;
    // Bucket spans maxSoFar: clip.
    if (effLo < maxSoFar) effLo = maxSoFar;
  }
  const pHi = effHi === Infinity ? 1 : normCdf((effHi - mean) / std);
  const pLo = effLo === -Infinity ? 0 : normCdf((effLo - mean) / std);
  return Math.max(0, pHi - pLo);
}

export default async () => {
  let predData;
  try {
    predData = await fetchPredictions();
  } catch (e) {
    return new Response(JSON.stringify({ error: "weather fetch failed", detail: String(e) }), {
      status: 502, headers: { "content-type": "application/json" }
    });
  }

  const now = new Date();
  const cities = [];
  const allBets = [];

  for (const city of predData.cities || []) {
    if (city.error) continue;
    const series = CITY_TO_KALSHI_SERIES[city.name];
    if (!series) {
      cities.push({ name: city.name, station: city.station, kalshi: "no market", model: { mean: city.mean, std: city.std } });
      continue;
    }

    const eventTicker = `${series}-${kalshiDateSuffix(now, city.tz)}`;
    const m = await fetchKalshiMarkets(eventTicker);
    if (!m || !m.markets || !m.markets.length) {
      cities.push({ name: city.name, station: city.station, kalshi: `event ${eventTicker} not found`, model: { mean: city.mean, std: city.std } });
      continue;
    }

    // Renormalize bucket probabilities so they sum to 1 (handles floor truncation cleanly).
    const bucketsRaw = m.markets.map(mkt => {
      const { loInt, hiInt } = bucketBounds(mkt);
      const yes_ask = mkt.yes_ask_dollars ? parseFloat(mkt.yes_ask_dollars) : null;
      const yes_bid = mkt.yes_bid_dollars ? parseFloat(mkt.yes_bid_dollars) : null;
      const no_ask  = mkt.no_ask_dollars  ? parseFloat(mkt.no_ask_dollars)  : null;
      const no_bid  = mkt.no_bid_dollars  ? parseFloat(mkt.no_bid_dollars)  : null;
      const last    = mkt.last_price_dollars ? parseFloat(mkt.last_price_dollars) : null;
      const midPx   = (yes_ask != null && yes_bid != null) ? (yes_ask + yes_bid) / 2 : last;
      return { ticker: mkt.ticker, subtitle: mkt.subtitle, loInt, hiInt,
               yes_ask, yes_bid, no_ask, no_bid, last, midPx,
               volume: mkt.volume_fp || 0 };
    });
    const probSum = bucketsRaw.reduce((a, b) => a + bucketProb(city.mean, city.std, b.loInt, b.hiInt, city.maxSoFar), 0);
    const buckets = bucketsRaw.map(b => {
      const rawP = bucketProb(city.mean, city.std, b.loInt, b.hiInt, city.maxSoFar);
      const p_model = probSum > 0 ? rawP / probSum : 0;
      // EV per $1 staked (buying at ask).
      const evYes = b.yes_ask != null ? p_model - b.yes_ask : null;
      const evNo  = b.no_ask  != null ? (1 - p_model) - b.no_ask : null;
      return { ...b, p_model: Math.round(p_model * 1000) / 1000, evYes, evNo };
    });

    cities.push({
      name: city.name,
      station: city.station,
      kalshi: eventTicker,
      model: { mean: city.mean, std: city.std, maxSoFar: city.maxSoFar, currentTemp: city.currentTemp },
      buckets: buckets.map(b => ({
        bucket: b.subtitle,
        ticker: b.ticker.split("-").pop(),
        kalshi_mid: b.midPx,
        kalshi_yes_ask: b.yes_ask,
        kalshi_no_ask: b.no_ask,
        p_model: b.p_model,
        edgeYes: b.yes_ask != null ? Math.round((b.p_model - b.yes_ask) * 1000) / 1000 : null,
        edgeNo:  b.no_ask  != null ? Math.round(((1 - b.p_model) - b.no_ask) * 1000) / 1000 : null,
        volume: b.volume
      }))
    });

    // Collect bets for ranking.
    for (const b of buckets) {
      if (b.evYes != null && b.evYes > 0.02 && b.yes_ask < 0.95) {
        allBets.push({ city: city.name, bucket: b.subtitle, ticker: b.ticker.split("-").pop(),
                       side: "YES", price: b.yes_ask, p_model: b.p_model, ev: b.evYes, volume: b.volume });
      }
      if (b.evNo != null && b.evNo > 0.02 && b.no_ask < 0.95) {
        allBets.push({ city: city.name, bucket: b.subtitle, ticker: b.ticker.split("-").pop(),
                       side: "NO", price: b.no_ask, p_model: 1 - b.p_model, ev: b.evNo, volume: b.volume });
      }
    }
  }

  allBets.sort((a, b) => b.ev - a.ev);

  return new Response(JSON.stringify({
    ts: now.toISOString(),
    disclaimer: "Educational only. EV is per $1 staked. Our model RMSE is ~1.7°F; individual bet edges can be noise. Volume = lifetime contract count.",
    topBets: allBets.slice(0, 30),
    cities
  }, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=120" }
  });
};

export const config = { path: "/api/kalshi" };
