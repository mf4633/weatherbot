#!/usr/bin/env python3
r"""Decisive tradeability test for the 5-min nowcast lead signal.

The lead test showed edge(nowcast-market)->market_err corr +0.36 OOS, but priced P&L at
the MID. This buys REAL buckets at the candle ASK, holds to settlement, pays Kalshi taker
fees -- the test that killed every prior 'edge'. Plus three controls:

  1. CLI-BIAS control: is the edge just the known (closed) CLI-warm settlement bias?
     Recompute edge->market_err corr after de-meaning market_err PER CITY. If it collapses,
     it's a constant offset (already-known, arguably priced), not a live lead.
  2. Spread realism: buy at yes_ask (cross the spread), not the mid.
  3. NOWCAST-specific: compare the nowcast strategy to the SAME strategy driven by the
     bot's own model would-be estimate is unavailable here, so we compare to a market-mean
     null (buy +EV vs a Normal centered on the MARKET implied -> ~0 by construction).

Model: high ~ Normal(nowcast_peak, SIGMA); SIGMA fit on TRAIN = std(settle - nowcast_peak).
Buy YES on a bucket when model_p > yes_ask + fee. Fee = ceil(7*a*(1-a))/100 per contract.
PnL per contract = (1 if settle in bucket else 0) - yes_ask - fee.

Run:  PYTHONUTF8=1 python tools/bucket_pnl_nowcast.py
"""
import os, json, math
import numpy as np
import pandas as pd
from scipy.stats import norm

HERE = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(os.path.join(HERE, "_lead_rows.json")))
df = pd.DataFrame(rows)
df = df.dropna(subset=["settle", "nowcast", "implied"]).reset_index(drop=True)

dates = sorted(df["date"].unique())
cut = dates[int(len(dates) * 0.6)]
tr = df[df["date"] < cut]; te = df[df["date"] >= cut]
print(f"rows {len(df)}  TRAIN {len(tr)} (<{cut})  TEST {len(te)}")

# ---- control 1: CLI-bias (de-mean per city) --------------------------------
df["edge"] = df["nowcast"] - df["implied"]
df["mkt_err"] = df["settle"] - df["implied"]
raw = df["edge"].corr(df["mkt_err"])
city_mean = df.groupby("cli")["mkt_err"].transform("mean")
df["mkt_err_dm"] = df["mkt_err"] - city_mean
city_mean_e = df.groupby("cli")["edge"].transform("mean")
df["edge_dm"] = df["edge"] - city_mean_e
dm = df["edge_dm"].corr(df["mkt_err_dm"])
print(f"\nCLI-BIAS CONTROL:")
print(f"  mean market_err (settle-implied) = {df['mkt_err'].mean():+.2f}F  (per-city bias present if large)")
print(f"  edge->mkt_err corr  raw {raw:+.3f}   de-meaned-per-city {dm:+.3f}  "
      f"({'survives' if abs(dm) > 0.15 else 'COLLAPSES -> mostly constant bias'})")

# ---- bucket P&L engine -----------------------------------------------------
SIGMA = max(1.5, float((tr['settle'] - tr['nowcast']).std()))
print(f"\nSIGMA (train resid std) = {SIGMA:.2f}F")


def fee(a):
    return math.ceil(7 * a * (1 - a)) / 100.0


def bucket_p(centre_lo, centre_hi, mu, sig):
    lo = -np.inf if centre_lo is None else centre_lo - 0.5
    hi = np.inf if centre_hi is None else centre_hi + 0.5
    return norm.cdf(hi, mu, sig) - norm.cdf(lo, mu, sig)


def won(floor, cap, settle):
    return (floor is None or settle >= floor) and (cap is None or settle <= cap)


def run(sub, mu_col, sig, min_edge=0.0, sel_nws=None, max_ask=0.85, min_ask=0.03):
    pnl = 0.0; n = 0; wins = 0; staked = 0.0
    for row in sub.itertuples():
        mu = getattr(row, mu_col)
        if mu is None or (isinstance(mu, float) and math.isnan(mu)): continue
        if sel_nws is not None:
            if row.nws is None or abs(row.nowcast - row.nws) < sel_nws: continue
        for b in row.ladder:
            a = b.get("yes_ask")
            if a is None or a < min_ask or a > max_ask: continue
            p = bucket_p(b["floor"], b["cap"], mu, sig)
            if p > a + fee(a) + min_edge:            # +EV after fee
                w = won(b["floor"], b["cap"], row.settle)
                pnl += (1.0 if w else 0.0) - a - fee(a)
                staked += a + fee(a); wins += int(w); n += 1
    roi = pnl / staked if staked else float("nan")
    return pnl, n, (wins / n if n else float("nan")), roi


print(f"\n{'strategy':34s} {'nBets':>6s} {'win%':>5s} {'P&L$':>8s} {'ROI':>7s}")
for label, mu_col in [("nowcast_peak", "nowcast"), ("market_implied (null)", "implied")]:
    for tag, edge in [("EV>0", 0.0), ("EV>0.05", 0.05), ("EV>0.10", 0.10)]:
        pnl, n, wr, roi = run(te, mu_col, SIGMA, min_edge=edge)
        print(f"{label+' '+tag:34s} {n:6d} {wr:5.0%} {pnl:+8.2f} {roi:+7.1%}")

print("\n-- SELECTIVE: only fire when |nowcast - forecast| > 1F (OOS) --")
for tag, edge in [("EV>0", 0.0), ("EV>0.05", 0.05), ("EV>0.10", 0.10)]:
    pnl, n, wr, roi = run(te, "nowcast", SIGMA, min_edge=edge, sel_nws=1.0)
    print(f"  nowcast |ncfc|>1 {tag:9s} {'':6s} n={n:5d} win {wr:5.0%} P&L {pnl:+8.2f} ROI {roi:+7.1%}")

