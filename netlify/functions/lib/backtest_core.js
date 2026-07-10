// backtest_core.js — pure logic for the historical analog backtest (no network,
// no blobs; unit-tested in test_backtest.js). backtest-background.js feeds it IEM
// archives: hourly METARs (asos.py, tdf) + CLI daily highs (cli.json) + optional
// MOS guidance as the NWS stand-in — and it replays the v3 analog at a fixed
// decision hour for each historical day, exactly as the live card would have.

import { buildSnapshotV2 } from "./metar.js";
import { predict, thinAnalogGuard, localHourFrac } from "./claude_analog_v3.js";

const r1 = (x) => x == null ? null : Math.round(x * 10) / 10;

// IEM asos.py format=tdf → [{ts, metar}]. Header row "station\tvalid\tmetar".
export function parseAsosTdf(text) {
  const out = [];
  for (const line of (text || "").split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3 || parts[0].trim() === "station") continue;
    const ts = new Date(parts[1].trim().replace(" ", "T") + "Z");
    if (isNaN(ts)) continue;
    const metar = parts.slice(2).join(" ").trim();
    if (metar) out.push({ ts, metar });
  }
  return out;
}

const prevDate = (date) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// Replay one station over every date with a CLI truth: build the 72h snapshot as of
// decisionHourUTC that day, run the pure v3 analog + thin-analog guard, and pair it
// with persistence (yesterday's CLI high) and optional NWS-guidance points.
export function replayStation({ station, tz, obs, truthByDate, nwsByDate = {}, decisionHourUTC = 15 }) {
  const rows = [];
  for (const date of Object.keys(truthByDate).sort()) {
    const truth = truthByDate[date];
    if (truth == null) continue;
    const dec = new Date(`${date}T${String(decisionHourUTC).padStart(2, "0")}:00:00Z`);
    const lo = dec.getTime() - 72 * 3600 * 1000;
    const lines = obs.filter(o => o.ts.getTime() > lo && o.ts.getTime() <= dec.getTime()).map(o => o.metar);
    if (lines.length < 20) continue;                    // too sparse to replay honestly
    const snap = buildSnapshotV2({ station, tz, metarLines: lines, refNow: dec });
    if (!snap || !snap.analogs.length) continue;
    const card = predict(snap);
    const hrsToPeak = Math.max(0, 16 - localHourFrac(dec, tz));
    const g = thinAnalogGuard(card.dist.mean(), snap, card.components["R_analog(eff)"], hrsToPeak);
    rows.push({
      date, truth,
      analog: r1(g.point), guarded: g.guarded, analogRaw: r1(card.dist.mean()),
      persistence: truthByDate[prevDate(date)] ?? null,
      nws: nwsByDate[date] ?? null,
    });
  }
  return rows;
}

// Score engines over rows. blend = avg(analog, nws) where both exist — the historical
// stand-in for "average of the Bayesian and the analog" (the Bayesian is NWS-anchored
// and cannot be replayed historically; NWS guidance is its anchor).
export function aggregate(rows) {
  const engines = { analog: r => r.analog, persistence: r => r.persistence, nws: r => r.nws,
                    blend: r => (r.analog != null && r.nws != null) ? (r.analog + r.nws) / 2 : null };
  const out = {};
  for (const [name, get] of Object.entries(engines)) {
    let n = 0, abs = 0, sq = 0;
    for (const r of rows) {
      const v = get(r);
      if (v == null || r.truth == null) continue;
      n++; abs += Math.abs(v - r.truth); sq += (v - r.truth) ** 2;
    }
    out[name] = n ? { n, mae: r1(abs / n), rmse: r1(Math.sqrt(sq / n)) } : { n: 0 };
  }
  // head-to-head on rows where both sides exist (win = strictly smaller abs error)
  const h2h = (a, b) => {
    let n = 0, wins = 0;
    for (const r of rows) {
      const va = engines[a](r), vb = engines[b](r);
      if (va == null || vb == null || r.truth == null) continue;
      n++; if (Math.abs(va - r.truth) < Math.abs(vb - r.truth)) wins++;
    }
    return n ? { n, winPct: Math.round(100 * wins / n) } : { n: 0 };
  };
  out.analog_vs_nws = h2h("analog", "nws");
  out.blend_vs_nws = h2h("blend", "nws");
  out.blend_vs_analog = h2h("blend", "analog");
  out.analog_vs_persistence = h2h("analog", "persistence");
  return out;
}
