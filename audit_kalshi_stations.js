// Audit: do the Kalshi market settlement stations match the bot's CITIES config?
//
// For each city the bot trades, fetches a current Kalshi event and prints
// the market's rules_primary / settlement_source so we can verify the
// resolution station matches what `cli` and `station` are set to in
// netlify/functions/weather.js.
//
// Read-only — does not modify anything.
//
// Usage:
//   node audit_kalshi_stations.js

import https from "https";

// Mirror of CITIES from weather.js (subset of fields we need to compare against)
const CITIES = {
  "New York":          { cli: "NYC", station: "KNYC", tz: "America/New_York" },
  "Los Angeles":       { cli: "LAX", station: "KLAX", tz: "America/Los_Angeles" },
  "Chicago":           { cli: "MDW", station: "KMDW", tz: "America/Chicago" },
  "Houston":           { cli: "HOU", station: "KHOU", tz: "America/Chicago" },
  "Phoenix":           { cli: "PHX", station: "KPHX", tz: "America/Phoenix" },
  "Philadelphia":      { cli: "PHL", station: "KPHL", tz: "America/New_York" },
  "San Antonio":       { cli: "SAT", station: "KSAT", tz: "America/Chicago" },
  "Dallas-Fort Worth": { cli: "DFW", station: "KDFW", tz: "America/Chicago" },
  "Austin":            { cli: "AUS", station: "KAUS", tz: "America/Chicago" },
  "Seattle":           { cli: "SEA", station: "KSEA", tz: "America/Los_Angeles" },
  "Denver":            { cli: "DEN", station: "KDEN", tz: "America/Denver" },
  "Washington DC":     { cli: "DCA", station: "KDCA", tz: "America/New_York" },
  "Boston":            { cli: "BOS", station: "KBOS", tz: "America/New_York" },
};

// Mirror of CITY_TO_KALSHI from kalshi.js (the bot's mapping of city -> Kalshi series)
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
  "Washington DC":     { high: "KXHIGHTDC",  low: null          },
  "Boston":            { high: "KXHIGHTBOS", low: "KXLOWTBOS"   },
};

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function kalshiDateSuffix(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "2-digit", month: "short", day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}${parts.month.toUpperCase()}${parts.day}`;
}

// Try to find a station code in the resolution rules text
function extractStationHints(text) {
  if (!text) return [];
  const hints = new Set();
  // Match KXXX-style station codes
  const codes = text.match(/\bK[A-Z]{3}\b/g) || [];
  for (const c of codes) hints.add(c);
  // Match CLI<XXX> climate report references
  const cliRefs = text.match(/\bCLI[A-Z]{3}\b/gi) || [];
  for (const c of cliRefs) hints.add(c.toUpperCase());
  // Match "International Airport" / specific airport names
  const airports = text.match(/(LaGuardia|JFK|Newark|Central Park|O'?Hare|Midway|Hobby|Intercontinental|Bush|Reagan|Dulles|BWI|Sky Harbor|Logan|Sea-?Tac|Stapleton|DIA)/gi) || [];
  for (const a of airports) hints.add(a);
  // Match "Love Field" specifically (Dallas)
  if (/love field/i.test(text)) hints.add("Love Field");
  if (/dfw/i.test(text)) hints.add("DFW");
  return Array.from(hints);
}

async function getMarketInfo(eventTicker, dateSuffix) {
  // Walk forward up to 14 days to find an active market for this series.
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const d = new Date(Date.now() + dayOffset * 24 * 3600 * 1000);
    const suffix = kalshiDateSuffix(d, "America/New_York");
    const url = `https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=${eventTicker}-${suffix}&limit=1`;
    try {
      const text = await fetchUrl(url);
      const j = JSON.parse(text);
      if (j.markets && j.markets.length > 0) {
        return { market: j.markets[0], dateUsed: suffix };
      }
    } catch (e) { /* try next day */ }
  }
  return null;
}

async function main() {
  console.log("Audit: Kalshi market resolution station vs bot's CITIES config");
  console.log("=".repeat(80));

  for (const [cityName, kalshi] of Object.entries(CITY_TO_KALSHI)) {
    const city = CITIES[cityName];
    if (!kalshi.high) continue;

    const info = await getMarketInfo(kalshi.high);
    console.log("");
    console.log(`-- ${cityName} (bot uses CLI=${city.cli}, station=${city.station}) --`);
    console.log(`   Kalshi event series: ${kalshi.high}`);
    if (!info) {
      console.log(`   ⚠️  No active market found (next 3 days)`);
      continue;
    }
    const m = info.market;
    console.log(`   Sample market: ${m.ticker}`);
    console.log(`   Title: ${m.title}`);
    if (m.subtitle) console.log(`   Subtitle: ${m.subtitle}`);

    // The settlement criteria is in `rules_primary` (sometimes also `rules_secondary` and `settlement_sources`)
    const rules = m.rules_primary || "";
    const sources = m.settlement_sources || [];

    // Extract station hints from rules and sources
    const ruleHints = extractStationHints(rules);
    const sourceHints = sources.flatMap(s =>
      extractStationHints(s.name || "") .concat(extractStationHints(s.url || ""))
    );
    const allHints = [...new Set([...ruleHints, ...sourceHints])];

    if (rules) {
      console.log(`   Rules: ${rules}`);
    }
    if (m.rules_secondary) {
      console.log(`   Rules (secondary): ${m.rules_secondary}`);
    }
    if (sources.length) {
      for (const s of sources) console.log(`   Source: ${s.name || ""}  url=${s.url || ""}  agent=${s.agent || ""}`);
    }
    if (allHints.length) {
      console.log(`   Station hints from market spec: ${allHints.join(", ")}`);
    }

    // Verdict
    const matchesCli = allHints.includes(city.cli) || allHints.some(h => h.includes(city.cli));
    const matchesStation = allHints.includes(city.station);
    if (allHints.length === 0) {
      console.log(`   ❓  No station hints found in market spec — manual review needed`);
    } else if (matchesCli || matchesStation) {
      console.log(`   ✅  Bot's ${city.station}/${city.cli} appears in market spec — likely match`);
    } else {
      console.log(`   ⚠️  Bot's ${city.station}/${city.cli} does NOT appear in market spec — possible mismatch`);
    }
  }

  console.log("");
  console.log("=".repeat(80));
  console.log("Manual verification: open https://kalshi.com/markets/<ticker> for any flagged item.");
  console.log("Look for the resolution criteria sentence; it names the airport/station explicitly.");
}

main().catch(e => { console.error(e); process.exit(1); });
