// low_screen.js — LOW-market screening heuristics as trader signals.
//
// Origin: the 2026-07-22 nightly screen (repo root low_screen.py). This module
// transcribes its three heuristics into the shapes the live trader already
// uses (cityWeather payload + normalized bet), so they run on every cron tick
// instead of living in a standalone report.
//
// Mapping from the screen to trader semantics:
//
//   PHYSICS FLOOR (screen: MISPRICED-MODE floor) — overnight radiational cooling
//     stalls near the dewpoint; a LOW bucket entirely below (Td − 1) is
//     near-impossible while air-mass moisture holds. Trader form: skip LOW YES
//     on buckets whose upper edge sits below the floor while the trough is
//     still ahead. Protective only — it can never place a bet, only block one.
//
//   JAGGED TRACE (screen: JAGGED-TRACE) — active/recent convection (TS/SQ/+RA
//     or gusts ≥ 25 kt in the last 6 h) means the continuous settlement trace
//     undercuts what hourly obs show. Trader form: skip LOW NO on buckets in
//     the convective crash zone just below the observed min — selling the
//     jagged tail is the classic leak. (The screen's buy-side of this play is
//     model territory, not a gate.)
//
//   UNDERCUT-LIVE (screen: UNDERCUT-LIVE) — advisory ONLY. Radiational-evening
//     conditions (obs within 6°F of the running min, ≥ 3 h to local midnight,
//     sky ≤ SCT, wind ≤ 10 kt, no precip) mean today's min can still be
//     undercut. The calibrated bucket-above-obs / tail-obs-floor gates block
//     LOW YES below the running min; this advisory is logged alongside those
//     skips so we can count, over real days, how often the block was wrong
//     under these specific conditions BEFORE any exemption is considered
//     (gates were seeded from real losses — see gate inventory).
//
//   MODEL-VS-FLOOR (screen: MISPRICED-MODE mode-outside-band) — advisory: the
//     model's lowMean sitting below the physics floor is a model-QA flag, not
//     a trade.
//
// All temps °F. Everything here is pure — no fetching, no side effects.
//
// HIGH-side mirror (added 2026-07-22, same evening): no dewpoint anchor exists
// for the daily max, so the HIGH heuristics bound *heating rate* instead:
//
//   HIGH-CLOUD-CAPPED (mirror of physics floor) — a HIGH YES bucket entirely
//     above the observed max needs (bucket_lo − maxObs) of further warming
//     before the peak. Credible warming rate in the final approach (≤4 h to
//     peak) tops out ~4 F/h clear, ~2.5 F/h under overcast/precip. Buckets
//     needing more are unreachable → skip.
//
//   HIGH-SPIKE-NO (mirror of jagged-trace) — gusty mixing under strong
//     insolation spikes the continuous/5-min trace 1-2 F above hourly
//     displays. Selling NO on a bucket just above the observed max while
//     gusts ≥ 20 kt and the peak isn't passed is selling into that spike.
//     (DEN 2026-07-22 outflow: hourly showed 69 F min, the 6-hr group read
//     19.4 C = 66.9 F — same trace physics, LOW direction.)
//
//   LATE-SURGE advisory (mirror of undercut-live) — after the nominal peak,
//     current temp within 2 F of the max with a rising 3 h trend means warm
//     advection (downslope / warm sector) may still beat the afternoon max
//     before local midnight. Advisory only, joined offline against gates that
//     block HIGH YES above maxSoFar.

const SKY_RANK = { CLR: 0, SKC: 0, FEW: 1, SCT: 2, BKN: 3, OVC: 4, VV: 4 };

export function skyWorstRank(skyStr) {
  if (!skyStr) return 0;
  let worst = 0;
  for (const m of skyStr.matchAll(/\b(FEW|SCT|BKN|OVC|VV)\d{3}\b/g)) {
    worst = Math.max(worst, SKY_RANK[m[1]] ?? 0);
  }
  return worst;
}

