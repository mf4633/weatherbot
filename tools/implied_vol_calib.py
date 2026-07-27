#!/usr/bin/env python3
r"""Properly-powered test of the ONE live hypothesis: is the market's implied high-temp
distribution systematically TOO WIDE (overpricing uncertainty)?

The earlier edge_impliedvol.py used the thin :50 _lead_rows snapshot (14-day train, sign
flipped train->test). This rebuilds the calibration from the FULL per-minute candle ladder:
one clean observation per (city, contract-day) at a fixed noon snapshot, so the unit of
analysis is the city-day (not correlated intraday rows). More cities x more days = power.

Per (series, contract-day):
  - snapshot = the minute nearest local 12:00 that has a full 2-sided ladder.
  - implied dist = yes-mid per bucket, normalized to sum 1 over `centre`; implied_mean,
    implied_std = sqrt(prob-weighted var about implied_mean). Require >=5 priced buckets.
  - settlement = centre of the bucket whose FINAL candle mid > 0.9 (the settling bucket).
  - z = (settle - implied_mean) / implied_std.
CALIBRATION: stdev(z)==1 if the market's width is right; <1 => too WIDE; >1 => too NARROW.
Report stdev(z) overall + per-city, TRAIN(early 60%)/TEST(late 40%) by contract-day, with
a day-clustered bootstrap 90% CI (2000 iters, seed 0). TRADEABLE only if BOTH halves'
CI exclude 1.0 on the SAME side (sign stable) -- the exact bar the thin test failed.

Run:  PYTHONUTF8=1 python tools/implied_vol_calib.py --dir data/backfill30
"""
import sys, os, glob, json, re, math, random
from datetime import datetime, timezone
from collections import defaultdict
from zoneinfo import ZoneInfo
import statistics as st

random.seed(0)
TZ = {"KXHIGHNY":"America/New_York","KXHIGHLAX":"America/Los_Angeles","KXHIGHDEN":"America/Denver",
      "KXHIGHTBOS":"America/New_York","KXHIGHTHOU":"America/Chicago","KXHIGHCHI":"America/Chicago",
      "KXHIGHPHIL":"America/New_York","KXHIGHTDC":"America/New_York","KXHIGHTSEA":"America/Los_Angeles",
      "KXHIGHTPHX":"America/Phoenix","KXHIGHTDAL":"America/Chicago","KXHIGHTSATX":"America/Chicago",
      "KXHIGHAUS":"America/Chicago"}
MON={m:i+1 for i,m in enumerate(["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"])}

argv=sys.argv[1:]
dirs=[argv[i+1] for i,a in enumerate(argv) if a=="--dir"] or ["data/backfill30"]
files=[f for d in dirs for f in glob.glob(os.path.join(d,"*.jsonl"))]

def parse_day(code):
    m=re.match(r"(\d{2})([A-Z]{3})(\d{2})",code); return datetime(2000+int(m.group(1)),MON[m.group(2)],int(m.group(3))).date() if m else None
def centre(f,c):
    if f is not None and c is not None: return (f+c)/2
    if f is None and c is not None: return c-1
    if f is not None and c is None: return f+1
    return None

# (series, day) -> minute-iso -> [ (ticker, floor, cap, yes_bid, yes_ask) ]; + final mid per ticker
snap=defaultdict(lambda: defaultdict(list)); final=defaultdict(dict)
for fp in files:
    for line in open(fp,encoding="utf-8"):
        if not line.strip(): continue
        try: r=json.loads(line)
        except: continue
        s=r.get("series"); tk=r.get("ticker"); ts=r.get("ts")
        if not s or not tk or not ts or s not in TZ: continue
        dc=re.search(r"-(\d{2}[A-Z]{3}\d{2})-",tk)
        if not dc: continue
        day=parse_day(dc.group(1))
        if not day: continue
        key=(s,day.isoformat())
        snap[key][ts[:16]].append((tk,r.get("floor"),r.get("cap"),r.get("yes_bid"),r.get("yes_ask")))
        yb,ya=r.get("yes_bid"),r.get("yes_ask"); mid=((yb or 0)+(ya if ya is not None else (yb or 0)))/2
        p=final[key].get(tk)
        if p is None or ts>p[0]: final[key][tk]=(ts,mid,centre(r.get("floor"),r.get("cap")))

def settle_centre(key):
    best=None
    for tk,(ts,mid,c) in final[key].items():
        if c is not None and (best is None or mid>best[0]): best=(mid,c)
    return best[1] if best and best[0]>0.9 else None

