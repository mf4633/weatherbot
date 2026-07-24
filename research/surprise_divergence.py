#!/usr/bin/env python3
# The decisive "surprise" test. A market surprise = settlement lands where the midday book
# priced it cheap. Are those surprises FORESEEABLE at decision time? The one signal we have
# is the model's disagreement with the market. If big model-vs-market divergences move the
# OUTCOME toward the model, epistemic (tradeable) surprises exist; if the outcome tracks the
# market regardless, the surprises are aleatoric (unbeatable). HIGH only, midday decision.
import json, glob, os, math
from collections import defaultdict

SP = r"C:\Users\MICHAE~1.FLY\AppData\Local\Temp\claude\C--Users-michael-flynn\95613a7f-d688-471b-b849-61a8229629c9\scratchpad"
DEC_HOURS = [12, 11, 13, 10, 14]     # prefer ~noon local (liquid market, outcome unresolved)

def center(b):
    lo, hi = b["loInt"], b["hiInt"]
    if lo is None and hi is not None: return hi - 1.0
    if hi is None and lo is not None: return lo + 1.0
    if lo is not None and hi is not None: return (lo + hi) / 2.0
    return None

def _p_settle(buckets, settle):
    for b in buckets:
        lo = -10**9 if b["loInt"] is None else b["loInt"]
        hi = 10**9 if b["hiInt"] is None else b["hiInt"]
        if lo <= settle <= hi:
            yb, ya = b.get("yes_bid"), b.get("yes_ask")
            if yb is None or ya is None: return None
            return max(0.0, min(1.0, (yb + ya) / 2.0))
    return None

# market implied mean from the book (mid price as prob, weight by bucket center)
def market_mean(buckets):
    num = den = 0.0
    for b in buckets:
        c = center(b)
        yb, ya = b.get("yes_bid"), b.get("yes_ask")
        if c is None or yb is None or ya is None: continue
        p = max(0.0, min(1.0, (yb + ya) / 2.0))
        num += p * c; den += p
    return num / den if den > 0 else None

shadow = json.load(open(os.path.join(SP, "mlex.json")))
bookmap = {}
for r in shadow:
    if r.get("variable") == "high" and r.get("settle", {}).get("extremumF") is not None:
        bookmap[(r["cli"], r["dateLocal"], r["localHour"])] = r
decs = []
for f in glob.glob(os.path.join(SP, "cdec", "*.json")):
    decs.extend(json.load(open(f)).get("decs", []))
decmap = {(d["cli"], d["date"], d["hour"]): d for d in decs if d.get("cli")}

# one row per settled city-day at the midday decision
rows = []
seen = set()
for (cli, date, hour), r in bookmap.items():
    k = (cli, date)
    if k in seen: continue
    # pick the preferred decision hour available for this city-day
    for h in DEC_HOURS:
        rb = bookmap.get((cli, date, h)); rd = decmap.get((cli, date, h))
        if rb and rd and rd.get("nws") is not None and rd.get("point") is not None:
            mm = market_mean(rb["buckets"])
            if mm is None: continue
            settle = round(rb["settle"]["extremumF"])
            rows.append({"cli": cli, "date": date, "hour": h, "settle": settle, "mkt": mm,
                         "pure": rd["point"], "nws": rd["nws"],
                         "mkt_settle_prob": _p_settle(rb["buckets"], settle)})
            seen.add(k); break

def _dummy(): pass
rows2 = rows
print(f"settled city-days with a midday decision: {len(rows2)}")

def ols(xs, ys):
    n = len(xs)
    if n < 3: return (float('nan'), float('nan'), n)
    mx = sum(xs)/n; my = sum(ys)/n
    sxx = sum((x-mx)**2 for x in xs); sxy = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
    b = sxy/sxx if sxx else float('nan'); a = my - b*mx
    ss = sum((y-(a+b*x))**2 for x, y in zip(xs, ys)); st = sum((y-my)**2 for y in ys)
    r2 = 1 - ss/st if st else float('nan')
    return (b, r2, n)

for model in ("nws", "pure"):
    div = [r[model] - r["mkt"] for r in rows2]           # model disagreement
    err = [r["settle"] - r["mkt"] for r in rows2]        # where the market was wrong
    b, r2, n = ols(div, err)
    # tail: only the biggest 25% |divergences|
    thr = sorted(abs(d) for d in div)[int(0.75*len(div))]
    tdiv = [d for d in div if abs(d) >= thr]; terr = [e for d, e in zip(div, err) if abs(d) >= thr]
    tb, tr2, tn = ols(tdiv, terr)
    # directional hit rate on the tail: does settle land on the model's side of the market?
    hit = sum(1 for d, e in zip(div, err) if abs(d) >= thr and d != 0 and (e > 0) == (d > 0))
    print(f"\n[{model.upper()}]  err ~ div  slope={b:+.3f} R²={r2:.3f} n={n}")
    print(f"   big-divergence tail (|div|>={thr:.1f}°F, top 25%): slope={tb:+.3f} R²={tr2:.3f} n={tn}"
          f"   directional hit rate={100*hit/tn:.0f}%  (50% = model's big calls are coin flips)")

# how surprised is the market, and which way?
surp = [r for r in rows2 if r["mkt_settle_prob"] is not None and r["mkt_settle_prob"] < 0.15]
hot = sum(1 for r in surp if r["settle"] > r["mkt"])
print(f"\nmarket 'surprised' (settling bucket priced <15% at midday): {len(surp)}/{len(rows2)} = {100*len(surp)/len(rows2):.0f}%")
print(f"   of surprises: {hot} hot (settle>mkt), {len(surp)-hot} cool")
# on surprise days, did the model beat the market toward the truth?
mnws = sum(1 for r in surp if abs(r["nws"]-r["settle"]) < abs(r["mkt"]-r["settle"]))
mpure = sum(1 for r in surp if abs(r["pure"]-r["settle"]) < abs(r["mkt"]-r["settle"]))
print(f"   on surprise days, model closer to truth than market: NWS {mnws}/{len(surp)}={100*mnws/len(surp):.0f}%  PURE {mpure}/{len(surp)}={100*mpure/len(surp):.0f}%")
