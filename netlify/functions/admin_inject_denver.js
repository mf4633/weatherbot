// One-shot ledger inject to unstick KXHIGHDEN-26MAY18-T50 +8 YES (the orphan
// from the 2026-05-18 over-sell auto-flip — see commits 615ed35/397583a for the
// preventive fixes). Writes a synthetic ledger entry on the YES side so the
// trader's sell loop picks it up at the next cycle and auto-closes at the 99¢
// bid. Delete this file after the cycle completes.
//
// Edge-function basic auth (password "hydro") gates this endpoint.

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const ledgerStore = getStore("jackson_open_bets");
  const ticker = "KXHIGHDEN-26MAY18-T50";
  const side = "YES";
  const contracts = 8;
  // Position record at inject time: market_exposure_dollars=6.00, position_fp=8.00
  // → avg entry price 0.75. Used by the sell loop only for cost-basis tracking.
  const stake_dollars = 6.0;
  const price = 0.75;
  const betId = `${ticker}-${side}-orphan-heal-${Date.now()}`;
  const entry = {
    betId, ticker, side, contracts,
    price, stake_dollars,
    city: "Denver", variable: "high", bucket: "T50",
    placedAtUTC: new Date().toISOString(),
    kalshiOrderId: null,
    manualInject: true,
    note: "one-shot orphan heal for 2026-05-18 over-sell flip",
  };
  await ledgerStore.setJSON(`${betId}.json`, entry);
  return new Response(JSON.stringify({ ok: true, entry }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};

export const config = { path: "/api/admin_inject_denver" };
