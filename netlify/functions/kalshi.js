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

// Map our city display name → Kalshi series ticker for HIGH and LOW.
// 7 of 20 cities don't have Kalshi markets and are skipped: SAN, JAX, TPA, SJC, CMH, CLT, IND.
const CITY_TO_KALSHI = {
  "New York":          { high: "KXHIGHNY",   low: "KXLOWNY"     },
  "Los Angeles":       { high: "KXHIGHLAX",  low: "KXLOWLAX"    },
  "Chicago":           { high: "KXHIGHCHI",  low: "KXLOWTCHI"   },
  "Houston":           { high: "KXHIGHTHOU", low: "KXLOWTHOU"   },
  "Phoenix":           { high: "KXHIGHTPHX", low: "KXLOWTPHX"   },
  "Philadelphia":      { high: "KXHIGHPHIL", low: "KXLOWPHIL"   },
  "San Antonio":       { high: "KXHIGHTSATX", low: "KXLOWTSATX" },
  "Dallas-Fort Worth": { high: "KXHIGHTDAL", low: "KXLOWTDAL"   },
  "Austin":            { high: "KXHIGHAUS",  low: "KXLOWAUS"    },
  "Seattle":           { high: "KXHIGHTSEA", low: "KXLOWTSEA"   },
  "Denver":            { high: "KXHIGHDEN",  low: "KXLOWDEN"    },
  "Washington DC":     { high: "KXHIGHTDC",  low: null          },  // no DCA low yet
  "Boston":            { high: "KXHIGHTBOS", low: "KXLOWTBOS"   }
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
  // Pass auth so we don't get blocked by the Basic Auth edge function.
  const auth = "Basic " + btoa("internal:hydro");
  const r = await fetch(`${SITE_BASE}/api/weather`, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`weather API ${r.status}`);
  return await r.json();
}

