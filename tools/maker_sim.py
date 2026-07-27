#!/usr/bin/env python3
r"""Maker (limit-order) simulation for the nowcast directional signal.

Taker (buy at ask) gave +1.7c/bet. Posting a LIMIT at the bid turns the ~2c spread from
a cost into a rebate AND pays the lower maker fee -- but introduces ADVERSE SELECTION: a
resting buy at the bid only fills when the ask later crosses DOWN to it, i.e. you fill
your losers (price fell) and miss your winners (price ran up before your bid filled).

This sims it honestly from the minute candle path:
  - entry @ local :50 for each |nowcast-implied|>1 opportunity; favored near-money bucket.
  - post a buy limit at that bucket's yes_bid (also test bid+1c "improve").
  - FILL if, at any later minute that contract-day, yes_ask <= limit (a seller crossed).
  - filled -> hold to settle: payoff(1 if settle in bucket) - limit - maker_fee. missed -> 0.
Reports fill rate, P&L per filled and per opportunity, and the adverse-selection tell:
win rate of FILLED vs MISSED bets. Compares to the taker baseline on the same set.

Run:  PYTHONUTF8=1 python tools/maker_sim.py --dir data/backfill --rows tools/_lead_rows14.json
"""
import sys, os, json, re, math
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from zoneinfo import ZoneInfo
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(r"C:\Users\michael.flynn\interpolatornyc"))
from interpolatornyc.cities import BY_CLI

SERIES_CLI = {"KXHIGHNY": "NYC", "KXHIGHLAX": "LAX", "KXHIGHDEN": "DEN", "KXHIGHTBOS": "BOS",
              "KXHIGHTHOU": "HOU", "KXHIGHCHI": "MDW", "KXHIGHTPHX": "PHX",
              "KXHIGHTDAL": "DFW", "KXHIGHTSEA": "SEA"}
CLI_SERIES = {v: k for k, v in SERIES_CLI.items()}
MON = {m: i + 1 for i, m in enumerate(["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"])}

argv = sys.argv[1:]
cdir = argv[argv.index("--dir") + 1] if "--dir" in argv else "data/backfill"
rowsf = argv[argv.index("--rows") + 1] if "--rows" in argv else "tools/_lead_rows.json"

def parse_day(code):
    m = re.match(r"(\d{2})([A-Z]{3})(\d{2})", code);
    return datetime(2000+int(m.group(1)), MON[m.group(2)], int(m.group(3))).date() if m else None

# candles -> (series, date_iso) -> ticker -> sorted[(minute_iso, yes_bid, yes_ask, floor, cap)]
import glob
paths = glob.glob(os.path.join(cdir, "*.jsonl"))
tick = defaultdict(lambda: defaultdict(list))
for f in paths:
    for line in open(f, encoding="utf-8"):
        if not line.strip(): continue
        try: r = json.loads(line)
        except Exception: continue
        if not r.get("ts") or not r.get("ticker") or r["series"] not in SERIES_CLI: continue
        dc = re.search(r"-(\d{2}[A-Z]{3}\d{2})-", r["ticker"])
        if not dc: continue
        d = parse_day(dc.group(1))
        if d is None: continue
        tick[(r["series"], d.isoformat())][r["ticker"]].append(
            (r["ts"][:16], r.get("yes_bid"), r.get("yes_ask"), r.get("floor"), r.get("cap")))
for k in tick:
    for t in tick[k]:
        tick[k][t].sort()

def won(f, c, s): return (f is None or s >= f) and (c is None or s <= c)
def maker_fee(p, reimbursed=False): return 0.0 if reimbursed else math.ceil(1.75 * p * (1 - p)) / 100.0
def taker_fee(p): return math.ceil(7 * p * (1 - p)) / 100.0

rows = json.load(open(rowsf))
df = pd.DataFrame(rows).dropna(subset=["settle", "nowcast", "implied"])

def entry_minute(cli, date_iso, hour):
    tz = ZoneInfo(BY_CLI[cli].tz)
    local = datetime.fromisoformat(date_iso).replace(hour=hour, minute=50, tzinfo=tz)
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")

def find_ticker(series, date_iso, floor, cap, minute):
    """ticker whose (floor,cap) match the bucket at entry."""
    for t, path in tick[(series, date_iso)].items():
        if path and path[0][3] == floor and path[0][4] == cap:
            return t, path
    return None, None

def fills_at(path, entry_min, limit):
    """True if any minute strictly after entry has yes_ask <= limit (seller crossed our bid)."""
    for (m, yb, ya, f, c) in path:
        if m <= entry_min: continue
        if ya is not None and ya <= limit + 1e-9:
            return True
    return False

def run(improve=0.0, reimbursed=False, edge_min=1.0):
    fill_pnl = []; fill_win = []; miss_win = []; opp = 0; fills = 0
    tak_pnl = []
    for r in df.itertuples():
        sig = r.nowcast - r.implied
        if abs(sig) < edge_min: continue
        up = sig > 0
        cand = []
        for b in r.ladder:
            c = b["centre"]
            if (up and c >= r.implied) or ((not up) and c <= r.implied):
                cand.append((abs(c - r.implied), b))
        if not cand: continue
        b = min(cand, key=lambda t: t[0])[1]
        yb, ya = b.get("yes_bid"), b.get("yes_ask")
        if yb is None or yb < 0.03 or yb > 0.90: continue
        limit = min(yb + improve, 0.94)
        em = entry_minute(r.cli, r.date, r.hour)
        t, path = find_ticker(CLI_SERIES[r.cli], r.date, b["floor"], b["cap"], em)
        if path is None: continue
        opp += 1
        w = won(b["floor"], b["cap"], r.settle)
        # taker baseline on same opp (buy ask, always fills)
        if ya is not None and 0.03 <= ya <= 0.90:
            tak_pnl.append((1.0 if w else 0.0) - ya - taker_fee(ya))
        if fills_at(path, em, limit):
            fills += 1
            fill_pnl.append((1.0 if w else 0.0) - limit - maker_fee(limit, reimbursed))
            fill_win.append(w)
        else:
            miss_win.append(w)
    fp = np.array(fill_pnl)
    print(f"  improve={improve*100:.0f}c fee={'0(reimb)' if reimbursed else 'billed'}: "
          f"opps={opp} fills={fills} ({fills/opp:.0%})  "
          f"P&L/fill={fp.mean()*100:+.1f}c  P&L/opp={fp.sum()/opp*100:+.1f}c  total=${fp.sum():+.2f}")
    print(f"       ADVERSE SELECTION -> win%% filled={np.mean(fill_win):.0%}  vs missed={np.mean(miss_win) if miss_win else float('nan'):.0%}  "
          f"| taker P&L/bet={np.mean(tak_pnl)*100:+.1f}c")

print(f"rows {len(df)}  candle days {len(set(k[1] for k in tick))}  (source: {rowsf})")
print("\nMAKER: post buy limit at the bid, fill if ask later crosses down, hold to settle")
run(improve=0.00, reimbursed=True)
run(improve=0.00, reimbursed=False)
run(improve=0.01, reimbursed=True)
run(improve=0.01, reimbursed=False)

# --- divergence-threshold sweep: does a large-|nowcast-implied| niche beat adverse
#     selection with limits? Best maker config (bid+1c, fees reimbursed). ------------
print("\nDIVERGENCE SWEEP (best maker: bid+1c, fees reimbursed) — does extreme divergence help?")
for em in (1.0, 2.0, 3.0, 4.0, 5.0):
    run(improve=0.01, reimbursed=True, edge_min=em)
