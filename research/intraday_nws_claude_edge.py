#!/usr/bin/env python3
# Per-hour entry-edge scan for the CLAUDE-MODIFIER models, Bayesian layer EXCLUDED.
#
# The shadow-logger `modelMean` is the Bayesian ensemble (duplicates NWS) — ignored here.
# Instead we join the Claude scoreboard (mode=export_slim: per station/date/hour `point`
# = pure obs-analog + physical modifiers, `nws` = forecast high, `sigma`) to the market
# book + CLI settlement from the market_logger export, and score three candidate means
# against the market, grouped by entry hour:
#   PURE  N(point, sigma)  — NWS/PWS obs + Claude physical modifiers, no NWS-grid anchor
#   NWS   N(nws,   sigma)  — the raw forecast high as the mean (baseline)
#   BLND  N(blend or point, sigma) — the served NWS-base blend
# HIGH only (the Claude scoreboard settles cli_max). Crosses the real ask, pays the fee.
import json, glob, math, os
from collections import defaultdict

SP = r"C:\Users\MICHAE~1.FLY\AppData\Local\Temp\claude\C--Users-michael-flynn\95613a7f-d688-471b-b849-61a8229629c9\scratchpad"
EDGE_MIN = float(os.environ.get("EDGE", "0.03"))
phi = lambda z: 0.5 * (1 + math.erf(z / math.sqrt(2)))
fee = lambda p: math.ceil(0.07 * p * (1 - p) * 100) / 100

# --- book + settlement from the shadow export, keyed (cli, date, hour) for high ---
shadow = json.load(open(os.path.join(SP, "mlex.json")))
book = {}
for r in shadow:
    if r.get("variable") != "high" or r.get("settle", {}).get("extremumF") is None:
        continue
    book[(r["cli"], r["dateLocal"], r["localHour"])] = (r["buckets"], round(r["settle"]["extremumF"]))

# --- claude decisions across all dates ---
decs = []
for f in glob.glob(os.path.join(SP, "cdec", "*.json")):
    d = json.load(open(f))
    decs.extend(d.get("decs", []))

def model_probs(buckets, mean, sigma):
    raw = []
    for b in buckets:
        lo = -math.inf if b["loInt"] is None else b["loInt"]
        hi = math.inf if b["hiInt"] is None else b["hiInt"]
        a = 0.0 if lo == -math.inf else phi((lo - 0.5 - mean) / sigma)
        bb = 1.0 if hi == math.inf else phi((hi + 0.5 - mean) / sigma)
        raw.append(max(0.0, bb - a))
    s = sum(raw) or 1.0
    return [x / s for x in raw]

def wins(b, x):
    lo = -math.inf if b["loInt"] is None else b["loInt"]
    hi = math.inf if b["hiInt"] is None else b["hiInt"]
    return lo <= x <= hi

MODELS = ["PURE", "NWS", "BLND"]
# per model -> per hour -> accumulators
H = {m: defaultdict(lambda: {"mSE": 0.0, "kSE": 0.0, "nBins": 0, "bets": []}) for m in MODELS}
n_join = 0
for dec in decs:
    key = (dec.get("cli"), dec.get("date"), dec.get("hour"))
    if key not in book:
        continue
    sigma = dec.get("sigma")
    if not sigma or sigma <= 0:
        continue
    buckets, x = book[key]
    means = {"PURE": dec.get("point"), "NWS": dec.get("nws"),
             "BLND": dec.get("blend") if dec.get("blend") is not None else dec.get("point")}
    n_join += 1
    for m in MODELS:
        mean = means[m]
        if mean is None:
            continue
        P = model_probs(buckets, mean, sigma)
        g = H[m][dec["hour"]]
        best = None
        for i, b in enumerate(buckets):
            ask = b.get("yes_ask")
            if ask is None or ask <= 0 or ask >= 1:
                continue
            o = 1 if wins(b, x) else 0
            g["mSE"] += (P[i] - o) ** 2
            g["kSE"] += (ask - o) ** 2
            g["nBins"] += 1
            edge = P[i] - ask
            if edge >= EDGE_MIN and (best is None or edge > best["edge"]):
                best = {"o": o, "edge": edge, "price": ask}
        if best:
            f = fee(best["price"])
            g["bets"].append({"pnl": best["o"] - best["price"] - f, "win": best["o"], "cost": best["price"] + f})

print(f"joined claude-hour x book-hour (high only): {n_join}   EDGE>={EDGE_MIN}\n")
for m in MODELS:
    print(f"===== MODEL {m} =====")
    print("hr | binN  mBrier kBrier  Δ(m-k) | bets win%  ROI%   net$")
    tot = {"mSE": 0.0, "kSE": 0.0, "nBins": 0, "bets": []}
    for h in sorted(H[m]):
        g = H[m][h]
        if not g["nBins"]:
            continue
        mB, kB = g["mSE"] / g["nBins"], g["kSE"] / g["nBins"]
        bets = g["bets"]; n = len(bets); w = sum(b["win"] for b in bets)
        net = sum(b["pnl"] for b in bets); cost = sum(b["cost"] for b in bets)
        for k in ("mSE", "kSE", "nBins"): tot[k] += g[k]
        tot["bets"] += bets
        roi = 100 * net / cost if cost else 0
        print(f"{h:2d} | {g['nBins']:4d}  {mB:.4f} {kB:.4f}  {mB-kB:+.4f} | {n:4d} {(100*w/n if n else 0):3.0f}% {(roi if n else 0):6.1f}  {net:6.2f}")
    n = len(tot["bets"]); w = sum(b["win"] for b in tot["bets"])
    net = sum(b["pnl"] for b in tot["bets"]); cost = sum(b["cost"] for b in tot["bets"])
    mB, kB = tot["mSE"] / tot["nBins"], tot["kSE"] / tot["nBins"]
    print("-" * 58)
    print(f"ALL| {tot['nBins']:4d}  {mB:.4f} {kB:.4f}  {mB-kB:+.4f} | {n:4d} {(100*w/n if n else 0):3.0f}% {(100*net/cost if cost else 0):6.1f}  {net:6.2f}\n")
