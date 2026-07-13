// Remaining diurnal-change bound tables for Strategy A (see diurnal.js).
// Each table is an ordered list of { ltHour, val }: the bound (°F) that applies when
// localHour < ltHour (first match wins). RISE = max further rise of the daily high
// after localHour; FALL = max further fall of the daily low.
//
// REGENERATE from data with:  node fit_diurnal.mjs --write SNAPSHOTS=<export.json>
// which replaces this file with data-derived safe upper envelopes. Until fitted from
// real (obs@hour → final-CLI) pairs, these are CONSERVATIVE PLACEHOLDERS: generous, so
// the strategy abstains rather than assert a false certainty.

export const meta = { source: "placeholder+ledger-violations", fittedAt: null, n: 0 };

// 2026-07-13: afternoon values LOOSENED after the first settled ledger (539
// decisions, 2026-07-10/11) showed real weather violating the old envelope:
// KCMH rose 9F after 14h local (2pm lock under an overcast that cleared),
// +7F was seen after 15h, KAVL +4F after 16h, +3F after 17-18h. Artifacts
// from stale DSM/1-min floors were excluded before reading these. Still
// placeholders - fit properly from market_logger pairs with fit_diurnal.mjs.
export const RISE = [
  { ltHour: 10, val: 40 },   // pre-warming: effectively unbounded
  { ltHour: 12, val: 22 },
  { ltHour: 14, val: 12 },
  { ltHour: 15, val: 10 },   // was 8 - KCMH +9 real
  { ltHour: 16, val: 8 },    // was 5 - +7 real
  { ltHour: 17, val: 5 },    // was 3 - KAVL +4 real
  { ltHour: 18, val: 4 },    // was 2 - +3 real
  { ltHour: 19, val: 3 },    // new step - +3 seen as late as 18h
  { ltHour: Infinity, val: 1 }, // post-sunset: high locked (observed max +1 after 19h)
];

export const FALL = [
  { ltHour: 8,  val: 40 },   // pre-dawn: low may still be dropping now
  { ltHour: 18, val: 8 },    // daytime: usually locked, guard an evening front
  { ltHour: 22, val: 5 },
  { ltHour: Infinity, val: 2 }, // late night: low locked for the LST day
];
