// claude_engine.js — the heavy Claude-method work: build snapshots, run v3.predict
// for every covered city, and log the (Claude, Bayes, Market) triple to the
// verification scoreboard blob; plus CLI settlement. Extracted from claude.js so a
// BACKGROUND function (15-min limit) can run it — the synchronous /api/claude path
// times out at ~10s before it logs anything (two self-HTTP calls + a 78-station
// METAR fetch happen before the first write), which is why the store was empty.

import { getStore } from "@netlify/blobs";
import { buildSnapshotV2, parseMetar } from "./metar.js";
import { predict, UPSTREAM_STATIONS } from "./claude_analog_v3.js";

export const SITE = "https://weatherbot-mf.netlify.app";
export const AUTH = "Basic " + btoa("internal:hydro");
export const STORE = "claude_scoreboard";
export const round1 = (x) => x == null ? x : Math.round(x * 10) / 10;

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
// aviationweather format=raw prefixes lines with "METAR "/"SPECI ". Match the station
// code immediately before the ddHHMMZ group, prefix or not — the old
// startsWith(station+" ") matched ZERO lines, so the scoreboard never logged anything.
export const stationLines = (text, station) => {
  const re = new RegExp(`\\b${station}\\s+\\d{6}Z`);
  return text.split("\n").map(l => l.trim()).filter(l => re.test(l));
};

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

// Parse a station's METAR lines into obs sorted oldest→newest (for prev-ob / upstream).
function parsedObs(text, station, refNow) {
  return stationLines(text, station).map(l => parseMetar(l, refNow)).filter(Boolean).sort((a, b) => a.ts - b.ts);
}

export async function runPredict(doLog) {
  const [wx, ks] = await Promise.all([getJSON("/api/weather"), getJSON("/api/kalshi")]);
  const ksByName = Object.fromEntries((ks.cities || []).map(c => [c.name, c]));
  const cities = (wx.cities || []).filter(c => c.station && !c.error);
  // Include L1 upstream neighbors in the METAR fetch — their CURRENT sky is the
  // incoming-advection signal (2026-07-09 KNYC shield). Union across all cities.
  const upIds = new Set();
  for (const c of cities) for (const u of (UPSTREAM_STATIONS[c.station] || [])) upIds.add(u.station);
  const metarText = await fetchMetars([...new Set([...cities.map(c => c.station), ...upIds])]);
  // One refNow for all cities: parseMetar only uses it to disambiguate a METAR's
  // day-of-month within the 72h window, and metarTime's month-rollover logic is
  // tolerant to a few hours of tz offset, so a shared wall-clock is safe here.
  const refNow = new Date();
  const store = doLog ? getStore(STORE) : null;
  const now = refNow.toISOString();
  const out = [];
  let logged = 0; const errors = [];
  for (const c of cities) {
    const kc = ksByName[c.name];
    const { bins, market } = binsAndMarket(kc?.highBuckets);
    const snap = buildSnapshotV2({ station: c.station, tz: c.tz, metarLines: stationLines(metarText, c.station), maxSoFarF: c.maxSoFarCli ?? c.maxSoFar });
    if (!snap) continue;
    // L1: current ob at each upstream neighbor. L3: previous ob (falling-trace check).
    const upstreamObs = {};
    for (const u of (UPSTREAM_STATIONS[c.station] || [])) {
      const o = parsedObs(metarText, u.station, refNow);
      if (o.length) upstreamObs[u.station] = o[o.length - 1];
    }
    const sObs = parsedObs(metarText, c.station, refNow);
    const snapPrev = sObs.length >= 2 ? { station: c.station, now: sObs[sObs.length - 2], max_so_far_f: snap.max_so_far_f } : null;
    const binsArg = bins.length ? bins : null;
    const mktArg = Object.keys(market).length ? market : null;
    // Ledger card is PURE (tilt off) so the scoreboard scores the model unaided.
    const card = predict(snap, null, binsArg, mktArg, upstreamObs, snapPrev, false);
    // Sizing card tilts toward the informed market (L2) — display only, never scored.
    const sizingCard = mktArg ? predict(snap, null, binsArg, mktArg, upstreamObs, snapPrev, true) : null;
    const d = card.dist;
    const bayes = bayesCard(c);
    // point = mixture mean (convection-aware); floor/ci68/bin_probs scored by scoreboard.js.
    const claude = {
      point: round1(d.mean()), mu: round1(d.mu), sigma: round1(d.sigma), floor: round1(d.floor),
      ci68: [round1(d.quantile(0.16)), round1(d.quantile(0.84))],
      p_trunc: round1(d.pTrunc), depth: round1(d.depth),
      components: Object.fromEntries(Object.entries(card.components).map(([k, v]) => [k, round1(v)])),
      bin_probs: card.bin_probs, market_pt: round1(card.market_pt), divergence_note: card.divergence_note,
      // v3 signals (not scored — context for reading the card / sizing)
      advection_score: round1(card.advection_score),
      peak_locked: card.peak_locked, lock_note: card.lock_note || null,
      upstream: card.upstream_audit && card.upstream_audit.length
        ? card.upstream_audit.map(a => ({ station: a.station, deficit: a.deficit })) : null,
      sizing: sizingCard ? { point: round1(sizingCard.dist.mean()), bin_probs: sizingCard.bin_probs, note: sizingCard.tilt_note } : null,
    };
    const divergence = bayes ? round1(d.mean() - bayes.point) : null;
    out.push({ city: c.name, station: c.station, claude, bayes, market, divergence });
    if (store) {
      const date = localDate(c.tz);
      // Surface write failures instead of swallowing them — a silent .catch here is
      // exactly what let the store sit empty without any signal.
      try {
        await store.setJSON(`dec/${c.station}/${date}/${String(localHour(c.tz)).padStart(2, "0")}.json`,
          { type: "decision", city: c.name, station: c.station, cli: c.cli || null, contract_date: date, asof: now,
            claude, bayes, market, nws: c.forecastHighF ?? c.nwsHighF ?? null });
        logged++;
      } catch (e) {
        errors.push(`${c.station}: ${String(e?.message || e)}`);
      }
    }
  }
  if (errors.length) console.log(`[claude-predict] ${errors.length} write errors: ${errors.slice(0, 3).join("; ")}`);
  return { ok: true, mode: "predict", asof: now, count: out.length, logged, errors, cities: out };
}

