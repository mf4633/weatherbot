// claude_ui.js — renders the Claude obs-analog cards next to the Bayesian prediction,
// plus the live Claude-vs-Bayes-vs-Market scoreboard. Self-contained (no dependency on
// app.js); fetches /api/claude and /api/claude?mode=scoreboard. See claude_analog.py.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const f1 = (x) => (x == null ? "—" : (+x).toFixed(1));
  const pct = (x) => (x == null ? "—" : (100 * x).toFixed(0) + "%");

  function gateBanner(g, gFirst) {
    if (!g) return "";
    const cls = g.passed ? "decision" : "decision rejected";
    const edge = g.edge == null ? "" :
      ` &nbsp;•&nbsp; edge ${g.edge >= 0 ? "+" : ""}${g.edge.toFixed(3)} Brier (market − v3)`;
    const detail = g.claudeBrier == null ? "" :
      `<div class="sub muted">v3 ${g.claudeBrier.toFixed(3)} vs market ${g.marketBrier.toFixed(3)} · n=${g.n}/${g.nMin} paired settled city-days${edge}</div>`;
    // First-decision window (the tradeable one): the last-decision book is already
    // ~99¢ on the winner by settlement, so this line is where a real morning edge
    // would show up. Informational — the pre-registered gate above still governs.
    const first = gFirst && gFirst.claudeBrier != null
      ? `<div class="sub muted">first-decision window: v3 ${gFirst.claudeBrier.toFixed(3)} vs market ${gFirst.marketBrier.toFixed(3)} · edge ${gFirst.edge >= 0 ? "+" : ""}${gFirst.edge.toFixed(3)} · n=${gFirst.n} (tradeable-window comparison, informational)</div>`
      : "";
    return `<div class="card" style="border-left:4px solid ${g.passed ? "#2e9e5b" : "#c0492e"}">
      <div class="row"><span><b>Trading gate</b> <span class="muted small">(pre-registered)</span></span>
        <span class="${cls}">${g.passed ? "PASS" : "HOLD — trading OFF"}</span></div>
      <div class="ci">${g.verdict || ""}</div>
      ${detail}
      ${first}
      <div class="sub muted">Rule: no real money on the Claude strategy until v3's out-of-sample Brier beats the market's posted book (net of spread) over ≥30 settled city-days. Both real-money traders remain halted.</div>
    </div>`;
  }

  function scoreTable(sb) {
    if (!sb || !sb.all) return "";
    const rows = ["claude", "bayes", "blend", "nws", "market"].map((k) => {
      const s = sb.all[k] || {};
      if (!s.n) return "";
      const cls = k === "claude" ? "warm" : k === "market" ? "cool" : "";
      return `<tr>
        <td class="${cls}">${k}</td><td>${s.n}</td>
        <td>${f1(s.mae)}</td><td>${f1(s.rmse)}</td>
        <td>${s.brier != null ? s.brier.toFixed(3) : "—"}</td>
        <td>${s.hit68 != null ? pct(s.hit68) : "—"}</td></tr>`;
    }).join("");
    if (!rows) return `<p class="sub muted">No settled decisions scored yet — the scoreboard fills in as CLI reports land.</p>`;
    return `<table class="kalshi-table"><thead><tr>
      <th>engine</th><th>n</th><th>MAE °F</th><th>RMSE °F</th><th>Brier</th><th>hit68</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <p class="sub muted">Lower MAE/RMSE/Brier = sharper. hit68 should sit near 68% (higher = under-confident, lower = over-confident). "market" scored from Kalshi yes-prices.</p>`;
  }

  function cityRow(c) {
    const cl = c.claude, b = c.bayes;
    const div = c.divergence;
    const flag = div == null ? "" :
      Math.abs(div) >= 2.0 ? `<span class="decision rejected">⚠ ${div > 0 ? "+" : ""}${f1(div)}°F</span>`
                           : `<span class="decision skipped">≈ ${div > 0 ? "+" : ""}${f1(div)}°F</span>`;
    const comp = Object.entries(cl.components || {})
      .filter(([k]) => k !== "T_now")
      .map(([k, v]) => `${k.replace("A_", "").replace("R_", "")} ${v >= 0 ? "+" : ""}${(+v).toFixed(1)}`)
      .join("  ");
    const bins = Object.entries(cl.bin_probs || {})
      .sort((a, z) => z[1] - a[1]).slice(0, 3)
      .map(([lbl, p]) => `${lbl} ${(100 * p).toFixed(0)}%`).join("  ");
    // Convective-truncation mixture: show the dry-ramp mode + P(convection caps it).
    // On a locked card the mixture's second component is the lock-FAILURE tail
    // (re-warming), not convection — don't caption it as a convective cap.
    const conv = cl.p_trunc > 0 && !cl.peak_locked
      ? `<div class="ci">mode ${f1(cl.mu)}°F  •  P(convective cap) ${(100 * cl.p_trunc).toFixed(0)}%  •  depth −${f1(cl.depth)}°F</div>`
      : "";
    // Market divergence: model mean vs Kalshi book-implied point.
    const mkt = cl.market_pt != null && !Number.isNaN(cl.market_pt)
      ? `<div class="ci muted" title="${(cl.divergence_note || "").replace(/"/g, "'")}">market ${f1(cl.market_pt)}°F ${
          Math.abs(cl.point - cl.market_pt) < 1 ? "≈ model" : (cl.point > cl.market_pt ? "▲ model hotter" : "▼ model colder")}</div>`
      : "";
    // v3 L3: peak locked — the day's max is physically behind us.
    const lock = cl.peak_locked
      ? `<div class="calibrating-note" title="${(cl.lock_note || "").replace(/"/g, "'")}">🔒 peak locked at ${f1(cl.floor)}°F — max is in</div>` : "";
    // v3 L1/L4: incoming upstream cloud + out-of-regime (advection) guard.
    const up = cl.upstream && cl.upstream.length
      ? `<div class="ci muted">upstream sky: ${cl.upstream.map(u => `${u.station.replace(/^K/, "")} ${(100 * u.deficit).toFixed(0)}%`).join("  ")}</div>` : "";
    const adv = !cl.peak_locked && cl.advection_score > 0.25
      ? `<div class="ci muted">⚠ advection regime ${f1(cl.advection_score)} — analogs off-regime, ramp capped &amp; σ inflated</div>` : "";
    // v3 L2: informed-market tilt (sizing view — never scored).
    const sizing = cl.sizing && Math.abs((cl.sizing.point ?? cl.point) - cl.point) >= 0.1
      ? `<div class="ci muted" title="${(cl.sizing.note || "").replace(/"/g, "'")}">sizing (market-tilt): ${f1(cl.sizing.point)}°F</div>` : "";
    // Served number = the fitted base blend (analog at its fitted weight on top of
    // the Bayesian ensemble); pure analog when no base was available. The pure point
    // stays visible as a subline so the divergence above it is auditable.
    const served = cl.point_blend ?? cl.point;
    const aw = cl.analog_w ?? null;
    const baseLbl = cl.blend_base_src === "nws" ? "NWS grid" : "Bayesian";
    const blendNote = aw != null && aw < 1
      ? `<div class="ci muted">analog ${Math.round(aw * 100)}% on a ${baseLbl} base (${f1(cl.blend_base)}°F) · pure analog ${f1(cl.point)}°F</div>` : "";
    return `<div class="card">
      <h2>${c.city} <span class="cli">${c.station}</span></h2>
      <div class="row"><span>Claude analog${aw != null && aw < 1 ? ` <span class="muted" style="font-size:11px">${Math.round(aw * 100)}% analog</span>` : ""}</span><span class="big cool" style="font-size:20px">${f1(served)}°F</span></div>
      ${blendNote}
      <div class="row"><span>Bayesian</span><span>${b ? f1(b.point) + "°F" : "—"}</span></div>
      <div class="row"><span>divergence</span><span>${flag}</span></div>
      ${lock}
      <div class="ci">σ ${f1(cl.sigma)}  •  floor ${f1(cl.floor)}  •  CI68 [${f1(cl.ci68[0])}, ${f1(cl.ci68[1])}]</div>
      <div class="ci">${comp}</div>
      ${conv}
      ${up}
      ${adv}
      ${bins ? `<div class="ci">bins: ${bins}</div>` : ""}
      ${mkt}
      ${sizing}
    </div>`;
  }

  async function refresh() {
    const grid = $("claude-grid"), sb = $("claude-scoreboard");
    if (!grid) return;
    try {
      // Fast blob-backed reads (newest logged decision per station + scoreboard),
      // not the heavy recompute path — so the section always renders.
      const [pred, scored] = await Promise.all([
        fetch("/api/claude?mode=latest").then((r) => r.json()),
        fetch("/api/claude?mode=scoreboard").then((r) => r.json()).catch(() => null),
      ]);
      if (sb && scored) sb.innerHTML = gateBanner(scored.gate, scored.gateFirst) + scoreTable(scored);
      if (pred && pred.cities && pred.cities.length) {
        grid.innerHTML = pred.cities.map(cityRow).join("");
      } else {
        grid.innerHTML = `<p class="sub muted">${pred && pred.error ? "error: " + pred.error : "No cards yet (obs/market not available)."}</p>`;
      }
    } catch (e) {
      grid.innerHTML = `<p class="sub muted">Claude engine unavailable: ${e}</p>`;
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh);
  else refresh();
  setInterval(refresh, 60000);
})();
