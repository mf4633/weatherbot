// Production residual logger — runs hourly via Netlify scheduled function.
//
// At each city's local 15:00 (peak heating): captures the current /api/weather prediction
// for that city, stores it under predictions/<cli>/<localDate>.json.
//
// At each city's local 07:00 (after morning CLI is typically issued): fetches the city's
// latest CLI<station> product, parses yesterday's MAXIMUM, looks up yesterday's stored
// prediction, computes the residual (predicted - actual), and stores under
// residuals/<cli>/<localDate>.json. Skips if reconciliation already done.
//
// All idempotent on date keys.

import { getStore } from "@netlify/blobs";

const SITE_BASE = "https://weatherbot-mf.netlify.app";
const UA = "weatherbot-logger";

function localDateParts(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const hourStr = p.hour === "24" ? "0" : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: parseInt(hourStr, 10),
    minute: parseInt(p.minute, 10)
  };
}

function priorLocalDate(tz, date = new Date()) {
  const yesterday = new Date(date.getTime() - 24 * 3600 * 1000);
  return localDateParts(tz, yesterday).date;
}

async function fetchAllPredictions() {
  const r = await fetch(`${SITE_BASE}/api/weather`);
  if (!r.ok) throw new Error(`weather API ${r.status}`);
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
  // Match "MAXIMUM   N" — the OBSERVED value column (first integer after MAXIMUM).
  const m = text.match(/^\s*MAXIMUM\s+(-?\d+)/im);
  const maxF = m ? parseInt(m[1], 10) : null;
  // Date label.
  const forMatch = text.match(/CLIMATE\s+SUMMARY\s+FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})/i);
  const isPartial = /VALID\s+(AS\s+OF|TODAY|THROUGH)/i.test(text);
  return { maxF, isPartial, dateLabel: forMatch ? `${forMatch[1]} ${forMatch[2]} ${forMatch[3]}` : null };
}

export default async () => {
  const now = new Date();
  const predStore = getStore("predictions");
  const residStore = getStore("residuals");

  let weatherData;
  try {
    weatherData = await fetchAllPredictions();
  } catch (e) {
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

    // Capture window: peak hour ±0.5 (so an hourly cron triggers exactly once per day).
    if (localHr === 15) {
      const key = `${city.cli}/${localDate}.json`;
      const existing = await predStore.get(key, { type: "json" }).catch(() => null);
      if (!existing) {
        const record = {
          cli: city.cli, station: city.station, name: city.name,
          localDate, capturedAtUTC: now.toISOString(),
          mean: city.mean, std: city.std, ci68: city.ci68, ci95: city.ci95,
          maxSoFar: city.maxSoFar, currentTemp: city.currentTemp,
          forecastHighF: city.forecastHighF, biasF: city.biasF,
          method: city.method
        };
        await predStore.setJSON(key, record);
        captures.push(`${city.cli}:${localDate}`);
      }
    }

    // Reconciliation window: morning, when yesterday's CLI should be out.
    if (localHr === 7) {
      const yDate = priorLocalDate(tz, now);
      const yKey = `${city.cli}/${yDate}.json`;
      const residKey = `${city.cli}/${yDate}.json`;
      const alreadyDone = await residStore.get(residKey, { type: "json" }).catch(() => null);
      if (alreadyDone) continue;
      const stored = await predStore.get(yKey, { type: "json" }).catch(() => null);
      if (!stored) continue;
      const cli = await fetchCLIYesterday(city.cli);
      if (!cli || cli.maxF == null || cli.isPartial) continue;
      const residual = stored.mean - cli.maxF;  // positive = predicted too warm
      const record = {
        cli: city.cli, name: city.name, localDate: yDate,
        predicted: stored.mean, actual: cli.maxF, residual,
        std: stored.std, withinCI68: Math.abs(residual) <= stored.std,
        withinCI95: Math.abs(residual) <= 1.96 * stored.std,
        cliDateLabel: cli.dateLabel,
        capturedAtUTC: stored.capturedAtUTC,
        reconciledAtUTC: now.toISOString()
      };
      await residStore.setJSON(residKey, record);
      reconciliations.push(`${city.cli}:${yDate} pred=${stored.mean} actual=${cli.maxF} resid=${residual.toFixed(2)}`);
    }
  }

  return new Response(JSON.stringify({
    ok: true, ranAtUTC: now.toISOString(),
    captures, reconciliations
  }), { headers: { "content-type": "application/json" } });
};

// Schedule: hourly at minute 5 (offset to give /api/weather a stable cache window).
// Scheduled functions can't have custom paths; access via /.netlify/functions/logger
// or via the redirect in netlify.toml.
export const config = {
  schedule: "5 * * * *"
};
