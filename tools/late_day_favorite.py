#!/usr/bin/env python3
r"""EDGE HYPOTHESIS (mine, not the user's): late-day FAVORITE underpricing.

Near settlement the daily-high outcome is nearly physically determined, yet favorites
(buckets priced high) often stay underpriced because capital-lockup deters buyers of a
90c contract that pays 100c. The price-only structural test used a median-time quote and
would wash this out. Here we condition on LATE quotes and ask: does buying a favorite at
its late ASK, held to settlement, net a positive edge after the real fee?

Method (pre-registered, OOS):
  - settlement per ticker from the candle path: final mid > 0.9 -> YES, < 0.1 -> NO, else drop.
  - "late" quote = the last candle with a 2-sided book (yes_bid>0 and yes_ask<1) — the last
    price a real taker could actually pay before it pinned to 0/1.
  - bucket the late yes_ask into price bins; per bin, realized YES rate vs the ask paid.
  - net EV per contract = realized_yes_rate - ask - fee(ask), fee = ceil(7*p*(1-p))/100 (taker).
  - TRAIN early 60% of event-days, TEST latest 40%. Report per-bin on TEST with a
    day-clustered bootstrap 90% CI; a tradeable bin needs TEST CI excluding 0 AND volume.

Run:  PYTHONUTF8=1 python tools/late_day_favorite.py --dir data/backfill30
"""
import sys, os, glob, json, re, math, random
from collections import defaultdict

argv = sys.argv[1:]
cdir = argv[argv.index("--dir") + 1] if "--dir" in argv else "data/backfill30"
files = sorted(glob.glob(os.path.join(cdir, "*.jsonl")))
random.seed(0)  # Math.random-free determinism note: python random is fine here (offline)

def daycode(t):
    m = re.search(r"-(\d{2}[A-Z]{3}\d{2})-", t or ""); return m.group(1) if m else "?"

# per ticker: sorted list of (ts, yes_bid, yes_ask, no_ask); also final mid for settlement
paths = defaultdict(list)
for f in files:
    for line in open(f, encoding="utf-8"):
        if not line.strip(): continue
        try: r = json.loads(line)
        except Exception: continue
        if not r.get("ts") or not r.get("ticker"): continue
        yb, ya = r.get("yes_bid"), r.get("yes_ask")
        if yb is None and ya is None: continue
        paths[r["ticker"]].append((r["ts"], yb, ya, r.get("no_ask")))

# We test buying the FAVORITE side at its real ask, held to settle:
#   favorite = YES if yes price > 0.5 else NO.  win = (settled matches the side).
#   record: (day, ticker, fav_ask, fav_won)
records = []
for tk, rows in paths.items():
    rows.sort()
    fb, fa = rows[-1][1], rows[-1][2]
    fmid = ((fb or 0) + (fa if fa is not None else (fb or 0))) / 2
    if fmid > 0.9: settled = 1
    elif fmid < 0.1: settled = 0
    else: continue
    late = None
    for ts, yb, ya, na in reversed(rows):
        if yb is not None and ya is not None and yb > 0 and ya < 1:
            late = (yb, ya, na); break
    if late is None: continue
    yb, ya, na = late
    ymid = (yb + ya) / 2
    if ymid >= 0.5:                       # YES is the favorite; pay yes_ask
        fav_ask, fav_won = ya, settled
    else:                                 # NO is the favorite; pay no_ask (fallback 1-yes_bid)
        fav_ask = na if (na is not None and 0 < na < 1) else (1 - yb)
        fav_won = 1 - settled
    if not (0 < fav_ask < 1): continue
    records.append((daycode(tk), tk, fav_ask, fav_won))

days = sorted(set(d for d, *_ in records))
cut = days[int(len(days) * 0.6)]
tr = [r for r in records if r[0] < cut]
te = [r for r in records if r[0] >= cut]
print(f"tickers resolved: {len(records)}   event-days {len(days)}  TRAIN<{cut}={len(tr)} TEST={len(te)}")

def fee(p): return math.ceil(7 * p * (1 - p)) / 100.0

BINS = [(0.50,0.60),(0.60,0.70),(0.70,0.80),(0.80,0.88),(0.88,0.94),(0.94,0.99)]

def summarize(rows, label):
    print(f"\n{label}: buy the late FAVORITE side at its ask, hold to settle, net of taker fee")
    print(f"  {'askbin':12s} {'n':>5s} {'avgAsk':>6s} {'favWin':>7s} {'netEV/ct':>8s} {'ROI':>7s} {'CI90(netEV)':>16s}")
    by_day = defaultdict(list)
    for d, tk, a, s in rows: by_day[d].append((a, s))
    for lo, hi in BINS:
        sel = [(a, s) for d, tk, a, s in rows if lo <= a < hi]
        if len(sel) < 20:
            print(f"  {f'{lo:.2f}-{hi:.2f}':12s} {len(sel):>5d}   (thin)"); continue
        asks = [a for a, s in sel]; wins = [s for a, s in sel]
        avg_ask = sum(asks)/len(asks); real = sum(wins)/len(wins)
        evs = [s - a - fee(a) for a, s in sel]
        net = sum(evs)/len(evs)
        roi = net / avg_ask
        # day-clustered bootstrap CI
        day_bins = defaultdict(list)
        for d, tk, a, s in rows:
            if lo <= a < hi: day_bins[d].append(s - a - fee(a))
        dl = list(day_bins.values())
        boots = []
        for _ in range(2000):
            samp = [random.choice(dl) for _ in range(len(dl))]
            flat = [x for g in samp for x in g]
            if flat: boots.append(sum(flat)/len(flat))
        boots.sort()
        lo_ci = boots[int(0.05*len(boots))]*100; hi_ci = boots[int(0.95*len(boots))]*100
        flag = "  <-- edge" if lo_ci > 0 else ""
        print(f"  {f'{lo:.2f}-{hi:.2f}':12s} {len(sel):>5d} {avg_ask:6.2f} {real:7.1%} "
              f"{net*100:+7.1f}c {roi:+7.1%} [{lo_ci:+5.1f},{hi_ci:+5.1f}]c{flag}")

summarize(tr, "TRAIN")
summarize(te, "TEST (out-of-sample)")
