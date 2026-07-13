// backtest-background.js — historical replay of the Claude analog vs NWS guidance
// vs persistence, scored on CLI truth. Runs on Netlify (15-min background budget;
// IEM is reachable from functions — lib/iem.js already uses it). For each of the
// last ~45 days × 20 Kalshi stations, rebuilds the 72h obs snapshot as of 15Z from
// IEM's METAR archive, runs the pure v3 analog + thin-analog guard, and pairs it
// with the day's 12Z GFS-MOS max-temp guidance (NWS stand-in — the Bayesian itself
// is NWS-anchored and cannot be replayed historically) and yesterday's CLI high
// (persistence). Truth = IEM's CLI archive. Results → blob; read via
// /api/claude?mode=backtest. Idempotent: skips if results are <6 days old
// (?force=1 recomputes). Places no trades.

import { getStore } from "@netlify/blobs";
import { parseAsosTdf, replayStation, aggregate } from "./lib/backtest_core.js";

const UA = "weatherbot.netlify.app (contact: github.com/mf4633)";
const DAYS = 45;

const STATIONS = [
  { station: "KNYC", cli: "NYC", tz: "America/New_York" },
  { station: "KLAX", cli: "LAX", tz: "America/Los_Angeles" },
  { station: "KMIA", cli: "MIA", tz: "America/New_York" },
  { station: "KMDW", cli: "MDW", tz: "America/Chicago" },
  { station: "KBOS", cli: "BOS", tz: "America/New_York" },
  { station: "KSEA", cli: "SEA", tz: "America/Los_Angeles" },
  { station: "KDEN", cli: "DEN", tz: "America/Denver" },
  { station: "KPHL", cli: "PHL", tz: "America/New_York" },
  { station: "KAUS", cli: "AUS", tz: "America/Chicago" },
  { station: "KHOU", cli: "HOU", tz: "America/Chicago" },
  { station: "KSFO", cli: "SFO", tz: "America/Los_Angeles" },
  { station: "KDFW", cli: "DFW", tz: "America/Chicago" },
  { station: "KMSY", cli: "MSY", tz: "America/Chicago" },
  { station: "KLAS", cli: "LAS", tz: "America/Los_Angeles" },
  { station: "KOKC", cli: "OKC", tz: "America/Chicago" },
  { station: "KDCA", cli: "DCA", tz: "America/New_York" },
  { station: "KPHX", cli: "PHX", tz: "America/Phoenix" },
  { station: "KSAT", cli: "SAT", tz: "America/Chicago" },
  { station: "KMSP", cli: "MSP", tz: "America/Chicago" },
  { station: "KATL", cli: "ATL", tz: "America/New_York" },
];

const iso = (d) => d.toISOString().slice(0, 10);
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Polite fetch: IEM rate-limits bursts (we saw 429s on the first run). One retry
// after a 6s pause; callers also space stations out sequentially.
async function getText(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (r.ok) return r.text();
    if (r.status === 429 && attempt === 0) { await sleep(6000); continue; }
    throw new Error(`${r.status} ${url.split("?")[0]}`);
  }
}

async function fetchObs(sid, start, end) {
  const [y1, m1, d1] = iso(start).split("-"), [y2, m2, d2] = iso(end).split("-");
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${sid.replace(/^K/, "")}` +
    `&data=metar&year1=${y1}&month1=${m1}&day1=${d1}&year2=${y2}&month2=${m2}&day2=${d2}` +
    `&tz=Etc%2FUTC&format=tdf&latlon=no&elev=no&missing=M&trace=T&direct=no&report_type=3&report_type=4`;
  return parseAsosTdf(await getText(url));
}

async function fetchCliTruths(cliStation, year) {
  // IEM's documented CLI archive service is /json/cli.py (the /api/1/cli.json guess
  // 404'd on the first run). Returns { results: [{ valid, high, low, ... }] }.
  const url = `https://mesonet.agron.iastate.edu/json/cli.py?station=K${cliStation}&year=${year}`;
  const j = JSON.parse(await getText(url));
  const rows = j.results || j.data || [];
  const byDate = {};
  for (const row of rows) {
    const date = (row.valid || row.date || "").slice(0, 10);
    const hi = row.high ?? row.high_temp ?? null;
    if (date && typeof hi === "number") byDate[date] = hi;
  }
  return byDate;
}

// Best-effort NWS-guidance proxy: 12Z GFS MOS max temp (n_x) for the local afternoon.
// dbg (optional array) collects WHY a station parsed to zero rows — the 2026-07-10
// run returned nws.n=0 across all 20 stations with errors:[] because every parse
// failure here was silent, leaving nothing to diagnose from the cron logs.
// 2026-07-13 diagnostics showed IEM's model=GFS (MAV) rows carry an EMPTY n_x
// field (3864 lines/station, header ok, 0 usable highs) — the max-temp guidance
// in IEM's archive lives in the extended MOS (MEX) and the National Blend (NBS).
// Try those first, keep GFS as a last resort.
async function fetchMosHighs(station, start, end, dbg = null) {
  for (const model of ["MEX", "NBS", "GFS"]) {
    const got = await fetchMosHighsModel(station, model, start, end, dbg).catch(() => ({}));
    if (Object.keys(got).length) return got;
  }
  return {};
}

