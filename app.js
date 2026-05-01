const grid = document.getElementById("grid");
const statusEl = document.getElementById("status");

function fmtF(v) { return v == null ? "—" : `${v.toFixed(1)}°F`; }
function fmtPair(arr) { return arr ? `[${arr[0].toFixed(1)}, ${arr[1].toFixed(1)}]` : "—"; }
function fmtSigned(v) {
  if (v == null) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(1)}°F`;
}

function renderCard(c) {
  if (c.error) {
    return `<div class="card error">
      <h2>${c.name}</h2>
      <div class="cli">CLI${c.cli} • ${c.station}</div>
      <div class="big">no data</div>
    </div>`;
  }
  const tempColor = c.mean >= 70 ? "" : "cool";
  const cliRow = c.lastCLI && c.lastCLI.maxF != null
    ? `<div class="row"><span>last CLI ${c.lastCLI.isPartial ? "(partial)" : ""}${c.lastCLI.dateLabel ? " " + c.lastCLI.dateLabel : ""}</span><span>${c.lastCLI.maxF}°F</span></div>`
    : `<div class="row"><span>last CLI</span><span class="muted">parse failed</span></div>`;
  const biasRow = c.biasF != null
    ? `<div class="row"><span>obs vs forecast bias</span><span class="${c.biasF >= 0 ? 'warm' : 'cool'}">${fmtSigned(c.biasF)}</span></div>`
    : "";
  const methodTag = `<span class="tag">${c.method}</span>`;
  return `<div class="card">
    <h2>${c.name} ${methodTag}</h2>
    <div class="cli">CLI${c.cli} • ${c.station} • ${c.hrsToPeak}h to peak</div>
    <div class="row"><span>current</span><span>${fmtF(c.currentTemp)}</span></div>
    <div class="row"><span>max so far today</span><span>${fmtF(c.maxSoFar)}</span></div>
    <div class="row"><span>NWS daily high</span><span>${c.forecastHighF == null ? "—" : c.forecastHighF + "°F"}</span></div>
    <div class="row"><span>NWS hourly peak</span><span>${c.forecastPeakHourly == null ? "—" : c.forecastPeakHourly + "°F"}</span></div>
    ${biasRow}
    ${cliRow}
    <div class="pred">
      <div class="big ${tempColor}">${c.mean.toFixed(1)}°F</div>
      <div class="row"><span>mean / median / mode</span><span>${c.mean.toFixed(1)}</span></div>
      <div class="row"><span>std (σ)</span><span>${c.std.toFixed(2)}°F</span></div>
      <div class="row ci"><span>68% CI</span><span>${fmtPair(c.ci68)}</span></div>
      <div class="row ci"><span>95% CI</span><span>${fmtPair(c.ci95)}</span></div>
    </div>
  </div>`;
}

async function load() {
  try {
    const r = await fetch("/api/weather", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    grid.innerHTML = j.cities.map(renderCard).join("");
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

async function loadKalshi() {
  const tbody = document.getElementById("kalshi-rows");
  if (!tbody) return;
  try {
    const r = await fetch("/api/kalshi", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderFreshness(j.freshness);
    const top = (j.topBets || []).slice(0, 15);
    if (!top.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="muted">No +EV bets above 2¢ edge right now.</td></tr>`;
      return;
    }
    tbody.innerHTML = top.map((b, i) => {
      const muSig = (b.modelMean != null) ? `${b.modelMean.toFixed(1)} ± ${b.modelStd.toFixed(1)}` : "—";
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
        <td><strong>${(b.halfKelly * 100).toFixed(1)}%</strong></td>
        <td>${Math.round(b.volume).toLocaleString()}</td>
      </tr>`;
    }).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted">Kalshi load error: ${e.message}</td></tr>`;
  }
}

function fmtSigned(v) { if (v == null) return "—"; const s = v >= 0 ? "+" : ""; return `${s}$${v.toFixed(2)}`; }
function fmtPctSigned(v) { if (v == null) return "—"; const s = v >= 0 ? "+" : ""; return `${s}${v.toFixed(1)}%`; }

