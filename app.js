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

load();
setInterval(load, 60_000);
