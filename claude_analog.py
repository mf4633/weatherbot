"""
claude_analog.py — Obs-analog daily-max prediction engine ("Claude method")
============================================================================

A deliberately different epistemic stance from the Bayesian (NWS-anchored)
engine: this model is anchored to *observations and yesterday's realized
diurnal ramp*, treating NWS guidance as absent. Run both, display both cards,
and let the disagreement itself be a signal (large divergence = the market
is pricing guidance the obs don't yet support, or vice versa).

Methodology (as developed 2026-07-09, KDEN/KNYC session):

    T_max = T_now + R_analog + A_bowen + A_trajectory + A_airmass

    R_analog     yesterday's ramp from this clock-hour to yesterday's max
    A_bowen      dewpoint penalty vs analog day: -k_td * max(0, dTd)
    A_trajectory wind-sector term: 0 for pinned land flow, negative and
                 growing as flow weakens or veers marine (sea-breeze risk)
    A_airmass    SLP 24h tendency as advection proxy: falling = warm sector

Distribution: Normal(T_max, sigma_h), floored at max-so-far (a realized max
cannot un-happen), where sigma_h shrinks as peak approaches. Discretized
onto Kalshi bins for direct EV comparison against the book.

Integration surface: build an `ObsSnapshot` from whatever your METAR/ASOS
pipeline already produces, call `predict()`, get a `ClaudeCard` mirroring
the fields on your Bayesian card.

No external deps beyond the stdlib + math.erf.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Sequence

# ---------------------------------------------------------------------------
# Station configuration
# ---------------------------------------------------------------------------

# Wind sectors (degrees, inclusive ranges) from which marine/lake air reaches
# the sensor. Everything else is treated as land trajectory.
# Extend per station as you add cities.
MARINE_SECTORS: dict[str, list[tuple[int, int]]] = {
    "KNYC": [(90, 200)],          # E through SSW off the harbor/Atlantic
    "KLGA": [(60, 180)],
    "KBOS": [(20, 170)],          # backdoor NE through S
    "KPHL": [(100, 180)],         # weak Delaware Bay influence
    "KMDW": [(0, 110)],           # lake breeze N through E
    "KDEN": [],                    # continental; no marine term
    "KDFW": [],
    "KSAT": [],
    "KLAX": [(180, 290)],          # onshore SW; basically always marine
    "KSEA": [(160, 280)],
    "KDCA": [(120, 200)],          # weak Potomac/Chesapeake term
}

# Per-station tuning. Defaults are the coefficients used in the 2026-07-09
# session; refine against your CLI archive (see calibrate() stub below).
@dataclass
class StationConfig:
    station: str
    k_td: float = 0.35            # °F max penalty per °F of Td excess vs analog day
    k_slp: float = 0.4            # °F per mb of 24h SLP fall (capped)
    slp_cap: float = 2.0          # max |airmass| adjustment, °F
    sea_breeze_penalty: float = 4.0   # full marine-shift penalty, °F
    weak_flow_kt: float = 8.0     # below this, land flow can't pin the marine air
    sigma_open: float = 4.5       # dist. spread at 07 LST
    sigma_peak: float = 1.0       # dist. spread at peak hour
    peak_hour: int = 16           # LST climatological max hour
    morning_hour: int = 7


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

@dataclass
class HourlyOb:
    """One hourly (or special) observation. Timestamps are local standard."""
    ts: datetime
    temp_f: float
    dewpoint_f: Optional[float] = None
    wind_dir_deg: Optional[int] = None      # None = variable/calm
    wind_speed_kt: float = 0.0
    slp_mb: Optional[float] = None
    sky: str = ""                            # raw sky string, e.g. "FEW085"


@dataclass
class ObsSnapshot:
    """Everything the model needs at decision time."""
    station: str
    now: HourlyOb
    max_so_far_f: float
    yesterday: Sequence[HourlyOb]            # yesterday's hourlies, chronological
    yesterday_max_f: float
    slp_24h_ago_mb: Optional[float] = None


# ---------------------------------------------------------------------------
# Output card
# ---------------------------------------------------------------------------

@dataclass
class ClaudeCard:
    station: str
    asof: datetime
    point_f: float                # T_max point estimate
    sigma_f: float
    floor_f: float                # max-so-far clamp
    ci68: tuple[float, float]
    ci95: tuple[float, float]
    components: dict = field(default_factory=dict)   # audit trail
    bin_probs: dict = field(default_factory=dict)    # label -> prob

    def render(self, bayes_point: Optional[float] = None) -> str:
        """Text card suitable for the dashboard, next to the Bayesian card."""
        lines = [
            f"CLAUDE analog  •  {self.station}  •  as of {self.asof:%-I:%M %p}",
            f"  HIGH (analog)      {self.point_f:.1f}°F",
            f"  σ                  {self.sigma_f:.2f}°F",
            f"  68% CI obs-floored [{self.ci68[0]:.1f}, {self.ci68[1]:.1f}]",
            f"  95% CI obs-floored [{self.ci95[0]:.1f}, {self.ci95[1]:.1f}]",
            "  components:",
        ]
        for k, v in self.components.items():
            lines.append(f"    {k:<14}{v:+.2f}" if isinstance(v, float) else f"    {k:<14}{v}")
        if self.bin_probs:
            lines.append("  bins:")
            for label, p in self.bin_probs.items():
                lines.append(f"    {label:<14}{100*p:5.1f}%")
        if bayes_point is not None:
            div = self.point_f - bayes_point
            flag = "⚠ divergence" if abs(div) >= 2.0 else "≈ agreement"
            lines.append(f"  vs bayes {bayes_point:.1f} → {div:+.1f}°F  {flag}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Core model
# ---------------------------------------------------------------------------

def _in_sector(deg: Optional[int], sectors: list[tuple[int, int]]) -> bool:
    if deg is None:
        return False
    return any(lo <= deg <= hi for lo, hi in sectors)


def _analog_ramp(snapshot: ObsSnapshot) -> tuple[float, Optional[HourlyOb]]:
    """Yesterday's rise from the ob nearest this clock-hour to yesterday's max."""
    target_hm = (snapshot.now.ts.hour, snapshot.now.ts.minute)
    best, best_delta = None, 1e9
    for ob in snapshot.yesterday:
        delta = abs((ob.ts.hour * 60 + ob.ts.minute) - (target_hm[0] * 60 + target_hm[1]))
        if delta < best_delta:
            best, best_delta = ob, delta
    if best is None:
        return 0.0, None
    return snapshot.yesterday_max_f - best.temp_f, best


def _bowen(snapshot: ObsSnapshot, analog_ob: Optional[HourlyOb], cfg: StationConfig) -> float:
    if analog_ob is None or analog_ob.dewpoint_f is None or snapshot.now.dewpoint_f is None:
        return 0.0
    d_td = snapshot.now.dewpoint_f - analog_ob.dewpoint_f
    return -cfg.k_td * max(0.0, d_td)


def _trajectory(snapshot: ObsSnapshot, cfg: StationConfig) -> float:
    sectors = MARINE_SECTORS.get(snapshot.station, [])
    if not sectors:
        return 0.0
    ob = snapshot.now
    if _in_sector(ob.wind_dir_deg, sectors):
        # Marine air already at the sensor: take most of the penalty now.
        return -cfg.sea_breeze_penalty
    # Land flow. Penalize weakness: a limp gradient can't hold the sea breeze off.
    if ob.wind_speed_kt < cfg.weak_flow_kt:
        frac = 1.0 - (ob.wind_speed_kt / cfg.weak_flow_kt)
        return -0.5 * cfg.sea_breeze_penalty * frac
    return 0.0


def _airmass(snapshot: ObsSnapshot, cfg: StationConfig) -> float:
    if snapshot.slp_24h_ago_mb is None or snapshot.now.slp_mb is None:
        return 0.0
    d_slp = snapshot.now.slp_mb - snapshot.slp_24h_ago_mb   # negative = falling
    adj = -cfg.k_slp * d_slp                                 # falling → warm bonus
    return max(-cfg.slp_cap, min(cfg.slp_cap, adj))


def _sigma(now: datetime, cfg: StationConfig) -> float:
    """Linear shrink from sigma_open at morning_hour to sigma_peak at peak_hour."""
    h = now.hour + now.minute / 60.0
    if h <= cfg.morning_hour:
        return cfg.sigma_open
    if h >= cfg.peak_hour:
        return cfg.sigma_peak
    frac = (h - cfg.morning_hour) / (cfg.peak_hour - cfg.morning_hour)
    return cfg.sigma_open + frac * (cfg.sigma_peak - cfg.sigma_open)


def _phi(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _floored_normal_cdf(x: float, mu: float, sigma: float, floor: float) -> float:
    """CDF of max(N(mu, sigma), floor): all mass below floor piles at floor."""
    if x < floor:
        return 0.0
    return _phi((x - mu) / sigma)


def _ci(mu: float, sigma: float, floor: float, z: float) -> tuple[float, float]:
    lo = max(floor, mu - z * sigma)
    hi = max(floor, mu + z * sigma)
    return (lo, hi)


def bin_probabilities(
    mu: float, sigma: float, floor: float,
    bins: Sequence[tuple[str, float, float]],
) -> dict[str, float]:
    """
    bins: (label, lo, hi) in whole °F, inclusive integer bins as Kalshi defines
    them, e.g. ("85-86", 85, 86). Use -inf/inf for open-ended bins. Bin edges
    are treated as [lo - 0.5, hi + 0.5) against the continuous dist, matching
    CLI whole-degree rounding.
    """
    out = {}
    for label, lo, hi in bins:
        a = -math.inf if math.isinf(lo) else lo - 0.5
        b = math.inf if math.isinf(hi) else hi + 0.5
        p_hi = 1.0 if math.isinf(b) else _floored_normal_cdf(b, mu, sigma, floor)
        p_lo = 0.0 if math.isinf(a) else _floored_normal_cdf(a, mu, sigma, floor)
        # mass parked exactly at the floor belongs to the bin containing it
        if a <= floor < b:
            p_lo = 0.0 if math.isinf(a) else min(p_lo, _phi((floor - mu) / sigma))
            p_hi = max(p_hi, _phi((floor - mu) / sigma))
        out[label] = max(0.0, p_hi - p_lo)
    # renormalize tiny numeric drift
    s = sum(out.values())
    if s > 0:
        out = {k: v / s for k, v in out.items()}
    return out


def predict(
    snapshot: ObsSnapshot,
    cfg: Optional[StationConfig] = None,
    kalshi_bins: Optional[Sequence[tuple[str, float, float]]] = None,
) -> ClaudeCard:
    cfg = cfg or StationConfig(station=snapshot.station)

    ramp, analog_ob = _analog_ramp(snapshot)
    a_bowen = _bowen(snapshot, analog_ob, cfg)
    a_traj = _trajectory(snapshot, cfg)
    a_air = _airmass(snapshot, cfg)

    mu = snapshot.now.temp_f + ramp + a_bowen + a_traj + a_air
    sigma = _sigma(snapshot.now.ts, cfg)
    floor = snapshot.max_so_far_f
    mu = max(mu, floor)   # can't forecast below a realized max

    card = ClaudeCard(
        station=snapshot.station,
        asof=snapshot.now.ts,
        point_f=mu,
        sigma_f=sigma,
        floor_f=floor,
        ci68=_ci(mu, sigma, floor, 1.0),
        ci95=_ci(mu, sigma, floor, 1.96),
        components={
            "T_now": snapshot.now.temp_f,
            "R_analog": ramp,
            "A_bowen": a_bowen,
            "A_trajectory": a_traj,
            "A_airmass": a_air,
        },
    )
    if kalshi_bins:
        card.bin_probs = bin_probabilities(mu, sigma, floor, kalshi_bins)
    return card


# ---------------------------------------------------------------------------
# Calibration stub — fit coefficients against your CLI archive
# ---------------------------------------------------------------------------

def calibrate(history: Sequence[tuple[ObsSnapshot, float]], cfg: StationConfig) -> StationConfig:
    """
    history: (snapshot_at_decision_time, verified_CLI_max) pairs.
    Grid-searches k_td and sea_breeze_penalty to minimize MAE. Coarse on
    purpose — with a season of CLI data per station this is plenty, and it
    keeps the model honest about how few parameters it actually earns.
    """
    best_cfg, best_mae = cfg, math.inf
    for k_td in (0.2, 0.3, 0.35, 0.4, 0.5):
        for sbp in (2.0, 3.0, 4.0, 5.0, 6.0):
            trial = StationConfig(**{**cfg.__dict__, "k_td": k_td, "sea_breeze_penalty": sbp})
            errs = [abs(predict(s, trial).point_f - truth) for s, truth in history]
            mae = sum(errs) / len(errs)
            if mae < best_mae:
                best_cfg, best_mae = trial, mae
    return best_cfg


# ---------------------------------------------------------------------------
# Worked example: the 2026-07-09 KNYC 9:51 AM decision point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from datetime import datetime as dt

    yesterday = [
        HourlyOb(dt(2026, 7, 8, 8, 51), 71, 62, 20, 6, 1017.4),
        HourlyOb(dt(2026, 7, 8, 9, 51), 73, 63, None, 0, 1017.5),
        HourlyOb(dt(2026, 7, 8, 13, 51), 85, 62, 0, 0, 1016.1),
    ]
    snap = ObsSnapshot(
        station="KNYC",
        now=HourlyOb(dt(2026, 7, 9, 9, 51), 79, 70, 225, 5, 1013.6),  # SW 6 mph ≈ 5 kt
        max_so_far_f=79.0,
        yesterday=yesterday,
        yesterday_max_f=85.0,
        slp_24h_ago_mb=1017.5,
    )
    bins = [
        ("<=82", -math.inf, 82),
        ("83-84", 83, 84),
        ("85-86", 85, 86),
        ("87-88", 87, 88),
        ("89-90", 89, 90),
        (">=91", 91, math.inf),
    ]
    card = predict(snap, kalshi_bins=bins)
    print(card.render(bayes_point=84.8))
