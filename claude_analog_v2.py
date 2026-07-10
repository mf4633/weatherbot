"""
claude_analog_v2.py — Obs-analog daily-max engine, judgment layer folded in
============================================================================

Everything v1 had, plus the six pieces of reasoning that were doing the real
work in the 2026-07-09 session (KNYC / KLAX / KDEN) but lived only in prose:

  1. CONVECTIVE TRUNCATION (mixture model)
     High-plains maxes get cut short when storms fire mid-ramp. Modeled as a
     mixture: with prob p_trunc the ramp is truncated by a random depth. This
     also gives the distribution its correct LEFT skew — truncation only cuts.

  2. REGIME-DEPENDENT BOWEN COEFFICIENT
     Surface Td persists all day at coastal stations but mixes out over a
     3–4 km boundary layer on the high plains. k_td now scales with a
     per-station mixing_dilution factor.

  3. SKY COVER CONSUMED
     Raw METAR sky strings ("FEW100 SCT120 BKN220") are parsed into an
     insolation deficit; layers below the mid-level ceiling matter most.

  4. MULTI-DAY ANALOG ENSEMBLE
     2–3 analog days, similarity-weighted by same-hour Td and sky, with ramp
     RATE and LEVEL treated separately (a nominal rate from a deficient level
     is not a nominal day).

  5. MARKET PRIOR / DIVERGENCE
     The Kalshi book can be passed in; the card reports the market-implied
     point, the divergence, and an interpretation. By default the model does
     NOT blend toward market — independence is what makes divergence a signal.

  6. STATION REGIMES incl. MARINE-BASELINE (the LAX fix)
     regime="marine_baseline" inverts the trajectory logic: offshore/drainage
     flow is a WARM term, weak flow is neutral, sigma is compressed, and the
     analog leans on multi-day persistence.

  7. CHECKPOINT POLICY
     The intraday branch logic ("≥83 and SW → press; 80 and SSE → exit")
     formalized: compare consecutive snapshots, emit signals + a stance.

Stdlib only.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Sequence

# ---------------------------------------------------------------------------
# Station configuration
# ---------------------------------------------------------------------------

MARINE_SECTORS: dict[str, list[tuple[int, int]]] = {
    "KNYC": [(90, 200)],    # harbor/Atlantic E through SSW
    "KLGA": [(60, 180)],
    "KBOS": [(20, 170)],    # backdoor NE through S off the cold Atlantic
    "KPHL": [(100, 180)],   # weak Delaware Bay
    "KMDW": [(0, 110)],     # Lake Michigan N through E; sharp and binary
    "KDCA": [(120, 200)],   # weak Potomac/Chesapeake
    "KMIA": [(40, 170)],    # Atlantic E/SE sea breeze — the daily norm
    "KHOU": [(100, 210)],   # Galveston Bay / Gulf SSE
    "KMSY": [(90, 230)],    # Lake Pontchartrain + Gulf; moisture everywhere
    "KLAX": [(180, 290)],
    "KSEA": [(160, 280)],
}

# For marine_baseline stations: sectors whose flow is OFFSHORE (warm signal).
OFFSHORE_SECTORS: dict[str, list[tuple[int, int]]] = {
    "KLAX": [(0, 140)],     # N through ESE drainage / Santa Ana component
    "KSEA": [(20, 140)],    # E/NE offshore or thermal-trough easterly
    "KSFO": [(0, 120)],     # NE/E offshore — the big warm anomaly at SF
}

REGIMES = ("continental", "sea_breeze", "marine_baseline")


@dataclass
class StationConfig:
    station: str
    regime: str = "continental"
    # Bowen
    k_td: float = 0.35            # base °F penalty per °F Td excess vs analog
    mixing_dilution: float = 1.0  # 1.0 = Td persists (coastal); 0.5 = deep-BL
                                  # dilution (high plains) halves the tax
    # Trajectory (sea_breeze regime)
    sea_breeze_penalty: float = 4.0
    weak_flow_kt: float = 8.0
    # Trajectory (marine_baseline regime)
    k_offshore: float = 2.5       # °F bonus for established offshore AM flow
    # Airmass
    k_slp: float = 0.4
    slp_cap: float = 2.0
    # Sky
    k_sky: float = 4.0            # °F penalty at full low/mid overcast
    sky_ceiling_x100ft: int = 150 # layers below this count toward the deficit
    # Convective truncation (continental/high-plains primarily)
    conv_enabled: bool = False
    conv_td_ref: float = 50.0     # Td above this raises truncation odds
    conv_a_td: float = 0.12       # logit slope per °F of Td excess
    conv_a_slp: float = 0.25      # logit slope per mb of 24h SLP FALL
    conv_a_sky: float = 0.7       # logit bump for existing debris cloud
    conv_base_logit: float = -2.0 # ~10% on a neutral in-season day
    conv_depth_mean: float = 4.0  # °F shaved when truncation occurs
    conv_depth_sigma: float = 2.0
    # Distribution
    sigma_open: float = 4.5
    sigma_peak: float = 1.0
    peak_hour: int = 16
    morning_hour: int = 7


# ---------------------------------------------------------------------------
# Full Kalshi daily-high roster (20 cities)
#
# Kalshi market -> CLI product -> ASOS station. VERIFY the station against the
# CLI link in each market's rules before trading it — a few markets settle on
# a downtown/climate station rather than the main airport (SF and Austin are
# the classic traps; NYC settles on Central Park, not LGA/JFK).
# ---------------------------------------------------------------------------

KALSHI_STATIONS: dict[str, str] = {
    "nyc": "KNYC",          # Central Park (NOT LGA/JFK)
    "la": "KLAX",
    "miami": "KMIA",
    "chicago": "KMDW",      # Midway (NOT O'Hare)
    "boston": "KBOS",
    "seattle": "KSEA",
    "denver": "KDEN",
    "philadelphia": "KPHL",
    "austin": "KAUS",       # VERIFY: some products key to Camp Mabry (KATT)
    "houston": "KHOU",      # Hobby (NOT IAH)
    "sf": "KSFO",           # VERIFY: CLI may be downtown SF, not the airport
    "dallas": "KDFW",
    "nola": "KMSY",
    "vegas": "KLAS",
    "okc": "KOKC",
    "dc": "KDCA",
    "phoenix": "KPHX",
    "san_antonio": "KSAT",
    "minneapolis": "KMSP",
    "atlanta": "KATL",
}

STATION_CONFIGS: dict[str, StationConfig] = {
    # --- Continental / high plains: deep BL, Td mixes out, storms truncate --
    "KDEN": StationConfig("KDEN", regime="continental", mixing_dilution=0.5,
                          conv_enabled=True, sigma_open=5.0),
    "KDFW": StationConfig("KDFW", regime="continental", mixing_dilution=0.7,
                          conv_enabled=True, sigma_open=3.5),
    "KSAT": StationConfig("KSAT", regime="continental", mixing_dilution=0.7,
                          conv_enabled=True, conv_base_logit=-2.4,
                          sigma_open=3.0),   # capped Gulf ridge = persistent
    "KAUS": StationConfig("KAUS", regime="continental", mixing_dilution=0.7,
                          conv_enabled=True, conv_base_logit=-2.4,
                          sigma_open=3.0),
    "KOKC": StationConfig("KOKC", regime="continental", mixing_dilution=0.6,
                          conv_enabled=True, conv_a_slp=0.30,
                          sigma_open=4.0),   # dryline/MCS alley
    "KMSP": StationConfig("KMSP", regime="continental", mixing_dilution=0.6,
                          conv_enabled=True, sigma_open=4.5),
    "KATL": StationConfig("KATL", regime="continental", mixing_dilution=0.9,
                          conv_enabled=True, conv_td_ref=62.0,
                          conv_depth_mean=3.0, sigma_open=3.5),
                          # humid subtropical: pulse storms are routine and
                          # shallow — high odds, small depth

    # --- Desert: dry, hot, hugely predictable EXCEPT monsoon outflow -------
    "KPHX": StationConfig("KPHX", regime="continental", mixing_dilution=0.4,
                          conv_enabled=True, conv_td_ref=55.0,
                          conv_base_logit=-2.4, conv_depth_mean=5.0,
                          conv_depth_sigma=2.5, sigma_open=3.0),
                          # Td>=55 at PHX = monsoon surge; outflow hits hard
                          # but often post-peak, hence depth sigma is wide
    "KLAS": StationConfig("KLAS", regime="continental", mixing_dilution=0.4,
                          conv_enabled=True, conv_td_ref=55.0,
                          conv_base_logit=-2.8, conv_depth_mean=4.0,
                          sigma_open=3.0),

    # --- Sea/lake/bay-breeze: land ramp vs marine cap is the daily fight ---
    "KNYC": StationConfig("KNYC", regime="sea_breeze"),
    "KBOS": StationConfig("KBOS", regime="sea_breeze", sea_breeze_penalty=5.0),
                          # cold shelf water: a backdoor/sea breeze cuts hard
    "KMDW": StationConfig("KMDW", regime="sea_breeze", sea_breeze_penalty=5.0,
                          conv_enabled=True),
                          # lake breeze is sharp and binary; summer MCS too
    "KPHL": StationConfig("KPHL", regime="sea_breeze", sea_breeze_penalty=3.0,
                          conv_enabled=True, conv_td_ref=60.0,
                          conv_depth_mean=3.0),
    "KDCA": StationConfig("KDCA", regime="sea_breeze", sea_breeze_penalty=2.5,
                          conv_enabled=True, conv_td_ref=62.0,
                          conv_depth_mean=3.0),
    "KMIA": StationConfig("KMIA", regime="sea_breeze", sea_breeze_penalty=2.0,
                          conv_enabled=True, conv_td_ref=70.0,
                          conv_base_logit=-1.2, conv_depth_mean=2.5,
                          sigma_open=2.0, sigma_peak=0.8, peak_hour=14),
                          # summer KMIA lives in a ~4°F corridor: sea breeze
                          # daily, storms near-daily but shallow, max ~2 PM
                          # before the breeze/storms cap it
    "KHOU": StationConfig("KHOU", regime="sea_breeze", sea_breeze_penalty=2.0,
                          conv_enabled=True, conv_td_ref=70.0,
                          conv_base_logit=-1.6, conv_depth_mean=3.0,
                          sigma_open=2.5, peak_hour=15),
    "KMSY": StationConfig("KMSY", regime="sea_breeze", sea_breeze_penalty=1.5,
                          conv_enabled=True, conv_td_ref=70.0,
                          conv_base_logit=-1.2, conv_depth_mean=3.0,
                          sigma_open=2.5, peak_hour=14),
                          # moisture is ambient, not advected — the marine
                          # sector barely matters; convection timing is all

    # --- Marine-baseline: onshore IS the climate; offshore is the anomaly --
    "KLAX": StationConfig("KLAX", regime="marine_baseline",
                          sigma_open=2.0, sigma_peak=0.8),
    "KSEA": StationConfig("KSEA", regime="marine_baseline", k_offshore=3.0,
                          sigma_open=2.5, sigma_peak=1.0),
    "KSFO": StationConfig("KSFO", regime="marine_baseline", k_offshore=5.0,
                          sigma_open=3.0, sigma_peak=1.2),
                          # SF's right tail is violent: an offshore day adds
                          # 10°F+; k_offshore high and sigma NOT compressed
                          # as far as LAX — the anomaly regime is common
                          # enough to keep the distribution honest
}


def get_config(station: str) -> StationConfig:
    if station in STATION_CONFIGS:
        return STATION_CONFIGS[station]
    import warnings
    warnings.warn(f"{station}: no StationConfig — using continental defaults "
                  f"with no marine/offshore sectors. Configure before trusting.")
    return StationConfig(station)


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

@dataclass
class HourlyOb:
    ts: datetime          # NAIVE LOCAL time in this reference; the JS port uses UTC
                          # and must convert per-station (see tz contract in _v3.py)
    temp_f: float
    dewpoint_f: Optional[float] = None
    wind_dir_deg: Optional[int] = None
    wind_speed_kt: float = 0.0
    slp_mb: Optional[float] = None
    sky: str = ""


@dataclass
class AnalogDay:
    """One prior day used as an analog."""
    hourlies: Sequence[HourlyOb]
    max_f: float


@dataclass
class ObsSnapshot:
    station: str
    now: HourlyOb
    max_so_far_f: float
    analogs: Sequence[AnalogDay]          # 1–3 recent days, most recent first
    slp_24h_ago_mb: Optional[float] = None


# ---------------------------------------------------------------------------
# Sky parsing
# ---------------------------------------------------------------------------

_COVER_FRAC = {"FEW": 0.15, "SCT": 0.40, "BKN": 0.70, "OVC": 0.95}
_SKY_RE = re.compile(r"(FEW|SCT|BKN|OVC)(\d{3})")


def sky_deficit(sky: str, ceiling_x100ft: int) -> float:
    """
    0.0 (clear) .. ~1.0 (low overcast). Layers below the ceiling count fully;
    higher layers at 30%. Uses max-coverage logic per band, not summation.
    """
    low, high = 0.0, 0.0
    for cover, hgt in _SKY_RE.findall(sky or ""):
        frac = _COVER_FRAC[cover]
        if int(hgt) <= ceiling_x100ft:
            low = max(low, frac)
        else:
            high = max(high, frac)
    return min(1.0, low + 0.3 * high * (1 - low))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _phi(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _in_sector(deg: Optional[int], sectors: list[tuple[int, int]]) -> bool:
    if deg is None:
        return False
    return any(lo <= deg <= hi for lo, hi in sectors)


def _nearest_ob(hourlies: Sequence[HourlyOb], ts: datetime) -> Optional[HourlyOb]:
    tgt = ts.hour * 60 + ts.minute
    best, bd = None, 1e9
    for ob in hourlies:
        d = abs(ob.ts.hour * 60 + ob.ts.minute - tgt)
        if d < bd:
            best, bd = ob, d
    return best


def _logistic(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


# ---------------------------------------------------------------------------
# Analog ensemble (piece 4)
# ---------------------------------------------------------------------------

def analog_ensemble(snap: ObsSnapshot, cfg: StationConfig) -> tuple[float, float, list[dict]]:
    """
    Returns (weighted ramp, weighted analog same-hour Td, per-analog audit).
    Weighting: similarity in same-hour Td and same-hour sky deficit.
    Ramp is analog_max - analog_same_hour_temp; the LEVEL deficit
    (now.temp vs analog same-hour temp) is intentionally NOT folded into the
    ramp — it enters via T_now, keeping rate and level separate.
    """
    audits, wsum, ramp_acc, td_acc = [], 0.0, 0.0, 0.0
    now_sky = sky_deficit(snap.now.sky, cfg.sky_ceiling_x100ft)
    for i, day in enumerate(snap.analogs):
        ob = _nearest_ob(day.hourlies, snap.now.ts)
        if ob is None:
            continue
        ramp = day.max_f - ob.temp_f
        d_td = abs((snap.now.dewpoint_f or 0) - (ob.dewpoint_f or 0)) \
            if snap.now.dewpoint_f is not None and ob.dewpoint_f is not None else 0.0
        d_sky = abs(now_sky - sky_deficit(ob.sky, cfg.sky_ceiling_x100ft))
        recency = 1.0 / (1 + i)                       # yesterday counts most
        w = recency * math.exp(-(d_td / 6.0) ** 2 - (d_sky / 0.4) ** 2)
        audits.append({"analog_idx": i, "same_hr_temp": ob.temp_f,
                       "same_hr_td": ob.dewpoint_f, "ramp": ramp, "weight": w})
        wsum += w
        ramp_acc += w * ramp
        if ob.dewpoint_f is not None:
            td_acc += w * ob.dewpoint_f
    if wsum == 0:
        return 0.0, snap.now.dewpoint_f or 0.0, audits
    return ramp_acc / wsum, td_acc / wsum, audits


# ---------------------------------------------------------------------------
# Adjustment terms
# ---------------------------------------------------------------------------

def bowen(snap: ObsSnapshot, analog_td: float, cfg: StationConfig) -> float:
    """Piece 2: dilution-scaled dewpoint tax."""
    if snap.now.dewpoint_f is None:
        return 0.0
    d_td = snap.now.dewpoint_f - analog_td
    return -cfg.k_td * cfg.mixing_dilution * max(0.0, d_td)


def trajectory(snap: ObsSnapshot, cfg: StationConfig) -> float:
    """Regime-aware wind term (pieces 6 and the v1 sea-breeze logic)."""
    ob = snap.now
    if cfg.regime == "sea_breeze":
        sectors = MARINE_SECTORS.get(snap.station, [])
        if _in_sector(ob.wind_dir_deg, sectors):
            return -cfg.sea_breeze_penalty
        if ob.wind_speed_kt < cfg.weak_flow_kt:
            frac = 1.0 - ob.wind_speed_kt / cfg.weak_flow_kt
            return -0.5 * cfg.sea_breeze_penalty * frac
        return 0.0
    if cfg.regime == "marine_baseline":
        # Offshore AM flow = warm; onshore already established = the ordinary
        # plateau day (0); weak/calm = neutral (the baseline climate).
        if _in_sector(ob.wind_dir_deg, OFFSHORE_SECTORS.get(snap.station, [])):
            return +cfg.k_offshore
        return 0.0
    return 0.0   # continental


def airmass(snap: ObsSnapshot, cfg: StationConfig) -> float:
    if snap.slp_24h_ago_mb is None or snap.now.slp_mb is None:
        return 0.0
    d = snap.now.slp_mb - snap.slp_24h_ago_mb
    return max(-cfg.slp_cap, min(cfg.slp_cap, -cfg.k_slp * d))


def insolation(snap: ObsSnapshot, cfg: StationConfig) -> float:
    """Piece 3: sky-cover penalty."""
    return -cfg.k_sky * sky_deficit(snap.now.sky, cfg.sky_ceiling_x100ft)


def truncation(snap: ObsSnapshot, cfg: StationConfig) -> tuple[float, float]:
    """
    Piece 1: (p_trunc, depth_mean). Probability that convection fires before
    the climatological peak and cuts the ramp; depth is how much it shaves.
    """
    if not cfg.conv_enabled:
        return 0.0, 0.0
    td = snap.now.dewpoint_f if snap.now.dewpoint_f is not None else cfg.conv_td_ref
    slp_fall = 0.0
    if snap.slp_24h_ago_mb is not None and snap.now.slp_mb is not None:
        slp_fall = max(0.0, snap.slp_24h_ago_mb - snap.now.slp_mb)
    debris = 1.0 if sky_deficit(snap.now.sky, 160) > 0.25 else 0.0
    logit = (cfg.conv_base_logit
             + cfg.conv_a_td * (td - cfg.conv_td_ref)
             + cfg.conv_a_slp * slp_fall
             + cfg.conv_a_sky * debris)
    return _logistic(logit), cfg.conv_depth_mean


# ---------------------------------------------------------------------------
# Mixture distribution
# ---------------------------------------------------------------------------

@dataclass
class MixtureDist:
    """(1-p)·N(mu, s) + p·N(mu - depth, sqrt(s² + depth_s²)), floored."""
    mu: float
    sigma: float
    p_trunc: float
    depth: float
    depth_sigma: float
    floor: float

    def cdf(self, x: float) -> float:
        if x < self.floor:
            return 0.0
        c1 = _phi((x - self.mu) / self.sigma)
        s2 = math.sqrt(self.sigma ** 2 + self.depth_sigma ** 2)
        c2 = _phi((x - (self.mu - self.depth)) / s2)
        return (1 - self.p_trunc) * c1 + self.p_trunc * c2

    def quantile(self, p: float) -> float:
        lo, hi = self.floor, self.mu + 8 * self.sigma
        if self.cdf(lo) >= p:
            return lo
        for _ in range(60):
            mid = 0.5 * (lo + hi)
            if self.cdf(mid) < p:
                lo = mid
            else:
                hi = mid
        return 0.5 * (lo + hi)

    def mean(self) -> float:
        # Mean of the FLOORED mixture, E[max(X, floor)] — closed form per normal
        # component: f + (m-f)*Phi(z) + s*phi(z), z=(m-f)/s. The old shortcut
        # (mu - p*depth) ignored the floor, so a hot convective day could report
        # a "high" BELOW the already-observed max (KMDW 2026-07-10).
        def comp(m: float, s: float) -> float:
            if s <= 0:
                return max(m, self.floor)
            z = (m - self.floor) / s
            pdf = math.exp(-0.5 * z * z) / math.sqrt(2 * math.pi)
            return self.floor + (m - self.floor) * _phi(z) + s * pdf
        s2 = math.sqrt(self.sigma ** 2 + self.depth_sigma ** 2)
        return ((1 - self.p_trunc) * comp(self.mu, self.sigma)
                + self.p_trunc * comp(self.mu - self.depth, s2))

    def bin_probs(self, bins: Sequence[tuple[str, float, float]]) -> dict[str, float]:
        out = {}
        for label, lo, hi in bins:
            a = -math.inf if math.isinf(lo) else lo - 0.5
            b = math.inf if math.isinf(hi) else hi + 0.5
            pa = 0.0 if math.isinf(a) else self.cdf(a)
            pb = 1.0 if math.isinf(b) else self.cdf(b)
            out[label] = max(0.0, pb - pa)
        s = sum(out.values())
        return {k: v / s for k, v in out.items()} if s else out


# ---------------------------------------------------------------------------
# Market prior (piece 5)
# ---------------------------------------------------------------------------

def market_point(book_cents: dict[str, float]) -> float:
    total, acc = 0.0, 0.0
    for lbl, cents in book_cents.items():
        p = cents / 100.0
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


def interpret_divergence(model_pt: float, mkt_pt: float) -> str:
    d = model_pt - mkt_pt
    if abs(d) < 1.0:
        return "≈ agreement — market fair per model, edge (if any) is in tails"
    side = "hotter" if d > 0 else "colder"
    return (f"⚠ model {d:+.1f}°F {side} than market. The crowd trades NBM/AFD; "
            f"divergence means guidance and obs disagree — identify WHICH "
            f"scenario guidance is pricing (marine shift / convection / cloud) "
            f"before sizing, and prefer owning the corridor between the two "
            f"modes over shorting the market's mode.")


# ---------------------------------------------------------------------------
# Prediction
# ---------------------------------------------------------------------------

@dataclass
class CardV2:
    station: str
    asof: datetime
    dist: MixtureDist
    components: dict
    analog_audit: list
    bin_probs: dict = field(default_factory=dict)
    market_pt: Optional[float] = None
    divergence_note: str = ""

    def render(self) -> str:
        d = self.dist
        lines = [
            f"CLAUDE analog v2  •  {self.station}  •  {self.asof:%-I:%M %p}",
            f"  HIGH (mixture mean) {d.mean():.1f}°F   "
            f"(full-ramp mode {d.mu:.1f}, p_trunc {d.p_trunc:.0%}, depth {d.depth:.1f})",
            f"  68% CI [{d.quantile(0.16):.1f}, {d.quantile(0.84):.1f}]   "
            f"95% CI [{d.quantile(0.025):.1f}, {d.quantile(0.975):.1f}]",
            "  components:",
        ]
        for k, v in self.components.items():
            lines.append(f"    {k:<14}{v:+.2f}" if isinstance(v, float) else f"    {k:<14}{v}")
        if self.bin_probs:
            lines.append("  bins:")
            for lbl, p in self.bin_probs.items():
                lines.append(f"    {lbl:<14}{100*p:5.1f}%")
        if self.market_pt is not None:
            lines.append(f"  market-implied point: {self.market_pt:.1f}°F")
            lines.append(f"  {self.divergence_note}")
        return "\n".join(lines)


def predict(
    snap: ObsSnapshot,
    cfg: Optional[StationConfig] = None,
    kalshi_bins: Optional[Sequence[tuple[str, float, float]]] = None,
    market_book_cents: Optional[dict[str, float]] = None,
) -> CardV2:
    cfg = cfg or get_config(snap.station)

    ramp, analog_td, audit = analog_ensemble(snap, cfg)
    a_bowen = bowen(snap, analog_td, cfg)
    a_traj = trajectory(snap, cfg)
    a_air = airmass(snap, cfg)
    a_sky = insolation(snap, cfg)
    p_tr, depth = truncation(snap, cfg)

    mu = snap.now.temp_f + ramp + a_bowen + a_traj + a_air + a_sky
    mu = max(mu, snap.max_so_far_f)

    h = snap.now.ts.hour + snap.now.ts.minute / 60.0
    if h <= cfg.morning_hour:
        sigma = cfg.sigma_open
    elif h >= cfg.peak_hour:
        sigma = cfg.sigma_peak
    else:
        f = (h - cfg.morning_hour) / (cfg.peak_hour - cfg.morning_hour)
        sigma = cfg.sigma_open + f * (cfg.sigma_peak - cfg.sigma_open)

    dist = MixtureDist(mu=mu, sigma=sigma, p_trunc=p_tr, depth=depth,
                       depth_sigma=cfg.conv_depth_sigma, floor=snap.max_so_far_f)

    card = CardV2(
        station=snap.station, asof=snap.now.ts, dist=dist,
        components={"T_now": snap.now.temp_f, "R_analog(ens)": ramp,
                    "A_bowen": a_bowen, "A_trajectory": a_traj,
                    "A_airmass": a_air, "A_sky": a_sky},
        analog_audit=audit,
    )
    if kalshi_bins:
        card.bin_probs = dist.bin_probs(kalshi_bins)
    if market_book_cents:
        card.market_pt = market_point(market_book_cents)
        card.divergence_note = interpret_divergence(dist.mean(), card.market_pt)
    return card


# ---------------------------------------------------------------------------
# Checkpoint policy (piece 7)
# ---------------------------------------------------------------------------

def checkpoint(prev: ObsSnapshot, now: ObsSnapshot,
               cfg: Optional[StationConfig] = None,
               expected_hourly_rise: float = 3.0) -> dict:
    """
    Compare consecutive decision-hour snapshots; emit signals and a stance.
    Signals mirror the session's branch logic: ramp vs expectation, wind
    veering into the cool sector, Td trajectory, sky thickening.
    """
    cfg = cfg or get_config(now.station)
    sig: dict = {"signals": [], "stance": "hold"}
    rise = now.now.temp_f - prev.now.temp_f
    sig["hourly_rise"] = rise

    if rise >= expected_hourly_rise:
        sig["signals"].append(f"ramp nominal-to-hot (+{rise:.0f})")
    elif rise >= expected_hourly_rise - 2:
        sig["signals"].append(f"ramp soft (+{rise:.0f})")
    else:
        sig["signals"].append(f"ramp stalled (+{rise:.0f}) — investigate wind/sky")
        sig["stance"] = "downgrade"

    if cfg.regime == "sea_breeze":
        if _in_sector(now.now.wind_dir_deg, MARINE_SECTORS.get(now.station, [])):
            sig["signals"].append("wind veered MARINE — cap engaged")
            sig["stance"] = "exit_upper_bins"
    if cfg.regime == "marine_baseline":
        was_off = _in_sector(prev.now.wind_dir_deg, OFFSHORE_SECTORS.get(now.station, []))
        now_off = _in_sector(now.now.wind_dir_deg, OFFSHORE_SECTORS.get(now.station, []))
        if was_off and not now_off:
            sig["signals"].append("onshore arrival — plateau begins, max ≈ current + 1-2")
            sig["stance"] = "settle_mode_bin"
        elif now_off:
            sig["signals"].append("offshore persisting — each hour ≈ +1°F on max; press upper bins")
            sig["stance"] = "press_upper_bins"

    if (now.now.dewpoint_f is not None and prev.now.dewpoint_f is not None):
        dtd = now.now.dewpoint_f - prev.now.dewpoint_f
        if dtd >= 2:
            sig["signals"].append(f"Td climbing ({dtd:+.0f}) — moisture transport, cu/convection risk up")
        elif dtd <= -3 and cfg.regime == "continental":
            sig["signals"].append(f"Td mixing out ({dtd:+.0f}) — deep-BL dilution on schedule, hot path intact")

    d_sky = (sky_deficit(now.now.sky, cfg.sky_ceiling_x100ft)
             - sky_deficit(prev.now.sky, cfg.sky_ceiling_x100ft))
    if d_sky > 0.15:
        sig["signals"].append("sky thickening — insolation tax rising")
        if sig["stance"] == "hold":
            sig["stance"] = "downgrade"
    return sig


# ---------------------------------------------------------------------------
# Replay today's three decision points
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from datetime import datetime as dt

    # ---- KNYC 9:51 AM --------------------------------------------------
    nyc = ObsSnapshot(
        station="KNYC",
        now=HourlyOb(dt(2026, 7, 9, 9, 51), 79, 70, 225, 5, 1013.6, "CLR"),
        max_so_far_f=79,
        analogs=[AnalogDay(
            hourlies=[HourlyOb(dt(2026, 7, 8, 9, 51), 73, 63, None, 0, 1017.5, "CLR")],
            max_f=85)],
        slp_24h_ago_mb=1017.5,
    )
    nyc_bins = [("<=82", -math.inf, 82), ("83-84", 83, 84), ("85-86", 85, 86),
                ("87-88", 87, 88), ("89-90", 89, 90), (">=91", 91, math.inf)]
    nyc_book = {"<=82": 22, "83-84": 59, "85-86": 28, "87-88": 3, "89-90": 1, ">=91": 1}
    print(predict(nyc, kalshi_bins=nyc_bins, market_book_cents=nyc_book).render())

    # ---- KLAX 6:53 AM ---------------------------------------------------
    lax = ObsSnapshot(
        station="KLAX",
        now=HourlyOb(dt(2026, 7, 9, 6, 53), 66, 62, 90, 3, 1011.5, "FEW009 FEW015"),
        max_so_far_f=66,
        analogs=[
            AnalogDay([HourlyOb(dt(2026, 7, 8, 6, 53), 66, 60, None, 0, 1014.5, "CLR")], 74),
            AnalogDay([HourlyOb(dt(2026, 7, 7, 6, 53), 65, 61, 248, 3, 1013.5,
                                "FEW009 FEW012 SCT029")], 74),
        ],
        slp_24h_ago_mb=1014.5,
    )
    lax_bins = [("<=72", -math.inf, 72), ("73-74", 73, 74), ("75-76", 75, 76),
                ("77-78", 77, 78), ("79-80", 79, 80), (">=81", 81, math.inf)]
    lax_book = {"<=72": 1, "73-74": 23, "75-76": 51, "77-78": 25, "79-80": 4, ">=81": 4}
    print()
    print(predict(lax, kalshi_bins=lax_bins, market_book_cents=lax_book).render())

    # ---- KDEN 7:53 AM ---------------------------------------------------
    den = ObsSnapshot(
        station="KDEN",
        now=HourlyOb(dt(2026, 7, 9, 7, 53), 66, 56, 157, 5, 1011.4,
                     "FEW100 SCT120 SCT150"),
        max_so_far_f=66,
        analogs=[
            AnalogDay([HourlyOb(dt(2026, 7, 8, 7, 53), 74, 49, None, 0, 1013.4,
                                "SCT090 BKN150 BKN220")], 94),
            AnalogDay([HourlyOb(dt(2026, 7, 7, 7, 53), 70, 48, 225, 9, 1012.8,
                                "FEW220")], 97),
        ],
        slp_24h_ago_mb=1013.4,
    )
    den_bins = [("<=83", -math.inf, 83), ("84-85", 84, 85), ("86-87", 86, 87),
                ("88-89", 88, 89), ("90-91", 90, 91), (">=92", 92, math.inf)]
    den_book = {"<=83": 3, "84-85": 3, "86-87": 14, "88-89": 24, "90-91": 44, ">=92": 21}
    print()
    print(predict(den, kalshi_bins=den_bins, market_book_cents=den_book).render())
