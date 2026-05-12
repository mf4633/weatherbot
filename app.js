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
    cardEl.appendChild(badge);
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
  const tempColor = c.mean >= 70 ? "" : "cool";
  // CI bounds are obs-floored when maxSoFar/minSoFar is in play. The displayed σ is
  // still the unclamped prior std (computed pre-truncation), so flag the floor on the
  // CI label rather than recompute a post-truncation σ.
  const hiFloored = c.maxSoFar != null && c.ci95 && c.ci95[0] <= c.maxSoFar + 0.05;
  const loCeiled = c.minSoFar != null && c.lowCi95 && c.lowCi95[1] >= c.minSoFar - 0.05;
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
  return `<div class="card" id="${cardId}">
    <h2>${c.name} ${methodTag}${noMarketTag}</h2>
    ${calibratingNote}
    <div class="cli">CLI${c.cli} • ${c.station} • ${c.hrsToPeak}h to peak</div>
    <div class="row"><span>current</span><span>${fmtF(c.currentTemp)}${c.lastMetarTime ? ` <span class="muted small">at ${fmtLocalTime(c.lastMetarTime, c.tz)}${c.lastMetarAgeMin != null ? `, ${c.lastMetarAgeMin}m ago` : ""}</span>` : ""}</span></div>
    ${c.oneMinAsos ? `<div class="row"><span>1-min ASOS latest <span class="muted small">(n=${c.oneMinAsos.n}, ${c.oneMinAsos.ageMin}m ago)</span></span><span>${fmtF(c.oneMinAsos.latestF)}</span></div>
    <div class="row"><span>1-min ASOS max today</span><span>${fmtF(c.oneMinAsos.maxSoFar)}${c.oneMinAsos.maxTs ? ` <span class="muted small">at ${fmtLocalTime(c.oneMinAsos.maxTs, c.tz)}</span>` : ""}</span></div>
    <div class="row"><span>5-min weighted max <span class="muted small">(CLI settle basis)</span></span><span>${fmtF(c.oneMinAsos.max5MinSoFar)}${c.oneMinAsos.max5MinTs ? ` <span class="muted small">at ${fmtLocalTime(c.oneMinAsos.max5MinTs, c.tz)}</span>` : ""}</span></div>` : ""}
    <div class="row"><span>max so far today (obs)</span><span>${fmtF(c.maxSoFar)}</span></div>
    <div class="row"><span>NWS daily high (forecast)</span><span>${c.forecastHighF == null ? "—" : c.forecastHighF + "°F"}</span></div>
    <div class="row"><span>NWS hourly peak (forecast)</span><span>${c.forecastPeakHourly == null ? "—" : c.forecastPeakHourly + "°F"}</span></div>
    ${biasRow}
    ${cliRows}
    <div class="pred">
      <div class="pred-label">HIGH</div>
      <div class="big ${tempColor}">${c.mean.toFixed(1)}°F</div>
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
  </div>`;
}

