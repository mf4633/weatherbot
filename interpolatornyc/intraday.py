"""Intra-hour peak detection: compare 5-min PWS + NWS obs vs hourly interpolation."""
import re
import urllib.request
from datetime import datetime

import numpy as np
import pandas as pd

from interpolatornyc.core import (
    API_KEY,
    PWS_STATIONS,
    TZ,
    UA,
    compute_station_stats,
    fetch_json,
    fetch_knyc_hourly,
    fetch_pws_hourly_range,
    format_hour_ending,
    station_weights,
    estimate_knyc_from_proxy,
)

NWS_UA = "weather-analysis"
# IEM station/tz for raw-METAR fetches; city clones patch these (e.g. "BOS")
IEM_STATION = "KNYC"
IEM_QUERY_TZ = "America/New_York"
# Flag when official or 5-min-derived peak exceeds hourly interpolation by this much
UNDERCOUNT_THRESHOLD_F = 1.0
# Momentum rule: last two official hourly deltas both >= this => still climbing, peak not in
MOMENTUM_DELTA_F = 1.0


def _fetch_iem_official_today(today):
    """Today's full official ob series from IEM ASOS — often ahead of NWS API for :51 METARs."""
    import urllib.error
    from datetime import timedelta

    start = datetime.combine(today, datetime.min.time())
    end = start + timedelta(days=1)
    url = (
        "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?"
        f"station=KNYC&data=tmpf&year1={start.year}&month1={start.month}&day1={start.day}"
        f"&hour1=0&year2={end.year}&month2={end.month}&day2={end.day}"
        f"&hour2=0&tz=America/New_York&format=onlycomma&latlon=no&elev=no"
        "&missing=M&trace=T&direct=no&report_type=3&report_type=4"
    )
    try:
        df = pd.read_csv(url)
    except urllib.error.HTTPError:
        return None
    if df.empty:
        return None
    df["valid"] = pd.to_datetime(df["valid"])
    df["tmpf"] = pd.to_numeric(df["tmpf"], errors="coerce")
    df = df[(df["valid"].dt.date == today) & df["tmpf"].notna()]
    if df.empty:
        return None
    return df[["valid", "tmpf"]].sort_values("valid")


def _fetch_iem_sixhr_today(today):
    """
    6-hr max temp groups parsed from IEM raw METARs (routine hourlies).
    NWS API rawMessage is unreliable (mostly empty), IEM serves the full
    METAR within minutes of the synoptic ob.
    """
    from datetime import timedelta

    start = datetime.combine(today, datetime.min.time())
    end = start + timedelta(days=1)
    url = (
        "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?"
        f"station={IEM_STATION}&data=metar&year1={start.year}&month1={start.month}&day1={start.day}"
        f"&hour1=0&year2={end.year}&month2={end.month}&day2={end.day}"
        f"&hour2=0&tz={IEM_QUERY_TZ}&format=onlycomma&latlon=no&elev=no"
        "&missing=M&trace=T&direct=no&report_type=3"
    )
    import time
    import urllib.error

    df = None
    for attempt in range(5):
        try:
            df = pd.read_csv(url)
            break
        except urllib.error.HTTPError as e:
            if attempt < 4 and e.code in (429, 503):
                time.sleep(5 * (attempt + 1))
                continue
            return None
        except Exception:
            return None
    if df is None:
        return None
    if df.empty or "metar" not in df.columns:
        return None
    df["valid"] = pd.to_datetime(df["valid"])
    df["sixhr_max_f"] = df["metar"].astype(str).map(_parse_metar_6hr_max_f)
    df = df[(df["valid"].dt.date == today) & df["sixhr_max_f"].notna()]
    return df[["valid", "sixhr_max_f"]].sort_values("valid") if not df.empty else None


