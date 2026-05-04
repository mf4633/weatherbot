// Apples-to-apples bot vs NWS logger.
//
// At each city's local 05:00, capture both the bot's HIGH/LOW prediction and the
// NWS-only HIGH/LOW forecast for today. Sunrise = neither model has the benefit
// of intra-day observations (maxSoFar/minSoFar are still small).
//
// At each city's local 07:00 next day, fetch the CLI<station> product, parse
// MAXIMUM and MINIMUM, compute residuals for both models.
//
// Storage: getStore("compare"), key `<cli>/<localDate>.json`.
// Aggregation: see /api/compare.

import { getStore } from "@netlify/blobs";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const UA = "weatherbot-compare-logger";
const CAPTURE_HOUR = 5;
const SETTLE_HOUR = 7;

function localDateParts(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const hourStr = p.hour === "24" ? "0" : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: parseInt(hourStr, 10)
  };
}
function priorLocalDate(tz, date = new Date()) {
  const yesterday = new Date(date.getTime() - 24 * 3600 * 1000);
  return localDateParts(tz, yesterday).date;
}

async function fetchInternal(path) {
  const auth = "Basic " + btoa("internal:hydro");
  const r = await fetch(`${SITE_BASE}${path}`, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return await r.json();
}

async function fetchCLIYesterday(cli) {
  const url = `https://forecast.weather.gov/product.php?site=NWS&product=CLI&issuedby=${cli}&format=txt&version=1&glossary=0`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const html = await r.text();
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!pre) return null;
  const text = pre[1];
  const isPartial = /VALID\s+(AS\s+OF|TODAY|THROUGH)/i.test(text);
  if (isPartial) return { isPartial: true, maxF: null, minF: null };
  const maxM = text.match(/^\s*MAXIMUM\s+(-?\d+)/im);
  const minM = text.match(/^\s*MINIMUM\s+(-?\d+)/im);
  return {
    isPartial: false,
    maxF: maxM ? parseInt(maxM[1], 10) : null,
    minF: minM ? parseInt(minM[1], 10) : null
  };
}

export default async () => {
  const now = new Date();
  const compareStore = getStore("compare");

  let weatherData;
  try { weatherData = await fetchInternal("/api/weather"); }
  catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  const captures = [];
  const reconciliations = [];

  for (const city of weatherData.cities || []) {
    if (city.error) continue;
    const tz = city.tz;
    const { date: localDate, hour: localHr } = localDateParts(tz, now);

    if (localHr === CAPTURE_HOUR) {
      const key = `${city.cli}/${localDate}.json`;
      const existing = await compareStore.get(key, { type: "json" }).catch(() => null);
      if (!existing) {
        await compareStore.setJSON(key, {
          cli: city.cli, name: city.name, station: city.station,
          localDate,
          capturedAtUTC: now.toISOString(),
          captureHourLocal: localHr,
          bot_high: city.mean,
          bot_high_std: city.std,
          bot_low: city.lowMean,
          bot_low_std: city.lowStd,
          nws_high: city.nwsHighF,
          nws_low: city.nwsLowF,
          currentTemp_at_capture: city.currentTemp,
          maxSoFar_at_capture: city.maxSoFar,
          minSoFar_at_capture: city.minSoFar,
          actual_high: null, actual_low: null,
          settled: false
        });
        captures.push(`${city.cli}:${localDate} bot_h=${city.mean} nws_h=${city.nwsHighF} bot_l=${city.lowMean} nws_l=${city.nwsLowF}`);
      }
    }

    if (localHr === SETTLE_HOUR) {
      const yDate = priorLocalDate(tz, now);
      const yKey = `${city.cli}/${yDate}.json`;
      const stored = await compareStore.get(yKey, { type: "json" }).catch(() => null);
      if (stored && !stored.settled) {
        const cli = await fetchCLIYesterday(city.cli);
        if (cli && !cli.isPartial && (cli.maxF != null || cli.minF != null)) {
          const updated = { ...stored, settled: true, settledAtUTC: now.toISOString(),
            actual_high: cli.maxF, actual_low: cli.minF };
          if (cli.maxF != null) {
            if (stored.bot_high != null) updated.bot_high_resid = stored.bot_high - cli.maxF;
            if (stored.nws_high != null) updated.nws_high_resid = stored.nws_high - cli.maxF;
          }
          if (cli.minF != null) {
            if (stored.bot_low != null) updated.bot_low_resid = stored.bot_low - cli.minF;
            if (stored.nws_low != null) updated.nws_low_resid = stored.nws_low - cli.minF;
          }
          await compareStore.setJSON(yKey, updated);
          reconciliations.push(
            `${city.cli}:${yDate} actual=${cli.maxF}/${cli.minF} ` +
            `bot_h=${updated.bot_high_resid?.toFixed(2)} nws_h=${updated.nws_high_resid?.toFixed(2)} ` +
            `bot_l=${updated.bot_low_resid?.toFixed(2)} nws_l=${updated.nws_low_resid?.toFixed(2)}`
          );
        }
      }
    }
  }

  return new Response(JSON.stringify({
    ok: true, ranAtUTC: now.toISOString(),
    captures, reconciliations
  }), { headers: { "content-type": "application/json" } });
};

export const config = { path: "/api/compare_log" };