async function fetchMosHighsModel(station, model, start, end, dbg = null) {
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=${station}&model=${model}` +
    `&sts=${iso(start)}T00:00Z&ets=${iso(end)}T23:00Z&format=csv`;
  const text = await getText(url);
  const lines = text.split("\n").filter(Boolean);
  const unq = (s) => (s || "").replace(/"/g, "").trim();
  const header = (lines[0] || "").split(",").map(s => unq(s).toLowerCase());
  const iRun = header.indexOf("runtime"), iFt = header.indexOf("ftime"), iNx = header.indexOf("n_x");
  if (iRun < 0 || iFt < 0 || iNx < 0) {
    if (dbg) dbg.push(`${station}/${model}: MOS header unrecognized (${lines.length} lines): ${(lines[0] || "(empty)").slice(0, 150)}`);
    return {};
  }
  const byDate = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const run = unq(cols[iRun]), ft = unq(cols[iFt]), nx = parseFloat(unq(cols[iNx]));
    if (!Number.isFinite(nx) || !/12:00/.test(run)) continue;   // 12Z runs only
    const date = run.slice(0, 10);
    const t = new Date(ft.replace(" ", "T") + (ft.endsWith("Z") ? "" : "Z"));
    const lo = new Date(`${date}T18:00:00Z`), hi = new Date(`${date}T18:00:00Z`); hi.setUTCHours(hi.getUTCHours() + 16);
    if (isNaN(t) || t < lo || t > hi) continue;         // afternoon/evening window only
    if (byDate[date] == null || nx > byDate[date]) byDate[date] = nx;
  }
  if (dbg && !Object.keys(byDate).length) {
    // show a row that actually HAS an n_x value if any exists — the GFS/MAV case
    // was every row's n_x being empty, which a random sample line can't reveal.
    const withNx = lines.slice(1).find(l => (l.split(",")[iNx] || "").trim() !== "");
    dbg.push(`${station}/${model}: MOS parsed 0 highs from ${lines.length - 1} lines; ` +
             (withNx ? `n_x row sample: ${withNx.slice(0, 150)}` : `n_x EMPTY in all rows`));
  }
  return byDate;
}

export default async (req) => {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const store = getStore("claude_scoreboard");
  const existing = await store.get("backtest/results.json", { type: "json" }).catch(() => null);
  // A 0-row result is a failed run, not a result — never let it block a recompute.
  // A result with NO NWS/MOS comparison (nws.n=0, like the 2026-07-10 run) is
  // incomplete: keep it for reading but retry in 6h instead of sitting for 6 days.
  const ttlMs = existing?.overall?.nws?.n > 0 ? 6 * 86400e3 : 6 * 3600e3;
  if (existing && (existing.totalRows || 0) > 0 && !force &&
      Date.now() - new Date(existing.ranAt).getTime() < ttlMs) {
    console.log("[backtest] fresh results exist — skipping (force=1 to recompute)");
    return new Response("ok");
  }
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);        // through yesterday
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - DAYS);
  const results = { ranAt: new Date().toISOString(), params: { days: DAYS, decisionHourUTC: 15, start: iso(start), end: iso(end) },
                    stations: {}, overall: null, errors: [] };
  const allRows = [];
  for (const s of STATIONS) {
    try {
      // Sequential, spaced fetches — parallel bursts got 429'd by IEM on run #1.
      const obs = await fetchObs(s.station, start, end);
      await sleep(1200);
      const truths = await fetchCliTruths(s.cli, end.getUTCFullYear());
      await sleep(1200);
      const mos = await fetchMosHighs(s.station, start, end, results.errors)
        .catch(e => { results.errors.push(`${s.station}: MOS fetch ${String(e?.message || e)}`); return {}; });
      await sleep(1200);
      // keep truths inside the window
      const truthByDate = Object.fromEntries(Object.entries(truths).filter(([d]) => d >= iso(start) && d <= iso(end)));
      const rows = replayStation({ station: s.station, tz: s.tz, obs, truthByDate, nwsByDate: mos });
      allRows.push(...rows);
      results.stations[s.station] = { rows: rows.length, ...aggregate(rows) };
      console.log(`[backtest] ${s.station}: ${rows.length} days replayed`);
    } catch (e) {
      results.errors.push(`${s.station}: ${String(e?.message || e)}`);
    }
  }
  results.overall = aggregate(allRows);
  results.totalRows = allRows.length;
  await store.setJSON("backtest/results.json", results);
  console.log("[backtest] done: " + JSON.stringify({ totalRows: results.totalRows, overall: results.overall, errors: results.errors.length }));
  return new Response("ok");
};
