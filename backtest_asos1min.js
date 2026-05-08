// Backtest: how much earlier does 1-min ASOS see the day's max temp
// vs the existing RMK 6-hour-extremes pipeline?
//
// Method:
//   For each (city, day) in a 30-day window:
//     1. Pull 1-min ASOS tmpf data from IEM
//     2. Compute the day's true max temp and the timestamp it occurred at (1-min resolution)
//     3. Compute when each method first "knew" maxSoFar reached the true max:
//          A. 1-min ASOS: instant (at peak timestamp)
//          B. RMK 6-hr group: at the next synoptic hour (00/06/12/18 UTC) AFTER the peak
//          C. Hourly T-group: at the :51 METAR observation AT or AFTER the peak
//     4. Also compute maxSoFar at typical Kalshi bet times (16:00, 18:00 local)
//        under each method.
//
// Output: median/mean lag (in minutes) for each method, and the typical
// 4 PM / 6 PM gap between 1-min vs RMK maxSoFar.

import https from "https";

const CITIES = [
  { sid: "NYC", tz: "America/New_York" },              // Central Park
  { sid: "LAX", tz: "America/Los_Angeles" },           // LAX
  { sid: "MDW", tz: "America/Chicago" },               // Chicago Midway
  { sid: "HOU", tz: "America/Chicago" },               // Houston Hobby
  { sid: "PHX", tz: "America/Phoenix" },               // Phoenix Sky Harbor
  { sid: "PHL", tz: "America/New_York" },              // Philadelphia
  { sid: "SAT", tz: "America/Chicago" },               // San Antonio
  { sid: "SAN", tz: "America/Los_Angeles" },           // San Diego
  { sid: "DFW", tz: "America/Chicago" },               // Dallas-FW
  { sid: "JAX", tz: "America/New_York" },              // Jacksonville
  { sid: "AUS", tz: "America/Chicago" },               // Austin-Bergstrom
  { sid: "TPA", tz: "America/New_York" },              // Tampa
  { sid: "SJC", tz: "America/Los_Angeles" },           // San Jose
  { sid: "CMH", tz: "America/New_York" },              // Columbus
  { sid: "CLT", tz: "America/New_York" },              // Charlotte
  { sid: "IND", tz: "America/Indiana/Indianapolis" },  // Indianapolis
  { sid: "SEA", tz: "America/Los_Angeles" },           // Seattle
  { sid: "DEN", tz: "America/Denver" },                // Denver
  { sid: "DCA", tz: "America/New_York" },              // Washington DC
  { sid: "BOS", tz: "America/New_York" },              // Boston
];

// Pull a 30-day window from IEM (1-min archive lags 3-5 days)
const START = new Date(Date.UTC(2026, 3, 1));   // April 1, 2026 UTC
const END   = new Date(Date.UTC(2026, 4, 1));   // May 1, 2026 UTC

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

