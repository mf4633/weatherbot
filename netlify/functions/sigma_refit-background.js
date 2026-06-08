// Tolerant background refit of the σ-revision alphas + intraday-β bins (2026-06-08).
//
// WHY: logger.js can run these two fits inline, but they were disabled (INLINE_REFIT=false,
// 2026-05-26) because the ~18s snapshot scan 502s on Netlify's ~10s HTTP sync limit. So
// regime_corrections.sigma_revision_state.fitAtUTC froze at 2026-05-26 and the live
// σ-revision alphas fell back to their seed (the stored α_high/α_low are null). This mirrors
// the calibration_update-background fix: a `-background` fn (15-min limit, returns 202) runs
// the heavy fit reliably under an external/self-kick trigger. It reuses logger.js's EXACT
// exported fit functions — single source of truth, no duplicated math.
//
// TRIGGER: jackson_trader self-kicks this hourly, GATED to start only after 2026-06-13
// (SIGMA_REFIT_RESUME_TS in jackson_trader.js) so it does NOT move live σ during the
// hands-off observation window. Manual/cron entrypoint: GET /api/sigma_refit.
//   /api/sigma_refit            → LIVE: runs both fits, writes regime_corrections "global"
//                                 (sigma_revision_state + intraday_beta_state), audit to
//                                 "sigma_refit_lastrun".
//   /api/sigma_refit?dryRun=1   → DRY: runs both fits but intercepts the write to "global"
//                                 (no-op), recording the would-be result to "sigma_refit_dryrun"
//                                 instead — lets us verify the fit WITHOUT shifting live σ.
//
// Both fits clamp their output (SIGMA_REVISION_ALPHA_CLAMP, per-bin sample floors), so a
// fresh fit is bounded by construction — it can populate real alphas or stay on seed, never
// produce a wild σ. See logger.js, project_weatherbot_calibration_selfheal.

import { getStore } from "@netlify/blobs";
import { runRefitSigmaRevision, runRefitIntradayBeta } from "./logger.js";

export default async (req) => {
  const now = Date.now();
  let dryRun = false;
  try { dryRun = new URL(req.url).searchParams.get("dryRun") === "1"; } catch { /* default live */ }

  const realRegime    = getStore("regime_corrections");
  const snapshotsStore = getStore("prediction_snapshots");
  // Dry-run: reads pass through, but writes to the live "global" blob are no-ops so the fit
  // can be verified without shifting live σ. Live: the real store (fits write "global").
  const regimeStore = dryRun
    ? { get: (...a) => realRegime.get(...a), setJSON: async () => {} }
    : realRegime;

  const out = { ok: true, ranAtUTC: new Date(now).toISOString(), dryRun };
  // Sequential (not parallel): each fit read-modify-writes the SAME "global" blob, so running
  // them in series avoids a lost update (β reads the blob σ just wrote).
  try { out.sigma = await runRefitSigmaRevision(snapshotsStore, regimeStore, now); }
  catch (e) { out.sigma = { fit: false, error: String(e?.message || e) }; }
  try { out.beta = await runRefitIntradayBeta(snapshotsStore, regimeStore, now); }
  catch (e) { out.beta = { fit: false, error: String(e?.message || e) }; }

  // Background fns return 202 — the caller never sees this body. Persist the result to a blob
  // the verifier can read (`netlify blobs:get regime_corrections <key>`). Never the "global"
  // blob the fits already own.
  try { await realRegime.setJSON(dryRun ? "sigma_refit_dryrun" : "sigma_refit_lastrun", out); }
  catch { /* audit write is best-effort */ }

  return new Response(JSON.stringify(out, null, 2),
    { status: 200, headers: { "content-type": "application/json" } });
};