async function fetchKalshiMarkets(eventTicker) {
  // Paginate so we don't silently truncate large bucket lists, AND retry on transient
  // failures — Kalshi's public markets endpoint flakes intermittently when /api/kalshi
  // hits 13 cities × 2 events = 26 sequential requests per cache miss. Without retry
  // the kalshi snapshot was non-deterministic: same query, 10 cities found one cycle,
  // 5 the next. We retry once with a 600ms backoff on non-2xx OR network throw, and
  // stop paginating once a page returns short of `PER_PAGE` (since the next cursor
  // sometimes lies — Kalshi returns a non-empty cursor for events that have nothing
  // more to fetch, and following it adds wasted requests + more rate-limit pressure).
  const MAX_PAGES = 3;
  const PER_PAGE = 200;
  async function fetchPage(cursor) {
    const url = `${KALSHI_API}/markets?event_ticker=${eventTicker}&limit=${PER_PAGE}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url);
        if (r.ok) return await r.json();
      } catch (_) { /* network error — fall through to retry */ }
      if (attempt === 0) await new Promise(res => setTimeout(res, 600));
    }
    return null;
  }
  const merged = { markets: [] };
  let cursor = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const j = await fetchPage(cursor);
    if (!j) return i === 0 ? null : merged;
    if (Array.isArray(j.markets)) merged.markets.push(...j.markets);
    // Stop if we got a short page — next cursor (if any) won't add real data.
    if (!Array.isArray(j.markets) || j.markets.length < PER_PAGE) break;
    cursor = j.cursor || "";
    if (!cursor) break;
  }
  return merged;
}

// σ_irreducible: quadrature-add a member-error prior so that even when the ensemble
// agrees, the predictive σ stays at or above the prior's natural width. Replaces a
// hard `max(σ, 1.0)` floor with a smooth hierarchical formulation:
//   σ_eff = √(σ_ensemble² + σ_irreducible²)
// Calibrated 2026-05-08 against the σ-floor A/B in backtest_gates.js — at irred=1.0
// the historical 49-bet sample shows +$82 net vs +$52 for the old floor (same scale).
// Theoretically justified by ensemble-mean RMSE 1.67°F (analyze.log) factored against
// typical ensemble-disagreement ~1°F: irreducible component ≈ √(1.67² − 1²) = 1.34°F.
// We ship 1.0 first for continuity; revisit upward to 1.3 once we have ~150 bets.
const SIGMA_IRREDUCIBLE_F = 1.0;

// Kalshi fee per $1 staked at a given binary contract price.
// Exact formula: fee_cents = ceil(7 × count × P × (1-P)) where P is yes_price ∈ [0,1].
// Per $1 staked at price P: fee ≈ 0.07 × (1−P) dollars (continuous approximation).
// Highest near P=0.5 (~3.5¢/$1), lowest near tails (P=0.01: ~7¢; P=0.99: ~0.07¢).
// Fees apply on BUY only; settlement is free; sell-to-close has separate fee (rare for us).
function kalshiFeePerDollar(price) {
  return 0.07 * (1 - price);
}

// Synthesize a human-readable label for any bucket, even when Kalshi's subtitle is empty.
function bucketLabel(loInt, hiInt, subtitle) {
  if (subtitle && subtitle.trim()) return subtitle.trim();
  if (loInt === -Infinity || loInt == null) return `≤ ${hiInt}°F`;
  if (hiInt === Infinity || hiInt == null) return `≥ ${loInt}°F`;
  return loInt === hiInt ? `${loInt}°F` : `${loInt}–${hiInt}°F`;
}

// Parse a market's bucket boundaries. Returns { loInt, hiInt } where bucket means high ∈ [loInt, hiInt]
// (inclusive of integer-degree highs). For tail buckets, use ±Infinity.
function bucketBounds(market) {
  const t = market.ticker.split("-").pop();
  const fs = market.floor_strike;
  const cs = market.cap_strike;
  if (t.startsWith("T")) {
    // Tail: T<n> can mean either "<= n-1" (low tail) or ">= n+1" (high tail).
    // Kalshi strike values are EXCLUSIVE bounds — a "less" market with cs=77
    // settles on integer outcomes ≤ 76 (subtitle "76° or below"), and a
    // "greater" market with fs=84 settles on integer outcomes ≥ 85 (subtitle
    // "85° or above"). Earlier code returned the strike value as the inclusive
    // bound (off-by-one), which made adjacent T-tail and B-bucket ranges
    // overlap and inflated probSum above 1.0 — e.g., on 2026-05-05 KXLOWTBOS
    // the T52-greater bucket was scored over [51.5, ∞) instead of [52.5, ∞),
    // double-counting probability mass that B51.5 already covered.
    if (market.strike_type === "less" || (cs != null && fs == null)) {
      return { loInt: -Infinity, hiInt: cs - 1 };  // x < cs (strict)
    }
    if (market.strike_type === "greater" || (fs != null && cs == null)) {
      return { loInt: fs + 1, hiInt: Infinity };   // x > fs (strict)
    }
    // Fallback: parse from subtitle.
    const sub = market.subtitle || "";
    if (sub.includes("below") || sub.includes("or less")) return { loInt: -Infinity, hiInt: parseInt(sub) };
    if (sub.includes("above") || sub.includes("or more")) return { loInt: parseInt(sub), hiInt: Infinity };
  }
  // Between bucket: floor_strike to cap_strike inclusive of integer highs.
  return { loInt: fs, hiInt: cs };
}

// P(temp in [loInt, hiInt]) under N(mean, std), with integer-degree quantization.
// Continuity correction: bucket [a, b] integer ↔ (a-0.5, b+0.5) on the continuous distribution.
// Truncation:
//  - lowerFloor: temp >= lowerFloor (e.g., today's HIGH can't be < maxSoFar already observed)
//  - upperFloor: temp <= upperFloor (e.g., today's LOW can't be > minSoFar already observed)
function bucketProb(mean, std, loInt, hiInt, lowerFloor = null, upperFloor = null) {
  let effLo = loInt === -Infinity ? -Infinity : loInt - 0.5;
  let effHi = hiInt === Infinity ? Infinity : hiInt + 0.5;
  if (lowerFloor != null) {
    if (effHi < lowerFloor) return 0;
    if (effLo < lowerFloor) effLo = lowerFloor;
  }
  if (upperFloor != null) {
    if (effLo > upperFloor) return 0;
    if (effHi > upperFloor) effHi = upperFloor;
  }
  const pHi = effHi === Infinity ? 1 : normCdf((effHi - mean) / std);
  const pLo = effLo === -Infinity ? 0 : normCdf((effLo - mean) / std);
  return Math.max(0, pHi - pLo);
}

// Lazy-import @netlify/blobs at handler time so local-only callers (tests, CLI
// invocations) still work without the runtime. Cached across calls.
let _blobGetStore = null;
async function getBlobStore(name) {
  if (!_blobGetStore) {
    try { _blobGetStore = (await import("@netlify/blobs")).getStore; }
    catch (e) { return null; }
  }
  return _blobGetStore(name);
}

// Read the live calibration state. Continuously updated by calibration_update.js.
// Returns inflation factors for HIGH and LOW; default 1.0 (no calibration) when
// the blob is missing or undeflfined for a side. See calibration_update.js for
// the residual-z-stdev computation.
async function readCalibration() {
  try {
    const store = await getBlobStore("calibration_state");
    if (!store) return { high: 1.0, low: 1.0 };
    const blob = await store.get("current.json", { type: "json" });
    return {
      high: blob?.high?.inflation_factor ?? 1.0,
      low:  blob?.low?.inflation_factor  ?? 1.0,
    };
  } catch (e) {
    return { high: 1.0, low: 1.0 };
  }
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

  // Calibration factors widen σ_eff on each side based on empirical residual
  // stdev. Applied as a multiplicative scaler AFTER the hierarchical-prior
  // quadrature, so the irreducible floor is still respected as a lower bound.
  const calibration = await readCalibration();

  const now = new Date();
  const cities = [];
  const allBets = [];

  // Freshness diagnostics: cache age + oldest forecast issuance among the matched cities.
  const cacheAgeMs = predData.ageMs ?? 0;
  const forecastUpdateTimes = (predData.cities || [])
    .map(c => c.forecastUpdateTime)
    .filter(Boolean)
    .map(s => new Date(s).getTime())
    .filter(t => !isNaN(t));
  const oldestForecastMs = forecastUpdateTimes.length ? Math.min(...forecastUpdateTimes) : null;
  const newestForecastMs = forecastUpdateTimes.length ? Math.max(...forecastUpdateTimes) : null;
  const freshness = {
    cacheAgeSec: Math.round(cacheAgeMs / 1000),
    cacheStale: cacheAgeMs > 5 * 60 * 1000,
    oldestForecastIssuedAt: oldestForecastMs ? new Date(oldestForecastMs).toISOString() : null,
    oldestForecastAgeMin: oldestForecastMs ? Math.round((Date.now() - oldestForecastMs) / 60000) : null,
    newestForecastAgeMin: newestForecastMs ? Math.round((Date.now() - newestForecastMs) / 60000) : null,
    forecastStale: oldestForecastMs ? (Date.now() - oldestForecastMs) > 90 * 60 * 1000 : false
  };

  // Helper: process one event (HIGH or LOW) for a city.
  // variable = "high" | "low"; mean / std come from our model for that variable;
  // lowerFloor / upperFloor are the truncation bounds from already-realized observations.
  async function processEvent(city, series, variable, mean, std, lowerFloor, upperFloor) {
    const eventTicker = `${series}-${kalshiDateSuffix(now, city.tz)}`;
    const m = await fetchKalshiMarkets(eventTicker);
    if (!m || !m.markets || !m.markets.length) return null;

    const bucketsRaw = m.markets.map(mkt => {
      const { loInt, hiInt } = bucketBounds(mkt);
      const yes_ask = mkt.yes_ask_dollars ? parseFloat(mkt.yes_ask_dollars) : null;
      const yes_bid = mkt.yes_bid_dollars ? parseFloat(mkt.yes_bid_dollars) : null;
      const no_ask  = mkt.no_ask_dollars  ? parseFloat(mkt.no_ask_dollars)  : null;
      const no_bid  = mkt.no_bid_dollars  ? parseFloat(mkt.no_bid_dollars)  : null;
      const last    = mkt.last_price_dollars ? parseFloat(mkt.last_price_dollars) : null;
      const midPx   = (yes_ask != null && yes_bid != null) ? (yes_ask + yes_bid) / 2 : last;
      const label   = bucketLabel(loInt, hiInt, mkt.subtitle);
      return { ticker: mkt.ticker, subtitle: mkt.subtitle, label, loInt, hiInt,
               yes_ask, yes_bid, no_ask, no_bid, last, midPx,
               volume: mkt.volume_fp || 0 };
    });
    const probSum = bucketsRaw.reduce((a, b) =>
      a + bucketProb(mean, std, b.loInt, b.hiInt, lowerFloor, upperFloor), 0);
    const buckets = bucketsRaw.map(b => {
      const rawP = bucketProb(mean, std, b.loInt, b.hiInt, lowerFloor, upperFloor);
      const p_model = probSum > 0 ? rawP / probSum : 0;
      // Gross EV = p_model - price. Net EV = gross - kalshi_fee_per_$_staked.
      // The trader's qualifying threshold checks NET EV (post-fee), so 5¢ "edge" means
      // 5¢ realized after Kalshi's take.
      const grossEvYes = b.yes_ask != null ? p_model - b.yes_ask : null;
      const grossEvNo  = b.no_ask  != null ? (1 - p_model) - b.no_ask : null;
      const feeYes = b.yes_ask != null ? kalshiFeePerDollar(b.yes_ask) : null;
      const feeNo  = b.no_ask  != null ? kalshiFeePerDollar(b.no_ask)  : null;
      const evYes = grossEvYes != null ? grossEvYes - feeYes : null;
      const evNo  = grossEvNo  != null ? grossEvNo  - feeNo  : null;
      return { ...b, p_model: Math.round(p_model * 1000) / 1000,
               grossEvYes, grossEvNo, feeYes, feeNo, evYes, evNo };
    });

    const kelly = (p, price) => Math.max(0, (p - price) / (1 - price));
    // Holding period for temp: a market for "today's high" settles when next morning's
    // CLI lands. Practically always within 24h of buy time → use 1 day. Rain is the
    // distance-asymmetric counterpart that gets actual TVM math (see rain.js).
    const HOLDING_DAYS = 1;
    const eventBets = [];
    for (const b of buckets) {
      if (b.evYes != null && b.evYes > 0.02 && b.yes_ask < 0.95) {
        const k = kelly(b.p_model, b.yes_ask);
        eventBets.push({
          city: city.name, variable, bucket: b.label, ticker: b.ticker.split("-").pop(),
          side: "YES", price: b.yes_ask, p_model: b.p_model, ev: b.evYes,
          evPerDay: b.evYes / HOLDING_DAYS, holdingDays: HOLDING_DAYS,
          kelly: k, halfKelly: k / 2, volume: b.volume,
          loInt: b.loInt, hiInt: b.hiInt, modelMean: mean, modelStd: std
        });
      }
      if (b.evNo != null && b.evNo > 0.02 && b.no_ask < 0.95) {
        const pNo = 1 - b.p_model;
        const k = kelly(pNo, b.no_ask);
        eventBets.push({
          city: city.name, variable, bucket: b.label, ticker: b.ticker.split("-").pop(),
          side: "NO", price: b.no_ask, p_model: pNo, ev: b.evNo,
          evPerDay: b.evNo / HOLDING_DAYS, holdingDays: HOLDING_DAYS,
          kelly: k, halfKelly: k / 2, volume: b.volume,
          loInt: b.loInt, hiInt: b.hiInt, modelMean: mean, modelStd: std
        });
      }
    }

    return { eventTicker, variable, mean, std, buckets, eventBets };
  }

  for (const city of predData.cities || []) {
    if (city.error) continue;
    const tickers = CITY_TO_KALSHI[city.name];
    if (!tickers) {
      cities.push({ name: city.name, station: city.station, kalshi: "no market" });
      continue;
    }
    const cityRecord = { name: city.name, station: city.station,
                         model: { highMean: city.mean, highStd: city.std, maxSoFar: city.maxSoFar,
                                  lowMean: city.lowMean, lowStd: city.lowStd, minSoFar: city.minSoFar,
                                  currentTemp: city.currentTemp },
                         // Per-source input ages — passthrough from weather.js for downstream
                         // traders (combo_trader) that consume /api/kalshi rather than /api/weather
                         // directly. Bayesian work-order #6b dataset feed; same fields as
                         // jackson_trader's cityInputAges block.
                         inputAges: {
                           nwsGridAgeMin: city.forecastUpdateTime
                             ? Math.round((Date.now() - new Date(city.forecastUpdateTime).getTime()) / 60000) : null,
                           metarAgeMin: city.lastMetarAgeMin ?? null,
                           dataAgeMin: city.dataAgeMin ?? null,
                           ensembleSourceCount: Array.isArray(city.ensembleSources) ? city.ensembleSources.length : null,
                           oneMinAsosAgeMin: city.oneMinAsos?.ageMin ?? null,
                           iemAgeMin: city.iemAgeMin ?? null,
                           currentTempSource: city.currentTempSource ?? null,
                           currentTempAgeMin: city.currentTempAgeMin ?? null,
                         } };

    // HIGH event. lowerFloor uses maxSoFarCli (integer °F) not raw maxSoFar — Kalshi
    // settles on NWS CLI which rounds to integer °F via a °C-internal path, so a raw
    // 87.8°F obs (= 31.0°C exact) can settle as 87°F. See feedback_weatherbot_cli_settlement.
    // σ_eff = √(σ_ensemble² + σ_irreducible²): hierarchical-prior formulation that
    // never collapses below the prior. See SIGMA_IRREDUCIBLE_F header.
    if (tickers.high) {
      const sigmaEff = Math.sqrt((city.std ?? 0) ** 2 + SIGMA_IRREDUCIBLE_F ** 2)
                       * calibration.high;
      const r = await processEvent(city, tickers.high, "high", city.mean, sigmaEff,
                                    city.maxSoFarCli ?? city.maxSoFar, null);
      if (r) {
        cityRecord.highEvent = r.eventTicker;
        cityRecord.highBuckets = r.buckets;
        allBets.push(...r.eventBets);
      } else {
        cityRecord.highEvent = "not found";
      }
    }
    // LOW event. upperFloor uses minSoFarCli (integer °F) — symmetric to HIGH lowerFloor.
    if (tickers.low && city.lowMean != null && city.lowStd != null) {
      const sigmaEff = Math.sqrt(city.lowStd ** 2 + SIGMA_IRREDUCIBLE_F ** 2)
                       * calibration.low;
      const r = await processEvent(city, tickers.low, "low", city.lowMean, sigmaEff,
                                    null, city.minSoFarCli ?? city.minSoFar);
      if (r) {
        cityRecord.lowEvent = r.eventTicker;
        cityRecord.lowBuckets = r.buckets;
        allBets.push(...r.eventBets);
      } else {
        cityRecord.lowEvent = "not found";
      }
    }
    cities.push(cityRecord);
  }

  // Sort by Kelly fraction (the "wisest choice" combining probability and edge).
  allBets.sort((a, b) => b.kelly - a.kelly);

  return new Response(JSON.stringify({
    ts: now.toISOString(),
    freshness,
    calibration,  // live σ-inflation factors applied this call
    disclaimer: "Educational only. EV is per $1 staked. Our model RMSE is ~1.7°F; individual bet edges can be noise. Volume = lifetime contract count. Edges from stale forecast data are FALSE — check freshness.",
    // Expanded from 30 → 200 to support the no-cap jackson_trader (2026-05-13).
    // Trader still threshold-gates on EV / halfKelly / Kelly-LCB so the long tail
    // gets filtered; this just stops cutting candidates the trader might want.
    topBets: allBets.slice(0, 200),
    cities
  }, null, 2), {
    // Short cache (30s): trader cron fires every ~5 min, so a 30s edge cache means each cycle
    // sees fresh model state. Previous 120s cache was a known cause of placement against stale
    // p_model when minSoFar / bias updates within a 2-min window.
    headers: { "content-type": "application/json", "cache-control": "public, max-age=30" }
  });
};

export const config = { path: "/api/kalshi" };
