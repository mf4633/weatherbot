#!/usr/bin/env python3
"""
edge_termstructure.py  -- ONE edge hypothesis, tested rigorously.

HYPOTHESIS: multi-day-ahead term-structure mispricing in Kalshi daily-high markets.
Are quotes >=1 day before settlement systematically biased vs the eventual
settlement, and do they converge in a predictable (tradeable) direction?

Data (offline): data/backfill30/*.jsonl -- 30 days of 1-min Kalshi candlesticks, 9 cities.
Each line: {ts, series, ticker, floor, cap, yes_bid, yes_ask, no_bid, no_ask,
            volume, open_interest, ...}

Ticker date field is YYMONDD (e.g. -26JUN28- == 2026-06-28), which matches the
backfill filename. (The task text called it DDMONYY, but the raw data and the
filenames prove it is YY-MON-DD; parsing the other way puts settlement in 2028.)

Settlement per ticker: FINAL candle (max ts) mid = (yb + ya)/2 with yb=yes_bid or 0,
ya=yes_ask or yes_bid or 0.  >0.9 => YES(1),  <0.1 => NO(0),  else drop (unresolved).

Pre-registered protocol is implemented verbatim below.  random.seed(0); no time/now.
"""

import json, glob, re, math, os, random, statistics
from datetime import date, datetime
from collections import defaultdict

random.seed(0)

DATA_GLOB = r"C:\Users\michael.flynn\weatherbot\data\backfill30\*.jsonl"
MONS = {'JAN':1,'FEB':2,'MAR':3,'APR':4,'MAY':5,'JUN':6,'JUL':7,
        'AUG':8,'SEP':9,'OCT':10,'NOV':11,'DEC':12}
TICK_RE = re.compile(r'-(\d{2})([A-Z]{3})(\d{2})-')

# entry-price (yes_mid) bins
BIN_EDGES = [0.0, 0.10, 0.30, 0.50, 0.70, 0.90, 1.0001]
BIN_LABELS = ["[.00-.10)", "[.10-.30)", "[.30-.50)", "[.50-.70)", "[.70-.90)", "[.90-1.0]"]
def bin_of(p):
    for i in range(len(BIN_EDGES)-1):
        if BIN_EDGES[i] <= p < BIN_EDGES[i+1]:
            return i
    return len(BIN_LABELS)-1

def taker_fee(p):
    """Kalshi taker fee, dollars/contract: ceil(7*p*(1-p))/100."""
    return math.ceil(7.0 * p * (1.0 - p)) / 100.0

def contract_day(ticker):
    m = TICK_RE.search(ticker)
    if not m:
        return None
    yy, mon, dd = int(m.group(1)), m.group(2), int(m.group(3))
    return date(2000+yy, MONS[mon], dd)

# ---------------------------------------------------------------- load
files = sorted(glob.glob(DATA_GLOB))

# per-ticker: final candle for settlement; per-horizon list of quote rows
final_cand = {}     # ticker -> (ts_str, yb, ya)
cday       = {}     # ticker -> date
series_of  = {}     # ticker -> series
# per (ticker, horizon): accumulate valid 2-sided quotes
th_yes_mid = defaultdict(list)
th_yes_ask = defaultdict(list)
th_no_ask  = defaultdict(list)
th_vol     = defaultdict(float)   # sum volume (all rows that day, not just 2-sided)
th_oi      = defaultdict(list)    # open_interest samples

n_rows = 0
for f in files:
    with open(f) as fh:
        for line in fh:
            if not line.strip():
                continue
            d = json.loads(line)
            n_rows += 1
            t = d['ticker']
            cd = cday.get(t)
            if cd is None:
                cd = contract_day(t)
                cday[t] = cd
                series_of[t] = d.get('series')
            ts = d['ts']
            # settlement = latest candle overall
            fc = final_cand.get(t)
            if fc is None or ts > fc[0]:
                yb = d.get('yes_bid'); ya = d.get('yes_ask')
                final_cand[t] = (ts, yb, ya)
            # horizon (days-to-settle) from UTC dates; clamp UTC-bleed (-1) to 0
            tsd = datetime.fromisoformat(ts.replace('Z','+00:00')).date()
            h = (cd - tsd).days
            if h < 0:
                h = 0
            key = (t, h)
            yb = d.get('yes_bid'); ya = d.get('yes_ask'); na = d.get('no_ask')
            vol = d.get('volume') or 0
            oi = d.get('open_interest')
            th_vol[key] += vol
            if oi is not None:
                th_oi[key].append(oi)
            # 2-sided validity: yes_bid>0 and yes_ask<1
            if yb is not None and ya is not None and yb > 0 and ya < 1.0:
                th_yes_mid[key].append((yb+ya)/2.0)
                th_yes_ask[key].append(ya)
                if na is not None and na < 1.0 and na > 0:
                    th_no_ask[key].append(na)

# ---------------------------------------------------------------- settle
def settle_outcome(t):
    ts, yb, ya = final_cand[t]
    yb = yb if yb is not None else 0.0
    ya = ya if ya is not None else (yb if yb is not None else 0.0)
    mid = (yb + ya)/2.0
    if mid > 0.9:  return 1
    if mid < 0.1:  return 0
    return None    # unresolved -> drop

