"""Recency-weighted regression, peak bias, and official KNYC blending."""
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from interpolatornyc.core import (
    PWS_STATIONS,
    align_knyc_obs,
    enrich_knyc_precise_temps,
    fetch_knyc_hourly,
    fetch_pws_hourly_range,
    merge_knyc_pws_periods,
    station_weights,
)

RECENCY_HALF_LIFE_H = 12.0  # recent 12h weighted ~2x vs 24h ago
PEAK_TEMP_THRESHOLD_F = 90.0
OFFICIAL_BLEND_WEIGHT = 0.30
PEAK_BIAS_BLEND = 0.65  # how much of learned peak bias to apply under hot conditions


def recency_weights(hours: pd.Series, now: datetime) -> np.ndarray:
    age_h = (now - hours).dt.total_seconds() / 3600.0
    age_h = age_h.clip(lower=0)
    return np.exp(-age_h / RECENCY_HALF_LIFE_H)


def weighted_polyfit(x, y, w):
    w = np.asarray(w, dtype=float)
    w = w / w.sum()
    x, y = np.asarray(x, float), np.asarray(y, float)
    # Weighted least squares for y = slope*x + intercept
    wsum = w.sum()
    xbar = np.sum(w * x) / wsum
    ybar = np.sum(w * y) / wsum
    cov = np.sum(w * (x - xbar) * (y - ybar))
    var = np.sum(w * (x - xbar) ** 2)
    if var < 1e-9:
        return 0.0, ybar
    slope = cov / var
    intercept = ybar - slope * xbar
    return slope, intercept


def compute_station_stats(merged, station, now):
    """Recency-weighted PWS -> KNYC regression for one station."""
    sub = merged.dropna(subset=["knyc_temp", "proxy_temp"])
    sub = sub[sub["station"] == station].copy()
    if len(sub) < 6:
        return None
    w = recency_weights(sub["hour"], now)
    x = sub["proxy_temp"].values
    y = sub["knyc_temp"].values
    slope, intercept = weighted_polyfit(x, y, w)
    yhat = slope * x + intercept
    rmse = np.sqrt(np.sum(w * (y - yhat) ** 2) / w.sum())
    r = np.corrcoef(x, y)[0, 1] if len(x) > 1 else 0.0
    bias = np.average(y - x, weights=w)
    return {
        "station": station,
        "n": len(sub),
        "r": r,
        "bias": bias,
        "slope": slope,
        "intercept": intercept,
        "rmse": rmse,
    }


def fit_all_station_stats(merged, stations, now):
    stats = [compute_station_stats(merged, s, now) for s in stations]
    df = pd.DataFrame([s for s in stats if s])
    return df.sort_values("r", ascending=False) if not df.empty else df


def fit_peak_bias(merged, stats_df, now):
    """
    Learn extra °F to add when PWS reads hot (captures 100°F vs ~98°F undercount).
    Uses recency-weighted residuals on warm hours (KNYC >= 90°F).
    """
    if stats_df.empty:
        return 0.0

    rows = []
    for station in PWS_STATIONS:
        st = stats_df[stats_df["station"] == station]
        if st.empty:
            continue
        st = st.iloc[0]
        sub = merged[(merged["station"] == station) & (merged["knyc_temp"] >= PEAK_TEMP_THRESHOLD_F)]
        if sub.empty:
            continue
        for _, r in sub.iterrows():
            pred = st["slope"] * r["proxy_temp"] + st["intercept"]
            rows.append(
                {
                    "hour": r["hour"],
                    "residual": r["knyc_temp"] - pred,
                    "knyc": r["knyc_temp"],
                }
            )

    if not rows:
        return 0.0

    rdf = pd.DataFrame(rows).groupby("hour", as_index=False).agg(
        residual=("residual", "mean"),
        knyc=("knyc", "first"),
    )
    w = recency_weights(rdf["hour"], now)
    bias = np.average(rdf["residual"], weights=w)
    # Only apply positive warm-bias (undercount correction), cap at 3°F
    return float(np.clip(max(bias, 0.0), 0.0, 3.0))