# per-city OOS (nowcast EV>0.05)
print("\n-- per-city OOS (nowcast, EV>0.05) --")
for cli, g in te.groupby("cli"):
    pnl, n, wr, roi = run(g, "nowcast", SIGMA, min_edge=0.05)
    if n: print(f"  {cli:4s} n={n:4d}  win {wr:4.0%}  P&L {pnl:+7.2f}  ROI {roi:+6.1%}")

# ---- measured spread + POINT-BET / THRESHOLD execution ---------------------
spreads = []
for row in df.itertuples():
    for b in row.ladder:
        ya, yb = b.get("yes_ask"), b.get("yes_bid")
        if ya is not None and yb is not None and 0 < yb < ya < 1:
            spreads.append(ya - yb)
print(f"\nmedian bucket bid-ask spread = {np.median(spreads)*100:.1f}c  (mean {np.mean(spreads)*100:.1f}c)")


def point_bet(sub, mu_col, min_ask=0.03, max_ask=0.85, sel_nws=None):
    """Buy the single bucket containing round(mu) at its ask; hold to settle."""
    pnl = 0.0; n = 0; wins = 0; staked = 0.0
    for row in sub.itertuples():
        mu = getattr(row, mu_col)
        if mu is None or (isinstance(mu, float) and math.isnan(mu)): continue
        if sel_nws is not None and (row.nws is None or abs(row.nowcast - row.nws) < sel_nws): continue
        tgt = round(mu)
        best = None
        for b in row.ladder:
            if won(b["floor"], b["cap"], tgt):
                best = b; break
        if not best: continue
        a = best.get("yes_ask")
        if a is None or a < min_ask or a > max_ask: continue
        w = won(best["floor"], best["cap"], row.settle)
        pnl += (1.0 if w else 0.0) - a - fee(a); staked += a + fee(a); wins += int(w); n += 1
    return pnl, n, (wins / n if n else float("nan")), (pnl / staked if staked else float("nan"))


def thresh_dir(sub, edge_min=1.0, min_ask=0.05, max_ask=0.90, reverse=False):
    """Directional: if nowcast>implied by edge_min, buy the near-the-money YES tail the
    nowcast favors (a '>= K' bucket just above implied); if below, favor the low tail.
    reverse=True bets AGAINST the nowcast (control)."""
    pnl = 0.0; n = 0; wins = 0; staked = 0.0
    for row in sub.itertuples():
        sig = row.nowcast - row.implied
        if abs(sig) < edge_min: continue
        up = (sig > 0) ^ reverse
        # pick the tail/closed bucket whose centre is nearest implied on the favored side
        cand = []
        for b in row.ladder:
            a = b.get("yes_ask")
            if a is None or a < min_ask or a > max_ask: continue
            c = b["centre"]
            if (up and c >= row.implied) or ((not up) and c <= row.implied):
                cand.append((abs(c - row.implied), b))
        if not cand: continue
        b = min(cand, key=lambda t: t[0])[1]
        a = b.get("yes_ask")
        w = won(b["floor"], b["cap"], row.settle)
        pnl += (1.0 if w else 0.0) - a - fee(a); staked += a + fee(a); wins += int(w); n += 1
    return pnl, n, (wins / n if n else float("nan")), (pnl / staked if staked else float("nan"))


print("\n-- POINT BET (buy bucket at round(mu)) OOS --")
for label, col in [("nowcast", "nowcast"), ("nowcast_now", "nowcast_now"), ("market null", "implied")]:
    pnl, n, wr, roi = point_bet(te, col)
    print(f"  {label:12s} n={n:4d}  win {wr:4.0%}  P&L {pnl:+7.2f}  ROI {roi:+6.1%}")
pnl, n, wr, roi = point_bet(te, "nowcast", sel_nws=1.0)
print(f"  nowcast |ncfc|>1  n={n:4d}  win {wr:4.0%}  P&L {pnl:+7.2f}  ROI {roi:+6.1%}")

print("\n-- THRESHOLD DIRECTIONAL (buy favored near-money tail) --")
for name, s in [("TRAIN", tr), ("TEST ", te)]:
    for em in (1.0, 1.5, 2.0):
        pnl, n, wr, roi = thresh_dir(s, edge_min=em)
        print(f"  {name} |nc-impl|>{em}  n={n:4d}  win {wr:4.0%}  P&L {pnl:+7.2f}  ROI {roi:+6.1%}")
print("  CONTROL reverse-direction (bet AGAINST nowcast), TEST:")
for em in (1.0, 1.5):
    pnl, n, wr, roi = thresh_dir(te, edge_min=em, reverse=True)
    print(f"    |nc-impl|>{em}  n={n:4d}  win {wr:4.0%}  P&L {pnl:+7.2f}  ROI {roi:+6.1%}")
print("  per-city TEST (|nc-impl|>1.0):")
for cli, g in te.groupby("cli"):
    pnl, n, wr, roi = thresh_dir(g, edge_min=1.0)
    if n: print(f"    {cli:4s} n={n:3d} win {wr:4.0%} P&L {pnl:+6.2f} ROI {roi:+6.1%}")
# full-sample (train+test) per-city for stability read
print("  per-city FULL sample (|nc-impl|>1.0):")
for cli, g in df.groupby("cli"):
    pnl, n, wr, roi = thresh_dir(g, edge_min=1.0)
    if n: print(f"    {cli:4s} n={n:3d} win {wr:4.0%} P&L {pnl:+6.2f} ROI {roi:+6.1%}")
