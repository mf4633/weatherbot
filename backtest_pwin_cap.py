"""
Backtest P_WIN_CAP=0.95 + σ-widening sensitivity on jackson_settled.ndjson.

For each settled bet:
- Parse ticker → (kind, threshold or bucket bounds)
- Reconstruct pWin from (modelMean, modelStd, side) under N(μ, σ).
  Uses raw normal CDF — close enough to the trader's truncated-normal at
  σ_post values seen in production for the cap-region (small σ → tight pWin).
- Aggregate by pWin bucket: n, stake, realized_pnl
- Show what P_WIN_CAP=0.95 would have skipped
- Sensitivity: widen σ by Δ ∈ {0.5, 1.0, 1.5, 2.0}°F, recompute pWin, re-aggregate
"""
import json, math
from collections import defaultdict

def Phi(z):
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2)))

def parse_ticker_tail(ticker):
    # KXHIGHPHIL-26MAY05-B85.5  /  KXLOWBOS-26MAY05-T49
    tail = ticker.split("-")[-1]
    if tail.startswith("B"):
        center = float(tail[1:])           # e.g. 85.5
        return ("B", center - 0.5, center + 0.5)
    if tail.startswith("T"):
        thresh = float(tail[1:])
        return ("T", thresh, None)
    return (None, None, None)

def pwin(bet):
    mu, sigma = bet["modelMean"], bet["modelStd"]
    if sigma <= 0:
        return None
    kind, a, b = parse_ticker_tail(bet["ticker"])
    side = bet["side"]
    var = bet["variable"]
    if kind == "B":
        # YES = temp in [a,b); NO = complement
        p_in = Phi((b - mu) / sigma) - Phi((a - mu) / sigma)
        return p_in if side == "YES" else 1 - p_in
    if kind == "T":
        # HIGH T (max): YES = max ≥ T; LOW T (min): YES = min ≤ T
        p_at_or_below = Phi((a - mu) / sigma)
        if var == "high":
            p_yes = 1 - p_at_or_below
        else:  # low
            p_yes = p_at_or_below
        return p_yes if side == "YES" else 1 - p_yes
    return None

def pwin_with_widened_sigma(bet, delta_f):
    mu = bet["modelMean"]; sigma_orig = bet["modelStd"]
    sigma_new = math.sqrt(sigma_orig ** 2 + delta_f ** 2)
    new_bet = dict(bet); new_bet["modelStd"] = sigma_new
    return pwin(new_bet)

def load(path):
    return [json.loads(l) for l in open(path)]

def aggregate(bets, label):
    n = len(bets)
    stake = sum(b["stake_dollars"] for b in bets)
    pnl = sum(b["realized_pnl"] for b in bets)
    wins = sum(1 for b in bets if b["outcome"] == "WIN")
    losses = sum(1 for b in bets if b["outcome"] == "LOSS")
    roi = pnl / stake * 100 if stake else 0
    print(f"  {label:40s} n={n:4d}  stake=${stake:8.2f}  pnl=${pnl:+8.2f}  ROI={roi:+6.1f}%  W/L={wins}/{losses}")