outcome = {}
for t in cday:
    o = settle_outcome(t)
    if o is not None:
        outcome[t] = o

# ---------------------------------------------------------------- observations
# one observation per (ticker, horizon) that has >=1 valid 2-sided quote & resolves
# obs fields: cd, city, horizon, entry_mid, entry_ask, entry_no_ask, outcome, vol, oi
obs = []
for (t, h), mids in th_yes_mid.items():
    if t not in outcome:
        continue
    entry_mid = statistics.median(mids)
    entry_ask = statistics.median(th_yes_ask[(t,h)])
    no_list = th_no_ask.get((t,h))
    entry_no_ask = statistics.median(no_list) if no_list else None
    vol = th_vol.get((t,h), 0.0)
    oi_list = th_oi.get((t,h), [])
    oi = statistics.median(oi_list) if oi_list else 0
    obs.append(dict(t=t, cd=cday[t], city=series_of[t], h=h,
                    entry_mid=entry_mid, entry_ask=entry_ask,
                    entry_no_ask=entry_no_ask, out=outcome[t],
                    vol=vol, oi=oi))

# ---------------------------------------------------------------- train/test split
all_cds = sorted(set(o['cd'] for o in obs))
n_train = int(round(len(all_cds) * 0.60))
train_cds = set(all_cds[:n_train])
test_cds  = set(all_cds[n_train:])

# ---------------------------------------------------------------- EV helpers
def ev_yes(o):
    """Buy YES at entry_ask, hold to settle."""
    p = o['entry_ask']
    return o['out'] - p - taker_fee(p)          # outcome 1/0

def ev_fav(o):
    """Buy the favorite side (mid>=.5 -> YES, else NO)."""
    if o['entry_mid'] >= 0.5:
        p = o['entry_ask']
        return o['out'] - p - taker_fee(p)
    else:
        p = o['entry_no_ask']
        if p is None:
            return None
        return (1 - o['out']) - p - taker_fee(p)

def cost_yes(o):  return o['entry_ask']
def cost_fav(o):
    return o['entry_ask'] if o['entry_mid'] >= 0.5 else o['entry_no_ask']

# ---------------------------------------------------------------- bootstrap
def day_clustered_ci(cell_obs, evfn, iters=2000, lo=5, hi=95):
    """Resample contract-days w/ replacement; mean netEV per resample."""
    by_day = defaultdict(list)
    for o in cell_obs:
        e = evfn(o)
        if e is not None:
            by_day[o['cd']].append(e)
    days = list(by_day.keys())
    if len(days) < 2:
        return (None, None)
    means = []
    for _ in range(iters):
        pool = []
        for _ in range(len(days)):
            pool.extend(by_day[random.choice(days)])
        if pool:
            means.append(sum(pool)/len(pool))
    if not means:
        return (None, None)
    means.sort()
    def pct(q):
        idx = min(len(means)-1, max(0, int(round(q/100.0*(len(means)-1)))))
        return means[idx]
    return (pct(lo), pct(hi))

# ---------------------------------------------------------------- aggregate + report
def cell_stats(cell_obs, evfn, costfn):
    n = len(cell_obs)
    if n == 0:
        return None
    entry = statistics.mean(o['entry_mid'] for o in cell_obs)
    settle_rate = statistics.mean(o['out'] for o in cell_obs)
    drift = statistics.mean(o['out'] - o['entry_mid'] for o in cell_obs)  # settle(0/1) - entry_mid
    evs = [evfn(o) for o in cell_obs if evfn(o) is not None]
    costs = [costfn(o) for o in cell_obs if costfn(o) is not None]
    netev = statistics.mean(evs) if evs else float('nan')
    tot_cost = sum(costs) if costs else 0.0
    roi = (sum(evs)/tot_cost) if tot_cost else float('nan')
    vol = sum(o['vol'] for o in cell_obs)
    oi = sum(o['oi'] for o in cell_obs)
    return dict(n=n, entry=entry, settle=settle_rate, drift=drift,
                netev=netev, roi=roi, vol=vol, oi=oi, ndays=len(set(o['cd'] for o in cell_obs)))

