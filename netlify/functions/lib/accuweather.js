// accuweather.js — forward-logging comparison for AccuWeather hourly forecasts.
//
// 2026-07-17: "backtest AccuWeather and incorporate if proven". A forecast vendor
// cannot be backtested retroactively — nobody archives what their hourly said at
// 10am last Tuesday (the free API serves only live forecasts). So this module runs
// the honest version: log AccuWeather's implied daily high at the SAME decision
// moments the scoreboard logs bayes/claude/nws, score everyone against the CLI
// settle, and let ?mode=accu_report call the winner once the sample is real.
// Incorporation into the served blend is gated on that report — nothing here
// touches the live numbers.
//
// Free-tier budget: 50 calls/day. We hard-stop at ACCU_DAILY_BUDGET=45 via a blob
// counter, restrict to ACCU_CITIES (default 6), and only fetch on even local hours
// 8..18 → 6 cities × 6 slots = 36 calls/day, worst case. Location-key lookups are
// one extra call per city, once ever (cached in a blob). MinuteCast is a paid tier
// and is precipitation-only — not fetched.

const BASE = "https://dataservice.accuweather.com";

export const ACCU_DAILY_BUDGET = 45;
export const ACCU_DEFAULT_CITIES = ["Denver", "Phoenix", "Washington DC", "New York", "Chicago", "Boston"];
export const ACCU_LOG_HOURS = new Set([8, 10, 12, 14, 16, 18]);

// Static geo per station (copied from weather.js CITIES) so the module works even
// when the upstream /api/weather payload omits lat/lon.
export const ACCU_GEO = {
  KAVL: [35.4362, -82.5414], KNYC: [40.7789, -73.9692], KLAX: [33.9425, -118.4081],
  KMDW: [41.7860, -87.7524], KHOU: [29.6454, -95.2769], KPHX: [33.4342, -112.0116],
  KPHL: [39.8729, -75.2437], KSAT: [29.5337, -98.4698], KSAN: [32.7336, -117.1897],
  KDFW: [32.8998, -97.0403], KJAX: [30.4941, -81.6879], KAUS: [30.1945, -97.6699],
  KTPA: [27.9755, -82.5332], KSJC: [37.3639, -121.9289], KCMH: [39.9980, -82.8919],
  KCLT: [35.2140, -80.9431], KIND: [39.7173, -86.2944], KSEA: [47.4502, -122.3088],
  KDEN: [39.8617, -104.6731], KDCA: [38.8512, -77.0402], KBOS: [42.3656, -71.0096],
  KMIA: [25.7906, -80.2869], KSFO: [37.6197, -122.3647], KMSY: [29.9934, -90.2581],
  KLAS: [36.0840, -115.1537], KOKC: [35.3931, -97.6007], KMSP: [44.8848, -93.2223],
  KATL: [33.6367, -84.4281],
};

export function accuCityAllowed(name, env = process.env) {
  const raw = env.ACCU_CITIES;
  const list = raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : ACCU_DEFAULT_CITIES;
  return list.includes(name);
}

export function accuHourAllowed(localHour) {
  return ACCU_LOG_HOURS.has(localHour);
}

const utcDate = () => new Date().toISOString().slice(0, 10);

// Take n calls from today's quota. Returns false (and takes nothing) at the ceiling.
// Blob counter, not atomic — the hourly cron is the only writer, so a lost update
// under manual+cron overlap costs at most one phantom call against a 5-call margin.
export async function accuQuotaTake(store, n = 1) {
  const key = `accu/quota_${utcDate()}.json`;
  const q = (await store.get(key, { type: "json" }).catch(() => null)) || { used: 0 };
  if (q.used + n > ACCU_DAILY_BUDGET) return false;
  q.used += n;
  await store.setJSON(key, q);
  return true;
}

export async function accuLocationKey(store, apiKey, station) {
  const cache = (await store.get("accu/location_keys.json", { type: "json" }).catch(() => null)) || {};
  if (cache[station]) return cache[station];
  const geo = ACCU_GEO[station];
  if (!geo) throw new Error(`accu: no geo for ${station}`);
  if (!(await accuQuotaTake(store))) throw new Error("accu: quota exhausted (location)");
  const r = await fetch(`${BASE}/locations/v1/cities/geoposition/search?apikey=${apiKey}&q=${geo[0]}%2C${geo[1]}`);
  if (!r.ok) throw new Error(`accu locations ${r.status}`);
  const j = await r.json();
  if (!j?.Key) throw new Error("accu: geoposition returned no Key");
  cache[station] = j.Key;
  await store.setJSON("accu/location_keys.json", cache);
  return j.Key;
}

