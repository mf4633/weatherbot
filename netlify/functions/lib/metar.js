// metar.js — minimal METAR decoder to build an ObsSnapshot for claude_analog.js
// from aviationweather.gov raw METAR text. Parses temp/dewpoint (prefers the RMK
// tenths T-group), wind dir/speed, sea-level pressure (SLP group, else altimeter),
// visibility (statute miles), and obstruction codes (HZ/FU/BR/FG/DU/SA).

// Resolve a METAR's "ddHHMMZ" to a full Date using a reference "now" (handles month
// rollover: a day-of-month greater than now's rolls to the previous month).
function metarTime(line, refNow) {
  const m = line.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  if (!m) return null;
  const [dd, hh, mm] = [+m[1], +m[2], +m[3]];
  let y = refNow.getUTCFullYear(), mo = refNow.getUTCMonth();
  if (dd > refNow.getUTCDate() + 1) { mo -= 1; if (mo < 0) { mo = 11; y -= 1; } }
  return new Date(Date.UTC(y, mo, dd, hh, mm));
}
const c2f = (c) => c * 9 / 5 + 32;

// SLPnnn → hPa (nnn = tenths of mb around 1000): SLP134→1013.4, SLP987→998.7.
function slpFrom(line) {
  const s = line.match(/\bSLP(\d{3})\b/);
  if (s) { const n = +s[1]; return (n >= 500 ? 900 : 1000) + n / 10; }
  const a = line.match(/\bA(\d{4})\b/);          // altimeter inHg*100 → hPa
  if (a) return +a[1] / 100 * 33.8639;
  return null;
}

// Visibility in statute miles: "10SM", "4SM", "1/2SM", "1 1/2SM", "M1/4SM".
// Returns null when the group is absent (some non-US or truncated reports).
function visibilityFrom(line) {
  const m = line.match(/\bM?(?:(\d{1,2})\s+)?(\d{1,2})(?:\/(\d{1,2}))?SM\b/);
  if (!m) return null;
  const whole = m[1] ? +m[1] : 0;
  const frac = m[3] ? +m[2] / +m[3] : +m[2];
  return whole + frac;
}

// Obstruction / obscuration codes relevant to insolation (2026-07-15 KNYC: 4SM HZ
// under CLR sky was a real ~1°F cut the sky group can't see). Body only — stop at
// RMK so remark text can't false-match.
function wxFrom(line) {
  const body = line.split(/\bRMK\b/)[0];
  return (body.match(/(?:^|\s)(?:[+-]|VC)?(HZ|FU|BR|FG|DU|SA)(?=\s|$)/g) || [])
    .map(s => s.trim().replace(/^[+-]|^VC/, "")).join(" ");
}

export function parseMetar(line, refNow) {
  const ts = metarTime(line, refNow);
  if (!ts) return null;
  let tempC = null, dewC = null;
  const tg = line.match(/\bT([01])(\d{3})([01])(\d{3})\b/);   // RMK tenths (most precise)
  if (tg) { tempC = (tg[1] === "1" ? -1 : 1) * (+tg[2]) / 10; dewC = (tg[3] === "1" ? -1 : 1) * (+tg[4]) / 10; }
  else {
    const bt = line.match(/\s(M?\d{2})\/(M?\d{2})?\s/);        // body whole-degree; dew optional (FIX 3: "25/ " must keep the temp)
    if (bt) { tempC = parseInt(bt[1].replace("M", "-"), 10); dewC = bt[2] ? parseInt(bt[2].replace("M", "-"), 10) : null; }
  }
  if (tempC == null) return null;
  const w = line.match(/\b(\d{3}|VRB)(\d{2,3})(?:G\d{2,3})?KT\b/);
  const sky = (line.match(/\b(?:FEW|SCT|BKN|OVC)\d{3}\b/g) || []).join(" ") ||
              (/\b(?:CLR|SKC|NSC|NCD)\b/.test(line) ? "CLR" : "");
  return {
    ts,
    temp_f: c2f(tempC),
    dewpoint_f: dewC == null ? null : c2f(dewC),
    wind_dir_deg: w ? (w[1] === "VRB" ? null : +w[1]) : null,
    wind_speed_kt: w ? +w[2] : 0,
    slp_mb: slpFrom(line),
    sky,
    visibility_mi: visibilityFrom(line),
    wx: wxFrom(line),
  };
}

