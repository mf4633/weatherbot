#!/usr/bin/env python3
# Strategy B2 test (pre-registered in B2_PREREGISTRATION.md). Does the highest-frequency
# PUBLIC obs (IEM 1-minute ASOS peak, which catches between-METAR excursions the crowd's
# :53 METAR misses) + a fitted per-station CLI-gap model price the settlement integer
# SHARPER than the Kalshi book at end of day? HIGH only. One pass, kill rule fixed.
import json, csv, glob, os, math, statistics
from collections import defaultdict, Counter
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

SP = r"C:\Users\MICHAE~1.FLY\AppData\Local\Temp\claude\C--Users-michael-flynn\95613a7f-d688-471b-b849-61a8229629c9\scratchpad"
meta = json.load(open(os.path.join(SP, "b2_meta.json")))
tzmap = {m["station"]: m["tz"] for m in meta.values()}
cli_of = {m["station"]: m["cli"] for m in meta.values()}

# 1-min peak per (station, localdate)
peak = {}   # (cli, date) -> max tmpf (float, whole F)
cnt = defaultdict(int)
for f in glob.glob(os.path.join(SP, "a1min", "*.csv")):
    stn = os.path.basename(f).replace(".csv", "")
    tz = ZoneInfo(tzmap[stn]); cli = cli_of[stn]
    for row in csv.DictReader(open(f)):
        t = (row.get("tmpf") or "").strip()
        v = (row.get("valid(UTC)") or "").strip()
        if not t or t in ("M", "None") or not v:
            continue
        try:
            temp = float(t)
            dt = datetime.strptime(v, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).astimezone(tz)
        except Exception:
            continue
        key = (cli, dt.strftime("%Y-%m-%d"))
        cnt[key] += 1
        if key not in peak or temp > peak[key]:
            peak[key] = temp

# shadow: last high snapshot per (cli,date) -> book, maxSoFar, settle
shadow = json.load(open(os.path.join(SP, "mlex.json")))
grp = defaultdict(list)
for r in shadow:
    if r["variable"] == "high" and r.get("settle", {}).get("extremumF") is not None and r.get("maxSoFar") is not None:
        grp[(r["cli"], r["dateLocal"])].append(r)
last = {}
for k, rows in grp.items():
    r = max(rows, key=lambda x: x["localHour"])
    if r["localHour"] >= 20:
        last[k] = r

# assemble joined records
J = []
for k, r in last.items():
    if k not in peak or cnt[k] < 300:   # need a reasonably complete 1-min day
        continue
    J.append({"cli": k[0], "date": k[1], "settle": round(r["settle"]["extremumF"]),
              "maxSoFar": r["maxSoFar"], "peak1": round(peak[k]), "buckets": r["buckets"]})
J.sort(key=lambda x: x["date"])
print(f"joined station-days (1-min complete, last snap hr>=20): {len(J)}")

# --- diagnostic 1: does 1-min catch more than the shadow (METAR/DSM-folded) max? ---
d_pm = Counter(j["peak1"] - j["maxSoFar"] for j in J)
d_sp = Counter(j["settle"] - j["peak1"] for j in J)
print("peak1min - maxSoFar (shadow):", dict(sorted(d_pm.items())))
print("settle - peak1min          :", dict(sorted(d_sp.items())))

# --- train/test split by median date ---
dates = sorted({j["date"] for j in J})
mid = dates[len(dates)//2]
train = [j for j in J if j["date"] < mid]
test  = [j for j in J if j["date"] >= mid]

# per-station gap distribution (settle - peak1) fit on TRAIN; global fallback
gap_by = defaultdict(Counter); gap_all = Counter()
for j in train:
    gap_by[j["cli"]][j["settle"] - j["peak1"]] += 1
    gap_all[j["settle"] - j["peak1"]] += 1
def gap_dist(cli):
    c = gap_by[cli] if sum(gap_by[cli].values()) >= 4 else gap_all
    tot = sum(c.values()) or 1
    return {g: n/tot for g, n in c.items()}

def in_bucket(b, x):
    lo = -10**9 if b["loInt"] is None else b["loInt"]
    hi = 10**9 if b["hiInt"] is None else b["hiInt"]
    return lo <= x <= hi
def model_prob(b, peak1, gd):
    return sum(p for g, p in gd.items() if in_bucket(b, peak1 + g))

fee = lambda p: math.ceil(0.07 * p * (1 - p) * 100) / 100

def evaluate(label, days):
    mSE = kSE = nb = 0
    bets = []
    for j in days:
        gd = gap_dist(j["cli"])
        for b in j["buckets"]:
            ask = b.get("yes_ask")
            if ask is None or ask <= 0 or ask >= 1:
                continue
            o = 1 if in_bucket(b, j["settle"]) else 0
            mp = model_prob(b, j["peak1"], gd)
            mSE += (mp - o) ** 2; kSE += (ask - o) ** 2; nb += 1
            if mp - ask > 0.03:
                bets.append((o, ask))
    n = len(bets); w = sum(o for o, _ in bets)
    net = sum(o - a - fee(a) for o, a in bets); cost = sum(a + fee(a) for o, a in bets)
    print(f"[{label}] nDays={len(days)} nBins={nb}  modelBrier={mSE/nb:.4f}  marketBrier={kSE/nb:.4f}  Δ={mSE/nb-kSE/nb:+.4f}"
          f"   trade: n={n} win={100*w/n if n else 0:.0f}% ROI={100*net/cost if cost else 0:.1f}% net=${net:.2f}")

print(f"\ngap dist (train, global): {dict(sorted(gap_all.items()))}")
evaluate("TRAIN", train)
evaluate("TEST ", test)
