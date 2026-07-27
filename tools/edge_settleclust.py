"""
edge_settleclust.py — Test ONE hypothesis, report straight.

HYPOTHESIS: settlement-integer clustering (even/odd or last-digit bias in CLI
settlement highs) creates bucket-boundary mispricing in Kalshi 2-degree high
buckets, giving a tradeable edge.

Pre-registered protocol:
  1. DISTRIBUTION: pool all CLI daily highs across 28 cities x 1 year.
     - even/odd split, binomial test H0: p(even)=0.5, 95% CI on even fraction.
     - per-city even/odd split + binomial p.
     - last-digit histogram.
  2. MISPRICING: per Kalshi ladder bucket, realized settle-rate vs market YES
     mid, grouped by floor parity. Determine the (if any) underpriced side on
     TRAIN.
  3. P&L: buy the underpriced-parity buckets at real yes_ask (fee =
     ceil(7*p*(1-p))/100), hold to settle. TRAIN 60% / TEST 40% split by date.
     Day-clustered bootstrap 90% CI (resample dates, 2000 iters, seed 0).
  4. TRADEABLE iff real clustering AND OOS bucket-level P&L 90% CI excludes 0
     net of fee.

No network, no time calls. Deterministic (random.seed(0)).
"""

import json
import glob
import os
import math
import random
import collections

import numpy as np
from scipy import stats

CACHE_DIR = r"C:\Users\michael.flynn\interpolatornyc\_cache_all"
LEAD_ROWS = r"C:\Users\michael.flynn\weatherbot\tools\_lead_rows.json"

BAR = "=" * 72


