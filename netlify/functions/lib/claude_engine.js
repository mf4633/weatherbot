// claude_engine.js — the heavy Claude-method work: build snapshots, run v3.predict
// for every covered city, and log the (Claude, Bayes, Market) triple to the
// verification scoreboard blob; plus CLI settlement. Extracted from claude.js so a
// BACKGROUND function (15-min limit) can run it — the synchronous /api/claude path
// times out at ~10s before it logs anything (two self-HTTP calls + a 78-station
// METAR fetch happen before the first write), which is why the store was empty.

import { getStore } from "@netlify/blobs";
import { buildSnapshotV2, parseMetar } from "./metar.js";
import { predict, UPSTREAM_STATIONS, gradeAnalogBelief, thinAnalogGuard, baseBlend } from "./claude_analog_v3.js";
import { accuCityAllowed, accuHourAllowed, accuImpliedHigh, scoreAccuDecisions } from "./accuweather.js";
import { scanNoFloor, scoreNoFloor, MIN_RETURN, MIN_WIN_PROB } from "./nofloor.js";

export const SITE = "https://weatherbot-mf.netlify.app";
export const AUTH = "Basic " + btoa("internal:hydro");
export const STORE = "claude_scoreboard";
export const round1 = (x) => x == null ? x : Math.round(x * 10) / 10;

