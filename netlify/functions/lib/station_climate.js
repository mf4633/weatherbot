// station_climate.js — per-station physiographic & regime knowledge, encoded
// (2026-07-22, distilled from the live-trading sessions: marine-layer/sea-breeze
// mechanics at LAX/SFO/SAN/BOS/SEA, compressional-offshore spike setups, humid
// gain-compression, lake breezes, monsoon surges, settlement quirks).
//
// Two exports:
//   STATION_CLIMATE — the knowledge base. Wind sectors are [from, to] degrees
//     CLOCKWISE (wraps through 360). `humid_dew` = dewpoint (F) above which the
//     Bowen ratio visibly taxes sensible heating. `capped_gain` = typical
//     remaining afternoon rise (F) once the marine/lake thermostat is engaged.
//   adviseClimate(station, ob, opts) — turns the latest ob into regime flags the
//     dashboard (and a human) can read. Display/context only: nothing here feeds
//     the scored models. lean: "cap" (argues low), "hot" (argues high), "info".
//
// TWO KINDS OF "COMPRESSION" (referenced in notes):
//   gain compression — afternoon temperature RISE shrinks when (a) the boundary
//     layer already sits near its airmass ceiling (hot start -> curves converge)
//     or (b) high dewpoints divert solar energy to latent heat (humid tax).
//   compressional flow — DESCENDING wind (downslope/offshore) warms ~5.5F per
//     1000 ft of descent and dries as it warms. This is the anti-marine regime:
//     coastal stations spike (SFO 92F on 2026-07-21 with dew crashing 63->38),
//     and analog ceilings break upward. Detected here via offshore sectors.