# ------------------------------------------------------------------ helpers
def wilson_ci(k, n, z=1.96):
    """Wilson score interval for a binomial proportion."""
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = (z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom
    return (centre - half, centre + half)


def kalshi_fee(p):
    """Kalshi trading fee in dollars: ceil(7 * p * (1-p)) cents / 100."""
    return math.ceil(7 * p * (1 - p)) / 100.0


# ------------------------------------------------------------------ load CLI
def load_cli_highs():
    per_city = collections.OrderedDict()
    files = sorted(glob.glob(os.path.join(CACHE_DIR, "cli_*.json")))
    for f in files:
        city = os.path.basename(f)[4:-5]
        d = json.load(open(f))
        highs = [r["high"] for r in d.get("results", []) if isinstance(r.get("high"), int)]
        per_city[city] = highs
    return per_city


# ------------------------------------------------------------------ part 1
def distribution_analysis(per_city):
    print(BAR)
    print("PART 1 - SETTLEMENT-INTEGER DISTRIBUTION (CLI daily highs)")
    print(BAR)

    all_highs = [h for hs in per_city.values() for h in hs]
    n = len(all_highs)
    even = sum(1 for h in all_highs if h % 2 == 0)
    odd = n - even
    p_even = even / n
    lo, hi = wilson_ci(even, n)
    # two-sided exact binomial test H0 p=0.5
    bt = stats.binomtest(even, n, 0.5, alternative="two-sided")

    print(f"\nPooled highs: n={n} ({len(per_city)} cities)")
    print(f"  even={even}  odd={odd}")
    print(f"  even fraction = {p_even:.4f}   95% CI [{lo:.4f}, {hi:.4f}]")
    print(f"  binomial test vs 0.5:  p = {bt.pvalue:.4g}")

    print("\nLast-digit histogram (Fahrenheit ones digit, pooled):")
    ld = collections.Counter(abs(h) % 10 for h in all_highs)
    for dgt in range(10):
        c = ld.get(dgt, 0)
        bar = "#" * int(round(60 * c / max(ld.values())))
        print(f"  {dgt}: {c:5d} ({100*c/n:4.1f}%) {bar}")
    # chi-square uniformity over 10 digits
    obs = np.array([ld.get(d, 0) for d in range(10)], dtype=float)
    chi = stats.chisquare(obs)
    print(f"  chi-square uniform(10 digits): stat={chi.statistic:.1f}  p={chi.pvalue:.4g}")

    print("\nPer-city even fraction (parity):")
    print(f"  {'city':4s} {'n':>4s} {'even%':>7s} {'95% CI':>18s} {'binom p':>9s}")
    n_sig = 0
    for city, hs in per_city.items():
        nc = len(hs)
        ec = sum(1 for h in hs if h % 2 == 0)
        pe = ec / nc if nc else float("nan")
        l, h = wilson_ci(ec, nc)
        p = stats.binomtest(ec, nc, 0.5).pvalue if nc else float("nan")
        flag = " *" if p < 0.05 else ""
        if p < 0.05:
            n_sig += 1
        print(f"  {city:4s} {nc:4d} {100*pe:6.1f}% [{100*l:5.1f}%,{100*h:5.1f}%] {p:9.3g}{flag}")
    print(f"\n  cities with p<0.05 parity deviation: {n_sig}/{len(per_city)}")

    clustering = bt.pvalue < 0.05
    print(f"\n  => Pooled parity clustering present (p<0.05)? {clustering}")
    return clustering, p_even


# ------------------------------------------------------------------ part 2/3
def mispricing_and_pnl(clustering):
    print("\n" + BAR)
    print("PART 2/3 - BUCKET MISPRICING & OOS P&L")
    print(BAR)

    rows = json.load(open(LEAD_ROWS))

    # Structural note: every width-1 bucket [f, f+1] contains exactly one even
    # and one odd integer, so pooled parity bias cannot by itself favour a
    # bucket. What CAN differ is boundary ALIGNMENT: a bucket may lead with an
    # odd floor (odd,even) or even floor (even,odd). We group by floor parity
    # and ask whether realized rate diverges from market mid within each group.

    # Build per-bucket records: (date, floor_parity, yes_ask, mid, realized)
    recs = []
    for r in rows:
        settle = r.get("settle")
        date = r["date"]
        if settle is None:
            continue
        for b in r["ladder"]:
            fl, cap = b.get("floor"), b.get("cap")
            ask, bid = b.get("yes_ask"), b.get("yes_bid")
            cen = b.get("centre")
            if not (isinstance(fl, int) and isinstance(cap, int)):
                continue  # skip open tails; parity only defined on 2-deg buckets
            if ask is None or bid is None or cen is None:
                continue
            mid = (ask + bid) / 2.0
            realized = 1 if abs(cen - settle) < 1e-9 else 0
            recs.append({
                "date": date,
                "par": fl % 2,           # 0 even floor, 1 odd floor
                "ask": ask,
                "mid": mid,
                "real": realized,
            })

    print(f"\nTwo-sided width-1 buckets with a market mid: {len(recs)}")

    # dates -> train/test split (60/40 by sorted date)
    dates = sorted({rc["date"] for rc in recs})
    n_tr = int(round(len(dates) * 0.6))
    train_dates = set(dates[:n_tr])
    test_dates = set(dates[n_tr:])
    print(f"Dates: {len(dates)}  train={len(train_dates)}  test={len(test_dates)}")

    def group_stats(subset, par):
        s = [rc for rc in subset if rc["par"] == par]
        if not s:
            return 0, float("nan"), float("nan"), float("nan")
        real = np.mean([rc["real"] for rc in s])
        mid = np.mean([rc["mid"] for rc in s])
        return len(s), real, mid, real - mid

    train = [rc for rc in recs if rc["date"] in train_dates]
    test = [rc for rc in recs if rc["date"] in test_dates]

    print("\nTRAIN realized-rate vs market-mid, by floor parity:")
    print(f"  {'group':12s} {'n':>5s} {'real':>7s} {'mid':>7s} {'real-mid':>9s}")
    edge = {}
    for par, name in [(0, "even-floor"), (1, "odd-floor")]:
        n, real, mid, d = group_stats(train, par)
        edge[par] = d
        print(f"  {name:12s} {n:5d} {real:7.4f} {mid:7.4f} {d:+9.4f}")

    # Underpriced side = parity group where realized > mid (positive edge) on TRAIN
    best_par = max(edge, key=lambda k: edge[k])
    side_name = "even-floor" if best_par == 0 else "odd-floor"
    print(f"\nUnderpriced side on TRAIN (real-mid max): {side_name} "
          f"(edge={edge[best_par]:+.4f})")

    if edge[best_par] <= 0:
        print("  No positive-edge parity side on TRAIN -> nothing to trade OOS.")
        return False

    # OOS P&L: buy YES at real yes_ask on every TEST bucket of the chosen parity
    trades = [rc for rc in test if rc["par"] == best_par]
    if not trades:
        print("  No TEST trades for chosen side.")
        return False

    def pnl_of(rc):
        cost = rc["ask"] + kalshi_fee(rc["ask"])
        payoff = 1.0 if rc["real"] else 0.0
        return payoff - cost

    pnls = np.array([pnl_of(rc) for rc in trades])
    print(f"\nOOS TEST trades ({side_name}): n={len(trades)}")
    print(f"  mean P&L/trade = {pnls.mean():+.4f}  total = {pnls.sum():+.2f}  "
          f"win-rate = {np.mean([t['real'] for t in trades]):.3f}")

    # Day-clustered bootstrap: resample TEST dates with replacement
    by_date = collections.defaultdict(list)
    for rc in trades:
        by_date[rc["date"]].append(pnl_of(rc))
    tdates = sorted(by_date)
    random.seed(0)
    means = []
    for _ in range(2000):
        samp = []
        for _ in range(len(tdates)):
            d = tdates[random.randrange(len(tdates))]
            samp.extend(by_date[d])
        means.append(np.mean(samp))
    lo, hi = np.percentile(means, [5, 95])
    print(f"  day-clustered bootstrap 90% CI (2000 iters, seed 0): "
          f"[{lo:+.4f}, {hi:+.4f}]")

    tradeable = clustering and (lo > 0)
    print(f"\n  clustering present? {clustering}   OOS CI excludes 0 (>0)? {lo > 0}")
    return tradeable


# ------------------------------------------------------------------ main
def main():
    per_city = load_cli_highs()
    clustering, _ = distribution_analysis(per_city)
    tradeable = mispricing_and_pnl(clustering)

    print("\n" + BAR)
    print("VERDICT")
    print(BAR)
    print(f"Settlement-clustering edge tradeable? {'YES' if tradeable else 'NO'}")


if __name__ == "__main__":
    main()