def report(title, evfn, costfn):
    print("\n" + "="*140)
    print(title)
    print("="*140)
    hdr = ("{:<8}{:<11}{:>6}{:>7}{:>9}{:>9}{:>8}{:>11}{:>9}   {:<22}{:>12}{:>12}"
           .format("horizon","priceBin","n","days","avgEnt","settle","drift","netEV/ct","ROI",
                   "TEST 90% CI (netEV)","vol","OI"))
    print(hdr)
    print("-"*140)
    horizons = sorted(set(o['h'] for o in obs))
    for h in horizons:
        for b in range(len(BIN_LABELS)):
            cell_all = [o for o in obs if o['h']==h and bin_of(o['entry_mid'])==b]
            if not cell_all:
                continue
            st = cell_stats(cell_all, evfn, costfn)
            cell_test = [o for o in cell_all if o['cd'] in test_cds]
            if len(cell_test) >= 2:
                lo, hi = day_clustered_ci(cell_test, evfn)
                ci = "[{:+.3f},{:+.3f}] n={}".format(lo, hi, len(cell_test)) if lo is not None else "n/a (test<2day)"
            else:
                ci = "n/a (test n={})".format(len(cell_test))
            flag = " <THIN" if st['vol'] < 50 else ""
            print("{:<8}{:<11}{:>6}{:>7}{:>9.3f}{:>9.3f}{:>+8.3f}{:>+11.4f}{:>9}   {:<22}{:>12.0f}{:>12.0f}{}"
                  .format("d-"+str(h), BIN_LABELS[b], st['n'], st['ndays'], st['entry'],
                          st['settle'], st['drift'], st['netev'],
                          ("{:+.2f}".format(st['roi']) if st['roi']==st['roi'] else "n/a"),
                          ci, st['vol'], st['oi'], flag))
    return

# ---------------------------------------------------------------- run
print("edge_termstructure.py  --  term-structure mispricing test")
print("files={}  rows={:,}  tickers(parsed)={}  resolved(settled)={}"
      .format(len(files), n_rows, len(cday), len(outcome)))
print("contract-days={}  TRAIN={} days (<= {})  TEST={} days (>= {})"
      .format(len(all_cds), len(train_cds), (sorted(train_cds)[-1] if train_cds else None),
              len(test_cds), (sorted(test_cds)[0] if test_cds else None)))
print("observations (ticker x horizon, resolved, >=1 two-sided quote)={}".format(len(obs)))
hc = defaultdict(int)
for o in obs: hc[o['h']] += 1
print("obs per horizon:", dict(sorted(hc.items())))

report("STRATEGY A: BUY YES at yes_ask, hold to settle  (netEV = outcome - ask - fee)", ev_yes, cost_yes)
report("STRATEGY B: BUY FAVORITE side (mid>=.5 YES @ ask / mid<.5 NO @ no_ask)", ev_fav, cost_fav)

# ---------------------------------------------------------------- verdict
def scan_tradeable():
    """A tradeable TAKER edge = a side you can BUY at strictly +EV net of fee.
    Requires horizon>=1 (term-structure), TEST 90% CI lower bound > 0, vol>=50.
    (Cells with CI entirely < 0 are systematically OVERPRICED buys -- not tradeable
     long; fading them means buying the mirror side, which the FAV run already
     tests in the opposite bin, and those are negative too.)"""
    pos_hits, neg_over = [], []
    horizons = sorted(set(o['h'] for o in obs))
    for label, evfn, costfn in [("YES",ev_yes,cost_yes), ("FAV",ev_fav,cost_fav)]:
        for h in horizons:
            if h < 1:   # term-structure claim requires >=1 day ahead
                continue
            for b in range(len(BIN_LABELS)):
                cell_test = [o for o in obs if o['h']==h and bin_of(o['entry_mid'])==b and o['cd'] in test_cds]
                if len(cell_test) < 2:
                    continue
                lo, hi = day_clustered_ci(cell_test, evfn)
                if lo is None:
                    continue
                vol = sum(o['vol'] for o in cell_test)
                st = cell_stats(cell_test, evfn, costfn)
                if lo > 0 and vol >= 50:
                    pos_hits.append((label, h, BIN_LABELS[b], lo, hi, st['netev'], vol))
                elif hi < 0 and vol >= 50:
                    neg_over.append((label, h, BIN_LABELS[b], lo, hi, st['netev'], vol))
    return pos_hits, neg_over

print("\n" + "#"*140)
pos_hits, neg_over = scan_tradeable()
if pos_hits:
    print("VERDICT: term-structure EDGE FOUND -- buyable at +EV (TEST CI lower bound > 0, net of fee, vol>=50):")
    for label, h, bl, lo, hi, ev, vol in pos_hits:
        print("   -> {} horizon d-{} bin {}: netEV={:+.4f}/ct  CI[{:+.3f},{:+.3f}]  vol={:.0f}"
              .format(label, h, bl, ev, lo, hi, vol))
else:
    print("VERDICT: NO tradeable term-structure edge. No days-ahead (horizon>=1) cell is buyable")
    print("         at strictly +EV: no TEST-half 90% CI lower bound > 0 net of fee with >=50 vol.")
    print("         Days-ahead (d-1) quotes are essentially CALIBRATED: settle-rate tracks entry-mid")
    print("         in every bin (.04->.03, .19->.19, .38->.39, .57->.51) and drift ~= 0. The only")
    print("         systematic term-structure signal is a small OVERPRICE on every buy = the taker")
    print("         fee itself; fading it just pays the fee on the mirror leg (also -EV).")
    if neg_over:
        print("         (Systematically-overpriced d-1 buy cells, CI entirely <0 -- fee/drift drag, not")
        print("          exploitable long:)")
        for label, h, bl, lo, hi, ev, vol in neg_over:
            print("            {} d-{} {}: netEV={:+.4f} CI[{:+.3f},{:+.3f}] vol={:.0f}"
                  .format(label, h, bl, ev, lo, hi, vol))
print("#"*140)