def main():
    bets = load("jackson_settled.ndjson")
    print(f"Loaded {len(bets)} settled bets\n")

    # Reconstruct pWin for each bet
    for b in bets:
        b["_pwin_recon"] = pwin(b)

    # Sanity: distribution of reconstructed pWin
    print("=== pWin distribution (reconstructed) ===")
    pw = [b["_pwin_recon"] for b in bets if b["_pwin_recon"] is not None]
    bins = [(0,0.5),(0.5,0.6),(0.6,0.7),(0.7,0.8),(0.8,0.9),(0.9,0.95),(0.95,0.99),(0.99,1.0001)]
    for lo, hi in bins:
        subset = [b for b in bets if b["_pwin_recon"] is not None and lo <= b["_pwin_recon"] < hi]
        aggregate(subset, f"pWin [{lo:.2f}, {hi:.2f})")

    print(f"\n=== HIGH vs LOW split (all bets) ===")
    aggregate([b for b in bets if b["variable"]=="high"], "HIGH")
    aggregate([b for b in bets if b["variable"]=="low"],  "LOW")

    # ---- P_WIN_CAP=0.95 ----
    print(f"\n=== P_WIN_CAP=0.95 (skip if pWin > 0.95) ===")
    skipped = [b for b in bets if b["_pwin_recon"] is not None and b["_pwin_recon"] > 0.95]
    kept    = [b for b in bets if b["_pwin_recon"] is None or b["_pwin_recon"] <= 0.95]
    aggregate(skipped, "SKIPPED (cap fires)")
    aggregate(kept,    "KEPT (cap does not fire)")
    aggregate(bets,    "BASELINE (all bets)")

    # Same split, by variable
    print(f"\n=== Cap impact split by variable ===")
    for v in ("high","low"):
        sk = [b for b in bets if b["variable"]==v and b["_pwin_recon"] is not None and b["_pwin_recon"] > 0.95]
        aggregate(sk, f"{v.upper()} skipped by cap")

    # Show a few representative cap-fires
    print(f"\n=== Sample SKIPPED bets (top 8 by stake) ===")
    print(f"  {'date':10s} {'city':14s} {'tkr-tail':10s} {'side':4s} {'mu':6s} {'sd':6s} {'pWin':7s} {'stake':8s} {'pnl':8s}")
    for b in sorted(skipped, key=lambda x: -x["stake_dollars"])[:8]:
        tail = b["ticker"].split("-")[-1]
        print(f"  {b['placedAtUTC'][:10]} {b['city'][:14]:14s} {tail:10s} {b['side']:4s} "
              f"{b['modelMean']:6.2f} {b['modelStd']:6.2f} {b['_pwin_recon']:7.4f} "
              f"${b['stake_dollars']:6.2f} ${b['realized_pnl']:+6.2f}")

    # ---- σ-widening sensitivity ----
    # If σ_revision contributes Δ°F in quadrature, how does the cap-fire cohort change?
    print(f"\n=== σ-widening sensitivity (σ_post → sqrt(σ²+Δ²)) ===")
    print(f"  Asks: if σ were wider by Δ°F (proxy for σ_revision), how many bets")
    print(f"  drop out of the pWin>0.95 cohort, AND what does new cohort PnL look like?")
    print(f"  Δ°F   bets-still-above-0.95   newly-below   stake-skipped   pnl-skipped")
    for delta in [0.0, 0.5, 1.0, 1.5, 2.0, 3.0]:
        sk_new = []
        for b in bets:
            p = pwin_with_widened_sigma(b, delta) if delta > 0 else b["_pwin_recon"]
            if p is not None and p > 0.95:
                sk_new.append(b)
        moved = len(skipped) - len(sk_new)
        stake_sk = sum(b["stake_dollars"] for b in sk_new)
        pnl_sk = sum(b["realized_pnl"] for b in sk_new)
        print(f"  {delta:4.1f}        {len(sk_new):4d}                {moved:4d}      ${stake_sk:7.2f}     ${pnl_sk:+7.2f}")

    # ---- σ_post calibration check ----
    # We don't have per-bet actual temperature, only ticker outcome.
    # But we can do a directional check: in cap-fire cohort, what fraction WON?
    # If the model is well-calibrated at pWin>0.95, win rate should be >95%.
    print(f"\n=== σ_post calibration (in cap-fire cohort) ===")
    for lo_bound in [0.95, 0.97, 0.99]:
        coh = [b for b in bets if b["_pwin_recon"] is not None and b["_pwin_recon"] > lo_bound]
        if coh:
            wr = sum(1 for b in coh if b["outcome"]=="WIN") / len(coh) * 100
            print(f"  pWin > {lo_bound:.2f}:  n={len(coh):3d}   actual win rate = {wr:5.1f}%   (model claims > {lo_bound*100:.0f}%)")

if __name__ == "__main__":
    main()
