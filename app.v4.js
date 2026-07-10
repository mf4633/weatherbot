const grid = document.getElementById("grid");
const statusEl = document.getElementById("status");

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function cardIdFor(name) { return `card-${slugify(name)}`; }
function cityLink(name) {
  if (!name || name === "—") return name || "—";
  return `<a class="city-link" href="#${cardIdFor(name)}">${name}</a>`;
}

// Cities the model runs on but Kalshi does not list (kept in sync with kalshi.js CITY_TO_KALSHI).
const NO_KALSHI_MARKET = new Set([
  "Asheville", "San Diego", "Jacksonville", "Tampa",
  "San Jose", "Columbus", "Charlotte", "Indianapolis"
]);
const CALIBRATING_CITIES = new Set(["Asheville"]);

let jacksonPositionsByCity = {};
let initialHashHandled = false;

// Which city cards are expanded — preserved across the 60s re-render so an open
// card doesn't snap shut. toggle events don't bubble, so listen in capture phase.
const openCards = new Set();
if (grid) grid.addEventListener("toggle", (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.classList.contains("card")) return;
  if (d.open) openCards.add(d.id); else openCards.delete(d.id);
}, true);

function updateJacksonBadges() {
  document.querySelectorAll(".jackson-badge").forEach(el => el.remove());
  for (const [city, info] of Object.entries(jacksonPositionsByCity)) {
    const cardEl = document.getElementById(cardIdFor(city));
    if (!cardEl) continue;
    const sign = info.unrealized >= 0 ? "+" : "−";
    const abs = Math.abs(info.unrealized).toFixed(2);
    const badge = document.createElement("div");
    badge.className = "jackson-badge";
    badge.innerHTML = `🟢 Jackson holds ${info.n} position${info.n === 1 ? "" : "s"} <span class="muted">· $${info.exposure.toFixed(2)} at risk · ${sign}$${abs} unrealized</span>`;
    // Into the summary so it's visible while the card is collapsed.
    (cardEl.querySelector(".card-summary") || cardEl).appendChild(badge);
  }
}

function handleHashOnLoad() {
  if (initialHashHandled) return;
  if (!location.hash || location.hash.length < 2) { initialHashHandled = true; return; }
  if (pulseCard(location.hash.slice(1))) initialHashHandled = true;
}


function fmtF(v) { return v == null ? "—" : `${v.toFixed(1)}°F`; }
// Render a UTC ISO timestamp in the city's local time as "12:30 AM" (no date).
// Used to annotate maxSoFar / minSoFar readings — a 12:30 AM max is a midnight
// carryover from the prior evening's warmth, not the day's eventual peak.
function fmtLocalTime(iso, tz) {
  if (!iso || !tz) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-US",
      { timeZone: tz, hour: "numeric", minute: "2-digit" });
  } catch { return ""; }
}
function fmtPair(arr) { return arr ? `[${arr[0].toFixed(1)}, ${arr[1].toFixed(1)}]` : "—"; }
function fmtSigned(v) {
  if (v == null) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(1)}°F`;
}

function renderCard(c) {
  const cardId = cardIdFor(c.name);
  if (c.error) {
    return `<div class="card error" id="${cardId}">
      <h2>${c.name}</h2>
      <div class="cli">CLI${c.cli} • ${c.station}</div>
      <div class="big">no data</div>
    </div>`;
  }
  // Claude analog high now arrives inline on the /api/weather city (c.claudeHigh),
  // so the card never depends on the separate /api/claude endpoint.
  const cl = c.claudeHigh != null ? { point: c.claudeHigh, peak_locked: c.claudePeakLocked } : null;
  const tempColor = c.mean >= 70 ? "" : "cool";
  // CI bounds are obs-floored at maxSoFarCli / minSoFarCli (Math.floor / Math.ceil of
  // the CLI-grade obs — 5-min weighted + DSM — per weather.js 96e5a62). Compare against
  // those integer bounds, not raw maxSoFar/minSoFar which can sit above the floor by up
  // to a full degree on 1-min ASOS spikes.
  const hiFloorRef = c.maxSoFarCli ?? c.maxSoFar;
  const loCeilRef  = c.minSoFarCli ?? c.minSoFar;
  const hiFloored = hiFloorRef != null && c.ci95 && c.ci95[0] <= hiFloorRef + 0.05;
  const loCeiled  = loCeilRef  != null && c.lowCi95 && c.lowCi95[1] >= loCeilRef - 0.05;
  // Two CLI rows: today-partial (NWS-observed so far today) vs yesterday-final.
  // If lastCLI is today's partial, show as "NWS today so far"; if yesterday's final,
  // show as "last CLI" (the existing copy).
  const cliRows = (() => {
    if (!c.lastCLI || c.lastCLI.maxF == null) {
      return `<div class="row"><span>last CLI</span><span class="muted">parse failed</span></div>`;
    }
    const todayLocal = new Date().toLocaleDateString("en-CA", { timeZone: c.tz });
    const isToday = c.lastCLI.coversDate === todayLocal;
    // Partial CLIs for "today" are typically issued at ~6 AM with a running max captured
    // at whatever time the observed peak hit so far (often a midnight reading like 71°F at
    // 12:06 AM). Once the day is underway, our METAR-derived maxSoFar/minSoFar are always
    // fresher than the issued CLI partial — so suppress the row when ours has surpassed it.
    // Verified bug 2026-05-05 on CLISAT/CLIAUS reading 71/70 (real overnight obs from 12:06 AM)
    // while live KSAT/KAUS were already at 80°F+.
    if (isToday && c.lastCLI.isPartial &&
        c.maxSoFar != null && c.maxSoFar > c.lastCLI.maxF + 0.5) {
      return "";
    }
    const label = isToday ? "NWS today so far (obs)" : `last CLI ${c.lastCLI.isPartial ? "(partial)" : ""}${c.lastCLI.dateLabel ? " " + c.lastCLI.dateLabel : ""}`;
    const valueText = c.lastCLI.minF != null
      ? `max ${c.lastCLI.maxF}°F / min ${c.lastCLI.minF}°F`
      : `${c.lastCLI.maxF}°F`;
    return `<div class="row"><span>${label}</span><span>${valueText}</span></div>`;
  })();
  const biasRow = c.biasF != null
    ? `<div class="row"><span>obs vs forecast bias</span><span class="${c.biasF >= 0 ? 'warm' : 'cool'}">${fmtSigned(c.biasF)}</span></div>`
    : "";
  const methodTag = `<span class="tag">${c.method}</span>`;
  const noMarketTag = NO_KALSHI_MARKET.has(c.name)
    ? `<span class="tag no-market-tag">no Kalshi mkt</span>` : "";
  const calibratingNote = CALIBRATING_CITIES.has(c.name)
    ? `<div class="calibrating-note">calibrating — n=0 logged residuals; prediction is raw NWS + national-shrink prior</div>` : "";
  // Collapsed by default: summary shows name + a compact HIGH peek (Bayesian ·
  // Claude, Claude in orange); click to expand the full detail. Open state is
  // preserved across the 60s refresh via `openCards` (see toggle listener + render).
  // Belief grade A (strongest) … F — how much the analog trusts its own number,
  // from regime fit / analog match / σ / peak proximity. Hover for the reasons.
  const gradeChip = c.claudeGrade
    ? ` <span class="grade g-${c.claudeGrade}" title="${(c.claudeGradeWhy || "").replace(/"/g, "'")}">${c.claudeGrade}</span>` : "";
  // Tri-state Claude marker (build v4): orange number if present; muted "n/a" if the
  // field came back null/absent — so a blank slot can't be confused with stale JS.
  const peek = `<span class="high-peek">HIGH <span class="peek-b">${c.mean.toFixed(0)}°</span> · ${
    cl && cl.point != null ? `<span class="peek-c">${(+cl.point).toFixed(0)}°</span>${gradeChip}` : `<span class="muted">n/a</span>`}${
    cl && cl.peak_locked ? ` <span class="lock-chip" title="peak locked — day's max is in">🔒</span>` : ""}</span>`;
  return `<details class="card" id="${cardId}"${openCards.has(cardId) ? " open" : ""}>
    <summary class="card-summary">
      <div class="card-head">
        <div class="card-title"><h2>${c.name} ${methodTag}${noMarketTag}</h2></div>
        ${peek}
        <span class="chev" aria-hidden="true"></span>
      </div>
    </summary>
    <div class="card-body">
    ${calibratingNote}
    <div class="cli">CLI${c.cli} • ${c.station} • ${c.hrsToPeak}h to peak</div>
    <div class="row"><span>current${c.currentTempSource === "asos1min" ? ` <span class="tag">1-min</span>` : ""}</span><span>${fmtF(c.currentTemp)}${c.currentTempTime ? ` <span class="muted small">at ${fmtLocalTime(c.currentTempTime, c.tz)}${c.currentTempAgeMin != null ? `, ${c.currentTempAgeMin}m ago` : ""}</span>` : c.lastMetarTime ? ` <span class="muted small">at ${fmtLocalTime(c.lastMetarTime, c.tz)}${c.lastMetarAgeMin != null ? `, ${c.lastMetarAgeMin}m ago` : ""}</span>` : ""}</span></div>
    ${c.oneMinAsos ? `<div class="row"><span>1-min ASOS latest <span class="muted small">(n=${c.oneMinAsos.n}, ${c.oneMinAsos.ageMin}m ago)</span></span><span>${fmtF(c.oneMinAsos.latestF)}</span></div>
    <div class="row"><span>1-min ASOS max today</span><span>${fmtF(c.oneMinAsos.maxSoFar)}${c.oneMinAsos.maxTs ? ` <span class="muted small">at ${fmtLocalTime(c.oneMinAsos.maxTs, c.tz)}</span>` : ""}</span></div>
    <div class="row"><span>5-min weighted max <span class="muted small">(CLI settle basis)</span></span><span>${fmtF(c.oneMinAsos.max5MinSoFar)}${c.oneMinAsos.max5MinTs ? ` <span class="muted small">at ${fmtLocalTime(c.oneMinAsos.max5MinTs, c.tz)}</span>` : ""}</span></div>` : ""}
    ${c.coverageWarn ? `<div class="calibrating-note"${c.coverageWarn.warn ? "" : ` style="opacity:.7"`}>${c.coverageWarn.warn ? "⚠ " : ""}settlement monitor ${c.coverageWarn.primaryCov} — cross-check ${c.coverageWarn.neighbor} ${c.coverageWarn.neighborLatestF == null ? "" : fmtF(c.coverageWarn.neighborLatestF) + " "}${c.coverageWarn.rise30F == null ? "" : (c.coverageWarn.rise30F >= 0 ? "+" : "") + c.coverageWarn.rise30F.toFixed(1) + "°F/30min"}${c.coverageWarn.warn ? " — max so far likely stale-low, cut size" : " — airmass flat"}</div>` : ""}
    <div class="row"><span>max so far today (obs)</span><span>${fmtF(c.maxSoFar)}</span></div>
    <div class="row"><span>NWS daily high (forecast)</span><span>${c.forecastHighF == null ? "—" : c.forecastHighF + "°F"}</span></div>
    <div class="row"><span>NWS hourly peak (forecast)</span><span>${c.forecastPeakHourly == null ? "—" : c.forecastPeakHourly + "°F"}</span></div>
    ${biasRow}
    ${cliRows}
    <div class="pred">
      <div class="pred-label">HIGH</div>
      <div class="high-duo">
        <div class="high-col">
          <div class="big ${tempColor}">${c.mean.toFixed(1)}°F</div>
          <div class="model-cap">Bayesian</div>
        </div>
        <div class="high-col">
          ${cl && cl.point != null
            ? `<div class="big claude-num">${(+cl.point).toFixed(1)}°F${gradeChip}${cl.peak_locked ? ` <span class="lock-chip" title="peak locked — day's max is in">🔒</span>` : ""}</div>`
            : `<div class="big claude-num" style="opacity:.5">n/a</div>`}
          <div class="model-cap">Claude analog${c.claudeGrade ? ` · belief ${c.claudeGrade}` : ""}</div>
        </div>
      </div>
      ${c.claudeComponents ? `<div class="ci">claude: T_now ${(+c.claudeComponents.T_now).toFixed(1)}  ${
        Object.entries(c.claudeComponents).filter(([k]) => k !== "T_now" && k !== "R_analog(raw)")
          .map(([k, v]) => `${k.replace("A_", "").replace("R_", "").replace("(eff)", "")} ${v >= 0 ? "+" : ""}${(+v).toFixed(1)}`)
          .join("  ")}${c.claudeGuarded ? `  · <span class="warm">persistence floor</span>` : ""}</div>` : ""}
      <div class="row"><span>std (σ)<span class="muted small"> pre-clamp</span></span><span>${c.std.toFixed(2)}°F</span></div>
      <div class="row ci"><span>68% CI${hiFloored ? `<span class="muted small"> obs-floored</span>` : ""}</span><span>${fmtPair(c.ci68)}</span></div>
      <div class="row ci"><span>95% CI${hiFloored ? `<span class="muted small"> obs-floored</span>` : ""}</span><span>${fmtPair(c.ci95)}</span></div>
    </div>
    ${c.lowMean != null ? `<div class="pred low">
      <div class="pred-label">LOW <span class="tag">${c.lowMethod || ""}</span></div>
      <div class="big ${c.lowMean >= 50 ? '' : 'cool'}">${c.lowMean.toFixed(1)}°F</div>
      <div class="row"><span>min so far today (obs)</span><span>${fmtF(c.minSoFar)}</span></div>
      ${c.oneMinAsos ? `<div class="row"><span>1-min ASOS min today</span><span>${fmtF(c.oneMinAsos.minSoFar)}${c.oneMinAsos.minTs ? ` <span class="muted small">at ${fmtLocalTime(c.oneMinAsos.minTs, c.tz)}</span>` : ""}</span></div>
      <div class="row"><span>5-min weighted min <span class="muted small">(CLI settle basis)</span></span><span>${fmtF(c.oneMinAsos.min5MinSoFar)}${c.oneMinAsos.min5MinTs ? ` <span class="muted small">at ${fmtLocalTime(c.oneMinAsos.min5MinTs, c.tz)}</span>` : ""}</span></div>` : ""}
      <div class="row"><span>NWS daily low (forecast)</span><span>${c.forecastLowF == null ? "—" : c.forecastLowF + "°F"}</span></div>
      <div class="row"><span>std (σ)<span class="muted small"> pre-clamp</span></span><span>${c.lowStd.toFixed(2)}°F</span></div>
      <div class="row ci"><span>68% CI${loCeiled ? `<span class="muted small"> obs-ceiled</span>` : ""}</span><span>${fmtPair(c.lowCi68)}</span></div>
      <div class="row ci"><span>95% CI${loCeiled ? `<span class="muted small"> obs-ceiled</span>` : ""}</span><span>${fmtPair(c.lowCi95)}</span></div>
    </div>` : ""}
    </div>
  </details>`;
}

