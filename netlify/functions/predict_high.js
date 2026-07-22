// /api/predicthigh — daily-HIGH predictor for the Kalshi daily-high markets, plus a
// rolling walk-forward backtest so its accuracy is a measured number on every call.
// 2026-07-21: the missing complement to /api/interp (a nowcaster). This answers
// "what will the settlement high be" via the hour-conditional rise-to-peak calibration
// in lib/highpredict.js — the deployable form of the live "+5 from 11:53" Denver rule.
//
//   ?city=DEN|HOU|NYC|PHX|LAX|DCA   which official station + Kalshi ladder parity
//   ?days=N        history window for calibration + backtest (2..14, default 10)
//   ?as_of_hour=H  local decision hour the backtest predicts from (default 12)
//   ?anchor=0|1    override the 2° ladder parity (0 even-start, 1 odd-start)
//
// Official-trace only (aviationweather METAR) — no PWS/api.weather.com, which is the
// interp's fragile, sometimes-unreachable leg. Robust by design.

import { parseMetar } from "./lib/metar.js";
import { stationLines } from "./lib/claude_engine.js";
import { predictHigh, backtestHigh } from "./lib/highpredict.js";
import { scanFloors } from "./lib/floorscan.js";

// Normalize a posted board into { label: {loInt, hiInt, no_ask, yes_bid} }. Accepts
// either that object shape or an array of {label, loInt, hiInt, no_ask, yes_bid}.
function normalizeBoard(board) {
  if (!board) return null;
  const entries = Array.isArray(board)
    ? board.map((b) => [b.label, b])
    : Object.entries(board);
  const out = {};
  for (const [label, b] of entries) {
    if (!label || !b) continue;
    out[label] = {
      loInt: b.loInt ?? null, hiInt: b.hiInt ?? null,
      no_ask: b.no_ask ?? null, yes_bid: b.yes_bid ?? null,
      yes_ask: b.yes_ask ?? null, no_bid: b.no_bid ?? null,
    };
  }
  return Object.keys(out).length ? out : null;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// bucketAnchor is the Kalshi ladder parity seen on each board: Houston/CLIHOU runs
// EVEN-start pairs (98-99, 100-101), Denver runs ODD-start (89-90, 91-92). Others
// default to even and can be overridden with ?anchor= once their board is confirmed.
const CITIES = {
  NYC: { official: "KNYC", tz: "America/New_York", anchor: 0 },
  DEN: { official: "KDEN", tz: "America/Denver", anchor: 1 },
  HOU: { official: "KHOU", tz: "America/Chicago", anchor: 0 },
  PHX: { official: "KPHX", tz: "America/Phoenix", anchor: 0 },
  LAX: { official: "KLAX", tz: "America/Los_Angeles", anchor: 0 },
  DCA: { official: "KDCA", tz: "America/New_York", anchor: 0 },
};

async function fetchOfficialObs(station, hours, refNow) {
  const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${station}&hours=${hours}&format=raw`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`METAR ${station} HTTP ${r.status}`);
  return stationLines(await r.text(), station).map((l) => parseMetar(l, refNow)).filter(Boolean)
    .map((o) => ({ tsMs: o.ts.getTime(), tempF: o.temp_f }))
    .filter((o) => Number.isFinite(o.tempF)).sort((a, b) => a.tsMs - b.tsMs);
}

const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2),
  { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const url = new URL(req.url);
  const cityKey = (url.searchParams.get("city") || "DEN").toUpperCase();
  const cfg = CITIES[cityKey];
  if (!cfg) return json({ ok: false, error: `unknown city ${cityKey} (${Object.keys(CITIES).join("|")})` }, 400);
  const days = Math.min(14, Math.max(2, parseInt(url.searchParams.get("days") || "10", 10)));
  const asOfHour = Math.min(20, Math.max(6, parseInt(url.searchParams.get("as_of_hour") || "12", 10)));
  const anchorParam = url.searchParams.get("anchor");
  const bucketAnchor = anchorParam != null ? (parseInt(anchorParam, 10) & 1) : cfg.anchor;
  const experimental = url.searchParams.get("experimental_anchor") === "1";

  // POST a board (JSON {board: …}) to also get the floor-scan: which low-tail NOs are
  // locked-or-locking and still paying, with the cold-pool tailwind surfaced.
  let board = null;
  if (req.method === "POST") {
    try { board = normalizeBoard((await req.json())?.board); } catch { /* no/!json body */ }
  }

  try {
    const now = new Date();
    const obs = await fetchOfficialObs(cfg.official, days * 24, now);
    if (obs.length < 24) throw new Error(`only ${obs.length} official obs`);

    const prediction = predictHigh(obs, cfg.tz, { bucketAnchor });
    const floors = board ? scanFloors(prediction, board, prediction.max_so_far) : undefined;
    const backtest = backtestHigh(obs, cfg.tz, { asOfHour, bucketAnchor, minPriorDays: 3 });

    // Opt-in peak-on-anchor regression (?experimental_anchor=1). Off by default: it did
    // NOT beat the base rise method on the 6-day KDEN sample — kept for re-evaluation.
    const experimentalBlock = experimental ? {
      prediction: predictHigh(obs, cfg.tz, { bucketAnchor, anchorAnomaly: true }),
      backtest: backtestHigh(obs, cfg.tz, { asOfHour, bucketAnchor, minPriorDays: 3, anchorAnomaly: true }),
      caveat: "peak-on-anchor regression; underperformed base on the 6-day KDEN sample, off by default",
    } : undefined;

    return json({
      ok: true, city: cityKey, official: cfg.official, tz: cfg.tz,
      bucket_anchor: bucketAnchor, asof: now.toISOString(),
      prediction,
      floors,
      backtest: {
        as_of_hour: backtest.as_of_hour, n: backtest.n, mae: backtest.mae, bias: backtest.bias,
        bucket_hit_pct: backtest.bucket_hit_pct, within1_pct: backtest.within1_pct, days: backtest.days,
      },
      experimental: experimentalBlock,
      note: "prediction = today's latest :53 + the median historical rise-to-peak from this clock hour, " +
        "floored by today's max so far (monotonic). bucket_probs = empirical distribution of those rises. " +
        "When today's anchor sits far off the same-hour norm (anchor_anomaly_f), low_confidence trips and " +
        "the range widens toward the airmass — the 2026-07-21 KDEN cold-pool lesson. backtest walks the " +
        "rule forward, target day held out.",
    });
  } catch (e) {
    return json({ ok: false, city: cityKey, error: String(e?.message || e) }, 500);
  }
};

export const config = { path: "/api/predicthigh" };