async function loadPaper() {
  try {
    const r = await fetch("/api/paper", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const s = j.state || {};
    const bankroll = s.bankroll ?? 0;
    const startBank = 20;
    const pnlPct = (bankroll - startBank) / startBank * 100;
    const roiPct = (s.roi ?? 0) * 100;
    const winRatePct = (s.win_rate ?? 0) * 100;
    const totalSettled = (s.n_bets_total ?? 0);
    const stateEl = document.getElementById("paper-state");
    if (stateEl) {
      stateEl.innerHTML = `
        <div class="stat"><div class="stat-label">bankroll</div><div class="stat-val ${bankroll >= startBank ? 'warm' : 'cool'}">$${bankroll.toFixed(2)} <span class="muted">(${fmtPctSigned(pnlPct)})</span></div></div>
        <div class="stat"><div class="stat-label">cash free</div><div class="stat-val">$${(s.cash_free ?? 0).toFixed(2)}</div></div>
        <div class="stat"><div class="stat-label">in flight</div><div class="stat-val">${s.open_count ?? 0} / ${s.max_concurrent ?? 20}</div></div>
        <div class="stat"><div class="stat-label">stake / bet</div><div class="stat-val">$${(s.bet_size_dollars ?? 1).toFixed(2)}</div></div>
        <div class="stat"><div class="stat-label">total bets</div><div class="stat-val">${totalSettled}</div></div>
        <div class="stat"><div class="stat-label">win rate</div><div class="stat-val">${winRatePct.toFixed(1)}%</div></div>
        <div class="stat"><div class="stat-label">total P&L</div><div class="stat-val ${(s.total_pnl ?? 0) >= 0 ? 'warm' : 'cool'}">${fmtSigned(s.total_pnl ?? 0)}</div></div>
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
          <th>City</th><th>Var</th><th>Bucket</th><th>Side</th><th>Entry</th><th>Stake</th><th>Model μ±σ</th><th>Placed (UTC)</th>
        </tr></thead><tbody>${open.map(b => `<tr>
          <td>${b.city}</td>
          <td class="muted small">${b.variable || "high"}</td>
          <td>${b.bucket || b.ticker}</td>
          <td class="${b.side === 'YES' ? 'warm' : 'cool'}">${b.side}</td>
          <td>$${b.price.toFixed(2)}</td>
          <td>$${b.stake_dollars.toFixed(2)}</td>
          <td class="muted small">${b.modelMean != null ? `${b.modelMean.toFixed(1)}±${b.modelStd.toFixed(1)}°F` : "—"}</td>
          <td class="muted small">${(b.placedAtUTC || "").slice(11, 16)}</td>
        </tr>`).join("")}</tbody></table>`;
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
          <td>${s.city}</td>
          <td>${s.bucket || s.ticker}</td>
          <td class="${s.side === 'YES' ? 'warm' : 'cool'}">${s.side}</td>
          <td>$${s.price.toFixed(2)}</td>
          <td class="${s.outcome === 'WIN' ? 'good' : (s.outcome === 'SOLD' ? 'muted' : 'bad')}">${s.outcome}</td>
          <td class="muted small">${s.actualHigh != null ? s.actualHigh + "°F" : (s.sell_price != null ? "@$" + s.sell_price.toFixed(2) : "—")}</td>
          <td class="${s.pnl_dollars >= 0 ? 'warm' : 'cool'}">${fmtSigned(s.pnl_dollars)}</td>
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
          <td>${c.city || c.cli}</td>
          <td>${c.n}</td><td>${c.wins}</td><td>${c.sold || 0}</td>
          <td>${c.win_rate_pct.toFixed(1)}%</td>
          <td>$${c.staked.toFixed(2)}</td>
          <td class="${c.pnl >= 0 ? 'warm' : 'cool'}">${fmtSigned(c.pnl)}</td>
          <td class="${c.roi_pct >= 0 ? 'warm' : 'cool'}">${fmtPctSigned(c.roi_pct)}</td>
        </tr>`).join("")}</tbody></table>`;
      }
    }
  } catch (e) {
    const el = document.getElementById("paper-state");
    if (el) el.innerHTML = `<p class="muted">Paper-trade load error: ${e.message}</p>`;
  }
}

load();
loadKalshi();
loadPaper();
setInterval(load, 60_000);
setInterval(loadKalshi, 120_000);
setInterval(loadPaper, 60_000);