// 2026-07-09 bugsweep FIX 1: parse the CLI product's own date, skip VALID-AS-OF
// partials, anchor ^MAXIMUM (a later RECORD line can't win), accept only the final
// product covering the target date.
const CLI_MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
export function parseCliProduct(html) {
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const text = pre ? pre[1] : html;
  const f = text.match(/CLIMATE\s+SUMMARY\s+FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})/i)
         || text.match(/SUMMARY\s+FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})/i);
  let coversDate = null;
  if (f) {
    const mo = CLI_MONTHS[f[1].toUpperCase().slice(0, 3)];
    if (mo != null) coversDate = `${f[3]}-${String(mo + 1).padStart(2, "0")}-${String(+f[2]).padStart(2, "0")}`;
  }
  const isPartial = /VALID\s+(AS\s+OF|TODAY|THROUGH)/i.test(text);
  const m = text.match(/^\s*MAXIMUM\s+(-?\d+)/im);
  return { coversDate, isPartial, maxF: m ? parseInt(m[1], 10) : null };
}

async function fetchCliMaxFor(cli, targetDate) {
  for (let version = 1; version <= 4; version++) {
    try {
      const url = `https://forecast.weather.gov/product.php?site=NWS&product=CLI&issuedby=${cli}&format=txt&version=${version}&glossary=0`;
      const r = await fetch(url); if (!r.ok) continue;
      const p = parseCliProduct(await r.text());
      if (p.coversDate !== targetDate) continue;   // wrong day's product
      if (p.isPartial) continue;                    // evening preliminary — wait for the final
      if (p.maxF != null) return p.maxF;
    } catch { /* try next version */ }
  }
  return null;
}

export async function runSettle() {
  const store = getStore(STORE);
  const { blobs } = await store.list({ prefix: "dec/" });
  const today = localDate("America/New_York");
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
    const cliMax = await fetchCliMaxFor(cli, date);
    if (cliMax != null) { await store.setJSON(`settle/${station}/${date}.json`, { type: "settlement", station, contract_date: date, cli_max: cliMax }); done.push(`${station}/${date}`); }
  }
  return { ok: true, mode: "settle", settled: done };
}