async function fetch1Min(sid, start, end) {
  const params = new URLSearchParams({
    station: sid, tz: "Etc/UTC",
    year1: start.getUTCFullYear(), month1: start.getUTCMonth() + 1, day1: start.getUTCDate(),
    hour1: 0, minute1: 0,
    year2: end.getUTCFullYear(), month2: end.getUTCMonth() + 1, day2: end.getUTCDate(),
    hour2: 23, minute2: 59,
    vars: "tmpf", what: "download", delim: "comma",
  });
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos1min.py?${params}`;
  return fetchUrl(url);
}

function parseCSV(csvText) {
  const lines = csvText.split(/\r?\n/);
  const out = [];
  // Header: station,station_name,valid(Etc/UTC),tmpf
  let started = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!started) { if (line.toLowerCase().startsWith("station")) started = true; continue; }
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const tmpf = parseFloat(parts[3]);
    if (!isFinite(tmpf)) continue;
    // valid(Etc/UTC) format: 2026-04-01 00:00
    const m = parts[2].match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
    if (!m) continue;
    const ts = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    out.push({ ts, tmpf });
  }
  return out;
}

// For a given local-day in a tz, find UTC midnight bounds.
function localDayBoundsUTC(localYear, localMonth, localDay, tzName) {
  // Approximate: pick noon local, find UTC offset, derive midnight bounds.
  const noonLocal = new Date(Date.UTC(localYear, localMonth - 1, localDay, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(noonLocal).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  const localHour = parseInt(parts.hour, 10);
  const offsetHrs = 12 - localHour;
  const localMidnightUTC = new Date(Date.UTC(localYear, localMonth - 1, localDay, offsetHrs, 0, 0));
  const nextMidnightUTC = new Date(localMidnightUTC.getTime() + 24 * 3600 * 1000);
  return { localMidnightUTC, nextMidnightUTC };
}

// Get the local hour from a UTC date in the given tz.
function localHourMin(utcDate, tzName) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName, hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(utcDate).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  return { h: parseInt(parts.hour, 10) % 24, m: parseInt(parts.minute, 10) };
}

// Find the next synoptic hour (00, 06, 12, 18 UTC) >= ts.
function nextSynopticUTC(ts) {
  const next = new Date(ts);
  next.setUTCMinutes(0, 0, 0);
  while (![0, 6, 12, 18].includes(next.getUTCHours()) || next < ts) {
    next.setUTCHours(next.getUTCHours() + 1);
  }
  return next;
}

// Find the next METAR :51 timestamp >= ts.
function nextMetarFiftyOneUTC(ts) {
  const next = new Date(ts);
  if (next.getUTCMinutes() <= 51) {
    next.setUTCMinutes(51, 0, 0);
  } else {
    next.setUTCHours(next.getUTCHours() + 1, 51, 0, 0);
  }
  return next;
}

async function main() {
  console.log(`Backtest window: ${START.toISOString().slice(0,10)} to ${END.toISOString().slice(0,10)} UTC`);
  console.log(`Cities: ${CITIES.map(c => c.sid).join(", ")}`);
  console.log("");

  const results = []; // per city-day rows

  for (const city of CITIES) {
    console.log(`Fetching 1-min data for K${city.sid}...`);
    const csv = await fetch1Min(city.sid, START, END);
    const obs = parseCSV(csv);
    console.log(`  got ${obs.length} 1-min rows`);

    // Determine local-date list. We iterate days in the local tz.
    // The 1-min data covers START..END UTC. For local days we want full local 24hr coverage.
    // For each local day: localMidnight to nextMidnight (in UTC), find peak.
    const dayPeaks = new Map(); // dateStr (local) -> { peakTs, peakF, midnightUTC, nextMidnightUTC }

    for (const o of obs) {
      const localDateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: city.tz, year: "numeric", month: "2-digit", day: "2-digit",
      }).format(o.ts);
      let entry = dayPeaks.get(localDateStr);
      if (!entry) {
        const [Y, M, D] = localDateStr.split("-").map(Number);
        const { localMidnightUTC, nextMidnightUTC } = localDayBoundsUTC(Y, M, D, city.tz);
        entry = { peakTs: o.ts, peakF: o.tmpf, midnightUTC: localMidnightUTC, nextMidnightUTC };
        dayPeaks.set(localDateStr, entry);
      } else if (o.tmpf > entry.peakF) {
        entry.peakF = o.tmpf;
        entry.peakTs = o.ts;
      }
    }

    for (const [localDateStr, peak] of dayPeaks) {
      const synopticDelivery = nextSynopticUTC(peak.peakTs);
      const metarDelivery = nextMetarFiftyOneUTC(peak.peakTs);
      const synLagMin = (synopticDelivery - peak.peakTs) / 60000;
      const metarLagMin = (metarDelivery - peak.peakTs) / 60000;

      // Also compute maxSoFar at 16:00 local under each method:
      //   - 1-min: max of obs[ts <= 16:00 local]
      //   - METAR T-group: max of obs sampled at :51 past hour, ts <= 16:00 local
      //   - RMK 6-hr: max of obs sampled at :51 BUT updated only after a synoptic hour
      const targetLocalHours = [12, 14, 16, 18];
      const at = {};
      for (const lh of targetLocalHours) {
        const target = new Date(peak.midnightUTC.getTime() + lh * 3600 * 1000);
        const cutoff = target;
        // 1-min max so far:
        let max1 = -Infinity;
        for (const o of obs) {
          if (o.ts < peak.midnightUTC) continue;
          if (o.ts > cutoff) break;
          if (o.tmpf > max1) max1 = o.tmpf;
        }
        // T-group max so far: METARs at :51 past hour up to cutoff
        let maxT = -Infinity;
        for (const o of obs) {
          if (o.ts < peak.midnightUTC) continue;
          if (o.ts > cutoff) break;
          const m = o.ts.getUTCMinutes();
          if (m === 51) {
            if (o.tmpf > maxT) maxT = o.tmpf;
          }
        }
        // RMK group max: at synoptic hours 00,06,12,18 UTC, the bot would learn the 6-hr max
        // before that synoptic hour.
        let maxR = -Infinity;
        // Find the most recent synoptic hour <= cutoff that's >= midnight.
        const synopticHours = [];
        for (let s = peak.midnightUTC.getTime(); s <= cutoff.getTime(); s += 3600 * 1000) {
          const t = new Date(s);
          if ([0, 6, 12, 18].includes(t.getUTCHours()) && t.getUTCMinutes() === 0) {
            synopticHours.push(t);
          }
        }
        for (const sh of synopticHours) {
          // 6-hr max ending at sh
          const winStart = new Date(sh.getTime() - 6 * 3600 * 1000);
          if (winStart < peak.midnightUTC) continue; // window must be inside today
          for (const o of obs) {
            if (o.ts <= winStart) continue;
            if (o.ts > sh) break;
            if (o.tmpf > maxR) maxR = o.tmpf;
          }
        }
        // Combined T-group + RMK is what the bot actually does
        const maxCurrent = Math.max(maxT, maxR);
        at[`local${lh}`] = { oneMin: max1, current: maxCurrent };
      }

      results.push({
        city: city.sid, date: localDateStr,
        peakF: peak.peakF, peakTs: peak.peakTs.toISOString(),
        synLagMin, metarLagMin, at,
      });
    }
  }

  // Summary
  console.log("");
  console.log("============== RESULTS ==============");
  console.log(`Total city-days: ${results.length}`);
  console.log("");

  // Distribution of synoptic lag
  const synLags = results.map(r => r.synLagMin).sort((a, b) => a - b);
  const metarLags = results.map(r => r.metarLagMin).sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.floor(arr.length * p)];
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  console.log("Lag from peak occurrence to when each method delivers it (minutes):");
  console.log(`  Synoptic RMK:  median ${pct(synLags, 0.5).toFixed(0)},  mean ${mean(synLags).toFixed(0)},  p25 ${pct(synLags, 0.25).toFixed(0)},  p75 ${pct(synLags, 0.75).toFixed(0)}`);
  console.log(`  Hourly METAR:  median ${pct(metarLags, 0.5).toFixed(0)},  mean ${mean(metarLags).toFixed(0)},  p25 ${pct(metarLags, 0.25).toFixed(0)},  p75 ${pct(metarLags, 0.75).toFixed(0)}`);
  console.log("");

  // For each target local hour, compute mean (1min - current) gap
  console.log("Mean (1-min maxSoFar - current-method maxSoFar), in °F, at each local hour:");
  console.log("(positive = 1-min sees a higher maxSoFar = bot would benefit)");
  for (const lh of [12, 14, 16, 18]) {
    const diffs = results.map(r => {
      const a = r.at[`local${lh}`];
      if (!a) return null;
      if (!isFinite(a.oneMin) || !isFinite(a.current)) return null;
      return a.oneMin - a.current;
    }).filter(d => d != null).sort((a, b) => a - b);
    if (!diffs.length) continue;
    const big = diffs.filter(d => d >= 1.0).length;
    const med = diffs.filter(d => d >= 0.5).length;
    console.log(`  local ${String(lh).padStart(2,"0")}:00  n=${diffs.length}  median=${pct(diffs, 0.5).toFixed(2)}°F  mean=${mean(diffs).toFixed(2)}°F  max=${diffs[diffs.length-1].toFixed(1)}°F  | ≥0.5°F gap: ${med}  | ≥1.0°F gap: ${big}`);
  }

  // Per-city breakdown: mean gap at 16:00 local (peak-window indicator)
  console.log("");
  console.log("Per-city breakdown — mean (1min - current) maxSoFar gap at 16:00 local:");
  console.log("city  | n   | mean   | median | max    | days≥1°F");
  console.log("------|-----|--------|--------|--------|--------");
  const byCity = new Map();
  for (const r of results) {
    if (!byCity.has(r.city)) byCity.set(r.city, []);
    byCity.get(r.city).push(r);
  }
  const citySummaries = [];
  for (const [c, rows] of byCity) {
    const diffs = rows.map(r => {
      const a = r.at["local16"];
      if (!a || !isFinite(a.oneMin) || !isFinite(a.current)) return null;
      return a.oneMin - a.current;
    }).filter(d => d != null);
    if (!diffs.length) continue;
    diffs.sort((a, b) => a - b);
    citySummaries.push({
      city: c, n: diffs.length,
      mean: mean(diffs),
      median: pct(diffs, 0.5),
      max: diffs[diffs.length - 1],
      bigDays: diffs.filter(d => d >= 1.0).length,
    });
  }
  citySummaries.sort((a, b) => b.mean - a.mean);
  for (const s of citySummaries) {
    console.log(`  ${s.city}  | ${String(s.n).padStart(3)} | ${s.mean.toFixed(2).padStart(6)} | ${s.median.toFixed(2).padStart(6)} | ${s.max.toFixed(1).padStart(6)} | ${String(s.bigDays).padStart(4)}/${s.n}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
