// /api/claude — the "Claude method" obs-analog engine, live. For each covered city it
// builds an ObsSnapshot from aviationweather METARs, runs claude_analog.predict(),
// pairs it with the Bayesian card (/api/weather) and the Kalshi book (/api/kalshi), and
// logs the triple to the verification scoreboard blob. Modes (?mode=):
//   predict  (default) — return Claude vs Bayes vs Market cards per city, and log decisions
//   settle             — fetch yesterday's CLI max per station, write settlements
//   scoreboard         — score all logged decisions against settlements (skill table)
// Places no trades. Pure model + verification; see STRATEGY.md / TRADING_POSTMORTEM.md.

import { getStore } from "@netlify/blobs";
import { buildSnapshotV2 } from "./lib/metar.js";
import { predict } from "./lib/claude_analog_v2.js";
import { score } from "./lib/scoreboard.js";

const SITE = "https://weatherbot-mf.netlify.app";
const AUTH = "Basic " + btoa("internal:hydro");
const STORE = "claude_scoreboard";

async function getJSON(path) {
  const r = await fetch(`${SITE}${path}`, { headers: { authorization: AUTH } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function fetchMetars(ids) {
  const url = `https://aviationweather.gov/api/data/metar?ids=${ids.join(",")}&hours=72&format=raw`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`METAR fetch ${r.status}`);
  return r.text();
}
const stationLines = (text, station) =>
  text.split("\n").map(l => l.trim()).filter(l => l.startsWith(`${station} `));

const labelOf = (lo, hi) =>
  lo === -Infinity || lo == null ? `<=${hi}` :
  hi === Infinity || hi == null ? `>=${lo}` :
  lo === hi ? `${lo}` : `${lo}-${hi}`;

// Kalshi highBuckets → claude bins [{label,lo,hi}] + market {label: yes_cents}.
function binsAndMarket(buckets) {
  const bins = [], market = {};
  for (const b of buckets || []) {
    const lo = b.loInt == null ? -Infinity : b.loInt;
    const hi = b.hiInt == null ? Infinity : b.hiInt;
    const label = labelOf(lo, hi);
    bins.push({ label, lo, hi });
    if (b.yes_ask != null) market[label] = Math.round(b.yes_ask * 100);
  }
  return { bins, market };
}

const localDate = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/Chicago" }).format(new Date());
const localHour = (tz) => parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz || "America/Chicago", hour: "2-digit", hour12: false }).format(new Date()), 10) % 24;

function bayesCard(c) {
  if (c.mean == null || c.std == null) return null;
  return { point: c.mean, sigma: c.std, floor: c.maxSoFarCli ?? c.maxSoFar ?? c.mean,
           ci68: [c.mean - c.std, c.mean + c.std] };
}

async function runPredict(doLog) {
  const [wx, ks] = await Promise.all([getJSON("/api/weather"), getJSON("/api/kalshi")]);
  const ksByName = Object.fromEntries((ks.cities || []).map(c => [c.name, c]));
  const cities = (wx.cities || []).filter(c => c.station && !c.error);
  const metarText = await fetchMetars([...new Set(cities.map(c => c.station))]);
  const store = doLog ? getStore(STORE) : null;
  const now = new Date().toISOString();
  const out = [];
  for (const c of cities) {
    const kc = ksByName[c.name];
    const { bins, market } = binsAndMarket(kc?.highBuckets);
    const snap = buildSnapshotV2({ station: c.station, tz: c.tz, metarLines: stationLines(metarText, c.station), maxSoFarF: c.maxSoFarCli ?? c.maxSoFar });
    if (!snap) continue;
    const card = predict(snap, null, bins.length ? bins : null, Object.keys(market).length ? market : null);
    const d = card.dist;
    const bayes = bayesCard(c);
    // point = mixture mean (convection-aware); floor/ci68/bin_probs scored by scoreboard.js.
    const claude = {
      point: round1(d.mean()), mu: round1(d.mu), sigma: round1(d.sigma), floor: round1(d.floor),
      ci68: [round1(d.quantile(0.16)), round1(d.quantile(0.84))],
      p_trunc: round1(d.pTrunc), depth: round1(d.depth),
      components: Object.fromEntries(Object.entries(card.components).map(([k, v]) => [k, round1(v)])),
      bin_probs: card.bin_probs, market_pt: round1(card.market_pt), divergence_note: card.divergence_note,
    };
    const divergence = bayes ? round1(d.mean() - bayes.point) : null;
    out.push({ city: c.name, station: c.station, claude, bayes, market, divergence });
    if (store) {
      const date = localDate(c.tz);
      await store.setJSON(`dec/${c.station}/${date}/${String(localHour(c.tz)).padStart(2, "0")}.json`,
        { type: "decision", station: c.station, cli: c.cli || null, contract_date: date, asof: now, claude, bayes, market })
        .catch(() => {});
    }
  }
  return { ok: true, mode: "predict", asof: now, count: out.length, cities: out };
}

// Compact CLI fetch (mirror of logger.js): final daily max °F for a station's CLI code.
async function fetchCliMax(cli) {
  try {
    const url = `https://forecast.weather.gov/product.php?site=NWS&product=CLI&issuedby=${cli}&format=txt&version=1&glossary=0`;
    const r = await fetch(url); if (!r.ok) return null;
    const m = (await r.text()).match(/MAXIMUM\s+(-?\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

async function runSettle() {
  const store = getStore(STORE);
  const { blobs } = await store.list({ prefix: "dec/" });
  const today = localDate("America/New_York");
  // (station, date, cli) tuples for past days not yet settled
  const pend = {};
  for (const b of blobs || []) {
    const [, station, date] = b.key.split("/");
    if (date >= today) continue;
    pend[`${station}|${date}`] = pend[`${station}|${date}`] || { station, date };
  }
  const done = [];
  for (const { station, date } of Object.values(pend)) {
    if (await store.get(`settle/${station}/${date}.json`, { type: "json" }).catch(() => null)) continue;
    const anyKey = (blobs.find(b => b.key.startsWith(`dec/${station}/${date}/`)) || {}).key;
    const rec = anyKey ? await store.get(anyKey, { type: "json" }).catch(() => null) : null;
    const cli = rec?.cli; if (!cli) continue;
    const cliMax = await fetchCliMax(cli);
    if (cliMax != null) { await store.setJSON(`settle/${station}/${date}.json`, { type: "settlement", station, contract_date: date, cli_max: cliMax }); done.push(`${station}/${date}`); }
  }
  return { ok: true, mode: "settle", settled: done };
}

async function runScoreboard() {
  const store = getStore(STORE);
  const { blobs } = await store.list();
  const records = (await Promise.all((blobs || []).map(b => store.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
  return { ok: true, mode: "scoreboard", n_records: records.length,
           all: score(records), lastObOnly: score(records, { lastObOnly: true }) };
}

const round1 = (x) => x == null ? x : Math.round(x * 10) / 10;
const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const mode = new URL(req.url).searchParams.get("mode") || "predict";
  try {
    if (mode === "settle") return json(await runSettle());
    if (mode === "scoreboard") return json(await runScoreboard());
    return json(await runPredict(new URL(req.url).searchParams.get("log") !== "0"));
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
};