// Implied CLI high from a 12-hour hourly forecast: the max forecast temp over the
// hours that fall in the station's REMAINING local calendar day (tomorrow's hours
// can't print in today's CLI), floored at the max already banked. Pure so it can
// be unit-tested against a fixture without network.
export function impliedHighFromHourly(hours, tz, maxSoFarF, todayLocal) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  const temps = (hours || [])
    .filter(h => h?.DateTime && fmt.format(new Date(h.DateTime)) === todayLocal)
    .map(h => h?.Temperature?.Value)
    .filter(Number.isFinite);
  if (!temps.length && maxSoFarF == null) return null;
  const fxMax = temps.length ? Math.max(...temps) : null;
  const implied = Math.max(fxMax ?? -Infinity, maxSoFarF ?? -Infinity);
  return {
    implied_high: Math.round(implied * 10) / 10,
    fx_max_remaining: fxMax,
    hours_in_day: temps.length,
  };
}

export async function accuImpliedHigh(store, apiKey, { station, tz, maxSoFarF }) {
  const locKey = await accuLocationKey(store, apiKey, station);
  if (!(await accuQuotaTake(store))) return null;
  const r = await fetch(`${BASE}/forecasts/v1/hourly/12hour/${locKey}?apikey=${apiKey}`);
  if (!r.ok) throw new Error(`accu hourly ${r.status}`);
  const hours = await r.json();
  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const out = impliedHighFromHourly(hours, tz, maxSoFarF, todayLocal);
  return out ? { ...out, source: "accu_hourly12", asof: new Date().toISOString() } : null;
}

// ---- scoring: accu vs bayes vs claude vs nws on settled decisions ----------------
// Residuals are computed per decision record so every model is compared at the SAME
// asof — a vendor that only looks good because it was sampled later in the day is
// the classic false win this guards against. accu_blend is the counterfactual
// 50/50 average of the bayes point and the accu implied high, scored from day one
// so "incorporate?" has an answer the moment the sample is big enough.
export function scoreAccuDecisions(decisions, cliMaxByKey) {
  const legs = ["accu", "bayes", "claude", "nws", "accu_blend"];
  const agg = {}; for (const l of legs) agg[l] = { n: 0, sae: 0 };
  const byCity = {};
  for (const d of decisions) {
    const cliMax = cliMaxByKey[`${d.station}|${d.contract_date}`];
    if (cliMax == null || d.accu?.implied_high == null) continue;
    const points = {
      accu: d.accu.implied_high,
      bayes: d.bayes?.point ?? null,
      claude: d.claude?.guarded_point ?? d.claude?.point ?? null,
      nws: d.nws ?? null,
      accu_blend: d.bayes?.point != null ? (d.bayes.point + d.accu.implied_high) / 2 : null,
    };
    const c = (byCity[d.city] = byCity[d.city] || {});
    for (const l of legs) {
      if (points[l] == null) continue;
      const ae = Math.abs(points[l] - cliMax);
      agg[l].n++; agg[l].sae += ae;
      const cl = (c[l] = c[l] || { n: 0, sae: 0 });
      cl.n++; cl.sae += ae;
    }
  }
  const mae = (x) => (x.n ? Math.round((x.sae / x.n) * 100) / 100 : null);
  const overall = Object.fromEntries(legs.map(l => [l, { n: agg[l].n, mae: mae(agg[l]) }]));
  const cities = Object.fromEntries(Object.entries(byCity).map(([city, ls]) =>
    [city, Object.fromEntries(Object.entries(ls).map(([l, x]) => [l, { n: x.n, mae: mae(x) }]))]));
  // Decision rule: a real sample and a margin bigger than noise. 0.15°F on n>=40
  // matched pairs is roughly the edge that survives a sign test at this scale.
  let recommendation = "KEEP LOGGING — sample too small";
  const b = overall.bayes, ab = overall.accu_blend, a = overall.accu;
  if (b.n >= 40 && ab.mae != null && b.mae != null) {
    if (ab.mae <= b.mae - 0.15) recommendation = `INCORPORATE — 50/50 accu+bayes blend beats bayes ${ab.mae} vs ${b.mae} on n=${b.n}`;
    else if (a.mae != null && a.mae <= b.mae - 0.15) recommendation = `INCORPORATE (accu-leaning) — raw accu beats bayes ${a.mae} vs ${b.mae} on n=${b.n}`;
    else recommendation = `DO NOT INCORPORATE — bayes ${b.mae} vs blend ${ab.mae} / accu ${a.mae} on n=${b.n}`;
  }
  return { overall, cities, recommendation };
}