async function load() {
  try {
    const r = await fetch("/api/weather", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    grid.innerHTML = j.cities.map(renderCard).join("");
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
  const fcStr = f.newestForecastAgeMin != null
    ? `forecast ${f.newestForecastAgeMin}–${f.oldestForecastAgeMin} min old`
    : "no forecast data";
  const stale = f.cacheStale || f.forecastStale;
  const cls = stale ? "stale" : "fresh";
  const note = stale
    ? "⚠ Stale data — apparent edges may be artifacts of forecast revisions the model hasn't seen yet."
    : "Data fresh; edges reflect current forecast.";
  el.className = cls;
  el.textContent = `${cacheStr} · ${fcStr} · ${note}`;
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
    // evPerDay is server-attached; for legacy temp data without it, fall back to ev (1d hold).
    const evPerDay = b.evPerDay != null ? b.evPerDay : b.ev;
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
      </tr>`;
  }).join("");
}

async function loadKalshi() {
  try {
    const r = await fetch("/api/kalshi", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderFreshness(j.freshness);
    const top = j.topBets || [];
    const highBets = top.filter(b => b.variable === "high" || !b.variable).slice(0, 15);
    const lowBets = top.filter(b => b.variable === "low").slice(0, 15);
    renderKalshiRows(highBets, "kalshi-rows-high", 10);
    renderKalshiRows(lowBets, "kalshi-rows-low", 10);
  } catch (e) {
    for (const id of ["kalshi-rows-high", "kalshi-rows-low"]) {
      const t = document.getElementById(id);
      if (t) t.innerHTML = `<tr><td colspan="10" class="muted">Kalshi load error: ${e.message}</td></tr>`;
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
    if (t) t.innerHTML = `<tr><td colspan="10" class="muted">Rain load error: ${e.message}</td></tr>`;
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
    tbody.innerHTML = `<tr><td colspan="10" class="muted">No +EV rain bets above 2¢ net edge right now.</td></tr>`;
    return;
  }
  tbody.innerHTML = bets.map((b, i) => {
    // rainbot threshold: 0 = "any rain" daily binary; otherwise monthly tier "≥ T inches".
    const thresholdLabel = b.kind === "daily-binary" ? "any rain (>0″)" : `≥ ${b.threshold}″`;
    const kindLabel = b.kind === "daily-binary"
      ? `daily <span class="muted small">(${b.holdingDays}d)</span>`
      : `monthly <span class="muted small">(${b.holdingDays}d)</span>`;
    const evPerDay = b.evPerDay != null ? b.evPerDay : (b.ev_net / Math.max(1, b.holdingDays || 1));
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
    const accountValue = balDollars + totalExposure + totalUnrealized;  // cash + at-risk + unrealized
    stateEl.innerHTML = `
      <div class="stat"><div class="stat-label">cash balance</div><div class="stat-val warm">$${balDollars.toFixed(2)}</div></div>
      <div class="stat"><div class="stat-label">capital at risk</div><div class="stat-val">$${totalExposure.toFixed(2)}</div></div>
      <div class="stat"><div class="stat-label">account value</div><div class="stat-val ${accountValue >= 20 ? 'warm' : 'cool'}">$${accountValue.toFixed(2)}</div></div>
      <div class="stat"><div class="stat-label">unrealized P&L</div><div class="stat-val ${totalUnrealized >= 0 ? 'warm' : 'cool'}">${fmtSignedDollars(totalUnrealized)}</div></div>
      <div class="stat"><div class="stat-label">realized P&L</div><div class="stat-val ${totalRealized >= 0 ? 'warm' : 'cool'}">${fmtSignedDollars(totalRealized)}</div></div>
      <div class="stat"><div class="stat-label">total P&L</div><div class="stat-val ${totalPnl >= 0 ? 'warm' : 'cool'}">${fmtSignedDollars(totalPnl)}</div></div>
      <div class="stat"><div class="stat-label">fees paid</div><div class="stat-val muted">$${totalFees.toFixed(2)}</div></div>
      <div class="stat"><div class="stat-label">positions</div><div class="stat-val">${heldPositions.length}</div></div>
      <div class="stat"><div class="stat-label">resting orders</div><div class="stat-val">${orders.length}</div></div>
      <div class="stat"><div class="stat-label">recent fills</div><div class="stat-val">${fills.length}</div></div>`;
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
        <th>City</th><th>Var</th><th>Bucket</th><th>Side</th><th>Contracts</th><th>Entry</th><th>Stake</th><th>Mkt now</th><th>Unreal P&L</th><th>Model μ±σ</th><th>Purchased</th>
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
        // Show raw μ and (when materially different) the obs-constrained effective μ.
        // The constrained μ = E[min(X, minSoFar)] for LOW or E[max(X, maxSoFar)] for HIGH;
        // it collapses toward the already-observed bound once the diurnal extremum is in.
        // Display "77.7→78.1°F" tells the operator the bet is bounded by today's obs even
        // though the raw forecast μ would imply more edge than really exists.
        const isTemp = mtm.variable !== "rain";
        let muSig = "—";
        if (mtm.modelMean != null) {
          const u = isTemp ? '°F' : '″';
          const d = isTemp ? 1 : 2;
          const raw = `${mtm.modelMean.toFixed(d)}±${mtm.modelStd.toFixed(d)}`;
          if (isTemp && mtm.effectiveMean != null && Math.abs(mtm.effectiveMean - mtm.modelMean) >= 0.1) {
            muSig = `${raw} → <span class="${mtm.variable === "low" ? 'cool' : 'warm'}">${mtm.effectiveMean.toFixed(1)}</span>${u}`;
          } else {
            muSig = `${raw}${u}`;
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
        const price = parseFloat((f.side === "yes" ? f.yes_price_dollars : f.no_price_dollars) || "0");
        return `<tr>
          <td class="muted small">${f.ticker}</td>
          <td>${f.action}</td>
          <td class="${f.side === 'yes' ? 'warm' : 'cool'}">${(f.side || "").toUpperCase()}</td>
          <td>${count}</td>
          <td>$${price.toFixed(2)}</td>
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
setInterval(load, 60_000);
setInterval(loadKalshi, 120_000);
setInterval(loadPaper, 60_000);
setInterval(loadCombo, 60_000);
setInterval(loadJackson, 60_000);