def peak_bias_factor(proxy_temp_f: float) -> float:
    """Ramp peak bias in as PWS temps approach heat-wave levels."""
    if proxy_temp_f < PEAK_TEMP_THRESHOLD_F - 5:
        return 0.0
    t = (proxy_temp_f - (PEAK_TEMP_THRESHOLD_F - 5)) / 10.0
    return float(np.clip(t, 0.0, 1.0))


def apply_peak_bias(estimate: float, proxy_temp_f: float, peak_bias: float) -> float:
    return estimate + peak_bias * peak_bias_factor(proxy_temp_f) * PEAK_BIAS_BLEND


def estimate_from_pws(stats_df, peak_bias, station, proxy_temp_f):
    row = stats_df[stats_df["station"] == station]
    if row.empty:
        return None
    row = row.iloc[0]
    est = row["slope"] * proxy_temp_f + row["intercept"]
    return apply_peak_bias(est, proxy_temp_f, peak_bias)


def build_merged_pws_calibration(now):
    """Fetch KNYC + PWS hourly highs and merge by preceding-hour window."""
    start = now - timedelta(hours=48)
    knyc = enrich_knyc_precise_temps(fetch_knyc_hourly(start, now))
    knyc_aligned = align_knyc_obs(knyc)

    pws_frames = []
    for stn_id in PWS_STATIONS:
        df = fetch_pws_hourly_range(stn_id, start.date(), now.date(), field="tempHigh")
        if not df.empty:
            pws_frames.append(df)
    if not pws_frames:
        return None, None, None

    pws_all = pd.concat(pws_frames, ignore_index=True)
    merged = merge_knyc_pws_periods(knyc, pws_all)
    merged = merged[merged["hour"] >= start]
    knyc_aligned = knyc_aligned[knyc_aligned["hour"] >= start]
    proxy_aligned = merged[["hour", "station", "proxy_temp"]].copy()
    return merged, knyc_aligned, proxy_aligned


def get_official_latest(knyc_aligned, now):
    """Most recent official KNYC hourly temp."""
    if knyc_aligned is None or knyc_aligned.empty:
        return None
    row = knyc_aligned.sort_values("hour").iloc[-1]
    return {"hour": row["hour"], "temp_f": row["knyc_temp"]}


def blend_now_estimate(
    pws_weighted: float,
    official_latest: dict | None,
    delta_nowcast: float | None,
    now: datetime,
) -> float:
    """
    Blend PWS regression with official KNYC anchor.
    - Official anchor weighted 30% if obs within last 2 hours
    - Delta nowcast 35% if available
    - PWS weighted gets remainder
    """
    parts, weights = [], []

    parts.append(pws_weighted)
    weights.append(1.0)

    if delta_nowcast is not None:
        parts.append(delta_nowcast)
        weights.append(0.85)

    if official_latest is not None:
        age_h = (now - official_latest["hour"]).total_seconds() / 3600.0
        if age_h <= 2.0:
            parts.append(official_latest["temp_f"])
            weights.append(1.2 if age_h <= 1.0 else 0.7)

    w = np.array(weights, dtype=float)
    w /= w.sum()
    return float(np.dot(parts, w))


def calibrate(now, stations=None):
    """Full calibration bundle used by now/peak/full."""
    stations = stations or list(PWS_STATIONS.keys())
    merged, knyc_aligned, proxy_aligned = build_merged_pws_calibration(now)
    if merged is None or merged.empty:
        return None

    stats_df = fit_all_station_stats(merged, stations, now)
    peak_bias = fit_peak_bias(merged, stats_df, now)
    official_latest = get_official_latest(knyc_aligned, now)

    return {
        "merged": merged,
        "knyc_aligned": knyc_aligned,
        "proxy_aligned": proxy_aligned,
        "stats_df": stats_df,
        "peak_bias": peak_bias,
        "official_latest": official_latest,
    }