export const STATION_CLIMATE = {
  // ------------------------------------------------------------- WEST COAST --
  KLAX: {
    city: "Los Angeles", setting: "beach-adjacent coastal, Santa Monica Bay west",
    onshore: [190, 300], offshore: [320, 130], humid_dew: 64, capped_gain: 3, peak_hour: 15,
    marine_thermostat: true,
    notes: [
      "Marine layer is the whole game May-Sep: burn-off TIME sets the high. Clear-by-9 ~ low 80s; clearing 11-12 ~ 75-78; deck holds past 1 PM ~ 73-75.",
      "Sea breeze IS the thermostat: W 260-280 = mature perpendicular onshore (max marine advection); SW/WSW = morning/transition, still marine; SSW-S = Catalina-eddy signature, DEEPER marine layer.",
      "Afternoon thermal-trough deepening inland (falling SLP) STRENGTHENS the breeze during peak heating — sunny afternoons still often gain only +1-3 once wind >= 12 mph.",
      "Danger sectors N-E: Santa Ana / weak offshore = compressional spike, 90s possible. Tell: wind with any N/E component + dewpoint falling. Calm = airport decoupled from ocean, also warm.",
      "Inland gradient is the leading indicator: Hawthorne (3 km) runs 3-6F warmer under a coastal deck; the gap COMPRESSING seaward = breeze winning, gap widening = burn-off spreading to the coast.",
      "Settlement: CLI LAX ran +1.7F above the hourly-PWS interpolated peak (30-day walk-forward, backtest_lax.py) — 1-min spikes the METARs miss.",
    ],
  },
  KSFO: {
    city: "San Francisco", setting: "bay shoreline, marine-dominated",
    onshore: [200, 320], offshore: [340, 140], humid_dew: 62, capped_gain: 3, peak_hour: 15,
    marine_thermostat: true,
    notes: [
      "Strongest marine thermostat in the network: onshore W-NW = 60s-low 70s regardless of season.",
      "The spike mode is the OFFSHORE FLUSH (2026-07-21: N winds all day, 4:15 PM calm, then 79->92 in 25 min with dew 63->38). Watch for N/NE winds, a mid-afternoon lull, then the switch — the day's high can arrive at 4-6 PM in minutes.",
      "A one-day 92 poisons obs-anchored models for days (anchor anomaly) — trust the current regime's wind, not yesterday's max.",
    ],
  },
  KSAN: {
    city: "San Diego", setting: "harbor-adjacent coastal",
    onshore: [180, 300], offshore: [330, 120], humid_dew: 65, capped_gain: 3, peak_hour: 14,
    marine_thermostat: true,
    notes: [
      "LAX-like but gentler amplitude: marine layer + bay breeze pin most summer days 72-79.",
      "Santa Ana (NE) season Oct-Mar is the only common 90s+ path.",
    ],
  },
  KSJC: {
    city: "San Jose", setting: "inland end of a marine-influenced valley",
    onshore: [280, 360], offshore: [60, 200], humid_dew: 60, capped_gain: 5, peak_hour: 16,
    marine_thermostat: false,
    notes: [
      "Partially sheltered from the marine layer — burns off earlier than SFO and runs 8-15F warmer; NW sea-breeze intrusion through the Golden Gate/valley arrives late afternoon and caps the tail.",
    ],
  },
  KSEA: {
    city: "Seattle", setting: "Puget Sound lowland",
    onshore: [180, 300], offshore: [20, 120], humid_dew: 60, capped_gain: 4, peak_hour: 16,
    marine_thermostat: true,
    notes: [
      "Onshore SW-W = mild marine cap. The hot regime is OFFSHORE E-NE through the Cascade gaps — compressional downslope (the 2021 heat-dome mechanism). Big positive anchor anomalies at KSEA almost always mean offshore flow is running.",
    ],
  },
  // ------------------------------------------------------------- GULF COAST --
  KHOU: {
    city: "Houston (Hobby)", setting: "coastal plain, Galveston Bay 15 mi SE",
    onshore: [90, 200], offshore: [250, 30], humid_dew: 74, capped_gain: 4, peak_hour: 17,
    marine_thermostat: false,
    notes: [
      "Two summer regimes: SE/S Gulf onshore = moderated (upper 90s hard to reach, dew 74-78 humid tax); W/NW offshore-continental = the hot one (2026-07-22: +6F over the prior day by noon, 100F+ with dew mixing DOWN to 22C).",
      "Afternoon gain from the noon ob ran +7 to +10 on consecutive W-flow heat days — the climb persists late (peak 4-6 PM CDT). Deceleration below +2/hr after 2 PM is the first true plateau signal.",
      "CLI high exceeded the METAR max on 9/14 backtest days (~+1.2F 1-min spike gap) — settlement leans HIGH of what the hourlies show.",
      "Settlement identity verified: Kalshi Houston (KXHIGHTHOU) = HOBBY CLI, not IAH (settled-market cross-check 2026-07-22). IAH runs 1-3F hotter on W-flow days — don't mix the stations.",
    ],
  },
  KMSY: {
    city: "New Orleans", setting: "lake/river delta, water on three sides",
    onshore: [80, 220], offshore: [270, 20], humid_dew: 75, capped_gain: 3, peak_hour: 16,
    marine_thermostat: false,
    notes: ["Permanent humid tax (dew 74-78) + afternoon pulse storms cap most days 91-95; the hot tail needs a dry NW airmass, rare in summer."],
  },
  KMIA: {
    city: "Miami", setting: "peninsula, Atlantic 8 mi E",
    onshore: [40, 180], offshore: [230, 340], humid_dew: 75, capped_gain: 3, peak_hour: 14,
    marine_thermostat: true,
    notes: [
      "The most range-bound station in the set: E-SE ocean breeze + dew ~75-78 pins ~89-93 nearly every summer day; the high often lands late morning BEFORE the breeze and storms.",
      "W-flow mornings (breeze delayed) are the only common 95+ path.",
    ],
  },
  KTPA: {
    city: "Tampa", setting: "bay east shore",
    onshore: [200, 320], offshore: [40, 160], humid_dew: 75, capped_gain: 3, peak_hour: 14,
    marine_thermostat: true,
    notes: ["Gulf/bay breeze + daily storms: highs 90-94 with the max typically before 2 PM; E-flow mornings run hotter until the breeze wins."],
  },
  KJAX: {
    city: "Jacksonville", setting: "coastal plain, ocean 15 mi E",
    onshore: [40, 160], offshore: [220, 340], humid_dew: 74, capped_gain: 4, peak_hour: 15,
    marine_thermostat: false,
    notes: ["Far enough inland that the sea breeze arrives late — highs mid-90s common under W flow before the breeze/storms knock it down."],
  },
  // ------------------------------------------------------------ TEXAS INLAND --
  KAUS: {
    city: "Austin (Bergstrom)", setting: "inland, Balcones escarpment west",
    onshore: [110, 200], offshore: [270, 20], humid_dew: 72, capped_gain: 5, peak_hour: 17,
    marine_thermostat: false,
    notes: [
      "NW-N light flow = COMPRESSIONAL (downslope off the Hill Country) — the hottest setup, dew mixing down all afternoon (2026-07-22: NWS grid verified 3F cold, day ran 105-106 vs 103 grid peak).",
      "SE Gulf flow moderates (adds 2-4F of humid tax + onshore character). Morning low stratus is common and its burn-off time shifts the afternoon gain: stratus-choked mornings gained +9-11 from 11:30; clear mornings front-load the heat.",
      "Settlement identity: Kalshi Austin = BERGSTROM (rules text explicit) — Camp Mabry runs warmer, don't cross-read.",
    ],
  },
  KSAT: {
    city: "San Antonio", setting: "inland, escarpment northwest",
    onshore: [110, 200], offshore: [270, 20], humid_dew: 72, capped_gain: 5, peak_hour: 17,
    marine_thermostat: false,
    notes: ["Austin's twin: NW compressional = hottest, SE Gulf = moderated + humid tax; frontal passages produce the B-bucket busts (SATX gate history)."],
  },
  KDFW: {
    city: "Dallas-Fort Worth", setting: "continental plains",
    onshore: [140, 200], offshore: null, humid_dew: 70, capped_gain: 6, peak_hour: 17,
    marine_thermostat: false,
    notes: ["Fully continental: late peaks (5-6 PM), big diurnal ranges, dryline west — W-flow days mix dew down and run hottest; S flow imports Gulf moisture and a mild tax."],
  },
  // -------------------------------------------------------------- DESERT SW --
  KPHX: {
    city: "Phoenix", setting: "desert basin",
    onshore: null, offshore: null, humid_dew: 55, capped_gain: 6, peak_hour: 17,
    marine_thermostat: false, monsoon_dew: 55,
    notes: [
      "Jul-Aug is monsoon season: dew >= 55F = surge in place, highs run 3-8F BELOW the dry-airmass ceiling (gain compression via humid tax + debris cloud); dew < 50 = dry regime, 110s available.",
      "Outflow boundaries drop temps 10-20F in minutes and can freeze the daily max mid-afternoon — a convective 'peak lock'.",
    ],
  },
  KLAS: {
    city: "Las Vegas", setting: "desert valley",
    onshore: null, offshore: null, humid_dew: 50, capped_gain: 6, peak_hour: 17,
    marine_thermostat: false, monsoon_dew: 50,
    notes: ["Drier than PHX; monsoon surges rarer but same rule — dew >= 50 marks the moist regime and shaves the ceiling."],
  },
  // -------------------------------------------------------------- MOUNTAIN ---
  KDEN: {
    city: "Denver (DIA)", setting: "high plains east of the Front Range",
    onshore: [20, 120], offshore: [220, 330], humid_dew: 55, capped_gain: 6, peak_hour: 16,
    marine_thermostat: false,
    notes: [
      "W-SW downslope (chinook-style) = compressional warm + dry; E-NE UPSLOPE = cool, moist, cloud — the 'onshore' sector here is upslope, and it caps like a sea breeze.",
      "Afternoon convection regularly locks the max early (momentum rule's 2026-07-21 KDEN miss: 89->92->94 momentum was read as a plateau — don't).",
      "DIA sits 15 mi NE of the city: metro PWS run cool of the airport on downslope days (backtest: PWS 2-6F cool — sign flipped vs coastal cities).",
    ],
  },
  // -------------------------------------------------------------- EAST COAST --
  KBOS: {
    city: "Boston (Logan)", setting: "harbor peninsula — sea-breeze station",
    onshore: [60, 150], offshore: [230, 320], humid_dew: 68, capped_gain: 3, peak_hour: 14,
    marine_thermostat: true,
    notes: [
      "TRUE sea breeze is E-SE (060-150) and can end the day's heating before noon — July highs often land late morning.",
      "SSW-SW is only PARTIALLY marine (crosses the harbor/Dorchester Bay): it holds Logan 1-3F below inland while gusty warm-sector sun still grinds upward in stair-steps (2026-07-22: 82 plateau 95 min, then step to 84, then 86-87 anyway). Half-marine flow DELAYS but doesn't cap.",
      "Dew >= 70 in the warm sector = real humid tax on the last 2-3F.",
    ],
  },
  KNYC: {
    city: "New York (Central Park)", setting: "urban park, well inland of the harbor",
    onshore: [140, 200], offshore: null, humid_dew: 70, capped_gain: 4, peak_hour: 15,
    marine_thermostat: false,
    notes: [
      "No reliable marine cap — the S harbor breeze occasionally shaves the late afternoon 1-2F but momentum days run through it (2026-07-22: 74->76->79->82 hourly, +3F/hr, settled 86-87 territory).",
      "Station quirk: the :51 hourly METAR reports the PRECEDING HOUR'S MAX, not an instant — daily max ~ max of hourlies (unique in this network).",
      "Manhattan PWS run 3-8F hot of the park; regression, not raw comparison.",
    ],
  },
  KPHL: {
    city: "Philadelphia", setting: "coastal-plain urban, Delaware River",
    onshore: [120, 190], offshore: null, humid_dew: 71, capped_gain: 4, peak_hour: 15,
    marine_thermostat: false,
    notes: ["Continental-humid: SE bay-breeze influence is weak and late; humid tax above dew ~71 is the main cap; otherwise momentum days carry."],
  },
  KDCA: {
    city: "Washington DC (National)", setting: "riverside urban",
    onshore: [140, 200], offshore: null, humid_dew: 72, capped_gain: 4, peak_hour: 15,
    marine_thermostat: false,
    notes: ["Urban + river micro-warmth: DCA runs hot of the metro; humid tax common; smoke/haze events (VV groups) can cut 1-3F (2026-07-17 KDCA smoke)."],
  },
  // ----------------------------------------------------------------- LAKES ---
  KMDW: {
    city: "Chicago (Midway)", setting: "urban, 10 mi SW of Lake Michigan",
    onshore: [20, 110], offshore: [180, 300], humid_dew: 68, capped_gain: 4, peak_hour: 15,
    marine_thermostat: true,
    notes: [
      "Lake breeze NE-E (020-110) is the cap — arrival at Midway (10 mi inland) is the whole question on warm days; SW flow holds it off and runs hot.",
      "Cold-pool mornings (big negative anchor anomaly) usually MIX OUT: the morning-anchored model's p_lock is a lower bound — the day runs hotter than obs-anchored projections (floorsweep tailwind rule).",
    ],
  },
  // ------------------------------------------------------------- INTERIOR ----
  KCMH: { city: "Columbus", setting: "continental interior", onshore: null, offshore: null, humid_dew: 70, capped_gain: 5, peak_hour: 16, marine_thermostat: false,
    notes: ["Plain continental-humid: airmass + cloud cover decide; no mesoscale thermostat."] },
  KIND: { city: "Indianapolis", setting: "continental interior", onshore: null, offshore: null, humid_dew: 70, capped_gain: 5, peak_hour: 16, marine_thermostat: false,
    notes: ["As Columbus — watch dew for the humid tax and convection for early peak locks."] },
  KCLT: { city: "Charlotte", setting: "piedmont", onshore: null, offshore: null, humid_dew: 71, capped_gain: 5, peak_hour: 16, marine_thermostat: false,
    notes: ["Piedmont ridge-influenced; SW downslope off the Appalachians adds a small compressional kick on hot days."] },
  KAVL: { city: "Asheville", setting: "mountain valley", onshore: null, offshore: null, humid_dew: 66, capped_gain: 5, peak_hour: 15, marine_thermostat: false,
    notes: ["Elevation-capped (2100 ft): valley inversions burn off late; afternoon ridging + convection ends heating early most summer days."] },
};