async function load() {
  try {
    const r = await fetch("/api/weather", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    grid.innerHTML = (j.cities || []).map(renderCard).join("");
    updateJacksonBadges();
    handleHashOnLoad();
    const t = new Date(j.ts || Date.now()).toLocaleTimeString();
    const cacheNote = j.cached ? ` (server cache, ${Math.round(j.ageMs / 1000)}s old)` : "";
    statusEl.textContent = `Updated ${t}${cacheNote} • next client refresh in 60s`;
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}. Retrying…`;
  }
}

function renderFreshness(f) {
  const el = document.getElementById("kalshi-freshness");
  if (!el || !f) return;
  const cacheStr = `cache ${f.cacheAgeSec}s old`;
  // Per-city observation staleness is what the trader actually gates on. The old
  // "oldest forecast issuance" badge fired ~constantly off one western city's overnight
  // NWS lull (a longitude artifact, not a tradeable-staleness signal), so it's demoted to
  // a parenthetical and no longer drives the badge.
  const tradeable = f.tradeableCityCount, total = f.cityCount;
  const cityStr = (total != null)
    ? `${tradeable}/${total} cities fresh`
    : (f.newestForecastAgeMin != null ? `forecast ${f.newestForecastAgeMin}–${f.oldestForecastAgeMin} min old` : "no forecast data");
  // Cache death or EVERY city stale = a real problem. A few stale cities is normal
  // (they're auto-skipped by the trader) so it's a soft warning, not the hard "stale" class.
  const hardStale = f.cacheStale || f.allStale;
  const cls = hardStale ? "stale" : "fresh";
  let note;
  if (hardStale) {
    note = "⚠ Stale data — cache dead or all cities past the freshness gate; edges may be artifacts.";
  } else if (f.staleCount > 0) {
    note = `Fresh; ${f.staleCount} stale (auto-skipped): ${(f.staleCities || []).join(", ")}.`;
  } else {
    note = "Data fresh; edges reflect current forecast.";
  }
  const issuanceStr = f.newestForecastAgeMin != null
    ? ` · NWS issuance ${f.newestForecastAgeMin}–${f.oldestForecastAgeMin} min`
    : "";
  el.className = cls;
  el.textContent = `${cacheStr} · ${cityStr} · ${note}${issuanceStr}`;
}

// Trader gates — kept in lockstep with netlify/functions/jackson_trader.js so the
// UI can explain WHY a top-edge candidate didn't fire even when the trader cycle
// didn't log it in `skipped` (the trader pre-filters by EV/Kelly/price/volume
// before the skip-loop). Update both files when these change.
const TEMP_GATES = {
  MIN_EDGE_HIGH: 0.28,              // 2026-06-13: tightened with trader. See jackson_trader.js.
  // Full replay (data_models.json): loose baseline ~24% ROI; tight 69.2% ROI (both 90d and 30d windows).
  // ~3× ROI, fewer bets. File restored to these values.
  MIN_EDGE_LOW: 0.28,
  MIN_HALF_KELLY: 0.20,
  MIN_PRICE: 0.10,
  MIN_VOLUME: 20,
  P_WIN_CAP: 0.95,                  // 2026-05-15 Bayesian humility cap
  LOW_PAUSED:  new Set(["San Antonio", "Phoenix"]),
  HIGH_PAUSED: new Set(),
  // city|variable → halfKelly multiplier. Mirror of SOFT_REOPEN_DERATE in
  // netlify/functions/jackson_trader.js — keep in sync.
  SOFT_REOPEN: new Map([
    ["Los Angeles|high", 0.5],
    ["Houston|low", 0.5]
  ])
};
const RAIN_GATES = {
  MIN_EDGE: 0.10,
  MIN_HALF_KELLY: 0.05,
  MIN_PRICE: 0.04,
  MIN_VOLUME: 20,
  REQUIRE_KIND: "daily-binary"   // monthly disabled (bankroll-protection mode)
};

// Map cryptic trader reason codes → human-readable badge text.
const REASON_LABEL = {
  "out-of-cash":                "out of cash",
  "low-city-paused":            "LOW paused for this city",
  "high-city-paused":           "HIGH paused for this city",
  "forecast-stale":             "forecast stale",
  "city-not-in-kalshi-data":    "city missing in Kalshi data",
  "event-not-listed-on-kalshi": "event not listed on Kalshi",
  "already-held":               "already held",
  "in-cooldown":                "in 60-min cooldown after sell",
  "event-side-stack-cap":       "event-side stack cap reached",
  "city-var-cooldown":          "city-var 60-min cooldown",
  "tile-conflict":              "tile conflict (dual-loss risk)",
  "bucket-margin-thin":         "bucket margin thin (vs obs)",
  "sigma-margin-thin":          "σ-bucket margin thin",
  "tail-posterior-skip":        "tail posterior < 10%",
  "kelly-lcb-shrink":           "Kelly-LCB shrink rejected EV",
  "no-strike-margin-thin":      "NO-strike margin thin",
  "bucket-above-obs":           "B-bucket already past observed",
  "pwin-cap-exceeded":          "pWin > 0.95 (humility cap)",
  "synoptic-coverage-degraded": "synoptic coverage degraded",
  "kalshi-rejected":            "Kalshi rejected order",
  "no-spare-capacity":          "no spare slots (cap 30)",
  "cap-days-budget":            "capital-days budget full",
  "city-kind-cooldown":         "city-kind 60-min cooldown"
};

// Cached decision maps populated by loadTraderDecisions(). Keys:
//   temp: `${city}|${variable}|${tickerCode}|${side}`   (side uppercase)
//   rain: `${fullTicker}|${side}`
let TEMP_DECISIONS = { map: {}, stamp: null, error: null };
let RAIN_DECISIONS = { map: {}, stamp: null, error: null };

// Live Kalshi account index, populated by loadJackson(). Lets renderDecisionCell
// tell a CONFIRMED fill apart from an accepted-but-unfilled limit order. Keys are
// `${fullTicker}__${SIDE}` (side uppercase). `loaded` stays false until /api/jackson
// has returned successfully — while false, decision cells fall back to the raw
// "purchased" label rather than mislabeling everything as unfilled.
let JACKSON_LIVE = { held: new Set(), filled: new Set(), resting: new Set(), loaded: false };
const liveKey = (ticker, side) => `${ticker}__${String(side || "").toUpperCase()}`;
// Last candidate bets rendered by loadKalshi, so loadJackson can re-render the
// decision cells once the live account index lands (the two loaders are async and
// uncoordinated; loadKalshi often finishes first on a cold page load).
let LAST_TEMP_BETS = { high: [], low: [] };

function pickLatestActiveCycle(entries) {
  // Just take the newest cycle. Empty placements+skipped is itself informative —
  // means every candidate failed the pre-filter (which we'll classify locally
  // from gate constants), and the cycle stamp still confirms the trader is running.
  if (!entries || !entries.length) return null;
  return entries[0];
}

async function loadTraderDecisions() {
  // Two endpoints in parallel; either failure leaves that side's map empty.
  const [tempRes, rainRes] = await Promise.allSettled([
    fetch("/api/trader_log?limit=10", { cache: "no-store" }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
    fetch("/api/rain_trader_log?limit=10", { cache: "no-store" }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
  ]);

  TEMP_DECISIONS = { map: {}, stamp: null, error: null };
  if (tempRes.status === "fulfilled") {
    const entries = (tempRes.value.entries || []);
    const latest = entries[0];
    if (latest) TEMP_DECISIONS.stamp = latest.ranAtUTC;
    // Merge across the last N cycles so candidates that fell out of the topBets
    // pool for one cycle (and are therefore absent from its placements/skipped
    // arrays) still show their most-recent decision instead of "pending next
    // cycle". Iterate OLDEST → newest so newer cycles overwrite older entries
    // for the same key. Each entry stamps cycleAtUTC so the UI can age it.
    for (let i = entries.length - 1; i >= 0; i--) {
      const cycle = entries[i];
      const cycleAt = cycle.ranAtUTC;
      for (const p of (cycle.placements || [])) {
        const code = p.bucketCode || (p.ticker || "").split("-").pop();
        const variable = p.variable
          || (/^KXLOW/i.test(p.ticker) ? "low"
              : /^KXHIGH/i.test(p.ticker) ? "high" : null);
        const side = (p.side || "").toUpperCase();
        const entry = {
          status: p.ok ? "bought" : "rejected",
          stake: p.stake_dollars, count: p.count, priceCents: p.priceCents,
          pWin: p.pWin, halfKelly: p.halfKelly, ev: p.ev,
          softReopen: p.softReopen ?? null,
          reason: p.ok ? null : "kalshi-rejected",
          detail: p.ok ? null : "order not accepted",
          // Full Kalshi ticker + side so renderDecisionCell can reconcile the
          // "bought" status (= order ACCEPTED, res.ok) against the live account.
          // A limit order can be accepted yet rest unfilled and expire (15-min TTL),
          // which the reconcile loop later deletes as a phantom — but this frozen
          // cycle-log row would otherwise keep claiming "purchased $X" forever.
          ticker: p.ticker || null,
          side,
          cycleAtUTC: cycleAt
        };
        if (p.city) TEMP_DECISIONS.map[`${p.city}|${variable}|${code}|${side}`] = entry;
        TEMP_DECISIONS.map[`*|${variable}|${code}|${side}`] = entry;
      }
      for (const s of (cycle.skipped || [])) {
        const key = `${s.city}|${s.variable || "high"}|${s.ticker}|${(s.side || "").toUpperCase()}`;
        TEMP_DECISIONS.map[key] = {
          status: s.reason === "kalshi-rejected" ? "rejected" : "skipped",
          reason: s.reason, detail: s,
          pWin: s.pWin, halfKelly: s.halfKelly, ev: s.ev,
          cycleAtUTC: cycleAt
        };
      }
    }
  } else {
    TEMP_DECISIONS.error = String(tempRes.reason);
  }

  RAIN_DECISIONS = { map: {}, stamp: null, error: null };
  if (rainRes.status === "fulfilled") {
    const entries = (rainRes.value.entries || []);
    const latest = entries[0];
    if (latest) RAIN_DECISIONS.stamp = latest.ranAtUTC;
    for (let i = entries.length - 1; i >= 0; i--) {
      const cycle = entries[i];
      const cycleAt = cycle.ranAtUTC;
      for (const p of (cycle.placements || [])) {
        const key = `${p.ticker}|${(p.side || "").toUpperCase()}`;
        RAIN_DECISIONS.map[key] = {
          status: p.ok ? "bought" : "rejected",
          stake: p.stake_dollars, count: p.count, priceCents: p.priceCents,
          pWin: p.pWin, halfKelly: p.halfKelly, ev: p.ev,
          reason: p.ok ? null : "kalshi-rejected",
          detail: p.ok ? null : "order not accepted",
          cycleAtUTC: cycleAt
        };
      }
      for (const s of (cycle.skipped || [])) {
        const key = `${s.ticker}|${(s.side || "").toUpperCase()}`;
        RAIN_DECISIONS.map[key] = {
          status: s.reason === "kalshi-rejected" ? "rejected" : "skipped",
          reason: s.reason, detail: s,
          pWin: s.pWin, halfKelly: s.halfKelly, ev: s.ev,
          cycleAtUTC: cycleAt
        };
      }
    }
  } else {
    RAIN_DECISIONS.error = String(rainRes.reason);
  }
}

function fmtCycleStamp(iso) {
  if (!iso) return "no recent cycle data";
  const d = new Date(iso);
  const ageMin = Math.round((Date.now() - d.getTime()) / 60000);
  return `last cycle ${d.toLocaleTimeString()} (${ageMin} min ago)`;
}

function renderDecisionStamps() {
  const high = document.getElementById("kalshi-decision-stamp");
  if (high) {
    const e = TEMP_DECISIONS.error;
    const s = TEMP_DECISIONS.stamp;
    high.textContent = e
      ? `Trader log unavailable: ${e}`
      : `Temp trader (every 5 min) — ${fmtCycleStamp(s)}.`;
  }
  const rain = document.getElementById("kalshi-rain-decision-stamp");
  if (rain) {
    const e = RAIN_DECISIONS.error;
    const s = RAIN_DECISIONS.stamp;
    rain.textContent = e
      ? `Rain trader log unavailable: ${e}`
      : `Rain trader (every 30 min) — ${fmtCycleStamp(s)}.`;
  }
}

// Look up a temp bet's decision. Match priority:
//   1. exact (city|var|code|side) from skip log
//   2. wildcard (*|var|code|side) from placement log (placement records lack city)
function lookupTempDecision(b) {
  const variable = b.variable || "high";
  const side = (b.side || "").toUpperCase();
  const exact = `${b.city}|${variable}|${b.ticker}|${side}`;
  if (TEMP_DECISIONS.map[exact]) return TEMP_DECISIONS.map[exact];
  const partial = `*|${variable}|${b.ticker}|${side}`;
  if (TEMP_DECISIONS.map[partial]) return TEMP_DECISIONS.map[partial];
  return null;
}

function lookupRainDecision(b) {
  const key = `${b.ticker}|${(b.side || "").toUpperCase()}`;
  return RAIN_DECISIONS.map[key] || null;
}

// Pre-filter classifier for temp bets the trader silently dropped before logging.
// Mirrors the `qualifying` filter at jackson_trader.js:856-858 plus city-pause sets.
function classifyTempPreFilter(b) {
  const variable = b.variable || "high";
  const minEdge = variable === "low" ? TEMP_GATES.MIN_EDGE_LOW : TEMP_GATES.MIN_EDGE_HIGH;
  if (b.ev < minEdge) {
    return { status: "below", reason: `edge ${(b.ev*100).toFixed(1)}¢ < ${(minEdge*100).toFixed(0)}¢ floor (${variable.toUpperCase()})` };
  }
  if (b.halfKelly < TEMP_GATES.MIN_HALF_KELLY) {
    return { status: "below", reason: `half-Kelly ${(b.halfKelly*100).toFixed(1)}% < ${(TEMP_GATES.MIN_HALF_KELLY*100).toFixed(0)}% floor` };
  }
  if (b.price < TEMP_GATES.MIN_PRICE) {
    return { status: "below", reason: `price ${(b.price*100).toFixed(0)}¢ < ${(TEMP_GATES.MIN_PRICE*100).toFixed(0)}¢ floor` };
  }
  if (b.volume != null && b.volume < TEMP_GATES.MIN_VOLUME) {
    return { status: "below", reason: `volume ${Math.round(b.volume)} < ${TEMP_GATES.MIN_VOLUME} floor` };
  }
  const softReopen = TEMP_GATES.SOFT_REOPEN.get(`${b.city}|${variable}`);
  if (softReopen != null && softReopen < 1.0) {
    const pct = Math.round(softReopen * 100);
    return { status: "pending", reason: `qualified — ${pct}% soft-reopen size, awaiting next 5-min cycle` };
  }
  return { status: "pending", reason: "qualified — awaiting next 5-min cycle" };
}

function classifyRainPreFilter(b) {
  if (b.kind !== RAIN_GATES.REQUIRE_KIND) {
    return { status: "below", reason: "monthly disabled (bankroll-protection mode)" };
  }
  if (b.ev_net < RAIN_GATES.MIN_EDGE) {
    return { status: "below", reason: `edge ${(b.ev_net*100).toFixed(1)}¢ < ${(RAIN_GATES.MIN_EDGE*100).toFixed(0)}¢ floor` };
  }
  if (b.halfKelly < RAIN_GATES.MIN_HALF_KELLY) {
    return { status: "below", reason: `half-Kelly ${(b.halfKelly*100).toFixed(1)}% < ${(RAIN_GATES.MIN_HALF_KELLY*100).toFixed(0)}% floor` };
  }
  if (b.price < RAIN_GATES.MIN_PRICE) {
    return { status: "below", reason: `price ${(b.price*100).toFixed(0)}¢ < ${(RAIN_GATES.MIN_PRICE*100).toFixed(0)}¢ floor` };
  }
  if (b.volume != null && b.volume < RAIN_GATES.MIN_VOLUME) {
    return { status: "below", reason: `volume ${Math.round(b.volume)} < ${RAIN_GATES.MIN_VOLUME} floor` };
  }
  return { status: "pending", reason: "qualified — awaiting next 30-min cycle" };
}

// Returns "(Xm ago)" tag when the matched cycle is older than the dashboard's
// latest stamp by more than one cycle width. Empty string for fresh entries.
function ageTagFromCycle(cycleAtUTC) {
  if (!cycleAtUTC) return "";
  const ageMin = Math.round((Date.now() - new Date(cycleAtUTC).getTime()) / 60000);
  if (ageMin < 6) return "";  // within one normal cycle width — treat as current
  return `(${ageMin}m ago)`;
}

// Compose the inline <span class="decision …"> cell. Decision = matched cycle log
// entry if present, else local pre-filter classification.
function renderDecisionCell(matched, preFilter, traderStamp) {
  if (matched) {
    if (matched.status === "bought") {
      const softTag = matched.softReopen != null && matched.softReopen < 1.0
        ? ` (½ soft-reopen)` : "";
      const stakeStr = `$${(matched.stake ?? 0).toFixed(2)}`;
      const baseTitle = `${matched.count} contracts @ ${matched.priceCents}¢ · pWin ${(matched.pWin*100||0).toFixed(1)}% · half-Kelly ${(matched.halfKelly*100||0).toFixed(1)}% · ev +$${(matched.ev||0).toFixed(2)}${matched.softReopen != null ? " · soft-reopen × " + matched.softReopen : ""}`;
      // "bought" means Kalshi ACCEPTED the limit order (res.ok), NOT that it filled.
      // Reconcile against the live account: only call it "purchased" if we actually
      // hold the position or have a buy fill on it. An accepted order can rest unfilled
      // and expire (15-min TTL), leaving a phantom that shows no position in the account.
      const key = matched.ticker ? liveKey(matched.ticker, matched.side) : null;
      const confirmed = key && (JACKSON_LIVE.held.has(key) || JACKSON_LIVE.filled.has(key));
      const resting = key && JACKSON_LIVE.resting.has(key);
      // Only downgrade the label when we have live data AND the ticker is identifiable.
      // Without that, fall back to the original "purchased" text to avoid false negatives.
      if (JACKSON_LIVE.loaded && key && !confirmed) {
        const ageMin = matched.cycleAtUTC
          ? (Date.now() - new Date(matched.cycleAtUTC).getTime()) / 60000 : Infinity;
        let label, sub;
        if (resting) {
          label = `ordered ${stakeStr}`; sub = "resting · unfilled";
        } else if (ageMin > 15) {           // past the 15-min limit-order expiration
          label = `ordered ${stakeStr}`; sub = "expired · unfilled";
        } else {
          label = `ordered ${stakeStr}`; sub = "awaiting fill";
        }
        const title = `Order accepted but no position/fill found in the live account — ${sub}. ${baseTitle}`;
        return `<span class="decision unfilled" title="${escapeAttr(title)}">${label} <span class="muted small">(${sub})</span></span>`;
      }
      const text = `purchased ${stakeStr}${softTag}`;
      return `<span class="decision bought" title="${escapeAttr(baseTitle)}">${text}</span>`;
    }
    if (matched.status === "rejected") {
      const text = "Kalshi rejected";
      const title = `${matched.reason || ""}${matched.detail ? " — " + JSON.stringify(matched.detail) : ""}`;
      return `<span class="decision rejected" title="${escapeAttr(title)}">${text}</span>`;
    }
    // skipped
    const label = REASON_LABEL[matched.reason] || matched.reason || "skipped";
    const detailParts = [];
    if (matched.detail && typeof matched.detail === "object") {
      // Pluck the most informative numeric fields per reason.
      const d = matched.detail;
      if (d.marginF != null && d.thresholdF != null) detailParts.push(`margin ${d.marginF}°F vs ${d.thresholdF}°F`);
      if (d.gapF != null) detailParts.push(`gap ${d.gapF}°F`);
      if (d.pWinPosterior != null) detailParts.push(`pPost ${d.pWinPosterior}`);
      if (d.pLCB != null) detailParts.push(`pLCB ${d.pLCB}`);
      if (d.evLCB != null) detailParts.push(`evLCB ${d.evLCB}`);
      if (d.halfKellyLCB != null) detailParts.push(`hKellyLCB ${d.halfKellyLCB}`);
      if (d.ageMin != null) detailParts.push(`forecast ${d.ageMin}min old`);
      if (d.coverage != null) detailParts.push(`coverage=${d.coverage}`);
      if (d.eventTicker != null) detailParts.push(d.eventTicker);
      if (d.detail != null && typeof d.detail !== "object") detailParts.push(String(d.detail));
    }
    // When the matched entry is from an older cycle (candidate dropped out of
    // the latest cycle's pool), tag the cell with cycle age so the staleness
    // is visible. Threshold: any cycle older than the latest stamp.
    const ageTag = ageTagFromCycle(matched.cycleAtUTC);
    const fullLabel = ageTag ? `${label} ${ageTag}` : label;
    const title = detailParts.length ? `${fullLabel} — ${detailParts.join(" · ")}` : fullLabel;
    return `<span class="decision skipped" title="${escapeAttr(title)}">${fullLabel}</span>`;
  }
  // 2026-05-28: distinguish genuine "pending next cycle" from "trader is paused / dead /
  // out of cash so no cycle is coming". If the latest trader cycle stamp is > 10 min old
  // (cron is 5min, so 10min = at least one missed cycle), label as paused, not pending.
  // This stops the dashboard from claiming a queued decision when in fact no cycles are
  // running. Caller passes the relevant store's .stamp (TEMP_DECISIONS or RAIN_DECISIONS).
  let text, cls, title;
  if (preFilter.status === "below") {
    text = preFilter.reason; cls = "below"; title = preFilter.reason;
  } else {
    const stampAge = traderStamp ? (Date.now() - new Date(traderStamp).getTime()) / 60000 : Infinity;
    if (stampAge > 10) {
      text = Number.isFinite(stampAge) ? `trader paused (${Math.round(stampAge)}m stale)` : "trader paused (no recent cycle)";
      cls = "below";   // visually de-emphasize — this is NOT a queued decision
      title = `Last trader cycle ${Number.isFinite(stampAge) ? Math.round(stampAge)+' min ago' : 'unknown'}. Disarmed (KALSHI_TRADING_LIVE), out of cash, or cron stalled.`;
    } else {
      text = "pending next cycle"; cls = "pending"; title = preFilter.reason;
    }
  }
  // Truncate long reasons for inline display; full text in tooltip.
  const displayText = text.length > 36 ? text.slice(0, 33) + "…" : text;
  return `<span class="decision ${cls}" title="${escapeAttr(title)}">${displayText}</span>`;
}

function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function renderKalshiRows(bets, tbodyId, colspan) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  if (!bets.length) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="muted">No +EV bets above 2¢ edge right now.</td></tr>`;
    return;
  }
  tbody.innerHTML = bets.map((b, i) => {
    const muSig = (b.modelMean != null) ? `${b.modelMean.toFixed(1)} ± ${b.modelStd.toFixed(1)}` : "—";
    const evPerDay = b.evPerDay != null ? b.evPerDay : b.ev;
    const matched = lookupTempDecision(b);
    // City-pause is a pre-filter that DOES flow through the skip-loop (so will appear in matched).
    // But if matched isn't set, also surface the pause as a below-floor reason for completeness.
    let pre = classifyTempPreFilter(b);
    if (!matched && pre.status === "pending") {
      const variable = b.variable || "high";
      if (variable === "low" && TEMP_GATES.LOW_PAUSED.has(b.city))   pre = { status: "below", reason: "LOW paused for this city (audit)" };
      else if (variable === "high" && TEMP_GATES.HIGH_PAUSED.has(b.city)) pre = { status: "below", reason: "HIGH paused for this city (audit)" };
      // SOFT_REOPEN cities (e.g. LA HIGH) fall through and stay "pending — ½ soft-reopen"
      // as set by classifyTempPreFilter above.
    }
    const decisionCell = renderDecisionCell(matched, pre, TEMP_DECISIONS.stamp);
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${b.city}</td>
        <td class="muted">${muSig}°F</td>
        <td>${b.bucket || b.ticker || "—"}</td>
        <td class="${b.side === 'YES' ? 'warm' : 'cool'}">${b.side}</td>
        <td>$${b.price.toFixed(2)}</td>
        <td>${(b.p_model * 100).toFixed(1)}%</td>
        <td>+$${b.ev.toFixed(2)}</td>
        <td>+$${evPerDay.toFixed(3)}</td>
        <td><strong>${(b.halfKelly * 100).toFixed(1)}%</strong></td>
        <td>${Math.round(b.volume).toLocaleString()}</td>
        <td>${decisionCell}</td>
      </tr>`;
  }).join("");
}

// "Where's the trade?" classifier — encodes the betting doctrine: the best setups
// are MODEL AGREEMENT + MARKET DISAGREEMENT (two decorrelated engines vs a lagging
// book). Wide model divergence is a risk gate, not a buy signal — that's a bimodal
// day where only the corridor bins between the modes are interesting, at small size.
function classifySetup(c) {
  const m = c.model || {};
  const imp = c.impliedHigh && c.impliedHigh.mean != null ? c.impliedHigh.mean : null;
  if (m.claudeHigh == null || m.highMeanBayes == null || imp == null) return null;
  const agree = Math.abs(m.highMeanBayes - m.claudeHigh);
  const div = m.highMean - imp;                      // blend vs market-implied μ
  let cls = "watch", note = "no setup — models and market roughly aligned";
  if (agree <= 1.5 && Math.abs(div) >= 2) { cls = "prime"; note = "models agree, market ≥2°F away — the class-1 setup (two decorrelated engines vs a lagging book)"; }
  else if (agree <= 1.5 && Math.abs(div) >= 1) { cls = "lean"; note = "models agree, market 1–2°F away — small edge, fees bite at mid prices"; }
  else if (agree >= 3) { cls = "corridor"; note = "models split ≥3°F — bimodal day; own the corridor bins between the modes, shrink size, don't bet direction"; }
  return { name: c.name, bayes: +m.highMeanBayes, claude: +m.claudeHigh, grade: m.claudeGrade || null,
           agree, blend: +m.highMean, imp: +imp, div, cls, note };
}

function renderSetups(cities) {
  const el = document.getElementById("kalshi-setups");
  if (!el) return;
  const rows = (cities || []).map(classifySetup).filter(Boolean);
  if (!rows.length) { el.innerHTML = `<p class="sub muted">No cities with both models and a market book right now.</p>`; return; }
  const rank = { prime: 0, lean: 1, corridor: 2, watch: 3 };
  rows.sort((a, b) => (rank[a.cls] - rank[b.cls]) || (Math.abs(b.div) - Math.abs(a.div)));
  const chip = (r) =>
    r.cls === "prime" ? `<span class="setup s-prime" title="${r.note}">PRIME</span>` :
    r.cls === "lean" ? `<span class="setup s-lean" title="${r.note}">lean</span>` :
    r.cls === "corridor" ? `<span class="setup s-corridor" title="${r.note}">corridor</span>` :
    `<span class="setup s-watch" title="${r.note}">—</span>`;
  el.innerHTML = `<div class="table-scroll"><table class="kalshi-table"><thead><tr>
    <th>City</th><th>Bayesian</th><th>Claude</th><th>Δ models</th><th>Market μ</th><th>blend − mkt</th><th>Setup</th>
  </tr></thead><tbody>${rows.map(r => `<tr>
    <td>${cityLink(r.name)}</td>
    <td>${r.bayes.toFixed(1)}°</td>
    <td>${r.claude.toFixed(1)}°${r.grade ? ` <span class="grade g-${r.grade}">${r.grade}</span>` : ""}</td>
    <td>${r.agree.toFixed(1)}°</td>
    <td>${r.imp.toFixed(1)}°</td>
    <td class="${Math.abs(r.div) >= 2 ? "warm" : "muted"}">${r.div >= 0 ? "+" : ""}${r.div.toFixed(1)}°</td>
    <td>${chip(r)}</td></tr>`).join("")}</tbody></table></div>`;
}

async function loadKalshi() {
  // Pull the latest trader-cycle logs first so renderKalshiRows can annotate
  // each candidate with its actual trader disposition (purchased / skipped / below floor).
  await loadTraderDecisions();
  renderDecisionStamps();

  try {
    const r = await fetch("/api/kalshi", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderFreshness(j.freshness);
    renderSetups(j.cities);
    const top = j.topBets || [];
    const highBets = top.filter(b => b.variable === "high" || !b.variable).slice(0, 15);
    const lowBets = top.filter(b => b.variable === "low").slice(0, 15);
    LAST_TEMP_BETS = { high: highBets, low: lowBets };  // cache for loadJackson re-render
    renderKalshiRows(highBets, "kalshi-rows-high", 12);
    renderKalshiRows(lowBets, "kalshi-rows-low", 12);
  } catch (e) {
    for (const id of ["kalshi-rows-high", "kalshi-rows-low"]) {
      const t = document.getElementById(id);
      if (t) t.innerHTML = `<tr><td colspan="12" class="muted">Kalshi load error: ${e.message}</td></tr>`;
    }
  }
  // Rain edges + outlook cards — both fed by a single /api/rain fetch (server-side
  // proxy of rainbot's /api/markets, enriched with per-city gamma stats).
  try {
    const r = await fetch("/api/rain", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderKalshiRainRows((j.topBets || []).slice(0, 20));
    renderRainOutlookGrid(j.cities || []);
  } catch (e) {
    const t = document.getElementById("kalshi-rows-rain");
    if (t) t.innerHTML = `<tr><td colspan="12" class="muted">Rain load error: ${e.message}</td></tr>`;
    const og = document.getElementById("rain-outlook-grid");
    if (og) og.innerHTML = `<p class="muted">Rain outlook load error: ${e.message}</p>`;
  }
}

// Map rainbot's 3-letter city codes to readable names. Mirrors SERIES_LOOKUP in jackson.js
// and rainbot/lib/cities.js — kept short here since the dashboard's the only consumer.
const RAIN_CITY_NAME = {
  NYC: "New York", HOU: "Houston", MIA: "Miami", SEA: "Seattle",
  CHI: "Chicago",  LAX: "Los Angeles", DAL: "Dallas-Fort Worth",
  AUS: "Austin",   DEN: "Denver", SFO: "San Francisco"
};

function fmtIn(v, dp = 2) { return v == null ? "—" : `${v.toFixed(dp)}″`; }
function fmtPairIn(arr, dp = 2) { return arr ? `[${arr[0].toFixed(dp)}, ${arr[1].toFixed(dp)}]″` : "—"; }

function renderRainOutlookGrid(cities) {
  const grid = document.getElementById("rain-outlook-grid");
  if (!grid) return;
  if (!cities.length) {
    grid.innerHTML = `<p class="muted">No rain cities to display.</p>`;
    return;
  }
  grid.innerHTML = cities.map(c => {
    const name = RAIN_CITY_NAME[c.code] || c.code;
    if (c.error) {
      return `<div class="card error"><h2>${name}</h2><div class="big">no data</div></div>`;
    }
    const m = c.monthly || {};
    const stats = m.stats;
    const observed = m.observedSoFar;
    const forecastSum = m.forecastSum;
    const meanTotal = stats?.mean ?? m.meanTotal;
    // Daily forecast (today) — the daily binary's calibrated probability.
    const dailyP = c.daily?.p_model;
    const dailyRow = dailyP != null
      ? `<div class="row"><span>P(any rain today)</span><span>${(dailyP * 100).toFixed(1)}%</span></div>`
      : "";
    return `<div class="card">
      <h2>${name} <span class="tag">rain</span></h2>
      <div class="cli">${c.station || "—"} • monthly gamma</div>
      <div class="row"><span>observed so far this month</span><span>${fmtIn(observed)}</span></div>
      <div class="row"><span>forecast (QPF window)</span><span>${fmtIn(forecastSum)}</span></div>
      ${dailyRow}
      <div class="pred">
        <div class="pred-label">MONTHLY TOTAL</div>
        <div class="big">${fmtIn(meanTotal)}</div>
        <div class="row"><span>mean</span><span>${fmtIn(stats?.mean)}</span></div>
        <div class="row"><span>median</span><span>${fmtIn(stats?.median)}</span></div>
        <div class="row"><span>mode</span><span>${fmtIn(stats?.mode)}</span></div>
        <div class="row"><span>σ <span class="muted small">(gamma std)</span></span><span>${fmtIn(stats?.std)}</span></div>
        <div class="row ci"><span>68% CI</span><span>${fmtPairIn(stats?.ci68)}</span></div>
        <div class="row ci"><span>95% CI</span><span>${fmtPairIn(stats?.ci95)}</span></div>
      </div>
    </div>`;
  }).join("");
}

function renderKalshiRainRows(bets) {
  const tbody = document.getElementById("kalshi-rows-rain");
  if (!tbody) return;
  if (!bets.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="muted">No +EV rain bets above 2¢ net edge right now.</td></tr>`;
    return;
  }
  tbody.innerHTML = bets.map((b, i) => {
    // rainbot threshold: 0 = "any rain" daily binary; otherwise monthly tier "≥ T inches".
    const thresholdLabel = b.kind === "daily-binary" ? "any rain (>0″)" : `≥ ${b.threshold}″`;
    const kindLabel = b.kind === "daily-binary"
      ? `daily <span class="muted small">(${b.holdingDays}d)</span>`
      : `monthly <span class="muted small">(${b.holdingDays}d)</span>`;
    const evPerDay = b.evPerDay != null ? b.evPerDay : (b.ev_net / Math.max(1, b.holdingDays || 1));
    const matched = lookupRainDecision(b);
    const pre = classifyRainPreFilter(b);
    const decisionCell = renderDecisionCell(matched, pre, RAIN_DECISIONS.stamp);
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${b.city}</td>
        <td class="muted">${kindLabel}</td>
        <td>${thresholdLabel}</td>
        <td class="${b.side === 'YES' ? 'warm' : 'cool'}">${b.side}</td>
        <td>$${b.price.toFixed(2)}</td>
        <td>${(b.p_model * 100).toFixed(1)}%</td>
        <td>+$${b.ev_net.toFixed(2)}</td>
        <td>+$${evPerDay.toFixed(3)}</td>
        <td><strong>${(b.halfKelly * 100).toFixed(1)}%</strong></td>
        <td>${b.volume != null ? Math.round(b.volume).toLocaleString() : "—"}</td>
        <td>${decisionCell}</td>
      </tr>`;
  }).join("");
}

function fmtSignedDollars(v) { if (v == null) return "—"; const s = v >= 0 ? "+" : ""; return `${s}$${v.toFixed(2)}`; }
function fmtPctSigned(v) { if (v == null) return "—"; const s = v >= 0 ? "+" : ""; return `${s}${v.toFixed(1)}%`; }
// Paper-trading uses "dollar-bucks" (Đ) — distinct symbol so it can't be misread as real dollars.
function fmtSignedDBks(v) { if (v == null) return "—"; const s = v >= 0 ? "+" : ""; return `${s}Đ${v.toFixed(2)}`; }

async function loadPaper() {
  try {
    const r = await fetch("/api/paper", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const s = j.state || {};
    const bankroll = s.bankroll ?? 0;
    const startBank = 100;
    const pnlPct = (bankroll - startBank) / startBank * 100;
    const roiPct = (s.roi ?? 0) * 100;
    const winRatePct = (s.win_rate ?? 0) * 100;
    const totalSettled = (s.n_bets_total ?? 0);
    const stateEl = document.getElementById("paper-state");
    if (stateEl) {
      const mtm = s.bankroll_mtm ?? bankroll;
      const unr = s.unrealized_pnl ?? 0;
      stateEl.innerHTML = `
        <div class="stat"><div class="stat-label">bankroll (dollar-bucks)</div><div class="stat-val ${bankroll >= startBank ? 'warm' : 'cool'}">Đ${bankroll.toFixed(2)} <span class="muted">(${fmtPctSigned(pnlPct)})</span></div></div>
        <div class="stat"><div class="stat-label">mark-to-market</div><div class="stat-val ${mtm >= startBank ? 'warm' : 'cool'}">Đ${mtm.toFixed(2)}</div></div>
        <div class="stat"><div class="stat-label">unrealized P&L</div><div class="stat-val ${unr >= 0 ? 'warm' : 'cool'}">${fmtSignedDBks(unr)}</div></div>
        <div class="stat"><div class="stat-label">cash free</div><div class="stat-val">Đ${(s.cash_free ?? 0).toFixed(2)}</div></div>
        <div class="stat"><div class="stat-label">in flight</div><div class="stat-val">${s.open_count ?? 0} / ${s.max_concurrent ?? 20}</div></div>
        <div class="stat"><div class="stat-label">stake / bet</div><div class="stat-val">Đ${(s.bet_size_dollars ?? 1).toFixed(2)}</div></div>
        <div class="stat"><div class="stat-label">settled bets</div><div class="stat-val">${totalSettled}</div></div>
        <div class="stat"><div class="stat-label">win rate</div><div class="stat-val">${winRatePct.toFixed(1)}%</div></div>
        <div class="stat"><div class="stat-label">total P&L</div><div class="stat-val ${(s.total_pnl ?? 0) >= 0 ? 'warm' : 'cool'}">${fmtSignedDBks(s.total_pnl ?? 0)}</div></div>
        <div class="stat"><div class="stat-label">ROI</div><div class="stat-val ${roiPct >= 0 ? 'warm' : 'cool'}">${fmtPctSigned(roiPct)}</div></div>
        <div class="stat"><div class="stat-label">sold early</div><div class="stat-val">${s.n_sold_total ?? 0}</div></div>`;
    }
    // Open positions table.
    const open = j.open_bets || [];
    const openEl = document.getElementById("paper-open-wrap");
    if (openEl) {
      if (open.length === 0) {
        openEl.innerHTML = `<p class="muted small">No open positions yet — first bets land when the next 5-min cron fires.</p>`;
      } else {
        openEl.innerHTML = `<table class="paper-table"><thead><tr>
          <th>City</th><th>Var</th><th>Bucket</th><th>Side</th><th>Contracts</th><th>Entry</th><th>Stake</th><th>Mkt now</th><th>Unreal P&L</th><th>Model μ±σ</th><th>Purchased</th>
        </tr></thead><tbody>${open.map(b => {
          const mtm = b.markToMarket;
          const sellPx = mtm?.sellPrice;
          const unr = mtm?.unrealized_pnl;
          const contracts = b.price > 0 ? Math.round(b.stake_dollars / b.price * 10) / 10 : "—";
          const placed = (b.placedAtUTC || "").slice(0, 16).replace("T", " ");
          return `<tr>
            <td>${cityLink(b.city)}</td>
            <td class="muted small">${b.variable || "high"}</td>
            <td>${b.bucket || b.ticker}</td>
            <td class="${b.side === 'YES' ? 'warm' : 'cool'}">${b.side}</td>
            <td>${contracts}</td>
            <td>Đ${b.price.toFixed(2)}</td>
            <td>Đ${b.stake_dollars.toFixed(2)}</td>
            <td class="muted small">${sellPx != null ? 'Đ'+sellPx.toFixed(2) : '—'}</td>
            <td class="${unr == null ? 'muted' : (unr >= 0 ? 'warm' : 'cool')}">${unr != null ? fmtSignedDBks(unr) : '—'}</td>
            <td class="muted small">${b.modelMean != null ? `${b.modelMean.toFixed(b.variable === "rain" ? 2 : 1)}±${b.modelStd.toFixed(b.variable === "rain" ? 2 : 1)}${b.variable === "rain" ? '″' : '°F'}` : "—"}</td>
            <td class="muted small">${placed || "—"}</td>
          </tr>`;
        }).join("")}</tbody></table>`;
      }
    }
    // Recent settled.
    const settled = (j.recent_settled || []).slice(0, 20);
    const settledEl = document.getElementById("paper-settled-wrap");
    if (settledEl) {
      if (settled.length === 0) {
        settledEl.innerHTML = `<p class="muted small">No settled bets yet — first settlements land at city's local 7 AM tomorrow.</p>`;
      } else {
        settledEl.innerHTML = `<table class="paper-table"><thead><tr>
          <th>Date</th><th>City</th><th>Bucket</th><th>Side</th><th>Entry</th><th>Outcome</th><th>Actual</th><th>P&L</th>
        </tr></thead><tbody>${settled.map(s => `<tr>
          <td class="muted small">${s.targetLocalDate || ""}</td>
          <td>${cityLink(s.city)}</td>
          <td>${s.bucket || s.ticker}</td>
          <td class="${s.side === 'YES' ? 'warm' : 'cool'}">${s.side}</td>
          <td>Đ${s.price.toFixed(2)}</td>
          <td class="${s.outcome === 'WIN' ? 'good' : (s.outcome === 'SOLD' ? 'muted' : 'bad')}">${s.outcome}</td>
          <td class="muted small">${s.actualHigh != null ? s.actualHigh + "°F" : (s.sell_price != null ? "@Đ" + s.sell_price.toFixed(2) : "—")}</td>
          <td class="${s.pnl_dollars >= 0 ? 'warm' : 'cool'}">${fmtSignedDBks(s.pnl_dollars)}</td>
        </tr>`).join("")}</tbody></table>`;
      }
    }
    // Per-city aggregate.
    const cities = j.by_city || [];
    const citiesEl = document.getElementById("paper-cities-wrap");
    if (citiesEl) {
      if (cities.length === 0) {
        citiesEl.innerHTML = `<p class="muted small">Per-city breakdown appears after first settlements.</p>`;
      } else {
        citiesEl.innerHTML = `<table class="paper-table"><thead><tr>
          <th>City</th><th>Bets</th><th>Wins</th><th>Sold</th><th>Win%</th><th>Staked</th><th>P&L</th><th>ROI</th>
        </tr></thead><tbody>${cities.map(c => `<tr>
          <td>${cityLink(c.city || c.cli)}</td>
          <td>${c.n}</td><td>${c.wins}</td><td>${c.sold || 0}</td>
          <td>${c.win_rate_pct.toFixed(1)}%</td>
          <td>Đ${c.staked.toFixed(2)}</td>
          <td class="${c.pnl >= 0 ? 'warm' : 'cool'}">${fmtSignedDBks(c.pnl)}</td>
          <td class="${c.roi_pct >= 0 ? 'warm' : 'cool'}">${fmtPctSigned(c.roi_pct)}</td>
        </tr>`).join("")}</tbody></table>`;
      }
    }
  } catch (e) {
    const el = document.getElementById("paper-state");
    if (el) el.innerHTML = `<p class="muted">Paper-trade load error: ${e.message}</p>`;
  }
}

