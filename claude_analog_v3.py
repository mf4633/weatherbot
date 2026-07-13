"""
claude_analog_v3.py — the 2026-07-09 KNYC post-mortem, encoded
================================================================

Extends v2 (imported, not duplicated). Four changes, each traceable to a
specific failure this day:

  L1  UPSTREAM ADVECTION TERM
      Failure: the warm-advection cloud shield (SCT028 SCT039 OVC110 at
      11:51) arrived from upstream and killed the ramp; A_sky evaluated at
      the station saw CLR all morning. Guidance (and thus the market) had
      it; the obs-anchored model structurally could not.
      Fix: each station gets UPSTREAM_STATIONS — ASOS neighbors 1–3 hours
      of advection upwind. Their *current* sky deficit, weighted by lead
      time and steering-flow plausibility, becomes an incoming-insolation
      penalty and a variance inflator. Not satellite, but the same 80% of
      the signal from data the pipeline already fetches.

  L2  INFORMED-MARKET DIVERGENCE
      Failure: model-vs-market divergence was interpreted all day as "the
      crowd is slow / trading stale guidance." The crowd was right; the
      guidance knew about the shield. Divergence must budget for "they
      know something" — asymmetrically, since the market has strictly more
      inputs (NBM/HRRR/satellite) than this model.
      Fix: optional posterior tilt — mean shifts toward the market-implied
      point by a weight that grows with |divergence|, and sigma inflates
      with residual disagreement. Off by default for the ledger (the pure
      model must be scored pure); ON for anything feeding sizing.

  L3  PEAK-LOCK DETECTION
      Failure: at ~13:00 the trace was FALLING (81.9 → 79.4) under overcast
      and the day's max was physically locked at the morning value — but
      nothing in the model could declare it. Bins stayed "live" in the
      output long after they were dead.
      Fix: checkpoint() detects a falling trace after late morning under
      heavy sky / marine shift / precip and returns peak_locked=True; the
      distribution collapses to max_so_far ± rounding.

  L4  ADVECTION-REGIME GUARD
      Failure: the analog ensemble used pre-shield days (CLR ramps) to
      forecast a shield day. Analogs are only valid within-regime.
      Fix: a warm-advection score (falling SLP + rising Td + upstream/local
      mid-cloud). High score caps the analog ramp's contribution and
      inflates sigma — the model KNOWS it is out of regime and says so.

Stdlib only. Requires claude_analog_v2.py alongside.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Sequence

# TIMEZONE CONTRACT (read before porting): every HourlyOb.ts here is treated as
# NAIVE LOCAL time — the hour thresholds (peak-lock's "11 LT", the sigma schedule)
# compare ts.hour directly. Production is JS and its timestamps are UTC, so the JS
# port MUST convert to the station's IANA tz first (see localHourFrac in
# claude_analog_v3.js). Ignoring this is exactly what caused the 2026-07-09
# dawn-false-lock bug. These .py files are the reference/derivation only; the live
# engine is the JS.

from claude_analog_v2 import (
    AnalogDay, CardV2, HourlyOb, MixtureDist, ObsSnapshot, StationConfig,
    STATION_CONFIGS, MARINE_SECTORS, OFFSHORE_SECTORS,
    airmass, analog_ensemble, bowen, get_config, insolation, interpret_divergence,
    market_point, sky_deficit, trajectory, truncation, _in_sector, _logistic,
)

# ---------------------------------------------------------------------------
# L1: upstream stations — ASOS neighbors ~1–3 h of advection upwind for the
# climatologically dominant warm-sector steering flow (W/SW for the east,
# etc.). lead_h is a rough advection time at ~25 kt mid-level steering.
# ---------------------------------------------------------------------------

@dataclass
class Upstream:
    station: str
    lead_h: float          # hours of advection lead this station provides
    bearing_from: int      # direction the flow comes FROM for this pairing


UPSTREAM_STATIONS: dict[str, list[Upstream]] = {
    "KNYC": [Upstream("KPHL", 1.0, 240), Upstream("KABE", 1.5, 260),
             Upstream("KAVP", 2.0, 280), Upstream("KBWI", 2.5, 230)],
    "KBOS": [Upstream("KBDL", 1.0, 250), Upstream("KALB", 2.0, 280),
             Upstream("KPOU", 1.5, 260)],
    "KPHL": [Upstream("KBWI", 1.0, 230), Upstream("KMDT", 1.5, 290),
             Upstream("KIAD", 1.5, 240)],
    "KDCA": [Upstream("KCHO", 1.5, 230), Upstream("KIAD", 0.5, 280),
             Upstream("KMRB", 1.5, 290)],
    "KMDW": [Upstream("KRFD", 1.5, 280), Upstream("KDVN", 2.5, 260),
             Upstream("KJOT", 0.75, 240)],
    "KDEN": [Upstream("KAPA", 0.5, 200), Upstream("KCOS", 1.5, 190),
             Upstream("KBJC", 0.5, 270)],   # Palmer Divide + foothills initiation
    "KDFW": [Upstream("KACT", 1.5, 190), Upstream("KSPS", 2.0, 290),
             Upstream("KMWL", 1.0, 260)],
    "KATL": [Upstream("KCSG", 1.5, 220), Upstream("KBHM", 2.5, 270),
             Upstream("KRMG", 1.0, 300)],
    "KMSP": [Upstream("KSTC", 1.0, 290), Upstream("KRWF", 1.5, 240),
             Upstream("KEAU", 1.5, 90)],
    "KOKC": [Upstream("KLAW", 1.0, 210), Upstream("KCDS", 2.5, 260),
             Upstream("KWWR", 2.0, 290)],
    "KHOU": [Upstream("KCXO", 1.0, 340), Upstream("KVCT", 1.5, 230)],
    "KMIA": [Upstream("KFLL", 0.4, 20), Upstream("KTMB", 0.3, 200),
             Upstream("KAPF", 1.5, 260)],   # Gulf-side storms crossing
    "KMSY": [Upstream("KBTR", 1.0, 290), Upstream("KASD", 0.5, 60)],
    # marine_baseline stations skip L1: their cloud is locally generated
    # stratus, not advected — upstream sky is uninformative.
}

# Bearing tolerance: upstream ob only counts if the CURRENT steering proxy
# (surface wind, or its recent mean) is within this many degrees of the
# pairing's bearing_from. Loose on purpose — surface wind is a weak proxy.
BEARING_TOL = 70.0
K_UPSTREAM = 3.5           # °F penalty at full upstream low/mid overcast
UPSTREAM_SIGMA_INFL = 1.6  # max multiplicative sigma inflation from L1


def upstream_advection(
    station: str,
    upstream_obs: dict[str, HourlyOb],   # {upstream_station: its current ob}
    steering_dir_deg: Optional[int],
    cfg: StationConfig,
) -> tuple[float, float, list[dict]]:
    """
    Returns (temp_penalty, sigma_multiplier, audit).
    Penalty phases in with 1/lead (nearer upstream cloud = more certain,
    sooner impact); off-bearing stations are discounted, not zeroed.
    """
    pairs = UPSTREAM_STATIONS.get(station, [])
    if not pairs or cfg.regime == "marine_baseline":
        return 0.0, 1.0, []
    audit, wsum, acc = [], 0.0, 0.0
    for up in pairs:
        ob = upstream_obs.get(up.station)
        if ob is None:
            continue
        deficit = sky_deficit(ob.sky, cfg.sky_ceiling_x100ft)
        # widen the ceiling: mid/high advected decks matter here even above
        # the local convective ceiling — recompute with a higher cut
        deficit = max(deficit, 0.7 * sky_deficit(ob.sky, 250))
        if steering_dir_deg is not None:
            miss = abs((steering_dir_deg - up.bearing_from + 180) % 360 - 180)
            bear_w = max(0.25, 1.0 - miss / (2 * BEARING_TOL))
        else:
            bear_w = 0.6
        w = bear_w / max(up.lead_h, 0.3)
        audit.append({"station": up.station, "deficit": round(deficit, 2),
                      "lead_h": up.lead_h, "weight": round(w, 2)})
        wsum += w
        acc += w * deficit
    if wsum == 0:
        return 0.0, 1.0, audit
    incoming = acc / wsum
    penalty = -K_UPSTREAM * incoming
    sigma_mult = 1.0 + (UPSTREAM_SIGMA_INFL - 1.0) * incoming
    return penalty, sigma_mult, audit


# ---------------------------------------------------------------------------
# L4: warm-advection regime score — is today even the analogs' regime?
# ---------------------------------------------------------------------------

def advection_regime_score(
    snap: ObsSnapshot,
    upstream_incoming: float,     # weighted upstream deficit from L1 (0..1)
    analog_td: float,
) -> float:
    """0 (in-regime) .. 1 (strong warm advection; analogs unreliable)."""
    s = 0.0
    if snap.slp_24h_ago_mb is not None and snap.now.slp_mb is not None:
        fall = snap.slp_24h_ago_mb - snap.now.slp_mb
        s += min(0.4, max(0.0, fall / 8.0))            # 8 mb fall saturates
    if snap.now.dewpoint_f is not None:
        td_rise = snap.now.dewpoint_f - analog_td
        s += min(0.3, max(0.0, td_rise / 15.0))
    s += 0.3 * upstream_incoming
    return min(1.0, s)


RAMP_CAP_AT_FULL_ADVECTION = 0.55   # analog ramp credited at most this
ADVECTION_SIGMA_INFL = 1.5          # additional sigma inflation at score=1


# ---------------------------------------------------------------------------
# L2: informed-market tilt
# ---------------------------------------------------------------------------

def informed_market_tilt(model_mu: float, mkt_pt: float,
                         enabled: bool) -> tuple[float, float, str]:
    """
    Returns (tilted_mu, extra_sigma, note).
    Weight toward market grows with divergence: w = |d| / (|d| + 3).
    At d=3°F the posterior sits halfway; at d=6°F it's 2/3 market. The
    residual disagreement (what the tilt does NOT close) becomes added-in-
    quadrature sigma — big unresolved divergence = admit you don't know.
    """
    d = model_mu - mkt_pt
    if not enabled:
        return model_mu, 0.0, (
            f"pure model (tilt off); divergence {d:+.1f}°F vs market — "
            f"remember 2026-07-09: ask 'what do they know' before 'why are they slow'")
    w = abs(d) / (abs(d) + 3.0)
    mu = (1 - w) * model_mu + w * mkt_pt
    extra_sigma = 0.5 * abs(d) * (1 - w)
    return mu, extra_sigma, (
        f"informed-market tilt: {w:.0%} toward market ({model_mu:.1f} → {mu:.1f}), "
        f"+{extra_sigma:.1f}°F sigma for residual disagreement")


# ---------------------------------------------------------------------------
# L3: peak-lock detection
# ---------------------------------------------------------------------------

def detect_peak_lock(
    snap_prev: Optional[ObsSnapshot],
    snap_now: ObsSnapshot,
    cfg: Optional[StationConfig] = None,
) -> tuple[bool, str]:
    """
    True when the day's max is physically behind us:
      trace falling >=1.5°F below the running max, after 11 LT, AND at
      least one capping mechanism visibly engaged (heavy low/mid sky,
      marine-sector wind, or precip implied by sky+fall rate).
    Conservative on purpose: a false lock is worse than a late one.
    """
    cfg = cfg or get_config(snap_now.station)
    h = snap_now.now.ts.hour + snap_now.now.ts.minute / 60.0
    if h < 11.0:
        return False, "too early to lock"
    drop = snap_now.max_so_far_f - snap_now.now.temp_f
    if drop < 1.5:
        return False, f"trace only {drop:.1f}°F off the max"
    falling = True
    if snap_prev is not None:
        falling = snap_now.now.temp_f < snap_prev.now.temp_f - 0.4
    if not falling:
        return False, "off the max but not actively falling"
    deck = sky_deficit(snap_now.now.sky, 250)
    marine = _in_sector(snap_now.now.wind_dir_deg,
                        MARINE_SECTORS.get(snap_now.station, []))
    if deck >= 0.5 or marine:
        why = "overcast deck" if deck >= 0.5 else "marine air at sensor"
        return True, (f"PEAK LOCKED at {snap_now.max_so_far_f:.0f}°F — trace "
                      f"falling ({drop:.1f}°F off max) after 11 LT under {why}; "
                      f"insolation cannot recover the deficit")
    return False, "falling but no visible cap — could be transient (outflow)"


def locked_distribution(max_so_far: float) -> MixtureDist:
    """Rounding/5-min-record uncertainty PLUS a lock-failure tail. First 68
    settled locked decisions (2026-07-10/11): truth - floor was {0: 38, +1: 23,
    +2: 5, +6: 1, +9: 1} - never negative, mean +0.71, 10% of locks failed by
    >=2F (re-warming after a transient dip). The 12% component at floor+2.55
    (sigma 1.79) reproduces that: P(floor) 0.55, P(+1) 0.35, P(>=+2) 0.10."""
    return MixtureDist(mu=max_so_far + 0.35, sigma=0.55, p_trunc=0.12,
                       depth=-2.2, depth_sigma=1.7, floor=max_so_far)


# ---------------------------------------------------------------------------
# v3 predict
# ---------------------------------------------------------------------------

@dataclass
class CardV3(CardV2):
    upstream_audit: list = field(default_factory=list)
    advection_score: float = 0.0
    peak_locked: bool = False
    lock_note: str = ""
    tilt_note: str = ""

    def render(self) -> str:
        base = super().render().replace("analog v2", "analog v3")
        extra = []
        if self.peak_locked:
            extra.append(f"  ** {self.lock_note}")
        if self.advection_score > 0.25:
            extra.append(f"  advection regime score {self.advection_score:.2f} — "
                         f"analog ramp capped, sigma inflated (out-of-regime guard)")
        if self.upstream_audit:
            ups = ", ".join(f"{a['station']}:{a['deficit']:.2f}" for a in self.upstream_audit)
            extra.append(f"  upstream sky: {ups}")
        if self.tilt_note:
            extra.append(f"  {self.tilt_note}")
        return base + ("\n" + "\n".join(extra) if extra else "")


def predict_v3(
    snap: ObsSnapshot,
    cfg: Optional[StationConfig] = None,
    kalshi_bins: Optional[Sequence[tuple[str, float, float]]] = None,
    market_book_cents: Optional[dict[str, float]] = None,
    upstream_obs: Optional[dict[str, HourlyOb]] = None,
    snap_prev: Optional[ObsSnapshot] = None,
    market_tilt: bool = False,
) -> CardV3:
    cfg = cfg or get_config(snap.station)
    upstream_obs = upstream_obs or {}

    # L3 first: a locked day short-circuits everything.
    locked, lock_note = detect_peak_lock(snap_prev, snap, cfg)
    if locked:
        dist = locked_distribution(snap.max_so_far_f)
        card = CardV3(station=snap.station, asof=snap.now.ts, dist=dist,
                      components={"max_so_far": snap.max_so_far_f},
                      analog_audit=[], peak_locked=True, lock_note=lock_note)
        if kalshi_bins:
            card.bin_probs = dist.bin_probs(kalshi_bins)
        if market_book_cents:
            card.market_pt = market_point(market_book_cents)
            card.divergence_note = interpret_divergence(dist.mean(), card.market_pt)
        return card

    # v2 terms
    ramp, analog_td, audit = analog_ensemble(snap, cfg)
    a_bowen = bowen(snap, analog_td, cfg)
    a_traj = trajectory(snap, cfg)
    a_air = airmass(snap, cfg)
    a_sky = insolation(snap, cfg)
    p_tr, depth = truncation(snap, cfg)

    # L1
    a_up, up_sigma_mult, up_audit = upstream_advection(
        snap.station, upstream_obs, snap.now.wind_dir_deg, cfg)
    incoming = -a_up / K_UPSTREAM if K_UPSTREAM else 0.0

    # L4
    adv = advection_regime_score(snap, incoming, analog_td)
    ramp_credit = 1.0 - adv * (1.0 - RAMP_CAP_AT_FULL_ADVECTION)
    ramp_eff = ramp * ramp_credit

    mu = snap.now.temp_f + ramp_eff + a_bowen + a_traj + a_air + a_sky + a_up
    mu = max(mu, snap.max_so_far_f)

    h = snap.now.ts.hour + snap.now.ts.minute / 60.0
    if h <= cfg.morning_hour:
        sigma = cfg.sigma_open
    elif h >= cfg.peak_hour:
        sigma = cfg.sigma_peak
    else:
        f = (h - cfg.morning_hour) / (cfg.peak_hour - cfg.morning_hour)
        sigma = cfg.sigma_open + f * (cfg.sigma_peak - cfg.sigma_open)
    sigma *= up_sigma_mult * (1.0 + (ADVECTION_SIGMA_INFL - 1.0) * adv)

    # L2 (post-hoc on the mean; sigma addition in quadrature)
    tilt_note, extra_sigma = "", 0.0
    mkt_pt = market_point(market_book_cents) if market_book_cents else None
    if mkt_pt is not None:
        mu, extra_sigma, tilt_note = informed_market_tilt(mu, mkt_pt, market_tilt)
        mu = max(mu, snap.max_so_far_f)
    sigma = math.sqrt(sigma ** 2 + extra_sigma ** 2)

    dist = MixtureDist(mu=mu, sigma=sigma, p_trunc=p_tr, depth=depth,
                       depth_sigma=cfg.conv_depth_sigma, floor=snap.max_so_far_f)
    card = CardV3(
        station=snap.station, asof=snap.now.ts, dist=dist,
        components={"T_now": snap.now.temp_f,
                    "R_analog(eff)": ramp_eff, "R_analog(raw)": ramp,
                    "A_bowen": a_bowen, "A_trajectory": a_traj,
                    "A_airmass": a_air, "A_sky": a_sky, "A_upstream": a_up},
        analog_audit=audit, upstream_audit=up_audit,
        advection_score=adv, tilt_note=tilt_note,
    )
    if kalshi_bins:
        card.bin_probs = dist.bin_probs(kalshi_bins)
    if mkt_pt is not None:
        card.market_pt = mkt_pt
        card.divergence_note = interpret_divergence(dist.mean(), mkt_pt)
    return card


# ---------------------------------------------------------------------------
# Replay: would v3 have saved the 2026-07-09 KNYC morning?
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from datetime import datetime as dt

    nyc_bins = [("<=82", -math.inf, 82), ("83-84", 83, 84), ("85-86", 85, 86),
                ("87-88", 87, 88), ("89-90", 89, 90), (">=91", 91, math.inf)]
    nyc_book = {"<=82": 22, "83-84": 59, "85-86": 28, "87-88": 3, "89-90": 1, ">=91": 1}
    analogs = [AnalogDay(
        [HourlyOb(dt(2026, 7, 8, 9, 51), 73, 63, None, 0, 1017.5, "CLR")], 85)]

    # 9:51 with the information v2 had (no upstream) vs with upstream obs
    # showing the shield over eastern PA (what KABE/KAVP actually looked
    # like that morning as the warm-advection deck moved east).
    snap_951 = ObsSnapshot(
        station="KNYC",
        now=HourlyOb(dt(2026, 7, 9, 9, 51), 79, 70, 225, 5, 1013.6, "CLR"),
        max_so_far_f=79, analogs=analogs, slp_24h_ago_mb=1017.5)

    upstream = {
        "KPHL": HourlyOb(dt(2026, 7, 9, 9, 51), 78, 70, 230, 7, 1013.0,
                         "SCT035 BKN110"),
        "KABE": HourlyOb(dt(2026, 7, 9, 9, 51), 76, 69, 240, 6, 1012.6,
                         "BKN032 OVC100"),
        "KAVP": HourlyOb(dt(2026, 7, 9, 9, 51), 74, 68, 250, 8, 1012.4,
                         "OVC090"),
    }

    print("=== 9:51 AM, v3 WITHOUT upstream obs (v2-equivalent info) ===")
    print(predict_v3(snap_951, kalshi_bins=nyc_bins,
                     market_book_cents=nyc_book).render())
    print("\n=== 9:51 AM, v3 WITH upstream obs (L1+L4 active) ===")
    print(predict_v3(snap_951, kalshi_bins=nyc_bins, market_book_cents=nyc_book,
                     upstream_obs=upstream).render())
    print("\n=== same + informed-market tilt ON (L2, sizing view) ===")
    print(predict_v3(snap_951, kalshi_bins=nyc_bins, market_book_cents=nyc_book,
                     upstream_obs=upstream, market_tilt=True).render())

    # 1:00 PM: trace falling under the deck — L3 should lock.
    snap_1251 = ObsSnapshot(
        station="KNYC",
        now=HourlyOb(dt(2026, 7, 9, 12, 51), 81.9, 72, None, 4, 1012.4,
                     "SCT028 SCT039 OVC110"),
        max_so_far_f=82, analogs=analogs, slp_24h_ago_mb=1016.7)
    snap_1300 = ObsSnapshot(
        station="KNYC",
        now=HourlyOb(dt(2026, 7, 9, 13, 5), 79.4, 72, 170, 6, 1012.3,
                     "SCT028 BKN045 OVC100"),
        max_so_far_f=82, analogs=analogs, slp_24h_ago_mb=1016.6)
    print("\n=== 1:05 PM, trace falling (L3) ===")
    print(predict_v3(snap_1300, kalshi_bins=nyc_bins, market_book_cents=nyc_book,
                     snap_prev=snap_1251).render())