// --- helpers ---------------------------------------------------------------------
const inSector = (deg, sector) => {
  if (deg == null || !sector) return false;
  const [a, b] = sector;
  return a <= b ? deg >= a && deg <= b : deg >= a || deg <= b;
};
const lowDeck = (sky) => {
  // any BKN/OVC layer with base <= 2000 ft ("BKN012" -> 1200)
  for (const m of (sky || "").matchAll(/(BKN|OVC)(\d{3})/g)) if (+m[2] <= 20) return true;
  return false;
};

// --- advisor ---------------------------------------------------------------------
// ob: parseMetar shape { temp_f, dewpoint_f, wind_dir_deg, wind_speed_kt, sky, ... }
// opts: { hourLocal } (fractional local hour, optional but improves burn-off logic)
export function adviseClimate(station, ob, opts = {}) {
  const cfg = STATION_CLIMATE[station];
  if (!cfg || !ob) return null;
  const flags = [];
  const dir = ob.wind_dir_deg, kt = ob.wind_speed_kt || 0;
  const mph = Math.round(kt * 1.15);
  const dew = ob.dewpoint_f, t = ob.temp_f;
  const h = opts.hourLocal ?? null;

  // Marine / lake / upslope thermostat
  if (cfg.marine_thermostat && inSector(dir, cfg.onshore) && mph >= 8) {
    flags.push({ code: "thermostat", lean: "cap",
      note: `onshore ${mph} mph — ${cfg.city.includes("Chicago") ? "lake" : cfg.city.includes("Denver") ? "upslope" : "sea"} breeze engaged; typical remaining gain <= +${cfg.capped_gain}F` });
  }
  // Low marine/stratus deck
  if (lowDeck(ob.sky)) {
    flags.push({ code: "low-deck", lean: "cap",
      note: h != null && h >= 12
        ? "low deck holding past noon — strongly capped day"
        : "low stratus deck — burn-off TIME sets the ceiling (later = cooler)" });
  } else if (cfg.marine_thermostat && h != null && h >= 10 && h <= 14 && /FEW|SCT/.test(ob.sky || "")) {
    flags.push({ code: "burnoff", lean: "info", note: "deck thinning/broken — burn-off in progress; watch whether the breeze or the sun wins the next hour" });
  }
  // Compressional / offshore
  if (inSector(dir, cfg.offshore) && kt >= 4) {
    flags.push({ code: "offshore-compressional", lean: "hot",
      note: "offshore/downslope sector — compressionally warmed, drying airmass; obs-anchored ceilings unreliable UPWARD (SFO-flush / chinook family)" });
  }
  // Coastal decoupling
  if (cfg.marine_thermostat && kt <= 3 && h != null && h >= 11 && h <= 17) {
    flags.push({ code: "calm-decoupled", lean: "hot",
      note: "near-calm at a marine station — ocean decoupled; watch for a spike, esp. if wind flips offshore after a lull" });
  }
  // Humid gain-compression
  if (dew != null && dew >= cfg.humid_dew) {
    flags.push({ code: "humid-tax", lean: "cap",
      note: `dew ${Math.round(dew)}F >= ${cfg.humid_dew} — latent-heat tax on the last few degrees (gain compression)` });
  }
  // Desert monsoon surge
  if (cfg.monsoon_dew != null && dew != null && dew >= cfg.monsoon_dew) {
    flags.push({ code: "monsoon-surge", lean: "cap",
      note: `dew ${Math.round(dew)}F — monsoon moisture in place; highs run below the dry ceiling, outflow can lock the max early` });
  }
  // Dry mixing (dew well below regime norm while temp climbs) — hot lean
  if (dew != null && t != null && (t - dew) >= 35) {
    flags.push({ code: "deep-mixing", lean: "hot",
      note: `T-Td spread ${Math.round(t - dew)}F — deeply mixed dry boundary layer; ceiling extends upward` });
  }

  const leans = flags.map(f => f.lean);
  const regime = leans.includes("hot") && !leans.includes("cap") ? "hot-lean"
    : leans.includes("cap") && !leans.includes("hot") ? "capped-lean"
    : flags.length ? "mixed" : "neutral";
  return { station, regime, flags, setting: cfg.setting, peak_hour: cfg.peak_hour, notes: cfg.notes };
}
