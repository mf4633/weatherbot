#!/usr/bin/env python3
# Drill the overnight NWS-mean entry window (00-02 local) that showed +20% ROI in the
# per-hour scan. Question: is it a real edge or 2-3 city-days? Train/test split by date
# (early dates = train, late = test), per-city-day PnL breakdown, and market-Brier gap
# per half. HIGH only. Same fills as the scan: cross the ask, pay the Kalshi fee.
import json, glob, math, os
from collections import defaultdict

SP = r"C:\Users\MICHAE~1.FLY\AppData\Local\Temp\claude\C--Users-michael-flynn\95613a7f-d688-471b-b849-61a8229629c9\scratchpad"
HOURS = set(int(x) for x in os.environ.get("HOURS", "0,1,2").split(","))
EDGE_MIN = float(os.environ.get("EDGE", "0.03"))
phi = lambda z: 0.5 * (1 + math.erf(z / math.sqrt(2)))
fee = lambda p: math.ceil(0.07 * p * (1 - p) * 100) / 100

shadow = json.load(open(os.path.join(SP, "mlex.json")))
book = {}
for r in shadow:
    if r.get("variable") != "high" or r.get("settle", {}).get("extremumF") is None:
        continue
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

# collect bets in the window (NWS mean), one bet per joined city-day-hour (best positive edge)
bets = []
mSE = kSE = nBins = 0
for dec in decs:
    if dec.get("hour") not in HOURS:
        continue
    key = (dec.get("cli"), dec.get("date"), dec.get("hour"))
    if key not in book:
        continue
    sigma, mean = dec.get("sigma"), dec.get("nws")
    if not sigma or sigma <= 0 or mean is None:
        continue
    buckets, x = book[key]
    P = probs(buckets, mean, sigma)
    best = None
    for i, b in enumerate(buckets):
        ask = b.get("yes_ask")
        if ask is None or ask <= 0 or ask >= 1:
            continue
        o = 1 if wins(b, x) else 0
        mSE += (P[i] - o) ** 2; kSE += (ask - o) ** 2; nBins += 1
        edge = P[i] - ask
        if edge >= EDGE_MIN and (best is None or edge > best["edge"]):
            tk = b["ticker"].split("-")[-1]
            best = {"o": o, "edge": edge, "price": ask, "ticker": tk}
    if best:
        f = fee(best["price"])
        bets.append({"date": dec["date"], "city": dec.get("city") or dec.get("cli"), "hour": dec["hour"],
                     "bucket": best["ticker"], "price": best["price"], "win": best["o"],
                     "pnl": best["o"] - best["price"] - f, "cost": best["price"] + f, "settle": x, "nws": mean})

def summ(label, bs):
    n = len(bs); w = sum(b["win"] for b in bs)
    net = sum(b["pnl"] for b in bs); cost = sum(b["cost"] for b in bs)
    print(f"{label:14s} n={n:3d}  win={100*w/n if n else 0:4.0f}%  ROI={100*net/cost if cost else 0:6.1f}%  net=${net:6.2f}")

dates = sorted({b["date"] for b in bets})
mid = dates[len(dates)//2] if dates else None
train = [b for b in bets if b["date"] < mid]
test = [b for b in bets if b["date"] >= mid]

print(f"OVERNIGHT NWS DRILL  hours={sorted(HOURS)}  EDGE>={EDGE_MIN}")
print(f"window book-Brier gap: model(NWS) {mSE/nBins:.4f} vs market {kSE/nBins:.4f}  Δ={mSE/nBins-kSE/nBins:+.4f}  (nBins={nBins})\n")
summ("ALL", bets)
summ(f"TRAIN(<{mid})", train)
summ(f"TEST(>={mid})", test)
print(f"\nunique city-days: {len({(b['city'],b['date']) for b in bets})}   dates: {dates[0]}..{dates[-1]}")

# concentration: PnL by city, and the individual bets
print("\nPnL by city:")
byc = defaultdict(lambda: [0, 0.0, 0])
for b in bets:
    byc[b["city"]][0] += 1; byc[b["city"]][1] += b["pnl"]; byc[b["city"]][2] += b["win"]
for c, (n, p, w) in sorted(byc.items(), key=lambda kv: kv[1][1]):
    print(f"  {c:14s} n={n:2d} win={w} net=${p:6.2f}")

print("\nall bets (date city hr bucket price->win  pnl  settle nws):")
for b in sorted(bets, key=lambda b: (b["date"], b["city"], b["hour"])):
    print(f"  {b['date']} {b['city']:12s} {b['hour']:02d} {b['bucket']:5s} @{b['price']:.2f} -> {'W' if b['win'] else 'L'}  {b['pnl']:+.2f}  settle={b['settle']} nws={b['nws']}")