async function loadJackson() {
  const statusEl = document.getElementById("jackson-status");
  const stateEl = document.getElementById("jackson-state");
  const openEl = document.getElementById("jackson-open-wrap");
  const fillsEl = document.getElementById("jackson-fills-wrap");
  const ordersEl = document.getElementById("jackson-orders-wrap");
  if (!statusEl || !stateEl) return;
  try {
    const r = await fetch("/api/jackson", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j.configured) {
      statusEl.textContent = "DORMANT — Kalshi API credentials not yet set. Add KALSHI_KEY_ID and KALSHI_PRIVATE_KEY to Netlify env to activate.";
      statusEl.className = "sub muted";
      stateEl.innerHTML = "";
      openEl.innerHTML = "";
      fillsEl.innerHTML = "";
      if (ordersEl) ordersEl.innerHTML = "";
      return;
    }
    if (j.error) {
      statusEl.textContent = `ERROR: ${j.error}`;
      statusEl.className = "sub";
      stateEl.style.color = "var(--warm)";
      return;
    }
    statusEl.textContent = `Live · fetched ${(j.fetchedAtUTC || "").slice(11, 16)} UTC`;
    statusEl.className = "sub fresh";
    const balDollars = (j.balance?.balance ?? 0) / 100;
    const positions = j.positions?.market_positions || [];
    // Kalshi position fields: position_fp (string of float; sign = direction),
    // market_exposure_dollars (string), realized_pnl_dollars (string).
    const heldPositions = positions
      .map(p => ({ ...p, _qty: parseFloat(p.position_fp || "0"),
                          _exposure: parseFloat(p.market_exposure_dollars || "0") }))
      .filter(p => p._qty !== 0);
    const fills = j.fills?.fills || [];
    const orders = j.orders?.orders || [];

    // Build the live-account index so the candidate decision cells can tell a
    // confirmed fill apart from an accepted-but-unfilled limit order. Side mapping:
    //   position_fp > 0 → long YES, < 0 → long NO (Kalshi convention).
    //   fills carry explicit side ("yes"/"no") and action ("buy"/"sell").
    {
      const held = new Set(), filled = new Set(), resting = new Set();
      for (const p of heldPositions) {
        held.add(liveKey(p.ticker, p._qty > 0 ? "YES" : "NO"));
      }
      for (const f of fills) {
        if ((f.action || "buy") === "buy") filled.add(liveKey(f.ticker, f.side));
      }
      for (const o of orders) {
        if (o.action && o.action !== "buy") continue;
        const rem = o.remaining_count ?? o.count ?? 0;
        if (rem > 0) resting.add(liveKey(o.ticker, o.side));
      }
      JACKSON_LIVE = { held, filled, resting, loaded: true };
      // Re-render the candidate tables now that the live index is fresh, so the
      // reconciled labels appear without waiting for loadKalshi's next 120-s tick.
      if (LAST_TEMP_BETS.high.length) renderKalshiRows(LAST_TEMP_BETS.high, "kalshi-rows-high", 12);
      if (LAST_TEMP_BETS.low.length)  renderKalshiRows(LAST_TEMP_BETS.low, "kalshi-rows-low", 12);
    }

    // Cash committed to resting BUY limit orders. Kalshi reserves this out of `balance`
    // until the order fills or cancels, and it isn't in `portfolio_value` yet (no contracts
    // held), so we add it back below to keep account value stable while orders rest. Sells
    // reserve contracts, not cash, so they don't count here.
    const committedResting = orders.reduce((a, o) => {
      if (o.action && o.action !== "buy") return a;
      const px = (o.side === "yes" ? o.yes_price : o.no_price) || 0;  // cents
      const rem = o.remaining_count ?? o.count ?? 0;
      return a + (px / 100) * rem;
    }, 0);
    const totalExposure = heldPositions.reduce((a, p) => a + p._exposure, 0);
    const mtmByTicker = j.markToMarket || {};
    const totalUnrealized = j.totalUnrealizedPnl ?? 0;
    // Roll up open positions by city for the card badges.
    const posByCity = {};
    for (const p of heldPositions) {
      const m = mtmByTicker[p.ticker] || {};
      const city = m.city;
      if (!city || city === "—") continue;
      if (!posByCity[city]) posByCity[city] = { n: 0, unrealized: 0, exposure: 0 };
      posByCity[city].n++;
      posByCity[city].unrealized += (m.unrealized_pnl || 0);
      posByCity[city].exposure += p._exposure;
    }
    jacksonPositionsByCity = posByCity;
    updateJacksonBadges();
    const totalRealized = j.totalRealizedPnl ?? 0;
    const totalFees = j.totalFeesPaid ?? 0;
    const totalPnl = j.totalPnl ?? (totalRealized + totalUnrealized);
    // cash + reserved-for-resting-buys + at-risk + unrealized. Including committedResting
    // keeps account value stable as cash moves into a resting limit and back on fill/cancel.
    const accountValue = balDollars + committedResting + totalExposure + totalUnrealized;
    stateEl.innerHTML = `
      <div class="stat"><div class="stat-label">free cash</div><div class="stat-val warm">$${balDollars.toFixed(2)}</div></div>
      <div class="stat"><div class="stat-label">in resting orders</div><div class="stat-val ${committedResting > 0 ? '' : 'muted'}">$${committedResting.toFixed(2)}</div></div>
      <div class="stat"><div class="stat-label">capital at risk</div><div class="stat-val">$${totalExposure.toFixed(2)}</div></div>
      <div class="stat"><div class="stat-label">account value</div><div class="stat-val ${accountValue >= 20 ? 'warm' : 'cool'}">$${accountValue.toFixed(2)}</div></div>
      <div class="stat"><div class="stat-label">unrealized P&L</div><div class="stat-val ${totalUnrealized >= 0 ? 'warm' : 'cool'}">${fmtSignedDollars(totalUnrealized)}</div></div>
      <div class="stat"><div class="stat-label">realized P&L</div><div class="stat-val ${totalRealized >= 0 ? 'warm' : 'cool'}">${fmtSignedDollars(totalRealized)}</div></div>
      <div class="stat"><div class="stat-label">total P&L</div><div class="stat-val ${totalPnl >= 0 ? 'warm' : 'cool'}">${fmtSignedDollars(totalPnl)}</div></div>
      <div class="stat"><div class="stat-label">fees paid</div><div class="stat-val muted">$${totalFees.toFixed(2)}</div></div>
      <div class="stat"><div class="stat-label">positions</div><div class="stat-val">${heldPositions.length}</div></div>
      <div class="stat"><div class="stat-label">resting orders</div><div class="stat-val">${orders.length}</div></div>
      <div class="stat"><div class="stat-label">recent fills</div><div class="stat-val">${fills.length}</div></div>`;
    // Resting limit orders — NOT positions (0 contracts owned until filled). Shown so the
    // passive LOW limits (which rest up to 15 min) and their committed cash are visible.
    if (ordersEl) {
      if (orders.length === 0) {
        ordersEl.innerHTML = `<p class="muted small">No resting orders.</p>`;
      } else {
        const nowMs = Date.now();
        ordersEl.innerHTML = `<table class="paper-table"><thead><tr>
          <th>Bucket</th><th>Side</th><th>Action</th><th>Limit</th><th>Contracts</th><th>Committed</th><th>Age</th>
        </tr></thead><tbody>${orders.map(o => {
          const side = (o.side || "").toUpperCase();
          const action = (o.action || "buy").toUpperCase();
          const px = (o.side === "yes" ? o.yes_price : o.no_price) || 0;  // cents
          const rem = o.remaining_count ?? o.count ?? 0;
          const isBuy = (o.action || "buy") === "buy";
          const committed = isBuy ? (px / 100) * rem : null;
          const created = o.created_time ? Date.parse(o.created_time)
                        : (o.created_ts ? o.created_ts * 1000 : null);
          const ageMin = created ? Math.max(0, Math.round((nowMs - created) / 60000)) : null;
          const bucket = (o.ticker || "").split("-").pop();
          return `<tr>
            <td title="${o.ticker || ''}">${bucket}</td>
            <td>${side}</td>
            <td>${action}</td>
            <td>${px}¢</td>
            <td>${rem}</td>
            <td>${committed == null ? '—' : '$' + committed.toFixed(2)}</td>
            <td>${ageMin == null ? '—' : ageMin + 'm'}</td>
          </tr>`;
        }).join("")}</tbody></table>`;
      }
    }
    if (heldPositions.length === 0) {
      openEl.innerHTML = `<p class="muted small">No open positions.</p>`;
    } else {
      // Earliest buy time per ticker, derived from the recent-fills window.
      // Fallback to position.last_updated_ts if no buy fill is in the window.
      const firstBuyByTicker = {};
      for (const f of fills) {
        if (f.action !== "buy") continue;
        const t = f.ticker;
        if (!firstBuyByTicker[t] || f.created_time < firstBuyByTicker[t]) {
          firstBuyByTicker[t] = f.created_time;
        }
      }
      openEl.innerHTML = `<table class="paper-table"><thead><tr>
        <th>City</th><th>Var</th><th>Bucket</th><th>Side</th><th>Contracts</th><th>Entry</th><th>Stake</th><th>Mkt now</th><th>Unreal P&L</th><th>Predicted high/low</th><th>Purchased</th>
      </tr></thead><tbody>${heldPositions.map(p => {
        const isYes = p._qty > 0;
        const contracts = Math.abs(p._qty);
        const avgCost = contracts > 0 ? p._exposure / contracts : 0;
        const mtm = mtmByTicker[p.ticker] || {};
        const city = mtm.city || "—";
        const variable = mtm.variable || "—";
        const bucket = mtm.bucket || p.ticker.split("-").pop();
        const sellPx = mtm.sellPrice;
        const unr = mtm.unrealized_pnl;
        // Predicted-temp column: bet-type-aware model μ ± σ. For temp bets, append
        // the obs-constrained effective μ ("→ 99.0°F") when it shifts the prediction
        // by ≥ 0.1°F (HIGH max-floored or LOW min-ceiled — see weather.js obs-floor
        // logic). Tag with "in" / "out" of the bet's bucket so the model-vs-strike
        // relationship is visible at a glance: NO bets want "out", YES bets want "in".
        const isTemp = mtm.variable !== "rain";
        let muSig = "—";
        if (mtm.modelMean != null) {
          const u = isTemp ? '°F' : '″';
          const d = isTemp ? 1 : 2;
          const raw = `${mtm.modelMean.toFixed(d)}±${mtm.modelStd.toFixed(d)}`;
          const effMu = isTemp ? (mtm.effectiveMean ?? mtm.modelMean) : mtm.modelMean;
          if (isTemp && mtm.effectiveMean != null && Math.abs(mtm.effectiveMean - mtm.modelMean) >= 0.1) {
            muSig = `${raw} → <span class="${mtm.variable === "low" ? 'cool' : 'warm'}">${mtm.effectiveMean.toFixed(1)}</span>${u}`;
          } else {
            muSig = `${raw}${u}`;
          }
          // Bucket-vs-prediction indicator (temp only — rain bets are threshold-based, not bucketed).
          if (isTemp && Number.isFinite(mtm.loInt) && Number.isFinite(mtm.hiInt)) {
            const inBucket = effMu >= (mtm.loInt - 0.5) && effMu < (mtm.hiInt + 0.5);
            const goodForBet = inBucket === isYes;  // YES wants in-bucket, NO wants out
            muSig += ` <span class="tag ${goodForBet ? 'warm' : 'cool'}">${inBucket ? 'in' : 'out'}</span>`;
          }
        }
        const purchasedRaw = firstBuyByTicker[p.ticker] || p.last_updated_ts || "";
        const purchased = purchasedRaw.slice(0, 16).replace("T", " ");
        const cityCell = (city && city !== "—")
          ? `<a class="city-link" href="#${cardIdFor(city)}">${city}</a>`
          : "—";
        return `<tr>
          <td>${cityCell}</td>
          <td class="muted small">${variable}</td>
          <td>${bucket}</td>
          <td class="${isYes ? 'warm' : 'cool'}">${isYes ? 'YES' : 'NO'}</td>
          <td>${contracts}</td>
          <td>$${avgCost.toFixed(2)}</td>
          <td>$${p._exposure.toFixed(2)}</td>
          <td class="muted small">${sellPx != null ? '$'+sellPx.toFixed(2) : '—'}</td>
          <td class="${unr == null ? 'muted' : (unr >= 0 ? 'warm' : 'cool')}">${unr != null ? fmtSignedDollars(unr) : '—'}</td>
          <td class="muted small">${muSig}</td>
          <td class="muted small">${purchased || "—"}</td>
        </tr>`;
      }).join("")}</tbody></table>`;
    }
    if (fills.length === 0) {
      fillsEl.innerHTML = `<p class="muted small">No recent fills.</p>`;
    } else {
      fillsEl.innerHTML = `<table class="paper-table"><thead><tr>
        <th>Ticker</th><th>Action</th><th>Side</th><th>Count</th><th>Price</th><th>When (UTC)</th>
      </tr></thead><tbody>${fills.slice(0, 20).map(f => {
        const count = parseFloat(f.count_fp || "0");
        const yp = parseFloat(f.yes_price_dollars || "0");
        const np = parseFloat(f.no_price_dollars  || "0");
        // Kalshi reports sells in YES-coordinates regardless of which side you
        // actually held (a NO position closed at no_bid=0.99 comes back as
        // side=yes, yes_price=0.01, no_price=0.99). For sells, display whichever
        // side has the higher price — that's the position you actually closed
        // and the price you actually received. Buys are unambiguous.
        let displaySide, displayPrice;
        if (f.action === "sell" && yp > 0 && np > 0) {
          if (np > yp) { displaySide = "NO";  displayPrice = np; }
          else         { displaySide = "YES"; displayPrice = yp; }
        } else {
          displaySide  = (f.side || "").toUpperCase();
          displayPrice = f.side === "yes" ? yp : np;
        }
        return `<tr>
          <td class="muted small">${f.ticker}</td>
          <td>${f.action}</td>
          <td class="${displaySide === 'YES' ? 'warm' : 'cool'}">${displaySide}</td>
          <td>${count}</td>
          <td>$${displayPrice.toFixed(2)}</td>
          <td class="muted small">${(f.created_time || "").slice(0, 16)}</td>
        </tr>`;
      }).join("")}</tbody></table>`;
    }
    const citiesEl = document.getElementById("jackson-cities-wrap");
    if (citiesEl) {
      const cities = j.byCity || [];
      if (cities.length === 0) {
        citiesEl.innerHTML = `<p class="muted small">Per-city breakdown appears after first settlements.</p>`;
      } else {
        citiesEl.innerHTML = `<table class="paper-table"><thead><tr>
          <th>City</th><th>Settled</th><th>W</th><th>L</th><th>Sold</th><th>Win%</th><th>Open</th><th>Staked</th><th>Realized</th><th>Unreal</th><th>Total P&L</th><th>ROI</th>
        </tr></thead><tbody>${cities.map(c => `<tr>
          <td><a class="city-link" href="#${cardIdFor(c.city)}">${c.city}</a></td>
          <td>${c.n_settled}</td>
          <td>${c.wins}</td>
          <td>${c.losses}</td>
          <td>${c.sold || 0}</td>
          <td>${c.win_rate_pct.toFixed(1)}%</td>
          <td>${c.open_count}</td>
          <td>$${c.total_staked.toFixed(2)}</td>
          <td class="${c.realized_pnl >= 0 ? 'warm' : 'cool'}">${fmtSignedDollars(c.realized_pnl)}</td>
          <td class="${c.unrealized_pnl >= 0 ? 'warm' : 'cool'}">${fmtSignedDollars(c.unrealized_pnl)}</td>
          <td class="${c.total_pnl >= 0 ? 'warm' : 'cool'}">${fmtSignedDollars(c.total_pnl)}</td>
          <td class="${c.roi_pct >= 0 ? 'warm' : 'cool'}">${fmtPctSigned(c.roi_pct)}</td>
        </tr>`).join("")}</tbody></table>`;
      }
    }
  } catch (e) {
    statusEl.textContent = `Load error: ${e.message}`;
    statusEl.className = "sub";
  }
}

