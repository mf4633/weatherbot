// Head-to-head bot vs NWS RMSE on settled comparison records.
//
// Reads getStore("compare") records written by compare_log.js, computes RMSE for
// HIGH and LOW separately, both global and per-city. Reports the bot's lift over
// NWS as a percentage.

import { getStore } from "@netlify/blobs";

function rmse(arr) {
  if (!arr.length) return null;
  return Math.sqrt(arr.reduce((s, e) => s + e * e, 0) / arr.length);
}
function mae(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, e) => s + Math.abs(e), 0) / arr.length;
}
function bias(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, e) => s + e, 0) / arr.length;
}
function stat(records, key) {
  const errs = records.map(r => r[key]).filter(e => e != null && !isNaN(e));
  const r = rmse(errs);
  const m = mae(errs);
  const b = bias(errs);
  return {
    n: errs.length,
    rmse: r != null ? Math.round(r * 100) / 100 : null,
    mae: m != null ? Math.round(m * 100) / 100 : null,
    bias: b != null ? Math.round(b * 100) / 100 : null
  };
}

export default async () => {
  const store = getStore("compare");
  const { blobs } = await store.list();
  const records = (await Promise.all(
    blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null))
  )).filter(r => r && r.settled);

  // Pair-wise stats: only count days where BOTH bot and NWS had a prediction
  // (so RMSEs are computed on the exact same set of (city, date) pairs).
  const pairedHigh = records.filter(r => r.bot_high_resid != null && r.nws_high_resid != null);
  const pairedLow = records.filter(r => r.bot_low_resid != null && r.nws_low_resid != null);

  const high = {
    bot: stat(pairedHigh, "bot_high_resid"),
    nws: stat(pairedHigh, "nws_high_resid")
  };
  const low = {
    bot: stat(pairedLow, "bot_low_resid"),
    nws: stat(pairedLow, "nws_low_resid")
  };

  function lift(botRmse, nwsRmse) {
    if (botRmse == null || nwsRmse == null || nwsRmse === 0) return null;
    return Math.round((nwsRmse - botRmse) / nwsRmse * 1000) / 10;  // % to 1 decimal
  }
  high.botLiftPct = lift(high.bot.rmse, high.nws.rmse);
  low.botLiftPct = lift(low.bot.rmse, low.nws.rmse);

  // Per-city breakdown.
  const byCity = {};
  for (const r of records) {
    (byCity[r.cli] ??= { name: r.name, records: [] }).records.push(r);
  }
  const perCity = Object.entries(byCity).map(([cli, { name, records: rs }]) => {
    const ph = rs.filter(r => r.bot_high_resid != null && r.nws_high_resid != null);
    const pl = rs.filter(r => r.bot_low_resid != null && r.nws_low_resid != null);
    return {
      cli, name,
      high: {
        n: ph.length,
        bot_rmse: stat(ph, "bot_high_resid").rmse,
        nws_rmse: stat(ph, "nws_high_resid").rmse,
        liftPct: lift(stat(ph, "bot_high_resid").rmse, stat(ph, "nws_high_resid").rmse)
      },
      low: {
        n: pl.length,
        bot_rmse: stat(pl, "bot_low_resid").rmse,
        nws_rmse: stat(pl, "nws_low_resid").rmse,
        liftPct: lift(stat(pl, "bot_low_resid").rmse, stat(pl, "nws_low_resid").rmse)
      }
    };
  }).sort((a, b) => (b.high.n + b.low.n) - (a.high.n + a.low.n));

  return new Response(JSON.stringify({
    n_settled: records.length,
    captureHourLocal: records[0]?.captureHourLocal ?? 5,
    high, low, perCity,
    records: records.sort((a, b) => (a.localDate < b.localDate ? 1 : -1))
  }, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=120" }
  });
};

export const config = { path: "/api/compare" };
