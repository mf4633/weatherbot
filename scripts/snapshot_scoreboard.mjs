// snapshot_scoreboard.mjs — pull the Claude scoreboard dataset off Netlify Blobs and
// onto disk (git), for durability, and decide whether the trading gate warrants a ping.
// Run by .github/workflows/scoreboard-snapshot.yml (GitHub runners have real network;
// CCR sessions don't). No deps — Node 20 global fetch + fs.
//
// Env: BASIC_AUTH="user:pass" (inbound site auth). SITE overrides the default host.
// Outputs (to $GITHUB_OUTPUT if set): notify=true|false, reason=<text>.
// Local dry-run: SNAPSHOT_SRC=/path/to/export.json node scripts/snapshot_scoreboard.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const SITE = process.env.SITE || "https://weatherbot-mf.netlify.app";
const DIR = "data/scoreboard-snapshots";
const LATEST = `${DIR}/latest.json`;

// Ping when the gate first reaches statistical maturity (n crosses nMin) or when its
// PASS/HOLD verdict flips vs the last snapshot. Pure so it can be reasoned about/tested.
export function shouldNotify(prevGate, gate) {
  if (!gate || gate.n == null) return { notify: false, reason: "no gate in export" };
  const prevN = prevGate?.n ?? 0, nMin = gate.nMin ?? 30;
  if (gate.n >= nMin && prevN < nMin)
    return { notify: true, reason: `Gate reached n=${gate.n} (≥${nMin}) — out-of-sample sample is now mature. ${gate.verdict}` };
  if (prevGate && !!gate.passed !== !!prevGate.passed)
    return { notify: true, reason: `Gate verdict flipped to ${gate.passed ? "PASS" : "HOLD"}. ${gate.verdict}` };
  return { notify: false, reason: gate.verdict || "no change" };
}

function todayUTC() {
  // Date.now is fine here (script runs on a real clock, not the workflow harness).
  return new Date().toISOString().slice(0, 10);
}

async function fetchExport() {
  if (process.env.SNAPSHOT_SRC) return JSON.parse(readFileSync(process.env.SNAPSHOT_SRC, "utf8"));
  const auth = process.env.BASIC_AUTH || "";
  const headers = auth ? { authorization: "Basic " + Buffer.from(auth).toString("base64") } : {};
  const r = await fetch(`${SITE}/api/claude?mode=export`, { headers, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`export HTTP ${r.status}`);
  const j = await r.json();
  if (!j || j.ok !== true || !Array.isArray(j.records)) throw new Error("export payload malformed");
  return j;
}

function setOutput(k, v) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) writeFileSync(f, `${k}=${String(v).replace(/\n/g, " ")}\n`, { flag: "a" });
}

async function main() {
  let exp;
  try {
    exp = await fetchExport();
  } catch (e) {
    // Netlify cold-start/timeout is transient — don't fail the run or overwrite good data.
    console.error(`snapshot skipped: ${e.message}`);
    setOutput("notify", "false");
    setOutput("reason", `fetch failed: ${e.message}`);
    return;
  }
  const prevGate = existsSync(LATEST) ? (JSON.parse(readFileSync(LATEST, "utf8")).gate ?? null) : null;
  mkdirSync(DIR, { recursive: true });
  const payload = JSON.stringify(exp, null, 0);
  writeFileSync(LATEST, payload);
  writeFileSync(`${DIR}/${todayUTC()}.json`, payload);

  // Also land the market-book dataset (for eval_strategy.mjs / edge research) and the
  // latest backtest results in git — the dev environment can't reach the site, so git
  // is the transport. Failures here must not sink the scoreboard snapshot.
  const auth = process.env.BASIC_AUTH || "";
  const hdrs = auth ? { authorization: "Basic " + Buffer.from(auth).toString("base64") } : {};
  mkdirSync("data/exports", { recursive: true });
  for (const [name, path] of [["market", "/api/market_logger?mode=export"], ["backtest", "/api/claude?mode=backtest"]]) {
    try {
      const r = await fetch(`${SITE}${path}`, { headers: hdrs, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      writeFileSync(`data/exports/${name}.json`, await r.text());
      console.log(`exports/${name}.json written`);
    } catch (e) { console.error(`export ${name} skipped: ${e.message}`); }
  }

  const g = exp.gate || {};
  console.log(`snapshot: ${exp.count} records (${exp.decisions} decisions, ${exp.settlements} settlements)`);
  console.log(`gate: n=${g.n}/${g.nMin} passed=${g.passed} — ${g.verdict}`);
  const { notify, reason } = shouldNotify(prevGate, g);
  setOutput("notify", String(notify));
  setOutput("reason", reason);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) writeFileSync(summary,
    `### Claude scoreboard snapshot\n- records: **${exp.count}** (${exp.decisions} decisions, ${exp.settlements} settlements)\n` +
    `- gate: n=**${g.n}/${g.nMin}**, ${g.passed ? "**PASS**" : "HOLD"}\n- ${g.verdict}\n`, { flag: "a" });
}

// Only run when invoked directly (lets shouldNotify be imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) main();
