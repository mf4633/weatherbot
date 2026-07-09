"""
scoreboard.py — Claude-vs-Bayes verification ledger
====================================================

Append-only JSONL ledger: log both engines' cards at each decision hour,
settle against the CLI max, and keep running skill scores. The point is to
make the model dispute empirical instead of rhetorical.

Scores per engine:
    MAE        point-estimate error, °F
    RMSE       ditto, quadratic
    Brier      multi-bin Brier score against Kalshi bins (needs bin_probs)
    CRPS-ish   integrated pinball at 16/50/84 quantiles from (mu, sigma, floor)
    hit68      fraction of settlements inside the stated 68% CI (calibration:
               should converge to ~0.68; systematically higher = overdispersed,
               lower = overconfident)

Usage:
    sb = Scoreboard("verification.jsonl")
    sb.log_decision(station="KNYC", contract_date="2026-07-09",
                    asof="2026-07-09T09:51",
                    claude=card_dict, bayes=bayes_dict,
                    market=market_dict)          # optional book snapshot
    ...
    sb.settle("KNYC", "2026-07-09", cli_max=88)
    print(sb.report())

Card dicts need at minimum: point, sigma, floor. Optional: ci68 [lo, hi],
bin_probs {label: p}. `market` is {label: yes_price_cents} so you can also
score the crowd as a third contestant.
"""

from __future__ import annotations

import json
import re
import math
import os
from collections import defaultdict
from dataclasses import dataclass
from typing import Optional