async function loadCombo() {
  const statusEl = document.getElementById("combo-status");
  const lbEl = document.getElementById("combo-leaderboard-wrap");
  const stateEl = document.getElementById("combo-state");
  const srcEl = document.getElementById("combo-sources-wrap");
  const openEl = document.getElementById("combo-open-wrap");
  const settledEl = document.getElementById("combo-settled-wrap");
  if (!statusEl) return;
  try {
    const r = await fetch("/api/combo", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const startBank = j.starting_bankroll ?? 100;
    const linkStatus = j.rainbot_link_status === "ok"
      ? "rainbot signals: linked"
      : `rainbot signals: ${j.rainbot_link_status}`;
    statusEl.textContent = linkStatus;
    statusEl.className = j.rainbot_link_status === "ok" ? "sub fresh" : "sub muted";

    // Leaderboard. Highlight the row with the highest comparable value (MTM where
    // available, bankroll otherwise — same metric the milestone log uses).
    if (lbEl) {
      const board = j.leaderboard || [];
      const valOf = p => p.mtm ?? p.bankroll;
      const leaderName = (() => {
        let best = null, bestVal = -Infinity;
        for (const p of board) {
          const v = valOf(p);
          if (v != null && v > bestVal) { bestVal = v; best = p.name; }
        }
        return best;
      })();
      const rows = board.map(p => {
        const bank = p.bankroll != null ? `Đ${p.bankroll.toFixed(2)}` : "—";
        const mtm = p.mtm != null ? `Đ${p.mtm.toFixed(2)}` : "—";
        const pnlPct = p.bankroll != null ? ((p.bankroll - 100) / 100 * 100) : null;
        const wr = p.win_rate != null ? `${(p.win_rate * 100).toFixed(1)}%` : "—";
        const err = p.error ? ` <span class="muted small">(${p.error})</span>` : "";
        const cls = p.name === leaderName ? "leader-row" : "";
        return `<tr class="${cls}">
          <td><strong>${p.name}</strong>${err}</td>
          <td>${bank}</td>
          <td>${mtm}</td>
          <td class="${pnlPct == null ? 'muted' : (pnlPct >= 0 ? 'warm' : 'cool')}">${pnlPct == null ? "—" : fmtPctSigned(pnlPct)}</td>
          <td>${p.n_bets ?? "—"}</td>
          <td>${wr}</td>
        </tr>`;
      }).join("");
      lbEl.innerHTML = `<table class="paper-table"><thead><tr>
        <th>Bot</th><th>Bankroll</th><th>Mark-to-market</th><th>P&L %</th><th>Settled</th><th>Win rate</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
    }

    // Banner: shown only when combo is leading both other bots.
    const bannerEl = document.getElementById("combo-banner");
    if (bannerEl) bannerEl.classList.toggle("live", !!j.is_combo_leading);

    // Milestone chronicle. Persistent log of "first time" crossings — survives flip-backs.
    const milestonesEl = document.getElementById("combo-milestones-wrap");
    if (milestonesEl) {
      const m = j.milestones || {};
      const entries = [
        ["first_overtook_weatherbot", "first overtook weatherbot"],
        ["first_overtook_rainbot",    "first overtook rainbot"],
        ["first_leading_both",        "first time leading both"]
      ];
      const items = entries
        .filter(([k]) => m[k])
        .map(([k, label]) => {
          const e = m[k];
          const when = (e.at || "").slice(0, 16).replace("T", " ");
          const detail = e.comboValue != null ? ` (combo Đ${e.comboValue.toFixed(2)})` : "";
          return `<li><strong>${label}</strong> · ${when} UTC${detail}</li>`;
        }).join("");
      milestonesEl.innerHTML = items
        ? `<p class="sub muted small" style="margin-top:6px"><strong>Milestones:</strong></p><ul>${items}</ul>`
        : `<p class="sub muted small">Milestones: none yet — combo hasn't overtaken either bot.</p>`;
    }

    // Combo state.
    const s = j.state || {};
    const bankroll = s.bankroll ?? startBank;
    const av = s.account_value ?? bankroll;
    const pnlPct = (bankroll - startBank) / startBank * 100;
    if (stateEl) {
      stateEl.innerHTML = `
        <div class="stat"><div class="stat-label">bankroll</div><div class="stat-val ${bankroll >= startBank ? 'warm' : 'cool'}">Đ${bankroll.toFixed(2)} <span class="muted">(${fmtPctSigned(pnlPct)})</span></div></div>
        <div class="stat"><div class="stat-label">account value (mtm)</div><div class="stat-val ${av >= startBank ? 'warm' : 'cool'}">Đ${av.toFixed(2)}</div></div>
        <div class="stat"><div class="stat-label">unrealized P&L</div><div class="stat-val ${(s.unrealized_pnl ?? 0) >= 0 ? 'warm' : 'cool'}">${fmtSignedDBks(s.unrealized_pnl ?? 0)}</div></div>
        <div class="stat"><div class="stat-label">cash free</div><div class="stat-val">Đ${(s.cash_free ?? 0).toFixed(2)}</div></div>
        <div class="stat"><div class="stat-label">in flight</div><div class="stat-val">${s.open_count ?? 0} / ${s.max_concurrent ?? 20}</div></div>
        <div class="stat"><div class="stat-label">settled bets</div><div class="stat-val">${s.n_bets_total ?? 0}</div></div>
        <div class="stat"><div class="stat-label">win rate</div><div class="stat-val">${(s.win_rate ?? 0).toFixed(1)}%</div></div>
        <div class="stat"><div class="stat-label">total P&L</div><div class="stat-val ${(s.total_pnl ?? 0) >= 0 ? 'warm' : 'cool'}">${fmtSignedDBks(s.total_pnl ?? 0)}</div></div>
        <div class="stat"><div class="stat-label">ROI</div><div class="stat-val ${(s.roi_pct ?? 0) >= 0 ? 'warm' : 'cool'}">${fmtPctSigned(s.roi_pct ?? 0)}</div></div>`;
    }

    // By source.
    const sources = j.by_source || [];
    if (srcEl) {
      if (sources.every(s => s.n === 0)) {
        srcEl.innerHTML = `<p class="muted small">Per-source breakdown appears after first settlements.</p>`;
      } else {
        srcEl.innerHTML = `<table class="paper-table"><thead><tr>
          <th>Source</th><th>Settled</th><th>Wins</th><th>Win%</th><th>Staked</th><th>P&L</th><th>ROI</th>
        </tr></thead><tbody>${sources.map(c => `<tr>
          <td><strong>${c.source}</strong></td>
          <td>${c.n}</td><td>${c.wins}</td>
          <td>${c.win_rate_pct.toFixed(1)}%</td>
          <td>Đ${c.staked.toFixed(2)}</td>
          <td class="${c.pnl >= 0 ? 'warm' : 'cool'}">${fmtSignedDBks(c.pnl)}</td>
          <td class="${c.roi_pct >= 0 ? 'warm' : 'cool'}">${fmtPctSigned(c.roi_pct)}</td>
        </tr>`).join("")}</tbody></table>`;
      }
    }

    // Open positions.
    const open = j.open_bets || [];
    if (openEl) {
      if (open.length === 0) {
        openEl.innerHTML = `<p class="muted small">No open positions yet — first bets land when the next 30-min combo cron fires (after rainbot env auth is set).</p>`;
      } else {
        openEl.innerHTML = `<table class="paper-table"><thead><tr>
          <th>Source</th><th>Market</th><th>Side</th><th>Entry</th><th>Stake</th><th>Mkt now</th><th>Unreal P&L</th><th>Edge / Kelly</th><th>Placed</th>
        </tr></thead><tbody>${open.map(b => {
          const mtm = b.markToMarket || {};
          const sellPx = mtm.sellPrice;
          const unr = mtm.unrealized_pnl;
          const placed = (b.placedAtUTC || "").slice(0, 16).replace("T", " ");
          return `<tr>
            <td><span class="tag">${b.source}</span></td>
            <td>${b.label || b.fullTicker}</td>
            <td class="${b.side === 'YES' ? 'warm' : 'cool'}">${b.side}</td>
            <td>Đ${b.price.toFixed(2)}</td>
            <td>Đ${b.stake_dollars.toFixed(2)}</td>
            <td class="muted small">${sellPx != null ? 'Đ'+sellPx.toFixed(2) : '—'}</td>
            <td class="${unr == null ? 'muted' : (unr >= 0 ? 'warm' : 'cool')}">${unr != null ? fmtSignedDBks(unr) : '—'}</td>
            <td class="muted small">+${(b.ev*100).toFixed(1)}¢ / ${(b.halfKelly*100).toFixed(1)}%</td>
            <td class="muted small">${placed || "—"}</td>
          </tr>`;
        }).join("")}</tbody></table>`;
      }
    }

    // Recent settled.
    const settled = (j.recent_settled || []).slice(0, 20);
    if (settledEl) {
      if (settled.length === 0) {
        settledEl.innerHTML = `<p class="muted small">No settled bets yet.</p>`;
      } else {
        settledEl.innerHTML = `<table class="paper-table"><thead><tr>
          <th>Settled</th><th>Source</th><th>Market</th><th>Side</th><th>Entry</th><th>Outcome</th><th>P&L</th>
        </tr></thead><tbody>${settled.map(s => `<tr>
          <td class="muted small">${(s.settledAtUTC || "").slice(0, 10)}</td>
          <td><span class="tag">${s.source}</span></td>
          <td>${s.label || s.fullTicker}</td>
          <td class="${s.side === 'YES' ? 'warm' : 'cool'}">${s.side}</td>
          <td>Đ${s.price.toFixed(2)}</td>
          <td class="${s.outcome === 'WIN' ? 'good' : 'bad'}">${s.outcome}</td>
          <td class="${(s.pnl_dollars ?? 0) >= 0 ? 'warm' : 'cool'}">${fmtSignedDBks(s.pnl_dollars ?? 0)}</td>
        </tr>`).join("")}</tbody></table>`;
      }
    }
  } catch (e) {
    statusEl.textContent = `Combo load error: ${e.message}`;
    statusEl.className = "sub";
  }
}

function pulseCard(id) {
  const el = document.getElementById(id);
  if (!el) return false;
  // Expand the target card when navigated to (nav link / hash) so it isn't hidden.
  if (el instanceof HTMLDetailsElement && !el.open) { el.open = true; openCards.add(id); }
  el.classList.remove("pulse");
  void el.offsetWidth;
  el.classList.add("pulse");
  el.addEventListener("animationend", () => el.classList.remove("pulse"), { once: true });
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.city-link");
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if (!href.startsWith("#")) return;
  e.preventDefault();
  const id = href.slice(1);
  if (pulseCard(id)) history.replaceState(null, "", "#" + id);
});