const localDate = (ts, tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);

// Build an ObsSnapshot from a station's METAR lines. maxSoFarF is passed in from the
// Bayesian pipeline (which already does the CLI-correct local-day max); yesterday_max
// and the hourly detail are derived from the METARs themselves.
export function buildSnapshot({ station, tz, metarLines, refNow = new Date(), maxSoFarF = null }) {
  const obs = (metarLines || []).map(l => parseMetar(l, refNow)).filter(Boolean)
    .sort((a, b) => a.ts - b.ts);
  if (!obs.length) return null;
  const now = obs[obs.length - 1];
  const today = localDate(now.ts, tz);
  const yDate = localDate(new Date(now.ts.getTime() - 86400000), tz);
  const yesterday = obs.filter(o => localDate(o.ts, tz) === yDate);
  const yesterday_max_f = yesterday.length ? Math.max(...yesterday.map(o => o.temp_f)) : null;
  const todayObs = obs.filter(o => localDate(o.ts, tz) === today);
  const max_so_far_f = maxSoFarF != null ? maxSoFarF
    : (todayObs.length ? Math.max(...todayObs.map(o => o.temp_f)) : now.temp_f);
  // SLP nearest to now-24h (advection proxy)
  const target = now.ts.getTime() - 86400000;
  let slp_24h_ago_mb = null, best = Infinity;
  for (const o of obs) if (o.slp_mb != null) { const d = Math.abs(o.ts.getTime() - target); if (d < best) { best = d; slp_24h_ago_mb = o.slp_mb; } }
  return { station, now, max_so_far_f, yesterday, yesterday_max_f, slp_24h_ago_mb };
}

// buildSnapshotV2 — snapshot for claude_analog_v2's multi-day analog ensemble.
// Buckets all obs by station-local day, then hands the engine the N most-recent prior
// local days as analogs (most-recent-first), each with its own hourly obs + observed max.
// today_hourlies carries the day's own trace so v3 can read intraday trends (the
// 2026-07-15 mixing-breakout signal needs the morning dewpoint history, not just now).
// Shape: { station, now, max_so_far_f, today_hourlies, analogs:[{hourlies, max_f}], slp_24h_ago_mb }.
export function buildSnapshotV2({ station, tz, metarLines, refNow = new Date(), maxSoFarF = null, nAnalogs = 2 }) {
  const obs = (metarLines || []).map(l => parseMetar(l, refNow)).filter(Boolean)
    .sort((a, b) => a.ts - b.ts);
  if (!obs.length) return null;
  const now = obs[obs.length - 1];
  const today = localDate(now.ts, tz);
  // group obs into local-day buckets
  const byDay = new Map();
  for (const o of obs) {
    const d = localDate(o.ts, tz);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(o);
  }
  const todayObs = byDay.get(today) || [now];
  const max_so_far_f = maxSoFarF != null ? maxSoFarF : Math.max(...todayObs.map(o => o.temp_f));
  // prior local days, most-recent-first, capped at nAnalogs
  const priorDays = [...byDay.keys()].filter(d => d < today).sort().reverse().slice(0, nAnalogs);
  const analogs = priorDays.map(d => {
    const hourlies = byDay.get(d);
    return { hourlies, max_f: Math.max(...hourlies.map(o => o.temp_f)) };
  });
  // SLP nearest to now-24h (advection proxy)
  const target = now.ts.getTime() - 86400000;
  let slp_24h_ago_mb = null, best = Infinity;
  for (const o of obs) if (o.slp_mb != null) { const d = Math.abs(o.ts.getTime() - target); if (d < best) { best = d; slp_24h_ago_mb = o.slp_mb; } }
  return { station, tz: tz || null, now, max_so_far_f, today_hourlies: todayObs, analogs, slp_24h_ago_mb };
}
