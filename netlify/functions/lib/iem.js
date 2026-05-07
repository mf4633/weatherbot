// IEM (Iowa Environmental Mesonet) preliminary daily-max/min for KNYC-equivalent
// settlement reference. IEM ingests the same NWS LDM feed that generates the CLI
// Daily Climate Report, so its `max_dayairtemp[F]` field is the closest publicly
// pollable proxy for what Kalshi will settle on. Used as an *independent* corroboration
// signal alongside the bot's METAR + Synoptic-derived maxSoFar — when the two diverge
// by more than ~0.5°F, something's off (one source has data the other missed).
//
// Today's KNYC incident showed why: Synoptic was returning hourly-only obs (degraded
// 1-min feed), but IEM's max_dayairtemp was still tracking the hourly snapshots
// correctly via NWS LDM. Cross-checking would have surfaced the divergence in seconds.

// Station → state ASOS network mapping (IEM organizes by US state postal code).
const STATION_NETWORK = {
  KNYC: "NY_ASOS", KLAX: "CA_ASOS", KMDW: "IL_ASOS", KHOU: "TX_ASOS",
  KPHX: "AZ_ASOS", KPHL: "PA_ASOS", KSAT: "TX_ASOS", KSAN: "CA_ASOS",
  KDFW: "TX_ASOS", KJAX: "FL_ASOS", KAUS: "TX_ASOS", KTPA: "FL_ASOS",
  KSJC: "CA_ASOS", KCMH: "OH_ASOS", KCLT: "NC_ASOS", KIND: "IN_ASOS",
  KSEA: "WA_ASOS", KDEN: "CO_ASOS", KDCA: "VA_ASOS", KBOS: "MA_ASOS",
};

const UA = "weatherbot.netlify.app (contact: github.com/mf4633)";

let CACHE = { ts: 0, byStation: null };
// IEM updates as new METARs arrive (hourly or on SPECI), so 5 min cache is plenty.
const CACHE_MS = 5 * 60 * 1000;

// Returns map of { stid -> { dailyMaxF, dailyMinF, latestF, latestTs } } or {} on
// total failure. Per-station failures are silently dropped (key absent).
export async function fetchIemDailyExtremes() {
  const now = Date.now();
  if (CACHE.byStation && now - CACHE.ts < CACHE_MS) return CACHE.byStation;

  const stids = Object.keys(STATION_NETWORK);
  const fetchOne = async (kstid) => {
    const network = STATION_NETWORK[kstid];
    const sid = kstid.replace(/^K/, "");
    const url = `https://mesonet.agron.iastate.edu/json/current.py?network=${network}&station=${sid}`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) return null;
      const j = await r.json();
      const o = j?.last_ob;
      if (!o) return null;
      const dailyMaxF = o["max_dayairtemp[F]"];
      const dailyMinF = o["min_dayairtemp[F]"];
      const latestF = o["airtemp[F]"];
      const latestTs = o.utc_valid ? new Date(o.utc_valid) : null;
      return {
        dailyMaxF: typeof dailyMaxF === "number" ? dailyMaxF : null,
        dailyMinF: typeof dailyMinF === "number" ? dailyMinF : null,
        latestF: typeof latestF === "number" ? latestF : null,
        latestTs: latestTs && !isNaN(latestTs) ? latestTs : null,
      };
    } catch (e) {
      return null;
    }
  };

  const results = await Promise.all(stids.map(fetchOne));
  const byStation = {};
  for (let i = 0; i < stids.length; i++) {
    if (results[i]) byStation[stids[i]] = results[i];
  }
  CACHE = { ts: now, byStation };
  return byStation;
}
