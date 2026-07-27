"""
edge_crosscity.py -- Test ONE hypothesis: cross-city common-factor mispricing.

Hypothesis: on broad heat-wave / cold-front days many cities settle above/below
the market together. If the market prices each city independently, a common daily
surprise is predictable and tradeable.

Pre-registered protocol (see task):
  - collapse each (city,date) to one obs using midday decision hours 11..14
    (median implied, median settle).
  - per-city daily surprise  s = settle - implied  (market error)
                             f = settle - nws       (vs NWS forecast)
  - leave-one-out common factor C_t^(-i) = mean of s over the OTHER cities that day.
      Test corr( C_t^(-i) , s_i )  on TRAIN then TEST. Market-priced => 0.
  - lagged (actually tradeable at open) common factor:
      C_{t-1} = full cross-city mean surprise on the prior date.
      Test corr( C_{t-1} , s_{i,t} ) OOS.
  - split TRAIN = earliest 60% of dates, TEST = latest 40%.
  - day-clustered bootstrap 90% CI: resample DATES, 2000 iters, seed 0, no time calls.
  - fee-aware directional P&L for the tradeable (lagged) signal: bet sign at
    price ~0.5, Kalshi taker fee. Report OOS P&L + CI.
  - TRADEABLE requires TEST CI excluding 0 AND P&L positive net of fee.
"""

import json, os, random, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
ROWS = os.path.join(HERE, "_lead_rows.json")

MID_HOURS = range(11, 15)          # 11,12,13,14
TRAIN_FRAC = 0.60
BOOT_ITERS = 2000
BOOT_SEED = 0
CI_LO, CI_HI = 0.05, 0.95          # 90% CI
PRICE = 0.50                       # directional bet at coin-flip price
# Kalshi taker fee ~ round_up(0.07 * n * p * (1-p)); per-contract at p=0.5:
FEE = 0.07 * PRICE * (1.0 - PRICE)  # = 0.0175


# ---------- helpers ----------
def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return float("nan")
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    if sxx <= 0 or syy <= 0:
        return float("nan")
    return sxy / (sxx ** 0.5 * syy ** 0.5)


