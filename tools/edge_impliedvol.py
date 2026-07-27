"""
edge_impliedvol.py — Test ONE edge hypothesis: is the market's implied DISTRIBUTION
WIDTH mispriced? Back out market-implied std of the daily high from the bucket ladder,
compare to realized dispersion via standardized error z = (settle - implied_mean)/implied_std.

Pre-registered protocol (see task). Reports straight; negative is a fine outcome.
No p-hacking: single width statistic (stdev of z), fixed chronological TRAIN/TEST split,
fixed bootstrap seed, one tradeable rule derived mechanically from the calibration sign.
"""
import json, math, os, random
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROWS_PATH = os.path.join(HERE, "_lead_rows.json")

# ---------------------------------------------------------------- helpers
def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))

def bucket_prob(floor, cap, mean, sd):
    """P(Normal(mean,sd) in bucket). Open tails: floor None => (-inf,cap]; cap None => [floor,inf)."""
    if sd <= 0:
        return 0.0
    lo = -1e18 if floor is None else floor
    hi = 1e18 if cap is None else cap
    return max(0.0, norm_cdf((hi - mean) / sd) - norm_cdf((lo - mean) / sd))

def settle_in_bucket(settle, floor, cap):
    lo = -1e18 if floor is None else floor
    hi = 1e18 if cap is None else cap
    return lo <= settle <= hi

def fee(p):
    # Kalshi-style: ceil(7 * p * (1-p)) cents
    return math.ceil(7.0 * p * (1.0 - p)) / 100.0

def wstd(z):
    """sample std about the mean (ddof=1)."""
    n = len(z)
    if n < 2:
        return float("nan")
    m = sum(z) / n
    return math.sqrt(sum((v - m) ** 2 for v in z) / (n - 1))

# ---------------------------------------------------------------- load & build per-row features
rows = json.load(open(ROWS_PATH))

# detect volume availability
has_volume = any(("volume" in b) for r in rows for b in r.get("ladder", []))

feat = []  # each: dict with cli,date,hour,implied_mean,implied_std,z,ladder(priced buckets),settle
skip_hour = skip_settle = skip_nbuckets = 0
for r in rows:
    hour = r.get("hour")
    settle = r.get("settle")
    if hour is None or not (10 <= hour <= 15):
        skip_hour += 1
        continue
    if settle is None:
        skip_settle += 1
        continue
    priced = []
    for b in r.get("ladder", []):
        bid, ask = b.get("yes_bid"), b.get("yes_ask")
        if bid is None or ask is None:
            continue
        mid = 0.5 * (bid + ask)
        if mid <= 0:
            continue
        priced.append({"floor": b.get("floor"), "cap": b.get("cap"),
                       "centre": b.get("centre"), "mid": mid, "ask": ask})
    if len(priced) < 4:
        skip_nbuckets += 1
        continue
    tot = sum(b["mid"] for b in priced)
    if tot <= 0:
        continue
    for b in priced:
        b["p"] = b["mid"] / tot
    imean = sum(b["p"] * b["centre"] for b in priced)
    ivar = sum(b["p"] * (b["centre"] - imean) ** 2 for b in priced)
    istd = math.sqrt(ivar)
    if istd <= 0:
        continue
    z = (settle - imean) / istd
    feat.append({"cli": r["cli"], "date": r["date"], "hour": hour,
                 "imean": imean, "istd": istd, "z": z,
                 "settle": settle, "priced": priced})

print(f"loaded {len(rows)} rows; usable {len(feat)}")
print(f"  skipped: hour_out_of_10_15={skip_hour}, no_settle={skip_settle}, <4_priced_buckets={skip_nbuckets}")
print(f"  ladder has 'volume' field: {has_volume}")

# ---------------------------------------------------------------- TRAIN/TEST split (chronological by date)
all_dates = sorted({f["date"] for f in feat})
half = len(all_dates) // 2
train_dates = set(all_dates[:half])
test_dates = set(all_dates[half:])
train = [f for f in feat if f["date"] in train_dates]
test = [f for f in feat if f["date"] in test_dates]
print(f"\ndates: {len(all_dates)} total -> TRAIN {len(train_dates)} dates ({len(train)} rows), "
      f"TEST {len(test_dates)} dates ({len(test)} rows)")

# ---------------------------------------------------------------- day-clustered bootstrap for stdev(z)
def boot_std_ci(subset, iters=2000, seed=0):
    """Resample DATES with replacement, pool z, compute stdev(z). Return (point, lo, hi)."""
    by_date = defaultdict(list)
    for f in subset:
        by_date[f["date"]].append(f["z"])
    dates = list(by_date.keys())
    if len(dates) < 2:
        return (wstd([f["z"] for f in subset]), float("nan"), float("nan"))
    rng = random.Random(seed)
    stats = []
    for _ in range(iters):
        pool = []
        for _ in range(len(dates)):
            pool.extend(by_date[dates[rng.randrange(len(dates))]])
        if len(pool) >= 2:
            stats.append(wstd(pool))
    stats.sort()
    lo = stats[int(0.05 * len(stats))]
    hi = stats[int(0.95 * len(stats))]
    return (wstd([f["z"] for f in subset]), lo, hi)

def report_group(name, tr, te):
    pt_tr, lo_tr, hi_tr = boot_std_ci(tr) if len(tr) >= 2 else (float("nan"),)*3
    pt_te, lo_te, hi_te = boot_std_ci(te) if len(te) >= 2 else (float("nan"),)*3
    excl = "" if math.isnan(lo_te) else ("  [CI excludes 1.0]" if (lo_te > 1.0 or hi_te < 1.0) else "  [CI includes 1.0]")
    print(f"  {name:6s}  TRAIN n={len(tr):4d} stdev(z)={pt_tr:5.3f} [{lo_tr:5.3f},{hi_tr:5.3f}]"
          f"   TEST n={len(te):4d} stdev(z)={pt_te:5.3f} [{lo_te:5.3f},{hi_te:5.3f}]{excl}")
    return pt_tr, (pt_te, lo_te, hi_te)