def _momentum_from_official(nws_today, iem_df):
    """Trend of the last 3 official hourly obs (IEM + NWS merged, deduped by hour).

    Returns {"times", "temps", "deltas", "rising"} or None if fewer than
    3 hourly obs are available today.
    """
    rows = []
    if iem_df is not None and not iem_df.empty:
        h = iem_df[iem_df["valid"].dt.minute >= 45]
        rows.extend(zip(h["valid"], h["tmpf"]))
    if nws_today is not None and not nws_today.empty:
        h = nws_today[nws_today["valid"].dt.minute >= 45]
        col = "best_f" if "best_f" in h.columns else "temp_f"
        rows.extend(zip(h["valid"], h[col]))
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=["valid", "temp_f"]).sort_values("valid")
    df["hour"] = df["valid"].dt.floor("h")
    df = df.groupby("hour", as_index=False).last()
    if len(df) < 3:
        return None
    tail = df.tail(3)
    temps = list(tail["temp_f"])
    times = list(tail["valid"])
    deltas = [temps[1] - temps[0], temps[2] - temps[1]]
    return {
        "times": times,
        "temps": temps,
        "deltas": deltas,
        "rising": all(d >= MOMENTUM_DELTA_F for d in deltas),
    }


def fetch_knyc_nws_recent(limit=100):
    """All recent KNYC observations from NWS API (includes SPECI when issued)."""
    url = f"https://api.weather.gov/stations/KNYC/observations?limit={limit}"
    req = urllib.request.Request(url, headers={"User-Agent": NWS_UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = __import__("json").loads(resp.read().decode())

    rows = []
    for feat in data.get("features", []):
        p = feat["properties"]
        temp_c = p.get("temperature", {}).get("value")
        if temp_c is None:
            continue
        ts = pd.to_datetime(p["timestamp"]).tz_convert(TZ).tz_localize(None)
        raw = p.get("rawMessage") or ""
        precise = _parse_metar_precise_temp_f(raw)
        rows.append(
            {
                "valid": ts,
                "temp_f": temp_c * 9 / 5 + 32,
                "precise_f": precise,
                "sixhr_max_f": _parse_metar_6hr_max_f(raw),
                "raw": raw,
                "is_hourly": ts.minute >= 51 or ts.minute <= 4,
                "is_speci": bool(raw) and "AUTO" not in raw[:20] and ts.minute not in (51, 52),
            }
        )
    return pd.DataFrame(rows).sort_values("valid") if rows else pd.DataFrame()


def _parse_metar_precise_temp_f(raw):
    """Parse ASOS T-group (tenths °C) from METAR remarks, e.g. T03560211."""
    m = re.search(r"\bT(\d{4})(\d{4})\b", raw)
    if not m:
        return None
    t_tenths = int(m.group(1))
    sign = -1 if t_tenths >= 1000 else 1
    t_c = sign * (t_tenths % 1000) / 10.0
    return t_c * 9 / 5 + 32


def _parse_metar_6hr_max_f(raw):
    """
    Parse the 6-hour max temp group (1sTTT, tenths °C) from METAR remarks.
    Only present on synoptic-hour obs (~00/06/12/18Z). Sourced from continuous
    1-min ASOS data, so it catches spikes the instantaneous temp field misses.
    """
    if "RMK" not in raw:
        return None
    rmk = raw.split("RMK", 1)[1]
    m = re.search(r"(?:^|\s)1([01])(\d{3})(?=\s|$)", rmk)
    if not m:
        return None
    t_c = int(m.group(2)) / 10.0
    if m.group(1) == "1":
        t_c = -t_c
    return t_c * 9 / 5 + 32


def fetch_pws_5min_day(station_id, date):
    """~5-minute PWS buckets for a single day (history/all). Uses tempAvg to avoid spike outliers."""
    url = (
        f"https://api.weather.com/v2/pws/history/all?stationId={station_id}"
        f"&format=json&units=e&date={date.strftime('%Y%m%d')}&apiKey={API_KEY}&numericPrecision=decimal"
    )
    try:
        data = fetch_json(url)
    except Exception:
        return pd.DataFrame(columns=["valid", "station", "temp_f"])
    rows = []
    for obs in data.get("observations", []):
        if obs.get("qcStatus", 1) == 0:
            continue
        rows.append(
            {
                "valid": pd.to_datetime(obs["obsTimeLocal"]),
                "station": station_id,
                "temp_f": obs["imperial"]["tempAvg"],
            }
        )
    return pd.DataFrame(rows)


def calibrate_pws_stats(now):
    """Recency-weighted PWS->KNYC regression."""
    from interpolatornyc.calibration import calibrate

    cal = calibrate(now)
    return cal["stats_df"] if cal else None


def interp_from_pws_temps(stats_df, readings):
    """Weighted KNYC estimate from {station: temp_f} dict or list of rows."""
    stats_w = station_weights(stats_df[stats_df["station"].isin(PWS_STATIONS.keys())])
    ests = []
    for station, temp in readings.items():
        est = estimate_knyc_from_proxy(stats_w, temp, station)
        if est is None:
            continue
        sw = stats_w[stats_w["station"] == station].iloc[0]
        ests.append((est, sw["weight"]))
    if not ests:
        return None
    wsum = sum(w for _, w in ests)
    return sum(e * w for e, w in ests) / wsum


def analyze_intraday(stats_df, now, hourly_interp_peak=None):
    """
    Compare hourly interpolation vs 5-min PWS-derived peaks and NWS observations.
    Returns dict with peaks, gaps, and flags.
    """
    today = now.date()
    stats_w = station_weights(stats_df[stats_df["station"].isin(PWS_STATIONS.keys())])

    # --- 5-min PWS -> interpolated trace ---
    five_min_estimates = []
    for stn_id in PWS_STATIONS:
        df = fetch_pws_5min_day(stn_id, datetime.combine(today, datetime.min.time()))
        if df.empty:
            continue
        for _, row in df.iterrows():
            if row["valid"] > now:
                continue
            est = estimate_knyc_from_proxy(stats_w, row["temp_f"], stn_id)
            if est is not None:
                five_min_estimates.append(
                    {"valid": row["valid"], "station": stn_id, "pws_temp": row["temp_f"], "knyc_est": est}
                )

    five_min_peak = None
    five_min_peak_time = None
    if five_min_estimates:
        fdf = pd.DataFrame(five_min_estimates)
        blended = []
        for ts, grp in fdf.groupby("valid"):
            if len(grp) < 2:
                continue
            ests = grp["knyc_est"].values
            med = np.median(ests)
            mask = np.abs(ests - med) <= 3.0
            if mask.sum() < 2:
                if len(grp) == 1:
                    blended.append({"valid": ts, "knyc_est": ests[0]})
                continue
            grp = grp[mask]
            w, e = [], []
            for _, r in grp.iterrows():
                sw = stats_w[stats_w["station"] == r["station"]].iloc[0]
                e.append(r["knyc_est"])
                w.append(sw["weight"])
            w = np.array(w) / np.sum(w)
            blended.append({"valid": ts, "knyc_est": np.dot(e, w)})
        if blended:
            bdf = pd.DataFrame(blended)
            idx = bdf["knyc_est"].idxmax()
            five_min_peak = bdf.loc[idx, "knyc_est"]
            five_min_peak_time = bdf.loc[idx, "valid"]

    # --- Official KNYC: NWS API + IEM hourly fallback (NWS API often lags) ---
    nws = fetch_knyc_nws_recent()
    iem_df = _fetch_iem_official_today(today)
    iem_peak = None
    if iem_df is not None and not iem_df.empty:
        iidx = iem_df["tmpf"].idxmax()
        iem_peak = (iem_df.loc[iidx, "tmpf"], iem_df.loc[iidx, "valid"])
    official_all_peak = None
    official_all_time = None
    official_hourly_peak = None
    official_hourly_time = None
    speci_count = 0
    nws_today = pd.DataFrame()

    if not nws.empty:
        nws_today = nws[nws["valid"].dt.date == today]
        if not nws_today.empty:
            # Use precise T-group when available (higher resolution than rounded METAR temp)
            nws_today = nws_today.copy()
            nws_today["best_f"] = nws_today["precise_f"].fillna(nws_today["temp_f"])
            idx = nws_today["best_f"].idxmax()
            official_all_peak = nws_today.loc[idx, "best_f"]
            official_all_time = nws_today.loc[idx, "valid"]
            speci_count = int((~nws_today["is_hourly"]).sum())

            hourly = nws_today[nws_today["valid"].dt.minute >= 51]
            if not hourly.empty:
                hidx = hourly["best_f"].idxmax()
                official_hourly_peak = hourly.loc[hidx, "best_f"]
                official_hourly_time = hourly.loc[hidx, "valid"]

    # --- Gaps and flags ---
    flags = []
    likely_true_peak = hourly_interp_peak

    if five_min_peak is not None:
        likely_true_peak = max(likely_true_peak or 0, five_min_peak)
        if hourly_interp_peak and five_min_peak - hourly_interp_peak >= UNDERCOUNT_THRESHOLD_F:
            flags.append(
                f"5-min PWS peak ({five_min_peak:.1f}F) exceeds hourly interpolation "
                f"({hourly_interp_peak:.1f}F) by {five_min_peak - hourly_interp_peak:.1f}F"
            )

    if iem_peak is not None:
        iem_f, iem_t = iem_peak
        if official_all_peak is None or iem_f > official_all_peak:
            official_all_peak = iem_f
            official_all_time = iem_t
            if official_hourly_peak is None or iem_f > official_hourly_peak:
                official_hourly_peak = iem_f
                official_hourly_time = iem_t

    # --- 6-hr max groups (synoptic obs; from 1-min data, catch between-ob spikes) ---
    sixhr_frames = []
    if not nws_today.empty and "sixhr_max_f" in nws_today.columns:
        f = nws_today[["valid", "sixhr_max_f"]].dropna(subset=["sixhr_max_f"])
        if not f.empty:
            sixhr_frames.append(f)
    iem_sixhr = _fetch_iem_sixhr_today(today)
    if iem_sixhr is not None:
        sixhr_frames.append(iem_sixhr)

    sixhr_max = None
    sixhr_time = None
    if sixhr_frames:
        cand = pd.concat(sixhr_frames, ignore_index=True)
        # The ~06Z group's window reaches back into yesterday evening — only
        # use obs whose full 6-hr window falls within today (local).
        cand = cand[(cand["valid"] - pd.Timedelta(hours=6)).dt.date == today]
        if not cand.empty:
            sidx = cand["sixhr_max_f"].idxmax()
            sixhr_max = cand.loc[sidx, "sixhr_max_f"]
            sixhr_time = cand.loc[sidx, "valid"]

    if sixhr_max is not None:
        likely_true_peak = max(likely_true_peak or 0, sixhr_max)
        if official_all_peak is not None and sixhr_max - official_all_peak >= 0.5:
            flags.append(
                f"6-hr max group ({sixhr_max:.1f}F, ob {sixhr_time.strftime('%I:%M %p')}) exceeds "
                f"all-obs peak ({official_all_peak:.1f}F) — spike missed between obs"
            )

    if official_all_peak is not None:
        likely_true_peak = max(likely_true_peak or 0, official_all_peak)
        if hourly_interp_peak and official_all_peak - hourly_interp_peak >= UNDERCOUNT_THRESHOLD_F:
            flags.append(
                f"Official KNYC ({official_all_peak:.1f}F) exceeds hourly interpolation "
                f"({hourly_interp_peak:.1f}F) by {official_all_peak - hourly_interp_peak:.1f}F"
            )
        if official_hourly_peak and official_all_peak - official_hourly_peak >= 0.5:
            flags.append(
                f"Intra-hour official peak ({official_all_peak:.1f}F at "
                f"{official_all_time.strftime('%I:%M %p')}) exceeds hourly METAR "
                f"({official_hourly_peak:.1f}F at {official_hourly_time.strftime('%I:%M %p')})"
            )

    # --- Momentum rule: obs still climbing => today's peak is NOT in yet ---
    momentum = _momentum_from_official(nws_today, iem_df)
    peak_not_in = bool(momentum and momentum["rising"])

    return {
        "hourly_interp_peak": hourly_interp_peak,
        "five_min_interp_peak": five_min_peak,
        "five_min_interp_time": five_min_peak_time,
        "official_all_peak": official_all_peak,
        "official_all_time": official_all_time,
        "official_hourly_peak": official_hourly_peak,
        "official_hourly_time": official_hourly_time,
        "sixhr_max": sixhr_max,
        "sixhr_time": sixhr_time,
        "likely_true_peak": likely_true_peak,
        "flags": flags,
        "momentum": momentum,
        "peak_not_in": peak_not_in,
        "speci_count": speci_count,
        "nws_obs_today": len(nws[nws["valid"].dt.date == today]) if not nws.empty else 0,
    }


def print_intraday_report(analysis):
    """Print intra-hour peak analysis section."""
    print("\n=== Intra-Hour Peak Analysis ===")
    a = analysis

    if a["hourly_interp_peak"] is not None:
        print(f"  Hourly interpolated peak:     {a['hourly_interp_peak']:.1f}F")

    if a["five_min_interp_peak"] is not None:
        t = a["five_min_interp_time"].strftime("%I:%M %p")
        print(f"  5-min PWS interpolated peak:  {a['five_min_interp_peak']:.1f}F at {t} EDT")

    if a["official_hourly_peak"] is not None:
        print(
            f"  Official KNYC (:51 hourly):   {a['official_hourly_peak']:.1f}F "
            f"({format_hour_ending(a['official_hourly_time'])})"
        )
        print(f"    (ASOS :51 = max in preceding hour)")

    if a["official_all_peak"] is not None:
        t = a["official_all_time"].strftime("%I:%M %p")
        print(f"  Official KNYC (all NWS obs):  {a['official_all_peak']:.1f}F at {t} EDT")

    if a.get("sixhr_max") is not None:
        t = a["sixhr_time"].strftime("%I:%M %p")
        print(f"  6-hr max group (1-min data):  {a['sixhr_max']:.1f}F (ob {t} EDT)")

    if a["five_min_interp_peak"] is None:
        print("  5-min PWS interpolated peak:  (insufficient overlapping 5-min data)")

    if a["likely_true_peak"] is not None:
        print(f"  >>> Likely true peak:          {a['likely_true_peak']:.1f}F")

    print(f"  NWS obs today: {a['nws_obs_today']}  |  SPECI/non-hourly: {a['speci_count']}")
    if a["official_all_peak"] and a["official_all_peak"] >= 99:
        print("  (Official >=99F — hourly interpolation may undercount brief spikes.)")

    if a["flags"]:
        print("\n  *** UNDERCOUNT FLAGS ***")
        for f in a["flags"]:
            print(f"  ! {f}")
        print(
            "\n  Note: Hourly PWS regression can miss brief spikes. "
            "Trust official KNYC or 5-min PWS peak when flagged."
        )
    else:
        print("\n  No undercount flags (hourly interpolation aligns with available obs).")

    mom = a.get("momentum")
    if mom is not None:
        seq = " -> ".join(
            f"{t.strftime('%I:%M %p')}: {v:.1f}F" for t, v in zip(mom["times"], mom["temps"])
        )
        deltas = ", ".join(f"{d:+.1f}F" for d in mom["deltas"])
        print(f"\n  Momentum (last 3 official hourly obs): {seq}  ({deltas})")
        if mom["rising"]:
            if a["flags"]:
                print("\n  *** PEAK NOT IN -- MOMENTUM + UNDERCOUNT ***")
                print("  ! Official obs still climbing while hourly regression undershoots.")
                print("  ! Favor buckets ABOVE the current official max; do NOT price the")
                print("    current max as the day's high or read the regression as a plateau.")
            else:
                print("  >>> Still climbing (last two deltas >= +1.0F) — today's peak is NOT in yet.")
        else:
            print("  Momentum rule quiet (obs not climbing >= +1.0F/hr).")


def run_intraday():
    """Standalone intra-hour peak analysis command."""
    now = datetime.now(TZ).replace(tzinfo=None)
    print(f"Intra-hour analysis ({now.strftime('%I:%M %p EDT, %b %d %Y')})")

    from interpolatornyc.calibration import calibrate
    from interpolatornyc.core import enrich_knyc_precise_temps, find_today_peak, fetch_knyc_hourly as fk
    from datetime import timedelta

    cal = calibrate(now)
    if cal is None:
        print("Calibration failed.")
        return
    stats_df = cal["stats_df"]
    knyc = enrich_knyc_precise_temps(fk(now - timedelta(hours=48), now))
    peak_result = find_today_peak(stats_df, cal["proxy_aligned"], knyc, now, cal["peak_bias"])
    hourly_peak = peak_result["interp_peak"]["knyc_est"] if peak_result else None

    analysis = analyze_intraday(stats_df, now, hourly_peak)
    print_intraday_report(analysis)