async function getJSON(path) {
  const r = await fetch(`${SITE}${path}`, { headers: { authorization: AUTH } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

// CHUNKED: one 78-station × 72h request comes back truncated (recent-first), so
// prior local days vanish and every analog collapses — R_analog(eff) was 0 on 807
// of 884 logged decisions and the thin-analog guard NEVER fired in production
// (guarded_point == point on all 1008). Pre-dawn decisions (06-08Z) still had
// nonzero ramps because "yesterday" was only minutes away. Smaller batches keep
// each station's full 72h window.
async function fetchMetars(ids) {
  const CHUNK = 15;
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const texts = await Promise.all(chunks.map(async (c) => {
    const url = `https://aviationweather.gov/api/data/metar?ids=${c.join(",")}&hours=72&format=raw`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`METAR fetch ${r.status}`);
    return r.text();
  }));
  return texts.join("\n");
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

// Kalshi highBuckets → claude bins [{label,lo,hi}] + market {label: yes_cents} +
// books {label: full two-sided quote} (the NO-floor scan needs the NO side).
function binsAndMarket(buckets) {
  const bins = [], market = {}, books = {};
  for (const b of buckets || []) {
    const lo = b.loInt == null ? -Infinity : b.loInt;
    const hi = b.hiInt == null ? Infinity : b.hiInt;
    const label = labelOf(lo, hi);
    bins.push({ label, lo, hi });
    if (b.yes_ask != null) market[label] = Math.round(b.yes_ask * 100);
    books[label] = { loInt: b.loInt ?? null, hiInt: b.hiInt ?? null,
      yes_ask: b.yes_ask ?? null, yes_bid: b.yes_bid ?? null,
      no_ask: b.no_ask ?? null, no_bid: b.no_bid ?? null };
  }
  return { bins, market, books };
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
  let logged = 0; const errors = []; const analogStarved = [];
  for (const c of cities) {
    const kc = ksByName[c.name];
    const { bins, market, books } = binsAndMarket(kc?.highBuckets);
    const snap = buildSnapshotV2({ station: c.station, tz: c.tz, metarLines: stationLines(metarText, c.station), maxSoFarF: c.maxSoFarCli ?? c.maxSoFar });
    if (!snap) continue;
    // Truncated-fetch canary: a station with NO prior-day analogs means its METAR
    // window collapsed — the analog ramp reads 0 and the guard can't fire.
    if (!snap.analogs || !snap.analogs.length) analogStarved.push(c.station);
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
    // Guarded point alongside the pure one. Retro-validation on 2026-07-10/11
    // ledger: morning blend MAE 4.45 → 2.07 when the blend uses the guarded point
    // (the zero-ramp degeneracy poisoned pure-model mornings, MAE 9.2). `point`
    // stays the PURE model for continuity; scoreboard's blend prefers guarded_point.
    const hrsToPeak = Math.max(0, 16 - localHour(c.tz));
    const guard = thinAnalogGuard(d.mean(), snap, card.components["R_analog(eff)"], hrsToPeak);
    // Fitted base blend (2026-07-23, research/analyze_stack.js): the served/display
    // point is anchored on the strongest available estimate — the Bayesian ensemble,
    // NOT the NWS grid, which earns w=0.00 at every hour once the ensemble is in the
    // stack — and the analog carries its FITTED weight (0.30 near peak → 0.05 far
    // out). `point` stays the PURE model for ledger continuity; point_blend is what
    // dashboards show.
    const nwsHigh = c.forecastHighF ?? c.nwsHighF ?? null;
    const baseSrc = bayes?.point != null ? "bayes" : (nwsHigh != null ? "nws" : null);
    const basePoint = bayes?.point ?? nwsHigh ?? null;
    const blend = baseBlend(guard.point, basePoint, hrsToPeak, snap.max_so_far_f);
    const claude = {
      point: round1(d.mean()), mu: round1(d.mu), sigma: round1(d.sigma), floor: round1(d.floor),
      guarded_point: round1(guard.point), guarded: guard.guarded,
      point_blend: round1(blend.point), analog_w: round1(blend.w),
      blend_base: basePoint != null ? round1(basePoint) : null, blend_base_src: baseSrc,
      nws_base: nwsHigh != null ? round1(nwsHigh) : null,
      ci68: [round1(d.quantile(0.16)), round1(d.quantile(0.84))],
      p_trunc: round1(d.pTrunc), depth: round1(d.depth),
      components: Object.fromEntries(Object.entries(card.components).map(([k, v]) => [k, round1(v)])),
      bin_probs: card.bin_probs, market_pt: round1(card.market_pt), divergence_note: card.divergence_note,
      // v3 signals (not scored — context for reading the card / sizing)
      advection_score: round1(card.advection_score),
      // Grade with the SAME opts the dashboard passes (weather.js) — omitting them
      // let guarded/far-from-peak morning cards grade B in the ledger: 2026-07-13
      // calibration on 539 settled decisions found grade B MAE 9.4°F (all 11 were
      // pre-guard degenerate mornings) vs A 0.8, C 2.7, D 4.6, F 6.3.
      grade: gradeAnalogBelief(card, { guarded: guard.guarded, hrsToPeak }).grade,
      peak_locked: card.peak_locked, lock_note: card.lock_note || null,
      upstream: card.upstream_audit && card.upstream_audit.length
        ? card.upstream_audit.map(a => ({ station: a.station, deficit: a.deficit })) : null,
      sizing: sizingCard ? { point: round1(sizingCard.dist.mean()), bin_probs: sizingCard.bin_probs, note: sizingCard.tilt_note } : null,
    };
    const divergence = bayes ? round1(d.mean() - bayes.point) : null;
    // NO-floor scan (2026-07-21 reorientation): sell the bottom bucket the day
    // clears with near-certainty; the monotonic high means it locks (early exit)
    // the instant the trace prints past the ceiling. Uses the SIZING card's tilted
    // bin_probs (market-aware) when available — the floor bet is about beating the
    // book, so the informed distribution is the right input. Attach the top
    // candidate + all evaluated rows to the card and the logged decision.
    const floorProbs = (sizingCard || card).bin_probs;
    let nofloorScan = { candidates: [], evaluated: [] };
    try {
      if (Object.keys(books).length && floorProbs && Object.keys(floorProbs).length)
        nofloorScan = scanNoFloor(books, floorProbs, c.maxSoFarCli ?? c.maxSoFar ?? null);
    } catch (e) { errors.push(`nofloor ${c.station}: ${String(e?.message || e)}`); }
    const nofloor = { top: nofloorScan.candidates[0] || null, candidates: nofloorScan.candidates,
      evaluated: nofloorScan.evaluated, max_so_far: round1(c.maxSoFarCli ?? c.maxSoFar ?? null) };
    // AccuWeather forward-log leg (2026-07-17): same asof as bayes/claude/nws so the
    // accu_report comparison is matched-pair. Quota-capped, city- and hour-gated;
    // a fetch failure logs the error but never blocks the decision write.
    let accu = null;
    const accuApiKey = process.env.ACCUWEATHER_API_KEY;
    if (store && accuApiKey && accuCityAllowed(c.name) && accuHourAllowed(localHour(c.tz))) {
      try {
        accu = await accuImpliedHigh(store, accuApiKey,
          { station: c.station, tz: c.tz, maxSoFarF: c.maxSoFarCli ?? c.maxSoFar ?? null });
      } catch (e) { errors.push(`accu ${c.station}: ${String(e?.message || e)}`); }
    }
    out.push({ city: c.name, station: c.station, claude, bayes, market, divergence, nofloor });
    if (store) {
      const date = localDate(c.tz);
      // Surface write failures instead of swallowing them — a silent .catch here is
      // exactly what let the store sit empty without any signal.
      try {
        await store.setJSON(`dec/${c.station}/${date}/${String(localHour(c.tz)).padStart(2, "0")}.json`,
          { type: "decision", city: c.name, station: c.station, cli: c.cli || null, contract_date: date, asof: now,
            claude, bayes, market, nws: c.forecastHighF ?? c.nwsHighF ?? null, accu, nofloor });
        logged++;
      } catch (e) {
        errors.push(`${c.station}: ${String(e?.message || e)}`);
      }
    }
  }
  if (errors.length) console.log(`[claude-predict] ${errors.length} write errors: ${errors.slice(0, 3).join("; ")}`);
  if (analogStarved.length) console.log(`[claude-predict] ${analogStarved.length} stations with NO prior-day analogs: ${analogStarved.join(",")}`);
  return { ok: true, mode: "predict", asof: now, count: out.length, logged, errors,
           analog_starved: analogStarved, cities: out };
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
  const mn = text.match(/^\s*MINIMUM\s+(-?\d+)/im);
  return { coversDate, isPartial, maxF: m ? parseInt(m[1], 10) : null,
           minF: mn ? parseInt(mn[1], 10) : null };
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

// AccuWeather vs bayes/claude/nws on settled decisions (matched-pair by asof).
// Only decision records that actually carry an accu leg are scored, so the report
// is empty until ACCUWEATHER_API_KEY is set and the cron has logged through a
// settle. Scans the last `days` of settled dates to bound blob reads.
export async function runAccuReport(days = 14) {
  const store = getStore(STORE);
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const { blobs: settleBlobs } = await store.list({ prefix: "settle/" });
  const cliMaxByKey = {};
  for (const b of settleBlobs || []) {
    const [, station, dateJson] = b.key.split("/");
    const date = dateJson.replace(/\.json$/, "");
    if (date < cutoff) continue;
    const s = await store.get(b.key, { type: "json" }).catch(() => null);
    if (s?.cli_max != null) cliMaxByKey[`${station}|${date}`] = s.cli_max;
  }
  const { blobs: decBlobs } = await store.list({ prefix: "dec/" });
  const decisions = [];
  for (const b of decBlobs || []) {
    const [, station, date] = b.key.split("/");
    if (cliMaxByKey[`${station}|${date}`] == null) continue;
    const d = await store.get(b.key, { type: "json" }).catch(() => null);
    if (d?.accu?.implied_high != null) decisions.push(d);
  }
  const report = scoreAccuDecisions(decisions, cliMaxByKey);
  return { ok: true, mode: "accu_report", days, settled_days: Object.keys(cliMaxByKey).length,
           scored_decisions: report.overall.accu.n, ...report };
}

// Live NO-floor board: newest logged decision per station, its floor candidates
// ranked across all cities. This is the reoriented primary output — "where can I
// sell the floor for >=20% with near-certainty and an early exit today". Fast
// (blob reads only). Re-derives candidates from the stored scan so a threshold
// override (?min_return=, ?min_win=) re-filters without a recompute.
export async function runNoFloor(opts = {}) {
  const store = getStore(STORE);
  const { blobs } = await store.list({ prefix: "dec/" });
  const best = {};
  for (const b of blobs || []) {
    const parts = b.key.split("/");
    if (parts.length < 4) continue;
    const [, station, date, hourFile] = parts;
    const sort = `${date} ${hourFile.replace(".json", "")}`;
    if (!best[station] || sort > best[station].sort) best[station] = { key: b.key, sort };
  }
  const recs = (await Promise.all(Object.values(best).map(({ key }) =>
    store.get(key, { type: "json" }).catch(() => null)))).filter(Boolean);
  const minReturn = opts.minReturn, minWin = opts.minWinProb;
  const board = [];
  for (const rec of recs) {
    const nf = rec.nofloor;
    if (!nf) continue;
    // Re-filter the stored evaluation if the caller tightened/loosened the gates.
    let cands = nf.candidates || [];
    if (minReturn != null || minWin != null) {
      cands = (nf.evaluated || []).filter(o => !o.already_locked &&
        (minReturn == null || (o.return_pct != null && o.return_pct >= minReturn * 100)) &&
        (minWin == null || (o.p_lock != null && o.p_lock >= minWin)))
        .sort((a, b) => (b.ev_profit ?? -1) - (a.ev_profit ?? -1));
    }
    for (const c of cands) {
      board.push({ city: rec.city || rec.station, station: rec.station, contract_date: rec.contract_date,
        asof: rec.asof, max_so_far: nf.max_so_far, ...c });
    }
  }
  board.sort((a, b) => (b.ev_profit ?? -1) - (a.ev_profit ?? -1));
  return { ok: true, mode: "nofloor",
           gates: { min_return_pct: (minReturn ?? MIN_RETURN) * 100, min_win_prob: minWin ?? MIN_WIN_PROB },
           count: board.length, board };
}

// Score the logged NO-floor picks against CLI settles: hit rate + realized return,
// so "near guaranteed 20%" is measured, not asserted. Picks = the top candidate of
// each settled decision (the one the strategy would actually have taken).
export async function runNoFloorReport(days = 21) {
  const store = getStore(STORE);
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const { blobs: settleBlobs } = await store.list({ prefix: "settle/" });
  const cliMaxByKey = {};
  for (const b of settleBlobs || []) {
    const [, station, dateJson] = b.key.split("/");
    const date = dateJson.replace(/\.json$/, "");
    if (date < cutoff) continue;
    const s = await store.get(b.key, { type: "json" }).catch(() => null);
    if (s?.cli_max != null) cliMaxByKey[`${station}|${date}`] = s.cli_max;
  }
  // One pick per settled station-day: the EARLIEST decision that had a floor
  // candidate (entry is a morning act, and the earliest fill carries the most
  // premium). Dedup by station|date keeping the lowest hour.
  const { blobs: decBlobs } = await store.list({ prefix: "dec/" });
  const byKey = {};
  for (const b of decBlobs || []) {
    const parts = b.key.split("/");
    if (parts.length < 4) continue;
    const [, station, date, hourFile] = parts;
    if (cliMaxByKey[`${station}|${date}`] == null) continue;
    const hour = hourFile.replace(".json", "");
    const k = `${station}|${date}`;
    if (!byKey[k] || hour < byKey[k].hour) byKey[k] = { key: b.key, hour };
  }
  const picks = [];
  for (const { key } of Object.values(byKey)) {
    const d = await store.get(key, { type: "json" }).catch(() => null);
    const top = d?.nofloor?.top;
    if (top && top.no_ask != null) picks.push({ station: d.station, contract_date: d.contract_date, ...top });
  }
  const report = scoreNoFloor(picks, cliMaxByKey);
  return { ok: true, mode: "nofloor_report", days, settled_days: Object.keys(cliMaxByKey).length, ...report };
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
