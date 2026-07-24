#!/usr/bin/env python3
# Conditional-edge hunt: do the Claude mesoscale modifiers (marine advection, cloud/haze
# insolation cut) let the model beat the market in the REGIMES WHERE THEY FIRE — coastal
# afternoons (marine layer / sea-breeze cap) and cloudy afternoons (suppressed heat gain)?
# The aggregate says no edge; this asks whether a coastal/cloud subset hides one. HIGH only.
import json, glob, os, math
from collections import defaultdict

SP = r"C:\Users\MICHAE~1.FLY\AppData\Local\Temp\claude\C--Users-michael-flynn\95613a7f-d688-471b-b849-61a8229629c9\scratchpad"
phi = lambda z: 0.5 * (1 + math.erf(z / math.sqrt(2)))
fee = lambda p: math.ceil(0.07 * p * (1 - p) * 100) / 100
COASTAL = {"LAX", "SEA", "NYC", "BOS", "HOU"}          # marine / sea-breeze / Gulf exposed
AFT = set(range(13, 18))                                # 13-17 local: sea-breeze + marine-cap window

shadow = json.load(open(os.path.join(SP, "mlex.json")))
book = {}
for r in shadow:
    if r.get("variable") == "high" and r.get("settle", {}).get("extremumF") is not None:
        book[(r["cli"], r["dateLocal"], r["localHour"])] = (r["buckets"], round(r["settle"]["extremumF"]))

decs = []
for f in glob.glob(os.path.join(SP, "cdec", "*.json")):
    decs.extend(json.load(open(f)).get("decs", []))

def probs(buckets, mean, sigma):
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

# collect joined records with regime tags
rows = []
for dec in decs:
    key = (dec.get("cli"), dec.get("date"), dec.get("hour"))
    if key not in book: continue
    sig = dec.get("sigma");
    if not sig or sig <= 0: continue
    comp = dec.get("components") or {}
    rows.append({"cli": dec["cli"], "date": dec["date"], "hour": dec["hour"], "sigma": sig,
                 "pure": dec.get("point"), "nws": dec.get("nws"), "buckets": book[key][0], "x": book[key][1],
                 "coastal": dec["cli"] in COASTAL,
                 "marine": (comp.get("A_upstream") or 0) < -0.3,        # advection penalty firing
                 "cloudy": ((comp.get("A_haze") or 0) + (comp.get("A_sky") or 0)) < -0.3})

def scan(label, subset):
    if not subset:
        print(f"[{label:26s}] empty"); return
    dates = sorted({r["date"] for r in subset}); mid = dates[len(dates)//2]
    out = {}
    for model in ("pure", "nws"):
        for split, days in (("all", subset), ("test", [r for r in subset if r["date"] >= mid])):
            mSE = kSE = nb = 0; bets = []
            for r in days:
                mean = r[model]
                if mean is None: continue
                P = probs(r["buckets"], mean, r["sigma"])
                for i, b in enumerate(r["buckets"]):
                    ask = b.get("yes_ask")
                    if ask is None or ask <= 0 or ask >= 1: continue
                    o = 1 if wins(b, r["x"]) else 0
                    mSE += (P[i]-o)**2; kSE += (ask-o)**2; nb += 1
                    if P[i]-ask > 0.03: bets.append((o, ask))
            if nb:
                n=len(bets); w=sum(o for o,_ in bets)
                net=sum(o-a-fee(a) for o,a in bets); cost=sum(a+fee(a) for o,a in bets)
                out[(model,split)] = (mSE/nb, kSE/nb, nb, n, (100*net/cost if cost else 0), (100*w/n if n else 0))
    nd = len({(r["cli"],r["date"]) for r in subset})
    print(f"\n[{label}]  city-days={nd}  snaps={len(subset)}")
    print("  model  split |  mBrier kBrier   Δ    | bets ROI%  win%")
    for model in ("pure","nws"):
        for split in ("all","test"):
            if (model,split) in out:
                mB,kB,nb,n,roi,win = out[(model,split)]
                print(f"  {model:4s}  {split:4s}  | {mB:.4f} {kB:.4f} {mB-kB:+.4f} | {n:4d} {roi:6.1f} {win:4.0f}")

print("Regime-conditional edge scan (market Brier is the bar; Δ<0 = model beats market)")
scan("COASTAL, afternoon 13-17", [r for r in rows if r["coastal"] and r["hour"] in AFT])
scan("COASTAL, all hours", [r for r in rows if r["coastal"]])
scan("INTERIOR, afternoon 13-17", [r for r in rows if not r["coastal"] and r["hour"] in AFT])
scan("MARINE modifier firing", [r for r in rows if r["marine"]])
scan("CLOUDY modifier, aft 13-17", [r for r in rows if r["cloudy"] and r["hour"] in AFT])
scan("ALL (baseline)", rows)
