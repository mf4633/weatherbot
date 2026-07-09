// claude_ui.js — renders the Claude obs-analog cards next to the Bayesian prediction,
// plus the live Claude-vs-Bayes-vs-Market scoreboard. Self-contained (no dependency on
// app.js); fetches /api/claude and /api/claude?mode=scoreboard. See claude_analog.py.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const f1 = (x) => (x == null ? "—" : (+x).toFixed(1));
  const pct = (x) => (x == null ? "—" : (100 * x).toFixed(0) + "%");

  function scoreTable(sb) {
    if (!sb || !sb.all) return "";
    const rows = ["claude", "bayes", "market"].map((k) => {
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
    const conv = cl.p_trunc > 0
      ? `<div class="ci">mode ${f1(cl.mu)}°F  •  P(convective cap) ${(100 * cl.p_trunc).toFixed(0)}%  •  depth −${f1(cl.depth)}°F</div>`
      : "";
    // Market divergence: model mean vs Kalshi book-implied point.
    const mkt = cl.market_pt != null && !Number.isNaN(cl.market_pt)
      ? `<div class="ci muted" title="${(cl.divergence_note || "").replace(/"/g, "'")}">market ${f1(cl.market_pt)}°F ${
          Math.abs(cl.point - cl.market_pt) < 1 ? "≈ model" : (cl.point > cl.market_pt ? "▲ model hotter" : "▼ model colder")}</div>`
      : "";
    return `<div class="card">
      <h2>${c.city} <span class="cli">${c.station}</span></h2>
      <div class="row"><span>Claude analog</span><span class="big cool" style="font-size:20px">${f1(cl.point)}°F</span></div>
      <div class="row"><span>Bayesian</span><span>${b ? f1(b.point) + "°F" : "—"}</span></div>
      <div class="row"><span>divergence</span><span>${flag}</span></div>
      <div class="ci">σ ${f1(cl.sigma)}  •  floor ${f1(cl.floor)}  •  CI68 [${f1(cl.ci68[0])}, ${f1(cl.ci68[1])}]</div>
      <div class="ci">${comp}</div>
      ${conv}
      ${bins ? `<div class="ci">bins: ${bins}</div>` : ""}
      ${mkt}
    </div>`;
  }

  async function refresh() {
    const grid = $("claude-grid"), sb = $("claude-scoreboard");
    if (!grid) return;
    try {
      const [pred, scored] = await Promise.all([
        fetch("/api/claude").then((r) => r.json()),
        fetch("/api/claude?mode=scoreboard").then((r) => r.json()).catch(() => null),
      ]);
      if (sb && scored) sb.innerHTML = scoreTable(scored);
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
