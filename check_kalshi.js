// Local check: pull /api/weather + Kalshi for each city, compute EV table.

const SITE = "https://weatherbot-mf.netlify.app";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

const CITY_TO_KALSHI_SERIES = {
  "New York":          "KXHIGHNY",
  "Los Angeles":       "KXHIGHLAX",
  "Chicago":           "KXHIGHCHI",
  "Houston":           "KXHIGHTHOU",
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

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x*x/2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function dateSuffix(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "2-digit", month: "short", day: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}${p.month.toUpperCase()}${p.day}`;
}

function bucketBounds(market) {
  const fs = market.floor_strike;
  const cs = market.cap_strike;
  const t = market.ticker.split("-").pop();
  if (t.startsWith("T")) {
    if (market.strike_type === "less" || (cs != null && fs == null)) return { loInt: -Infinity, hiInt: cs };
    if (market.strike_type === "greater" || (fs != null && cs == null)) return { loInt: fs, hiInt: Infinity };
  }
  return { loInt: fs, hiInt: cs };
}

function bucketProb(mean, std, loInt, hiInt, maxSoFar) {
  let lo = loInt === -Infinity ? -Infinity : loInt - 0.5;
  let hi = hiInt === Infinity ? Infinity : hiInt + 0.5;
  if (maxSoFar != null) {
    if (hi < maxSoFar) return 0;
    if (lo < maxSoFar) lo = maxSoFar;
  }
  const pHi = hi === Infinity ? 1 : normCdf((hi - mean) / std);
  const pLo = lo === -Infinity ? 0 : normCdf((lo - mean) / std);
  return Math.max(0, pHi - pLo);
}

const wr = await fetch(`${SITE}/api/weather`);
if (!wr.ok) { console.error(`GET /api/weather failed: HTTP ${wr.status}`); process.exit(1); }
const wd = await wr.json();
console.log(`Pulled ${wd.cities.length} city predictions (cached=${wd.cached})\n`);

const allBets = [];
const now = new Date();

for (const city of wd.cities) {
  if (city.error) continue;
  const series = CITY_TO_KALSHI_SERIES[city.name];
  if (!series) continue;
  const ticker = `${series}-${dateSuffix(now, city.tz)}`;
  const r = await fetch(`${KALSHI}/markets?event_ticker=${ticker}&limit=50`);
  if (!r.ok) { console.log(`${city.name}: no event ${ticker}`); continue; }
  const m = await r.json();
  if (!m.markets || !m.markets.length) { console.log(`${city.name}: empty event`); continue; }

  const bucketsRaw = m.markets.map(mkt => {
    const { loInt, hiInt } = bucketBounds(mkt);
    return {
      ticker: mkt.ticker.split("-").pop(),
      sub: mkt.subtitle,
      loInt, hiInt,
      yes_ask: mkt.yes_ask_dollars ? parseFloat(mkt.yes_ask_dollars) : null,
      yes_bid: mkt.yes_bid_dollars ? parseFloat(mkt.yes_bid_dollars) : null,
      no_ask:  mkt.no_ask_dollars  ? parseFloat(mkt.no_ask_dollars)  : null,
      last:    mkt.last_price_dollars ? parseFloat(mkt.last_price_dollars) : null,
      vol:     mkt.volume_fp || 0
    };
  });
  const sumP = bucketsRaw.reduce((a, b) => a + bucketProb(city.mean, city.std, b.loInt, b.hiInt, city.maxSoFar), 0);

  // Sort by floor_strike for display
  bucketsRaw.sort((a, b) => {
    const av = a.loInt === -Infinity ? -1e9 : a.loInt;
    const bv = b.loInt === -Infinity ? -1e9 : b.loInt;
    return av - bv;
  });

  console.log(`\n=== ${city.name} (${city.station}) ===`);
  console.log(`  model: μ=${city.mean}°F  σ=${city.std}  maxSoFar=${city.maxSoFar}  current=${city.currentTemp}`);
  console.log(`  ${'bucket'.padEnd(14)} ${'p_model'.padStart(8)} ${'mid'.padStart(6)} ${'yes_ask'.padStart(8)} ${'no_ask'.padStart(8)} ${'edge_YES'.padStart(9)} ${'edge_NO'.padStart(8)} ${'vol'.padStart(8)}`);
  for (const b of bucketsRaw) {
    const rawP = bucketProb(city.mean, city.std, b.loInt, b.hiInt, city.maxSoFar);
    const p_model = sumP > 0 ? rawP / sumP : 0;
    const mid = (b.yes_ask != null && b.yes_bid != null) ? (b.yes_ask + b.yes_bid) / 2 : b.last;
    const evY = b.yes_ask != null ? p_model - b.yes_ask : null;
    const evN = b.no_ask  != null ? (1 - p_model) - b.no_ask : null;
    const fmt = (x, w) => x == null ? '—'.padStart(w) : x.toFixed(3).padStart(w);
    const sub = (b.sub || b.ticker || "?").padEnd(14);
    console.log(`  ${sub} ${fmt(p_model,8)} ${fmt(mid,6)} ${fmt(b.yes_ask,8)} ${fmt(b.no_ask,8)} ${fmt(evY,9)} ${fmt(evN,8)} ${Number(b.vol || 0).toFixed(0).padStart(8)}`);
    if (evY != null && evY > 0.02 && b.yes_ask < 0.95) allBets.push({ city: city.name, bucket: b.sub, side: "YES", price: b.yes_ask, p: p_model, ev: evY, vol: b.vol });
    if (evN != null && evN > 0.02 && b.no_ask < 0.95)  allBets.push({ city: city.name, bucket: b.sub, side: "NO",  price: b.no_ask,  p: 1-p_model, ev: evN, vol: b.vol });
  }
}

allBets.sort((a, b) => b.ev - a.ev);
console.log(`\n\n=== TOP 15 BETS BY EV (per $1 staked) ===\n`);
console.log(`  ${'#'.padStart(2)} ${'city'.padEnd(20)} ${'bucket'.padEnd(14)} ${'side'.padEnd(4)} ${'price'.padStart(6)} ${'p_model'.padStart(8)} ${'EV/$'.padStart(7)} ${'vol'.padStart(8)}`);
for (let i = 0; i < Math.min(15, allBets.length); i++) {
  const b = allBets[i];
  const bucketStr = (b.bucket || "?").padEnd(14);
  console.log(`  ${(i+1).toString().padStart(2)} ${b.city.padEnd(20)} ${bucketStr} ${b.side.padEnd(4)} ${b.price.toFixed(2).padStart(6)} ${b.p.toFixed(3).padStart(8)} ${b.ev.toFixed(3).padStart(7)} ${Number(b.vol || 0).toFixed(0).padStart(8)}`);
}