function windFromLine(line) {
  const body = line.split(/\bRMK\b/)[0];
  const m = body.match(/\b(?:\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  if (!m) return { windKt: null, gustKt: null };
  return { windKt: parseInt(m[1], 10), gustKt: m[2] ? parseInt(m[2], 10) : null };
}

// Convective marker in the METAR body: thunder, squall, or heavy rain.
function convWx(line) {
  const body = line.split(/\bRMK\b/)[0];
  return /\bTS|\bSQ\b|\+RA/.test(body);
}

// Any present weather (precip) token in the METAR body, at any intensity.
// Scans the raw body — parseMetar's wx field misses some token forms.
function precipWx(line) {
  const body = line.split(/\bRMK\b/)[0];
  return /(?:^|\s)[+-]?(?:VC)?(?:TS|SH)?(?:RA|SN|DZ|GS|GR|PL|UP|SG|IC)\b/.test(body)
      || /(?:^|\s)[+-]?TS(?:RA|SN|PL|GS|GR)?\b/.test(body);
}

// Build a compact surface summary from weather.js's parsed METAR array
// (objects with { line, ts, tempC }). parseMetarOb = lib/metar.js parseMetar,
// injected so this module stays dependency-light for tests.
export function surfaceObsFromMetars(metars, tz, refNow, parseMetarOb) {
  if (!metars?.length) return null;
  const now = refNow ?? new Date();
  const recent = metars.filter(o => o.ts && now - o.ts <= 26 * 3600 * 1000);
  if (!recent.length) return null;
  const latest = recent[recent.length - 1];
  const ob = parseMetarOb ? parseMetarOb(latest.line, now) : {};
  const { windKt, gustKt } = windFromLine(latest.line);

  const sixHrAgo = now.getTime() - 6 * 3600 * 1000;
  const last6 = recent.filter(o => o.ts.getTime() >= sixHrAgo);
  const convective = last6.some(o => convWx(o.line) || (windFromLine(o.line).gustKt ?? 0) >= 25);

  // 3 h temp trend from the parsed tempC series (°F).
  const threeHrAgo = now.getTime() - 3.2 * 3600 * 1000;
  const trendWindow = recent.filter(o => o.ts.getTime() >= threeHrAgo && o.tempC != null);
  const cToF = c => c * 9 / 5 + 32;
  const trend3F = trendWindow.length > 1
    ? Math.round((cToF(trendWindow[trendWindow.length - 1].tempC) - cToF(trendWindow[0].tempC)) * 10) / 10
    : null;

  // Hours until the next LOCAL midnight — the calendar-day CLI window edge.
  let hrsToLocalMidnight = null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit"
    }).formatToParts(now);
    const h = parseInt(parts.find(p => p.type === "hour").value, 10) % 24;
    const mi = parseInt(parts.find(p => p.type === "minute").value, 10);
    hrsToLocalMidnight = Math.round((24 - h - mi / 60) * 10) / 10;
  } catch (e) { /* bad tz -> advisory simply won't fire */ }

  const r = v => (v == null ? null : Math.round(v * 10) / 10);
  return {
    obsTs: latest.ts.toISOString(),
    ageMin: Math.round((now - latest.ts) / 60000),
    tempF: latest.tempC != null ? r(cToF(latest.tempC)) : null,
    dewpointF: ob.dewpoint_f != null ? r(ob.dewpoint_f) : null,
    windKt, gustKt,
    sky: ob.sky ?? null,
    skyWorst: skyWorstRank(ob.sky),
    wx: ob.wx ?? null,
    precipNow: precipWx(latest.line),
    convective6h: convective,
    trend3F,
    hrsToLocalMidnight,
  };
}

export function physicsFloorF(surface) {
  return surface?.dewpointF != null ? surface.dewpointF - 1 : null;
}

// Radiational-evening undercut conditions (screen's UNDERCUT-LIVE gate set).
export function undercutLiveConditions(surface, minObsF) {
  if (!surface || minObsF == null || surface.tempF == null) return { active: false };
  const gapF = surface.tempF - minObsF;
  const active =
    gapF <= 6 &&
    (surface.hrsToLocalMidnight ?? 0) >= 3 &&
    surface.skyWorst <= 2 &&
    (surface.windKt ?? 99) <= 10 &&
    !surface.precipNow;
  return { active, gapF: Math.round(gapF * 10) / 10,
           hrsToLocalMidnight: surface.hrsToLocalMidnight,
           skyWorst: surface.skyWorst, windKt: surface.windKt };
}