def _phi(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _floored_cdf(x: float, mu: float, sigma: float, floor: float) -> float:
    if x < floor:
        return 0.0
    return _phi((x - mu) / sigma)


def _quantile(p: float, mu: float, sigma: float, floor: float) -> float:
    # invert the floored normal by bisection (cheap, robust)
    lo, hi = floor, mu + 8 * sigma
    if _floored_cdf(lo, mu, sigma, floor) >= p:
        return lo
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if _floored_cdf(mid, mu, sigma, floor) < p:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def _pinball(truth: float, q: float, tau: float) -> float:
    d = truth - q
    return max(tau * d, (tau - 1.0) * d)


def _bin_hit(label: str, truth: float) -> bool:
    """Parse labels like '<=82', '83-84', '>=91' against an integer CLI max."""
    t = round(truth)
    label = label.replace("°", "").strip()
    if label.startswith("<="):
        return t <= int(label[2:])
    if label.startswith(">="):
        return t >= int(label[2:])
    m = re.match(r"^(-?\d+)-(-?\d+)$", label)   # 2026-07-09: signed winter bins
    if m:
        return int(m.group(1)) <= t <= int(m.group(2))
    return t == int(label)


@dataclass
class EngineScore:
    n: int = 0
    abs_err: float = 0.0
    sq_err: float = 0.0
    brier: float = 0.0
    brier_n: int = 0
    pinball: float = 0.0
    in68: int = 0
    ci_n: int = 0

    def add(self, card: dict, truth: float) -> None:
        mu = float(card["point"])
        self.n += 1
        self.abs_err += abs(mu - truth)
        self.sq_err += (mu - truth) ** 2

        sigma = float(card.get("sigma", 0) or 0)
        floor = float(card.get("floor", -math.inf))
        if sigma > 0:
            for tau in (0.16, 0.50, 0.84):
                q = _quantile(tau, mu, sigma, floor)
                self.pinball += _pinball(truth, q, tau)

        ci = card.get("ci68")
        if ci:
            self.ci_n += 1
            if ci[0] <= truth <= ci[1]:
                self.in68 += 1

        probs = card.get("bin_probs")
        if probs:
            self.brier_n += 1
            self.brier += sum(
                (p - (1.0 if _bin_hit(lbl, truth) else 0.0)) ** 2
                for lbl, p in probs.items()
            )

    def row(self, name: str) -> str:
        if self.n == 0:
            return f"{name:<8} —"
        mae = self.abs_err / self.n
        rmse = math.sqrt(self.sq_err / self.n)
        parts = [f"{name:<8} n={self.n:<3} MAE {mae:5.2f}  RMSE {rmse:5.2f}"]
        if self.brier_n:
            parts.append(f"Brier {self.brier / self.brier_n:.3f}")
        if self.pinball:
            parts.append(f"pinball {self.pinball / self.n:.3f}")
        if self.ci_n:
            parts.append(f"hit68 {self.in68 / self.ci_n:.0%}")
        return "  ".join(parts)


class Scoreboard:
    def __init__(self, path: str = "verification.jsonl"):
        self.path = path

    # -- ledger ------------------------------------------------------------

    def _append(self, rec: dict) -> None:
        with open(self.path, "a") as f:
            f.write(json.dumps(rec) + "\n")

    def _read(self) -> list[dict]:
        if not os.path.exists(self.path):
            return []
        with open(self.path) as f:
            return [json.loads(line) for line in f if line.strip()]

    def log_decision(
        self,
        station: str,
        contract_date: str,
        asof: str,
        claude: dict,
        bayes: Optional[dict] = None,
        market: Optional[dict] = None,
        note: str = "",
    ) -> None:
        self._append({
            "type": "decision",
            "station": station,
            "contract_date": contract_date,
            "asof": asof,
            "claude": claude,
            "bayes": bayes,
            "market": market,   # {bin_label: yes_price_cents}
            "note": note,
        })

    def settle(self, station: str, contract_date: str, cli_max: float) -> None:
        self._append({
            "type": "settlement",
            "station": station,
            "contract_date": contract_date,
            "cli_max": cli_max,
        })

    # -- scoring -----------------------------------------------------------

    def report(self, last_ob_only: bool = False) -> str:
        """
        Score every decision against its settlement. By default every logged
        decision hour counts (so an engine that converges faster intraday
        wins); with last_ob_only=True only the final pre-peak decision per
        (station, date) is scored.
        """
        recs = self._read()
        truths = {
            (r["station"], r["contract_date"]): r["cli_max"]
            for r in recs if r["type"] == "settlement"
        }
        decisions = [r for r in recs if r["type"] == "decision"
                     and (r["station"], r["contract_date"]) in truths]
        if last_ob_only:
            latest: dict = {}
            for r in decisions:
                key = (r["station"], r["contract_date"])
                if key not in latest or r["asof"] > latest[key]["asof"]:
                    latest[key] = r
            decisions = list(latest.values())

        scores = defaultdict(EngineScore)
        market_pnl, market_n = 0.0, 0
        for r in decisions:
            truth = truths[(r["station"], r["contract_date"])]
            scores["claude"].add(r["claude"], truth)
            if r.get("bayes"):
                scores["bayes"].add(r["bayes"], truth)
            # score the market as implied probs (price/100)
            if r.get("market"):
                probs = {k: v / 100.0 for k, v in r["market"].items()}
                scores["market"].add(
                    {"point": _market_point(probs), "bin_probs": probs}, truth
                )

        lines = [f"verification ledger: {self.path}",
                 f"settled decisions scored: {sum(s.n for s in scores.values())}"]
        for name in ("claude", "bayes", "market"):
            if name in scores:
                lines.append(scores[name].row(name))
        return "\n".join(lines)


def _market_point(probs: dict) -> float:
    """Prob-weighted bin midpoint as the market's implied point estimate."""
    total, acc = 0.0, 0.0
    for lbl, p in probs.items():
        lbl = lbl.replace("°", "").strip()
        if lbl.startswith("<="):
            mid = int(lbl[2:]) - 1.0
        elif lbl.startswith(">="):
            mid = int(lbl[2:]) + 1.0
        else:
            m = re.match(r"^(-?\d+)-(-?\d+)$", lbl)   # 2026-07-09: signed winter bins
            mid = (int(m.group(1)) + int(m.group(2))) / 2.0 if m else float(lbl)
        acc += p * mid
        total += p
    return acc / total if total else float("nan")


# ---------------------------------------------------------------------------
# Self-test: replay today's KNYC session with a hypothetical settlement
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import tempfile

    tmp = tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False)
    sb = Scoreboard(tmp.name)

    claude_951 = {
        "point": 89.4, "sigma": 3.39, "floor": 79.0, "ci68": [86.0, 92.8],
        "bin_probs": {"<=82": 0.022, "83-84": 0.054, "85-86": 0.124,
                      "87-88": 0.200, "89-90": 0.232, ">=91": 0.368},
    }
    bayes_951 = {
        "point": 84.8, "sigma": 5.49, "floor": 79.0, "ci68": [79.3, 90.3],
    }
    market_942 = {"<=82": 22, "83-84": 59, "85-86": 28, "87-88": 3, "89-90": 1, ">=91": 1}

    sb.log_decision("KNYC", "2026-07-09", "2026-07-09T09:51",
                    claude=claude_951, bayes=bayes_951, market=market_942)

    for hypothetical in (83, 85, 87, 90):
        sb2 = Scoreboard(tmp.name + f".{hypothetical}")
        sb2.log_decision("KNYC", "2026-07-09", "2026-07-09T09:51",
                         claude=claude_951, bayes=bayes_951, market=market_942)
        sb2.settle("KNYC", "2026-07-09", cli_max=hypothetical)
        print(f"\n--- if CLI max = {hypothetical} ---")
        print(sb2.report())
