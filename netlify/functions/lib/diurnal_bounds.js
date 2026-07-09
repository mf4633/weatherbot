// Remaining diurnal-change bound tables for Strategy A (see diurnal.js).
// Each table is an ordered list of { ltHour, val }: the bound (°F) that applies when
// localHour < ltHour (first match wins). RISE = max further rise of the daily high
// after localHour; FALL = max further fall of the daily low.
//
// REGENERATE from data with:  node fit_diurnal.mjs --write SNAPSHOTS=<export.json>
// which replaces this file with data-derived safe upper envelopes. Until fitted from
// real (obs@hour → final-CLI) pairs, these are CONSERVATIVE PLACEHOLDERS: generous, so
// the strategy abstains rather than assert a false certainty.

export const meta = { source: "placeholder", fittedAt: null, n: 0 };

export const RISE = [
  { ltHour: 10, val: 40 },   // pre-warming: effectively unbounded
  { ltHour: 12, val: 22 },
  { ltHour: 14, val: 12 },
  { ltHour: 15, val: 8 },
  { ltHour: 16, val: 5 },
  { ltHour: 17, val: 3 },
  { ltHour: 18, val: 2 },
  { ltHour: Infinity, val: 1 }, // post-sunset: high locked (tiny anomaly margin)
];

export const FALL = [
  { ltHour: 8,  val: 40 },   // pre-dawn: low may still be dropping now
  { ltHour: 18, val: 8 },    // daytime: usually locked, guard an evening front
  { ltHour: 22, val: 5 },
  { ltHour: Infinity, val: 2 }, // late night: low locked for the LST day
];
