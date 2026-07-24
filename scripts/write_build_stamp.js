// Emit _build_stamp.json into the publish dir so the commit actually SERVING is
// observable from outside.
//
// Why this is needed at all: a failed Netlify build leaves the previous deploy answering
// 200 on every endpoint, so drift is invisible — exactly what happened on 2026-07-24
// (deploy 560089a errored at exit 2 and the site kept serving c4deb6d, looking perfectly
// healthy). Three cheaper routes were tried and none work on this site:
//   - process.env.COMMIT_REF at function runtime — only SITE_NAME is injected, verified
//   - GitHub commit status / deployments — Netlify posts neither for this repo, verified
//   - the Netlify API — needs a token secret, which is a manual step
// publish = "." means anything written here is served statically, so the health cron can
// simply curl it.
//
// CRITICAL: this is the site's ONLY build command, on a site that previously had none. It
// must never fail a deploy. Two layers, because the first draft proved one is not enough:
//   1. everything below is wrapped and the exit code forced to 0;
//   2. netlify.toml appends `|| true`, because a MODULE-LOAD error (the first draft used
//      require() in an ESM package and threw before any try/catch existed) happens before
//      any in-script guard can run.
// A missing stamp degrades the drift check to "unknown", which the cron handles.

import fs from "node:fs";
import path from "node:path";

try {
  const stamp = {
    // Netlify sets these during BUILD (they are simply absent at function runtime).
    commit: process.env.COMMIT_REF || null,
    branch: process.env.BRANCH || null,
    context: process.env.CONTEXT || null,
    deploy_id: process.env.DEPLOY_ID || null,
    built_at: new Date().toISOString(),
  };
  const out = path.join(process.cwd(), "_build_stamp.json");
  fs.writeFileSync(out, JSON.stringify(stamp, null, 2) + "\n");
  console.log(`[build-stamp] wrote ${out}: commit=${stamp.commit ?? "unknown"} context=${stamp.context ?? "?"}`);
} catch (e) {
  // Deliberately swallowed — a stamp is a diagnostic, not a dependency.
  console.error(`[build-stamp] FAILED (non-fatal, drift check degrades to unknown): ${e && e.message}`);
}

process.exit(0);