print("\n================ CALIBRATION: stdev(z)  (==1 calibrated; >1 too NARROW; <1 too WIDE) ================")
s_train_overall, test_ci = report_group("ALL", train, test)

cities = sorted({f["cli"] for f in feat})
print("  ---- per city ----")
for c in cities:
    report_group(c, [f for f in train if f["cli"] == c], [f for f in test if f["cli"] == c])

# ---------------------------------------------------------------- implied vs realized std comparison
def mean_(xs):
    return sum(xs) / len(xs) if xs else float("nan")
print("\n================ IMPLIED vs REALIZED std of the high ================")
print(f"  mean implied_std (TEST)            = {mean_([f['istd'] for f in test]):.3f} F")
# realized std of (settle - imean) is the empirical dispersion the market should have priced
resid_test = [f["settle"] - f["imean"] for f in test]
mr = mean_(resid_test)
realized_disp = math.sqrt(sum((x - mr) ** 2 for x in resid_test) / (len(resid_test) - 1))
print(f"  realized stdev(settle-implied_mean)= {realized_disp:.3f} F  (mean resid/bias = {mr:+.3f} F)")
print(f"  ratio realized/implied  ~ stdev(z) = {realized_disp / mean_([f['istd'] for f in test]):.3f} "
      f"(exact per-row stdev(z)={test_ci[0]:.3f})")

# ---------------------------------------------------------------- TRADEABLE vol trade on TEST
# Direction is mechanical: corrected per-row std = implied_std * s_train_overall.
# Buy every priced bucket whose model prob (Normal(implied_mean, corrected_std)) > ask + fee.
# s_train<1 (too wide) -> corrected narrower -> body buckets clear the bar (buy body).
# s_train>1 (too narrow) -> corrected wider -> tail buckets clear the bar (buy tails).
print("\n================ TRADEABLE (OOS) vol trade on TEST ================")
print(f"  correction factor s_train (overall stdev(z), TRAIN) = {s_train_overall:.3f}")
direction = "BUY BODY (market too WIDE)" if s_train_overall < 1 else "BUY TAILS (market too NARROW)"
print(f"  implied trade direction: {direction}")

bets = []  # each: (date, pnl, cost)
for f in test:
    sd_corr = f["istd"] * s_train_overall
    for b in f["priced"]:
        mp = bucket_prob(b["floor"], b["cap"], f["imean"], sd_corr)
        ask = b["ask"]
        fpay = fee(ask)
        if mp > ask + fpay:  # positive model edge net of fee
            win = 1.0 if settle_in_bucket(f["settle"], b["floor"], b["cap"]) else 0.0
            pnl = win - ask - fpay
            bets.append((f["date"], pnl, ask + fpay))

n_bets = len(bets)
tot_pnl = sum(b[1] for b in bets)
tot_cost = sum(b[2] for b in bets)
roi = tot_pnl / tot_cost if tot_cost > 0 else float("nan")

# day-clustered bootstrap CI on total P&L (resample TEST dates)
def boot_pnl_ci(bets, iters=2000, seed=0):
    by_date = defaultdict(list)
    for d, pnl, _ in bets:
        by_date[d].append(pnl)
    dates = list(by_date.keys())
    if not dates:
        return (float("nan"), float("nan"))
    rng = random.Random(seed)
    tots = []
    for _ in range(iters):
        s = 0.0
        for _ in range(len(dates)):
            s += sum(by_date[dates[rng.randrange(len(dates))]])
        tots.append(s)
    tots.sort()
    return (tots[int(0.05 * len(tots))], tots[int(0.95 * len(tots))])

pnl_lo, pnl_hi = boot_pnl_ci(bets)
print(f"  n bets = {n_bets}")
print(f"  OOS total P&L = ${tot_pnl:+.2f}  (per bet ${tot_pnl/n_bets:+.4f})" if n_bets else "  no bets triggered")
print(f"  OOS ROI = {roi*100:+.2f}%  on ${tot_cost:.2f} deployed" if n_bets else "")
print(f"  P&L day-clustered 90% CI = [${pnl_lo:+.2f}, ${pnl_hi:+.2f}]" if n_bets else "")
print(f"  fillability: volume field present = {has_volume} "
      f"({'UNTESTED — rely on calibration CI' if not has_volume else 'check volumes'})")

# ---------------------------------------------------------------- VERDICT
calib_tradeable = (not math.isnan(test_ci[1])) and (test_ci[1] > 1.0 or test_ci[2] < 1.0)
pnl_tradeable = (n_bets > 0) and (not math.isnan(pnl_lo)) and (pnl_lo > 0 or pnl_hi < 0)
verdict = "YES" if (calib_tradeable and pnl_tradeable) else "NO"
print("\n================ VERDICT ================")
print(f"  TEST stdev(z) CI excludes 1.0 : {calib_tradeable}  (CI [{test_ci[1]:.3f},{test_ci[2]:.3f}])")
print(f"  OOS trade P&L CI excludes 0   : {pnl_tradeable}  (CI [${pnl_lo:+.2f},${pnl_hi:+.2f}])" if n_bets else
      f"  OOS trade P&L CI excludes 0   : {pnl_tradeable}  (no bets)")
print(f"\nVERDICT: Is the market's implied vol mispriced in a TRADEABLE way? {verdict}")