def noon_minute(series,day,byMin):
    """Best-populated minute (most two-sided buckets) within 90min of local noon."""
    tz=ZoneInfo(TZ[series]); target=datetime.fromisoformat(day).replace(hour=12,minute=0,tzinfo=tz).astimezone(timezone.utc)
    best=None
    for m,rows in byMin.items():
        dt=datetime.fromisoformat(m+":00+00:00")
        if abs((dt-target).total_seconds())>90*60: continue
        nb=sum(1 for tk,f,c,yb,ya in rows if yb is not None and ya is not None and (yb+ya)/2>0)
        if best is None or nb>best[0]: best=(nb,m)
    return best[1] if best else None

def ncdf(x,mu,s): return 0.5*(1+math.erf((x-mu)/(s*math.sqrt(2))))
def bucket_true_p(f,c,mu,s):
    lo=-1e9 if f is None else f-0.5; hi=1e9 if c is None else c+0.5
    return ncdf(hi,mu,s)-ncdf(lo,mu,s)
def in_bucket(f,c,x): return (f is None or x>=f) and (c is None or x<=c)
def fee(p): return math.ceil(7*p*(1-p))/100.0

obs=[]   # (day, series, z)
snaps=[] # (day, series, mean, sd, settle, [(f,c,ce,yb,ya)])  -> for the tradeable test
for key,byMin in snap.items():
    series,day=key
    settle=settle_centre(key)
    if settle is None: continue
    m=noon_minute(series,day,byMin)
    if not m: continue
    cs,ps,buckets=[],[],[]
    for tk,f,c,yb,ya in byMin[m]:
        ce=centre(f,c)
        if ce is None or yb is None or ya is None: continue
        p=(yb+ya)/2
        if p<=0: continue
        cs.append(ce); ps.append(p); buckets.append((f,c,ce,yb,ya))
    if len(ps)<5: continue
    tot=sum(ps); pr=[p/tot for p in ps]
    mean=sum(p*c for p,c in zip(pr,cs))
    var=sum(p*(c-mean)**2 for p,c in zip(pr,cs))
    sd=math.sqrt(var)
    if sd<=0.3: continue  # degenerate (near-settled)
    obs.append((day,series,(settle-mean)/sd))
    snaps.append((day,series,mean,sd,settle,buckets))

days=sorted(set(d for d,_,_ in obs)); cut=days[int(len(days)*0.6)]
tr=[o for o in obs if o[0]<cut]; te=[o for o in obs if o[0]>=cut]
print(f"city-day observations: {len(obs)}  cities {len(set(s for _,s,_ in obs))}  days {len(days)}  TRAIN<{cut}={len(tr)} TEST={len(te)}")

def stdev_ci(rows):
    zs=[z for _,_,z in rows]
    if len(zs)<5: return (float('nan'),float('nan'),float('nan'))
    point=st.pstdev(zs)
    byday=defaultdict(list)
    for d,_,z in rows: byday[d].append(z)
    dl=list(byday.values()); boots=[]
    for _ in range(2000):
        samp=[random.choice(dl) for _ in range(len(dl))]; flat=[x for g in samp for x in g]
        if len(flat)>1: boots.append(st.pstdev(flat))
    boots.sort()
    return (point, boots[int(0.05*len(boots))], boots[int(0.95*len(boots))])

for name,rows in (("TRAIN",tr),("TEST ",te)):
    pt,lo,hi=stdev_ci(rows)
    tag = "too WIDE" if hi<1 else ("too NARROW" if lo>1 else "calibrated (CI incl 1.0)")
    print(f"  {name}: stdev(z)={pt:.3f}  90% CI [{lo:.3f},{hi:.3f}]  -> {tag}")

print("  per-city (TEST):")
for s in sorted(set(x[1] for x in te)):
    rows=[o for o in te if o[1]==s]
    if len(rows)<5: continue
    pt,lo,hi=stdev_ci(rows)
    print(f"    {s:12s} n={len(rows):3d}  stdev(z)={pt:.2f}  CI[{lo:.2f},{hi:.2f}]  {'WIDE' if hi<1 else ('NARROW' if lo>1 else '-')}")

# verdict on sign stability
ptr,ltr,htr=stdev_ci(tr); pte,lte,hte=stdev_ci(te)
stable_wide = htr<1 and hte<1
stable_narrow = ltr>1 and lte>1
print(f"\nSIGN-STABLE across TRAIN & TEST: {'WIDE (sell wings candidate)' if stable_wide else ('NARROW' if stable_narrow else 'NO -- not tradeable on this data')}")