load();
loadKalshi();
loadPaper();
loadCombo();
loadJackson();
loadBalanceHistory();
loadCalibration();
setInterval(load, 60_000);
setInterval(loadKalshi, 120_000);
setInterval(loadPaper, 60_000);
setInterval(loadCombo, 60_000);
setInterval(loadJackson, 60_000);
setInterval(loadBalanceHistory, 5 * 60_000);
setInterval(loadCalibration, 5 * 60_000);

// σ-calibration display. Refreshes every 5 min (matches the cron's */30 update
// cadence loosely — we may show stale-by-up-to-5min data, which is fine).
async function loadCalibration() {
  const el = document.getElementById("calibration-wrap");
  if (!el) return;
  try {
    const r = await fetch("/api/calibration_state", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j.ok || !j.updated_at) {
      el.innerHTML = `<span class="muted">No calibration data yet. The cron fires every 30 min — or trigger manually: <code>/api/calibration_state?seed=1</code>.</span>`;
      return;
    }
    el.innerHTML = renderCalibration(j);
  } catch (e) {
    el.innerHTML = `<span class="muted">Calibration unavailable: ${e.message}</span>`;
  }
}

function renderCalibration(c) {
  const fmtPct = v => v == null ? "—" : (100 * v).toFixed(0) + "%";
  const fmtNum = (v, d) => v == null ? "—" : v.toFixed(d ?? 2);
  const updated = c.updated_at ? new Date(c.updated_at).toISOString().slice(11, 16) + " UTC" : "—";
  // Color the factor: 1.0 neutral, >1.3 warm (heavy inflation = model overconfident),
  // <1.0 shouldn't happen (floor protects) but mark cool if it does.
  const factorCls = f => f == null ? "muted" : (f > 1.3 ? "warm" : (f < 1.0 ? "cool" : ""));
  // Color coverage: green if within 5% of nominal, warm if much worse than nominal.
  const covCls = (emp, nom) => emp == null ? "muted" : (Math.abs(emp - nom) <= 0.05 ? "" : "warm");
  const sideRow = (label, s) => {
    if (!s || s.n === 0) {
      return `<tr><td><strong>${label}</strong></td><td colspan="6" class="muted">no matched bets yet</td></tr>`;
    }
    return `<tr>
      <td><strong>${label}</strong></td>
      <td class="${factorCls(s.inflation_factor)}"><strong>${fmtNum(s.inflation_factor, 2)}×</strong></td>
      <td>n=${s.n}</td>
      <td>stdev(z)=${fmtNum(s.stdev_z, 2)}</td>
      <td class="${covCls(s.coverage_68, 0.68)}">68%CI cov=${fmtPct(s.coverage_68)}</td>
      <td class="${covCls(s.coverage_95, 0.95)}">95%CI cov=${fmtPct(s.coverage_95)}</td>
      <td class="muted small">w_data=${fmtPct(s.data_weight)}, cap=${fmtNum(s.adaptive_cap, 2)}</td>
    </tr>`;
  };
  return `<div class="muted small">last update ${updated} · matched ${c.matched ?? 0} bets to actuals (${c.unmatched ?? 0} unmatched)</div>
  <table class="paper-table" style="margin-top:6px">
    <thead><tr>
      <th>side</th><th>σ × factor</th><th>n</th><th>stdev(z)</th><th>68% cov</th><th>95% cov</th><th>diagnostics</th>
    </tr></thead>
    <tbody>
      ${sideRow("HIGH", c.high)}
      ${sideRow("LOW",  c.low)}
    </tbody>
  </table>`;
}

