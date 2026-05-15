"""
Sweep P_WIN_CAP threshold from 0.85 to 0.99 on jackson_settled.ndjson.
Find the threshold that maximizes simulated PnL reduction without
sacrificing the profitable [0.90, 0.95) band.
"""
import json, math

def Phi(z): return 0.5 * (1.0 + math.erf(z / math.sqrt(2)))

def parse_ticker_tail(ticker):
    tail = ticker.split("-")[-1]
    if tail.startswith("B"):
        c = float(tail[1:]); return ("B", c - 0.5, c + 0.5)
    if tail.startswith("T"):
        return ("T", float(tail[1:]), None)
    return (None, None, None)

def pwin(bet):
    mu, sigma = bet["modelMean"], bet["modelStd"]
    if sigma <= 0: return None
    kind, a, b = parse_ticker_tail(bet["ticker"])
    side, var = bet["side"], bet["variable"]
    if kind == "B":
        p_in = Phi((b - mu) / sigma) - Phi((a - mu) / sigma)
        return p_in if side == "YES" else 1 - p_in
    if kind == "T":
        p_at_or_below = Phi((a - mu) / sigma)
        p_yes = (1 - p_at_or_below) if var == "high" else p_at_or_below
        return p_yes if side == "YES" else 1 - p_yes
    return None

def main():
    bets = [json.loads(l) for l in open("jackson_settled.ndjson")]
    for b in bets:
        b["_pwin"] = pwin(b)
    baseline_pnl = sum(b["realized_pnl"] for b in bets)
    print(f"Baseline: n={len(bets)}, PnL=${baseline_pnl:+.2f}\n")

    print(f"  {'cap':>6} {'n_skip':>7} {'skip_$':>9} {'skip_pnl':>10} {'kept_pnl':>10} {'sim_pnl':>10} {'vs_base':>8}")
    print(f"  {'-'*6:>6} {'-'*7:>7} {'-'*9:>9} {'-'*10:>10} {'-'*10:>10} {'-'*10:>10} {'-'*8:>8}")
    best = None
    for cap in [0.85, 0.86, 0.87, 0.88, 0.89, 0.90, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99]:
        sk = [b for b in bets if b["_pwin"] is not None and b["_pwin"] > cap]
        kp = [b for b in bets if not (b["_pwin"] is not None and b["_pwin"] > cap)]
        skip_pnl = sum(b["realized_pnl"] for b in sk)
        skip_stake = sum(b["stake_dollars"] for b in sk)
        kept_pnl = sum(b["realized_pnl"] for b in kp)
        sim_pnl  = kept_pnl  # what we'd have ended at if we'd skipped sk
        delta = sim_pnl - baseline_pnl
        print(f"  {cap:6.2f} {len(sk):7d} ${skip_stake:8.2f} ${skip_pnl:+9.2f} ${kept_pnl:+9.2f} ${sim_pnl:+9.2f} ${delta:+7.2f}")
        if best is None or delta > best[1]: best = (cap, delta, sim_pnl, len(sk))

    print(f"\nBest cap: {best[0]:.2f}  (+${best[1]:+.2f} vs baseline; simulated PnL ${best[2]:+.2f}, {best[3]} bets skipped)")
    print(f"Currently deployed: 0.95")

    # Calibration: actual win rate at each cap threshold
    print(f"\n=== Actual win rate at each cap threshold (sanity) ===")
    print(f"  {'cap':>6} {'n':>5} {'wins':>5} {'winrate':>8}  vs claim")
    for cap in [0.85, 0.90, 0.93, 0.95, 0.97, 0.99]:
        cohort = [b for b in bets if b["_pwin"] is not None and b["_pwin"] > cap]
        if not cohort: continue
        wins = sum(1 for b in cohort if b["outcome"] == "WIN")
        wr = wins / len(cohort) * 100
        gap = wr - cap*100
        print(f"  >{cap:.2f} {len(cohort):5d} {wins:5d} {wr:7.1f}%  gap={gap:+5.1f}pp")

    # ROI by pWin tail, just below cap
    print(f"\n=== pWin tail ROI breakdown ===")
    print(f"  {'band':>14} {'n':>4} {'stake':>9} {'pnl':>9} {'ROI':>7}")
    bands = [(0.85,0.90),(0.90,0.92),(0.92,0.94),(0.94,0.95),(0.95,0.97),(0.97,1.0001)]
    for lo, hi in bands:
        c = [b for b in bets if b["_pwin"] is not None and lo <= b["_pwin"] < hi]
        if not c: continue
        n = len(c); s = sum(b["stake_dollars"] for b in c); p = sum(b["realized_pnl"] for b in c)
        roi = p/s*100 if s else 0
        print(f"  [{lo:.2f},{hi:.2f}) {n:4d} ${s:7.2f} ${p:+8.2f} {roi:+6.1f}%")

if __name__ == "__main__":
    main()