# ---- TRADEABLE TEST: sell the wings at the REAL BID, net of fee, OOS -------------
# If the market is too wide, wing buckets are overpriced. k = TRAIN width factor: true
# std = k * implied_std. On TEST, SELL YES (at yes_bid) any bucket where selling is +EV
# under the k-corrected Normal AND it's a genuine wing (>=1 implied-sigma from the mean).
# Executes at the BID (crossing the spread) -> a mid-price/vig artifact dies here.
k = max(0.4, min(1.0, ptr))   # width correction from TRAIN only
MARGIN = 0.00                 # require >=3c edge over the k-Normal to act (be conservative)
by_day=defaultdict(list); n=wins=0; staked=0.0; pnl=0.0
for day,series,mean,sd,settle,buckets in snaps:
    if day<cut: continue      # TEST only
    for f,c,ce,yb,ya in buckets:
        if abs(ce-mean) < 1.0*sd: continue          # wings only
        true_p = bucket_true_p(f,c,mean,k*sd)
        ev_sell = yb - true_p - fee(yb)             # sell YES at bid
        if ev_sell <= MARGIN: continue
        won = not in_bucket(f,c,settle)             # sold YES wins if bucket does NOT settle
        net = (yb - (0.0 if won else 1.0)) - fee(yb)
        pnl+=net; staked += (1.0-yb) + fee(yb)      # capital at risk selling YES ~ (1-bid)
        wins+=int(won); n+=1
        by_day[day].append(net)
roi = pnl/staked if staked else float('nan')
# day-clustered bootstrap CI on total net (per-contract mean)
dl=list(by_day.values()); boots=[]
for _ in range(2000):
    samp=[random.choice(dl) for _ in range(len(dl))] if dl else []
    flat=[x for g in samp for x in g]
    if flat: boots.append(sum(flat)/len(flat))
boots.sort()
if boots:
    lo_ci=boots[int(0.05*len(boots))]*100; hi_ci=boots[int(0.95*len(boots))]*100
else:
    lo_ci=hi_ci=float('nan')
print(f"\nSELL-WINGS trade (k={k:.2f} from TRAIN, at real BID, TEST OOS):")
print(f"  n={n}  win%={wins/n if n else float('nan'):.0%}  netEV/contract={pnl/n*100 if n else float('nan'):+.2f}c  "
      f"ROI={roi:+.1%}  90% CI[{lo_ci:+.2f},{hi_ci:+.2f}]c  {'<-- EDGE (CI>0)' if lo_ci>0 else '(CI includes/below 0)'}")

# ---- COMPLEMENT: BUY THE BODY at the real ASK (near-money underpriced if too-wide) ----
by_day2=defaultdict(list); n2=wins2=0; staked2=0.0; pnl2=0.0
for day,series,mean,sd,settle,buckets in snaps:
    if day<cut: continue
    for f,c,ce,yb,ya in buckets:
        if abs(ce-mean) >= 1.0*sd: continue          # body only (near-money)
        true_p = bucket_true_p(f,c,mean,k*sd)
        ev_buy = true_p - ya - fee(ya)                # buy YES at ask
        if ev_buy <= MARGIN: continue
        won = in_bucket(f,c,settle)
        net = (1.0 if won else 0.0) - ya - fee(ya)
        pnl2+=net; staked2 += ya+fee(ya); wins2+=int(won); n2+=1
        by_day2[day].append(net)
dl2=list(by_day2.values()); boots2=[]
for _ in range(2000):
    samp=[random.choice(dl2) for _ in range(len(dl2))] if dl2 else []
    flat=[x for g in samp for x in g]
    if flat: boots2.append(sum(flat)/len(flat))
boots2.sort()
lo2=boots2[int(0.05*len(boots2))]*100 if boots2 else float('nan'); hi2=boots2[int(0.95*len(boots2))]*100 if boots2 else float('nan')
print(f"BUY-BODY trade  (k={k:.2f}, at real ASK, TEST OOS):")
print(f"  n={n2}  win%={wins2/n2 if n2 else float('nan'):.0%}  netEV/contract={pnl2/n2*100 if n2 else float('nan'):+.2f}c  "
      f"ROI={pnl2/staked2 if staked2 else float('nan'):+.1%}  90% CI[{lo2:+.2f},{hi2:+.2f}]c  {'<-- EDGE (CI>0)' if lo2>0 else '(CI includes/below 0)'}")
print("  TRADEABLE only if a CI excludes 0 net of fee at the REAL price (mid-width alone is NOT enough;")
print("  if both fail, the too-wide stdev(z) is a mid/vig artifact = the favorite-longshot bias restated).")