// Daily equity history — one row per UTC day from /api/balance_history.
// Renders a small inline SVG line chart of total equity over time + stats.
async function loadBalanceHistory() {
  try {
    const r = await fetch("/api/balance_history", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderBalanceRollup(j.rollup);
    renderBalanceChart(j.entries || []);
  } catch (e) {
    const el = document.getElementById("balance-rollup");
    if (el) el.textContent = `Balance history unavailable: ${e.message}`;
  }
}

function renderBalanceRollup(rollup) {
  const el = document.getElementById("balance-rollup");
  if (!el) return;
  if (!rollup) {
    el.innerHTML = `No snapshots yet — first one fires at 00:00 UTC, or trigger manually: <code>/api/balance_snapshot</code>`;
    return;
  }
  const fmt = n => (n >= 0 ? "+" : "") + "$" + n.toFixed(2);
  const cls = n => n >= 0 ? "warm" : "cool";
  const r = rollup;
  el.innerHTML = `
    <span>Equity <strong>$${r.currentEquity.toFixed(2)}</strong></span>
    &nbsp;·&nbsp; peak $${r.peakEquity.toFixed(2)}
    &nbsp;·&nbsp; drawdown $${r.drawdownDollars.toFixed(2)} (${r.drawdownPct.toFixed(1)}%)
    &nbsp;·&nbsp; <span class="${cls(r.lastDayDelta)}">last 24h ${fmt(r.lastDayDelta)}</span>
    &nbsp;·&nbsp; <span class="${cls(r.totalDelta)}">since start ${fmt(r.totalDelta)}</span>
    &nbsp;·&nbsp; ${r.daysRunning} day${r.daysRunning === 1 ? "" : "s"} tracked
  `;
}

function renderBalanceChart(entries) {
  const wrap = document.getElementById("balance-chart-wrap");
  if (!wrap) return;
  if (entries.length < 2) {
    wrap.innerHTML = `<div class="sub muted">Need ≥ 2 daily snapshots before the chart appears. Current: ${entries.length}.</div>`;
    return;
  }
  const W = 720, H = 180, PADL = 50, PADR = 20, PADT = 12, PADB = 24;
  const xs = entries.map((_, i) => i);
  const ys = entries.map(e => e.totalEquityDollars);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const yRange = Math.max(maxY - minY, 1);
  const sx = i => PADL + (i / (xs.length - 1)) * (W - PADL - PADR);
  const sy = v => PADT + (1 - (v - minY) / yRange) * (H - PADT - PADB);
  const pts = entries.map((e, i) => `${sx(i).toFixed(1)},${sy(e.totalEquityDollars).toFixed(1)}`).join(" ");
  const firstY = sy(ys[0]);
  const lastEntry = entries[entries.length - 1];
  const lastY = sy(lastEntry.totalEquityDollars);
  const ticksY = 4;
  const yTicks = [];
  for (let t = 0; t <= ticksY; t++) {
    const v = minY + (yRange * t / ticksY);
    yTicks.push(`<line x1="${PADL}" x2="${W - PADR}" y1="${sy(v)}" y2="${sy(v)}" stroke="#2a2a2a" stroke-width="0.5"/><text x="${PADL - 6}" y="${sy(v) + 3}" font-size="10" text-anchor="end" fill="#888">$${v.toFixed(0)}</text>`);
  }
  const xTicks = [];
  const skip = Math.max(1, Math.floor(entries.length / 8));
  for (let i = 0; i < entries.length; i += skip) {
    xTicks.push(`<text x="${sx(i)}" y="${H - 6}" font-size="9" text-anchor="middle" fill="#888">${entries[i].dateUtc.slice(5)}</text>`);
  }
  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px; background:#0d0d0d; border:1px solid #222; border-radius:4px;">
      ${yTicks.join("")}
      <line x1="${PADL}" x2="${PADL}" y1="${PADT}" y2="${H - PADB}" stroke="#444" stroke-width="0.5"/>
      <line x1="${PADL}" x2="${W - PADR}" y1="${H - PADB}" y2="${H - PADB}" stroke="#444" stroke-width="0.5"/>
      <line x1="${PADL}" x2="${W - PADR}" y1="${firstY}" y2="${firstY}" stroke="#666" stroke-dasharray="3,3" stroke-width="0.5"/>
      <polyline fill="none" stroke="#5fb3ff" stroke-width="1.6" points="${pts}"/>
      <circle cx="${sx(entries.length - 1)}" cy="${lastY}" r="3" fill="#5fb3ff"/>
      ${xTicks.join("")}
    </svg>
  `;
}