def quantile(sorted_vals, q):
    if not sorted_vals:
        return float("nan")
    idx = q * (len(sorted_vals) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = idx - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def boot_ci_by_date(records, stat_fn, rng):
    """records: list of (date, ...). Resample DATES with replacement, recompute stat."""
    by_date = {}
    for rec in records:
        by_date.setdefault(rec[0], []).append(rec)
    dates = list(by_date.keys())
    out = []
    for _ in range(BOOT_ITERS):
        samp = []
        for _ in range(len(dates)):
            d = dates[rng.randrange(len(dates))]
            samp.extend(by_date[d])
        v = stat_fn(samp)
        if v == v:  # drop nan
            out.append(v)
    out.sort()
    return quantile(out, CI_LO), quantile(out, CI_HI)


# ---------- load & collapse ----------
raw = json.load(open(ROWS))
mid = [r for r in raw if r["hour"] in MID_HOURS]

# per (city,date): median implied, median settle, median nws (if any)
cell = {}
for r in mid:
    cell.setdefault((r["cli"], r["date"]), []).append(r)

obs = {}  # (city,date) -> dict(implied,settle,nws,s,f)
for (city, date), rs in cell.items():
    implied = statistics.median([x["implied"] for x in rs])
    settle = statistics.median([x["settle"] for x in rs])
    nws_vals = [x["nws"] for x in rs if x["nws"] is not None]
    nws = statistics.median(nws_vals) if nws_vals else None
    s = settle - implied
    f = (settle - nws) if nws is not None else None
    obs[(city, date)] = dict(implied=implied, settle=settle, nws=nws, s=s, f=f)

dates = sorted(set(d for (_, d) in obs))
cities = sorted(set(c for (c, _) in obs))
n_dates = len(dates)
split = int(round(TRAIN_FRAC * n_dates))
train_dates = set(dates[:split])
test_dates = set(dates[split:])

# ---------- common-factor structure ----------
# same-day cross-city mean surprise (full) and leave-one-out per city
day_s = {d: [] for d in dates}          # list of (city, s)
for (c, d), o in obs.items():
    day_s[d].append((c, o["s"]))

C_full = {}   # date -> full cross-city mean s
for d in dates:
    ss = [s for (_, s) in day_s[d]]
    C_full[d] = sum(ss) / len(ss) if ss else float("nan")

# leave-one-out rows: (date, C_loo, s_i)  for the same-day contemporaneous test
loo_rows = []
for d in dates:
    lst = day_s[d]
    tot = sum(s for (_, s) in lst)
    k = len(lst)
    if k < 2:
        continue
    for (c, s_i) in lst:
        C_loo = (tot - s_i) / (k - 1)
        loo_rows.append((d, C_loo, s_i))

# lagged rows: (date_t, C_{t-1}, s_{i,t})  -- tradeable at today's open
lag_rows = []
for i in range(1, n_dates):
    d_prev, d = dates[i - 1], dates[i]
    if C_full[d_prev] != C_full[d_prev]:
        continue
    for (c, s_i) in day_s[d]:
        lag_rows.append((d, C_full[d_prev], s_i))


def corr_of(rows):
    xs = [r[1] for r in rows]
    ys = [r[2] for r in rows]
    return pearson(xs, ys)


loo_train = [r for r in loo_rows if r[0] in train_dates]
loo_test = [r for r in loo_rows if r[0] in test_dates]
lag_test = [r for r in lag_rows if r[0] in test_dates]
lag_train = [r for r in lag_rows if r[0] in train_dates]

rng = random.Random(BOOT_SEED)
loo_tr_ci = boot_ci_by_date(loo_train, corr_of, rng)
loo_te_ci = boot_ci_by_date(loo_test, corr_of, rng)
lag_te_ci = boot_ci_by_date(lag_test, corr_of, rng)


# ---------- fee-aware directional P&L on the lagged (tradeable) signal ----------
# On date t, for each city, if C_{t-1} != 0 bet the sign of C_{t-1} on
# (settle - implied). Binary at PRICE: win pays (1-PRICE), lose pays -PRICE, minus FEE.
def pnl_of(rows):
    pl = []
    for (d, c_prev, s_i) in rows:
        if c_prev == 0:
            continue
        pred = 1.0 if c_prev > 0 else -1.0
        correct = (pred * s_i) > 0
        tie = (s_i == 0)
        if tie:
            gross = 0.0            # settle == implied: bet resolves at cost-ish; treat push
        elif correct:
            gross = (1.0 - PRICE)
        else:
            gross = -PRICE
        pl.append(gross - FEE)
    return sum(pl) / len(pl) if pl else float("nan")


lag_test_pnl = pnl_of(lag_test)
rng2 = random.Random(BOOT_SEED)
pnl_te_ci = boot_ci_by_date(lag_test, pnl_of, rng2)

# also directional hit-rate for context
def hit_of(rows):
    h = n = 0
    for (d, c_prev, s_i) in rows:
        if c_prev == 0 or s_i == 0:
            continue
        n += 1
        if (c_prev > 0) == (s_i > 0):
            h += 1
    return h / n if n else float("nan")


# ---------- report ----------
def fmt(x):
    return "nan" if x != x else f"{x:+.4f}"

print("=" * 68)
print("CROSS-CITY COMMON-FACTOR MISPRICING TEST")
print("=" * 68)
print(f"cities={len(cities)} {cities}")
print(f"dates={n_dates}  ({dates[0]} .. {dates[-1]})")
print(f"midday hours used: {list(MID_HOURS)}")
print(f"city-date obs: {len(obs)}   (max {len(cities)*n_dates})")
print(f"TRAIN dates={len(train_dates)}  TEST dates={len(test_dates)} "
      f"(split at earliest {int(TRAIN_FRAC*100)}%)")
print(f"surprise s=settle-implied  mean={statistics.mean(o['s'] for o in obs.values()):+.3f} "
      f"sd={statistics.pstdev(o['s'] for o in obs.values()):.3f}")
fvals = [o['f'] for o in obs.values() if o['f'] is not None]
if fvals:
    print(f"vs-NWS f=settle-nws  n={len(fvals)} mean={statistics.mean(fvals):+.3f} "
          f"sd={statistics.pstdev(fvals):.3f}")
print(f"same-day common factor magnitude: sd(C_full)={statistics.pstdev(list(C_full.values())):.3f}")
print("-" * 68)
print("[1] LEAVE-ONE-OUT SAME-DAY COMMON FACTOR   corr( C_t^(-i) , s_i )")
print(f"    (contemporaneous -- NOT intraday-tradeable, structural test)")
print(f"    TRAIN corr = {fmt(corr_of(loo_train))}  n={len(loo_train)}  "
      f"90% CI [{fmt(loo_tr_ci[0])}, {fmt(loo_tr_ci[1])}]")
print(f"    TEST  corr = {fmt(corr_of(loo_test))}  n={len(loo_test)}  "
      f"90% CI [{fmt(loo_te_ci[0])}, {fmt(loo_te_ci[1])}]")
print("-" * 68)
print("[2] LAGGED COMMON FACTOR (tradeable at open)  corr( C_{t-1} , s_{i,t} )")
print(f"    TEST  corr = {fmt(corr_of(lag_test))}  n={len(lag_test)}  "
      f"90% CI [{fmt(lag_te_ci[0])}, {fmt(lag_te_ci[1])}]")
print(f"    (TRAIN corr = {fmt(corr_of(lag_train))}  n={len(lag_train)})")
print("-" * 68)
print("[3] FEE-AWARE DIRECTIONAL P&L on lagged signal (bet sign of C_{t-1})")
print(f"    price={PRICE}  taker fee={FEE:.4f}/contract")
print(f"    TEST hit-rate = {hit_of(lag_test):.3f}")
print(f"    TEST P&L/trade = {fmt(lag_test_pnl)}  "
      f"90% CI [{fmt(pnl_te_ci[0])}, {fmt(pnl_te_ci[1])}]")
print("=" * 68)

loo_sig = (loo_te_ci[0] > 0) or (loo_te_ci[1] < 0)
lag_sig = (lag_te_ci[0] > 0) or (lag_te_ci[1] < 0)
pnl_pos = (lag_test_pnl == lag_test_pnl) and lag_test_pnl > 0 and (pnl_te_ci[0] > 0)
tradeable = lag_sig and pnl_pos

print(f"structural (same-day LOO) TEST signal present: {'YES' if loo_sig else 'no'}")
print(f"lagged TEST corr excludes 0: {'YES' if lag_sig else 'no'}")
print(f"OOS P&L positive & CI>0: {'YES' if pnl_pos else 'no'}")
print("-" * 68)
print(f"VERDICT: tradeable cross-city common-factor edge? "
      f"{'YES' if tradeable else 'NO'}")