// Main check. bet = normalized trader bet (variable, side, loInt, hiInt, ticker);
// cityWeather = weather.js city payload (needs .surfaceObs, .minSoFar,
// .hrsToTrough, .lowMean, and the CLI-grade min via minObsF param).
// Returns { skips: [{reason, ...detail}], advisories: [{flag, ...detail}] }.
export function lowScreenCheck(bet, cityWeather, minObsF) {
  const out = { skips: [], advisories: [] };
  if (!bet || bet.variable !== "low" || !cityWeather?.surfaceObs) return out;
  const s = cityWeather.surfaceObs;
  const floor = physicsFloorF(s);
  const minObs = minObsF ?? cityWeather.minSoFar ?? null;

  // 1. PHYSICS FLOOR — LOW YES on a bucket entirely below Td−1, trough ahead.
  //    hiInt is the bucket's upper integer; bucket covers ≤ hiInt+0.499 as CLI
  //    rounds. Tail buckets with hiInt=null extend upward — not applicable.
  //    Stale-ob guard: dewpoint older than 3 h can misrepresent the air mass.
  if (bet.side === "yes" && floor != null && bet.hiInt != null && s.ageMin <= 180
      && (cityWeather.hrsToTrough ?? 0) > 1
      && bet.hiInt + 0.499 < floor) {
    out.skips.push({ reason: "low-physics-floor", floorF: floor,
                     dewpointF: s.dewpointF, bucketHi: bet.hiInt,
                     marginF: Math.round((floor - bet.hiInt - 0.499) * 10) / 10 });
  }

  // 2. JAGGED TRACE — LOW NO on a bucket in the convective crash zone just
  //    below the observed min: TS outflow / rain-cooling can spike the
  //    settlement trace into it between hourly obs. Zone: bucket intersecting
  //    (minObs − 6, minObs + 1).
  if (bet.side === "no" && s.convective6h && minObs != null) {
    const lo = bet.loInt ?? -999, hi = bet.hiInt ?? 999;
    if (hi >= minObs - 6 && lo <= minObs + 1) {
      out.skips.push({ reason: "low-jagged-no", minObsF: minObs,
                       wx: s.wx, gustKt: s.gustKt,
                       bucket: [bet.loInt, bet.hiInt] });
    }
  }

  // 3. UNDERCUT-LIVE — advisory. Logged for every LOW bet while conditions
  //    hold so bucket-above-obs / tail-obs-floor skips can be joined against
  //    it offline. Never a skip, never an exemption.
  const uc = undercutLiveConditions(s, minObs);
  if (uc.active) out.advisories.push({ flag: "undercut-live-conditions", ...uc });

  // 4. MODEL-VS-FLOOR — advisory: model lowMean below the physics floor is a
  //    model-QA smell (σ inflation or bad forecast blend), not a trade.
  if (floor != null && cityWeather.lowMean != null && cityWeather.lowMean < floor - 1) {
    out.advisories.push({ flag: "low-mean-below-dewpoint-floor",
                          lowMean: cityWeather.lowMean, floorF: floor });
  }
  return out;
}

// HIGH mirror. bet/cityWeather as in lowScreenCheck; maxObsF = CLI-grade
// observed max (trader's cliMaxObs). Returns the same { skips, advisories }.
export function highScreenCheck(bet, cityWeather, maxObsF) {
  const out = { skips: [], advisories: [] };
  if (!bet || bet.variable !== "high" || !cityWeather?.surfaceObs) return out;
  const s = cityWeather.surfaceObs;
  const maxObs = maxObsF ?? cityWeather.maxSoFar ?? null;
  const hrsToPeak = cityWeather.hrsToPeak ?? null;

  // 1. HIGH-CLOUD-CAPPED — YES on a bucket entirely above the observed max in
  //    the final approach to the peak, where the needed warming rate exceeds
  //    what the sky state supports. Not applied earlier than 4 h out (morning
  //    heating ramps ARE steep) or to tail bounds without a lower edge.
  if (bet.side === "yes" && maxObs != null && bet.loInt != null && s.ageMin <= 180
      && hrsToPeak != null && hrsToPeak > 0 && hrsToPeak <= 4
      && bet.loInt - 0.5 > maxObs) {
    const needF = bet.loInt - 0.5 - maxObs;
    const capped = s.precipNow || s.skyWorst >= 4;
    const maxRateF = capped ? 2.5 : 4.0;
    const rateF = needF / hrsToPeak;
    if (rateF > maxRateF) {
      out.skips.push({ reason: "high-cloud-capped",
                       needF: Math.round(needF * 10) / 10,
                       rateFPerHr: Math.round(rateF * 10) / 10,
                       maxRateFPerHr: maxRateF, hrsToPeak,
                       sky: s.sky, precipNow: s.precipNow });
    }
  }

  // 2. HIGH-SPIKE-NO — NO on a bucket intersecting the turbulent spike zone
  //    just above the observed max (maxObs − 1 to maxObs + 2) while gusts
  //    ≥ 20 kt and the peak isn't clearly passed. The continuous trace
  //    settles above hourly displays in exactly this zone.
  if (bet.side === "no" && maxObs != null && (s.gustKt ?? 0) >= 20
      && (hrsToPeak == null || hrsToPeak > -1)) {
    const lo = bet.loInt ?? -999, hi = bet.hiInt ?? 999;
    if (hi >= maxObs - 1 && lo <= maxObs + 2) {
      out.skips.push({ reason: "high-spike-no", maxObsF: maxObs,
                       gustKt: s.gustKt, bucket: [bet.loInt, bet.hiInt] });
    }
  }

  // 3. LATE-SURGE — advisory. Post-peak warm advection still climbing toward
  //    the max: log so blocks on HIGH YES above maxSoFar can be audited.
  if (s.tempF != null && maxObs != null
      && (hrsToPeak == null || hrsToPeak <= 0)
      && s.tempF >= maxObs - 2 && (s.trend3F ?? -99) >= 1
      && (s.hrsToLocalMidnight ?? 0) >= 1) {
    out.advisories.push({ flag: "late-high-surge-conditions",
                          tempF: s.tempF, maxObsF: maxObs,
                          trend3F: s.trend3F,
                          hrsToLocalMidnight: s.hrsToLocalMidnight });
  }
  return out;
}
