// Returns logged residuals as JSON, with summary stats per city.

import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("residuals");
  const { blobs } = await store.list();
  const records = await Promise.all(
    blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null))
  );
  const valid = records.filter(r => r != null);

  // Per-city summary.
  const byCity = {};
  for (const r of valid) {
    (byCity[r.cli] ??= []).push(r);
  }
  const summary = Object.entries(byCity).map(([cli, rs]) => {
    const errs = rs.map(r => r.residual);
    const n = errs.length;
    const mean = errs.reduce((a,b) => a + b, 0) / n;
    const rmse = Math.sqrt(errs.map(e => e*e).reduce((a,b) => a+b, 0) / n);
    const cov68 = rs.filter(r => r.withinCI68).length / n;
    const cov95 = rs.filter(r => r.withinCI95).length / n;
    return { cli, name: rs[0].name, n,
             meanResidual: Math.round(mean * 100) / 100,
             rmse: Math.round(rmse * 100) / 100,
             cov68: Math.round(cov68 * 1000) / 10,
             cov95: Math.round(cov95 * 1000) / 10 };
  }).sort((a, b) => b.rmse - a.rmse);

  // Global summary.
  const allErrs = valid.map(r => r.residual);
  const global = allErrs.length ? {
    n: allErrs.length,
    rmse: Math.round(Math.sqrt(allErrs.map(e=>e*e).reduce((a,b)=>a+b,0) / allErrs.length) * 100) / 100,
    bias: Math.round(allErrs.reduce((a,b)=>a+b,0) / allErrs.length * 100) / 100,
    cov68: Math.round(valid.filter(r => r.withinCI68).length / allErrs.length * 1000) / 10,
    cov95: Math.round(valid.filter(r => r.withinCI95).length / allErrs.length * 1000) / 10
  } : { n: 0 };

  return new Response(JSON.stringify({
    global, byCity: summary,
    records: valid.sort((a,b) => (a.localDate < b.localDate ? 1 : -1))
  }, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=120" }
  });
};

export const config = { path: "/api/residuals" };
