"""interpolatornyc: Interpolate KNYC temperature from nearby PWS using 48hr correlations."""
import json
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

API_KEY = "e1f10a1e78da46f5b10a1e78da96f525"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
TZ = ZoneInfo("America/New_York")

PWS_STATIONS = {
    "KNYNEWYO2109": "200WEA (Upper West Side)",
    "KNYNEWYO1686": "Tempest 4076",
    "KNYNEWYO270": "AMNH roof",
    "KNYNEWYO1596": "PWS 1596",
    "KNYNEWYO1931": "PWS 1931",
    "INEWYO2": "PWS INEWYO2",
    "KNYNEWYO1024": "PWS 1024",
}

NEARBY_ASOS = ["KLGA", "KJFK", "KEWR", "KTEB"]

# KNYC hourly METARs (:51) report the max temperature in the PRECEDING hour.
# e.g. 1:51 PM = max temp from ~12:51 PM – 1:51 PM (period ends at report time).
KNYC_PERIOD_HOURS = 1


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def fetch_knyc_hourly(start_dt, end_dt):
    import time
    import urllib.error

    url = (
        "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?"
        f"station=KNYC&data=tmpf&year1={start_dt.year}&month1={start_dt.month}&day1={start_dt.day}"
        f"&hour1={start_dt.hour}&year2={end_dt.year}&month2={end_dt.month}&day2={end_dt.day}"
        f"&hour2={end_dt.hour}&tz=America/New_York&format=onlycomma&latlon=no&elev=no"
        "&missing=M&trace=T&direct=no&report_type=3&report_type=4"
    )
    for attempt in range(3):
        try:
            df = pd.read_csv(url)
            break
        except urllib.error.HTTPError as e:
            if attempt < 2 and e.code in (429, 503):
                time.sleep(2 ** attempt)
                continue
            raise
    df["valid"] = pd.to_datetime(df["valid"])
    df = df.rename(columns={"tmpf": "temp_f"})
    df["station"] = "KNYC"
    return df[["valid", "station", "temp_f"]]


def fetch_asos_hourly(station, start_dt, end_dt):
    url = (
        "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?"
        f"station={station}&data=tmpf&year1={start_dt.year}&month1={start_dt.month}&day1={start_dt.day}"
        f"&hour1={start_dt.hour}&year2={end_dt.year}&month2={end_dt.month}&day2={end_dt.day}"
        f"&hour2={end_dt.hour}&tz=America/New_York&format=onlycomma&latlon=no&elev=no"
        "&missing=M&trace=T&direct=no&report_type=3&report_type=4"
    )
    try:
        df = pd.read_csv(url)
    except Exception:
        return pd.DataFrame(columns=["valid", "station", "temp_f"])
    if df.empty or "tmpf" not in df.columns:
        return pd.DataFrame(columns=["valid", "station", "temp_f"])
    df["valid"] = pd.to_datetime(df["valid"])
    df = df.rename(columns={"tmpf": "temp_f"})
    df["station"] = station
    return df[["valid", "station", "temp_f"]]


def fetch_pws_hourly_day(station_id, date, field="tempAvg"):
    date_str = date.strftime("%Y%m%d")
    url = (
        f"https://api.weather.com/v2/pws/history/hourly?stationId={station_id}"
        f"&format=json&units=e&date={date_str}&apiKey={API_KEY}&numericPrecision=decimal"
    )
    try:
        data = fetch_json(url)
    except Exception as e:
        print(f"  WARN {station_id} {date_str}: {e}")
        return pd.DataFrame(columns=["valid", "station", "temp_f"])
    rows = []
    for obs in data.get("observations", []):
        rows.append(
            {
                "valid": pd.to_datetime(obs["obsTimeLocal"]),
                "station": station_id,
                "temp_f": obs["imperial"][field],
            }
        )
    return pd.DataFrame(rows)


def fetch_pws_hourly_range(station_id, start_date, end_date, field="tempAvg"):
    frames = []
    d = start_date
    while d <= end_date:
        df = fetch_pws_hourly_day(station_id, d, field=field)
        if not df.empty:
            frames.append(df)
        d += timedelta(days=1)
    if not frames:
        return pd.DataFrame(columns=["valid", "station", "temp_f"])
    return pd.concat(frames, ignore_index=True)


def fetch_pws_current(station_id):
    url = (
        f"https://api.weather.com/v2/pws/observations/current?stationId={station_id}"
        f"&format=json&units=e&apiKey={API_KEY}"
    )
    try:
        data = fetch_json(url)
        obs = data["observations"][0]
        return {
            "station": station_id,
            "valid": pd.to_datetime(obs["obsTimeLocal"]),
            "temp_f": obs["imperial"]["temp"],
        }
    except Exception as e:
        print(f"  WARN current {station_id}: {e}")
        return None


def fetch_knyc_latest():
    url = "https://api.weather.gov/stations/KNYC/observations/latest"
    req = urllib.request.Request(url, headers={"User-Agent": "weather-analysis"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    c = data["properties"]["temperature"]["value"]
    ts = pd.to_datetime(data["properties"]["timestamp"]).tz_convert(TZ).tz_localize(None)
    return {"valid": ts, "temp_f": c * 9 / 5 + 32}


def align_hourly(df):
    """Round to nearest hour for matching (PWS fallback; prefer merge_knyc_pws_periods)."""
    out = df.copy()
    out["hour"] = out["valid"].dt.round("h")
    out = out.groupby(["hour", "station"], as_index=False)["temp_f"].mean()
    return out


def enrich_knyc_precise_temps(knyc_df):
    """Replace rounded IEM temps with NWS METAR T-group precision when available."""
    from interpolatornyc.intraday import fetch_knyc_nws_recent

    if knyc_df.empty:
        return knyc_df
    nws = fetch_knyc_nws_recent(limit=200)
    precise = nws[nws["precise_f"].notna()][["valid", "precise_f"]].sort_values("valid")
    if precise.empty:
        return knyc_df
    out = knyc_df.sort_values("valid").copy()
    merged = pd.merge_asof(
        out,
        precise,
        on="valid",
        direction="nearest",
        tolerance=pd.Timedelta(minutes=3),
    )
    merged["temp_f"] = merged["precise_f"].fillna(merged["temp_f"])
    return merged.drop(columns=["precise_f"])


def align_knyc_obs(knyc_df):
    """
    KNYC :51 reports = max temp in preceding hour.
    `hour` = period end (the METAR timestamp).
    """
    out = knyc_df.copy()
    out["hour"] = out["valid"]
    return out.rename(columns={"temp_f": "knyc_temp"})[["hour", "knyc_temp"]]


def merge_knyc_pws_periods(knyc_df, pws_df):
    """
    Pair each KNYC hourly max with PWS max in (report_time - 1hr, report_time].
    """
    rows = []
    for _, k in knyc_df.iterrows():
        end = k["valid"]
        start = end - timedelta(hours=KNYC_PERIOD_HOURS)
        window = pws_df[(pws_df["valid"] > start) & (pws_df["valid"] <= end)]
        for station, grp in window.groupby("station"):
            rows.append(
                {
                    "hour": end,
                    "knyc_temp": k["temp_f"],
                    "station": station,
                    "proxy_temp": grp["temp_f"].max(),
                }
            )
    return pd.DataFrame(rows)


def format_hour_ending(dt):
    """Display label for KNYC period-end timestamps."""
    return f"hour ending {dt.strftime('%I:%M %p')} EDT"


def pws_max_in_period(pws_df, period_end, period_hours=None):
    """Max PWS temp per station in (period_end - period_hours, period_end]."""
    if period_hours is None:
        period_hours = KNYC_PERIOD_HOURS
    start = period_end - timedelta(hours=period_hours)
    window = pws_df[(pws_df["valid"] > start) & (pws_df["valid"] <= period_end)]
    if window.empty:
        return pd.DataFrame(columns=["hour", "station", "temp_f"])
    out = window.groupby("station", as_index=False)["temp_f"].max()
    out["hour"] = period_end
    return out


def station_weights(stats_df):
    w = stats_df["r"] ** 2 / (stats_df["rmse"] ** 2 + 0.01)
    out = stats_df.copy()
    out["weight"] = w / w.sum()
    return out


def estimate_knyc_from_proxy(stats_w, proxy_temp, station):
    row = stats_w[stats_w["station"] == station]
    if row.empty:
        return None
    row = row.iloc[0]
    return row["slope"] * proxy_temp + row["intercept"]


def find_today_peak(stats_df, proxy_aligned, knyc, now, peak_bias=0.0):
    from interpolatornyc.calibration import apply_peak_bias

    today = now.date()
    stats_w = station_weights(stats_df[stats_df["station"].isin(PWS_STATIONS.keys())])

    # Official KNYC hourly obs today
    knyc_today = knyc[knyc["valid"].dt.date == today].copy()
    official_peak = None
    if not knyc_today.empty:
        idx = knyc_today["temp_f"].idxmax()
        official_peak = {
            "temp_f": knyc_today.loc[idx, "temp_f"],
            "time": knyc_today.loc[idx, "valid"],
            "label": format_hour_ending(knyc_today.loc[idx, "valid"]),
        }

    # PWS hourly highs for today (tempHigh captures intra-hour peaks)
    pws_high_frames = []
    for stn_id in PWS_STATIONS:
        df = fetch_pws_hourly_day(stn_id, datetime.combine(today, datetime.min.time()), field="tempHigh")
        if not df.empty:
            pws_high_frames.append(df)
    pws_high = pd.concat(pws_high_frames, ignore_index=True) if pws_high_frames else pd.DataFrame()

    current = []
    for stn_id in PWS_STATIONS:
        cur = fetch_pws_current(stn_id)
        if cur:
            current.append(cur)
    current_df = pd.DataFrame(current) if current else pd.DataFrame()

    # KNYC :51 = max in preceding hour; align interpolated trace to same period ends
    completed_periods = sorted(knyc_today["valid"].unique()) if not knyc_today.empty else []
    last_official = completed_periods[-1] if completed_periods else None
    in_progress = last_official is not None and now > last_official
    period_ends = list(completed_periods)
    if in_progress:
        period_ends.append(now)

    hourly_estimates = []
    for period_end in period_ends:
        if period_end > now:
            continue
        is_partial = period_end == now and in_progress
        if is_partial:
            partial_h = (now - last_official).total_seconds() / 3600.0
            hour_pws = pws_max_in_period(pws_high, now, period_hours=partial_h)
            hour_pws["hour"] = now
        else:
            hour_pws = pws_max_in_period(pws_high, period_end)

        # Stations whose readings were all null in this window come through as
        # NaN; they must be dropped BEFORE weighting or their weight share is
        # silently lost in the NaN-skipping .sum(), dragging the estimate down.
        hour_pws = hour_pws.dropna(subset=["temp_f"])

        if is_partial and not current_df.empty:
            for _, cr in current_df.iterrows():
                mask = hour_pws["station"] == cr["station"]
                if mask.any():
                    hour_pws.loc[mask, "temp_f"] = max(hour_pws.loc[mask, "temp_f"].iloc[0], cr["temp_f"])
                else:
                    new_row = pd.DataFrame([{"hour": period_end, "station": cr["station"], "temp_f": cr["temp_f"]}])
                    hour_pws = new_row if hour_pws.empty else pd.concat([hour_pws, new_row], ignore_index=True)

        ests = []
        for _, row in hour_pws.iterrows():
            est = estimate_knyc_from_proxy(stats_w, row["temp_f"], row["station"])
            if est is None or pd.isna(est):
                continue
            est = apply_peak_bias(est, row["temp_f"], peak_bias)
            sw = stats_w[stats_w["station"] == row["station"]].iloc[0]
            ests.append({"estimate": est, "weight": sw["weight"], "station": row["station"], "pws_temp": row["temp_f"]})

        if not ests:
            continue
        edf = pd.DataFrame(ests)
        edf["w_norm"] = edf["weight"] / edf["weight"].sum()
        weighted = (edf["estimate"] * edf["w_norm"]).sum()
        hourly_estimates.append(
            {
                "hour": period_end,
                "knyc_est": weighted,
                "knyc_est_min": edf["estimate"].min(),
                "knyc_est_max": edf["estimate"].max(),
                "n_stations": len(edf),
                "top_station": edf.loc[edf["weight"].idxmax(), "station"],
                "is_partial": is_partial,
            }
        )

    if not hourly_estimates:
        return None

    est_df = pd.DataFrame(hourly_estimates)
    completed_df = est_df[~est_df["is_partial"]] if "is_partial" in est_df.columns else est_df
    peak_source = completed_df if not completed_df.empty else est_df
    peak_idx = peak_source["knyc_est"].idxmax()
    interp_peak = est_df.loc[peak_idx]

    return {
        "today": today,
        "official_peak": official_peak,
        "interp_peak": interp_peak,
        "hourly": est_df,
        "stats_w": stats_w,
    }


def compute_station_stats(merged, station, now=None):
    """Delegate to recency-weighted fit when `now` provided."""
    if now is not None:
        from interpolatornyc.calibration import compute_station_stats as weighted_stats

        return weighted_stats(merged, station, now)
    sub = merged.dropna(subset=["knyc_temp", "proxy_temp"])
    sub = sub[sub["station"] == station]
    if len(sub) < 6:
        return None
    x = sub["proxy_temp"].values
    y = sub["knyc_temp"].values
    r = np.corrcoef(x, y)[0, 1]
    bias = np.mean(y - x)
    slope, intercept = np.polyfit(x, y, 1)
    rmse = np.sqrt(np.mean((y - (slope * x + intercept)) ** 2))
    return {
        "station": station,
        "n": len(sub),
        "r": r,
        "bias": bias,
        "slope": slope,
        "intercept": intercept,
        "rmse": rmse,
    }


def run_full():
    now = datetime.now(TZ).replace(tzinfo=None)
    start = now - timedelta(hours=48)
    start_date = start.date()
    end_date = now.date()

    print(f"Analysis time: {now.strftime('%Y-%m-%d %H:%M %Z')}")
    print(f"Correlation window: {start.strftime('%Y-%m-%d %H:%M')} to {now.strftime('%Y-%m-%d %H:%M')}")
    print()

    # --- Fetch KNYC hourly ---
    print("Fetching KNYC hourly (IEM ASOS)...")
    knyc = enrich_knyc_precise_temps(fetch_knyc_hourly(start, now))
    knyc_aligned = align_knyc_obs(knyc)

    # --- Fetch nearby ASOS ---
    print("Fetching nearby ASOS stations...")
    asos_frames = []
    for stn in NEARBY_ASOS:
        df = fetch_asos_hourly(stn, start, now)
        if not df.empty:
            asos_frames.append(df)
            print(f"  {stn}: {len(df)} hourly obs")
    asos_all = pd.concat(asos_frames, ignore_index=True) if asos_frames else pd.DataFrame()

    # --- Fetch PWS hourly highs ---
    print("Fetching PWS hourly history (tempHigh)...")
    pws_frames = []
    for stn_id, name in PWS_STATIONS.items():
        df = fetch_pws_hourly_range(stn_id, start_date, end_date, field="tempHigh")
        if not df.empty:
            pws_frames.append(df)
            print(f"  {stn_id} ({name}): {len(df)} hourly obs")
    pws_all = pd.concat(pws_frames, ignore_index=True) if pws_frames else pd.DataFrame()

    merged_pws = merge_knyc_pws_periods(knyc, pws_all) if not pws_all.empty else pd.DataFrame()
    merged_pws = merged_pws[merged_pws["hour"] >= start] if not merged_pws.empty else merged_pws

    # ASOS: approximate clock-hour merge (airport METAR timing differs from KNYC :51)
    merged_asos = pd.DataFrame()
    if not asos_all.empty:
        asos_proxy = align_hourly(asos_all).rename(columns={"temp_f": "proxy_temp"})
        knyc_round = knyc_aligned.copy()
        knyc_round["hour_round"] = knyc_round["hour"].dt.round("h")
        merged_asos = asos_proxy.merge(
            knyc_round[["hour_round", "hour", "knyc_temp"]].rename(columns={"hour": "knyc_period_end"}),
            left_on="hour",
            right_on="hour_round",
            how="inner",
        )
        merged_asos["hour"] = merged_asos["knyc_period_end"]
        merged_asos = merged_asos[["hour", "knyc_temp", "station", "proxy_temp"]]
        merged_asos = merged_asos[merged_asos["hour"] >= start]

    merged = pd.concat([merged_pws, merged_asos], ignore_index=True) if not merged_pws.empty or not merged_asos.empty else pd.DataFrame()
    knyc_aligned = knyc_aligned[knyc_aligned["hour"] >= start]
    proxy_aligned = merged[["hour", "station", "proxy_temp"]].copy() if not merged.empty else pd.DataFrame()

    # --- Correlation stats ---
    all_stations = list(PWS_STATIONS.keys()) + NEARBY_ASOS
    stats = []
    for stn in all_stations:
        s = compute_station_stats(merged, stn, now)
        if s:
            stats.append(s)

    stats_df = pd.DataFrame(stats).sort_values("r", ascending=False)
    from interpolatornyc.calibration import fit_peak_bias

    peak_bias = fit_peak_bias(merged, stats_df[stats_df["station"].isin(PWS_STATIONS.keys())], now)
    print(f"\n=== 48hr Correlation (recency-weighted, 12h half-life) ===")
    print(f"  KNYC :51 = max in preceding hour; PWS matched to same window")
    print(f"  Learned peak bias correction: +{peak_bias:.1f}F (warm hours, incl. 100F obs)")
    for _, row in stats_df.iterrows():
        name = PWS_STATIONS.get(row["station"], row["station"])
        print(
            f"  {row['station']:14s}  r={row['r']:.3f}  bias={row['bias']:+.1f}F  "
            f"slope={row['slope']:.3f}  RMSE={row['rmse']:.2f}F  n={int(row['n'])}  ({name})"
        )

    # --- Current readings ---
    print("\n=== Current Station Readings ===")
    knyc_latest = fetch_knyc_latest()
    print(f"  KNYC (official latest): {knyc_latest['temp_f']:.1f}F at {knyc_latest['valid']}")

    current_readings = []
    for stn_id, name in PWS_STATIONS.items():
        cur = fetch_pws_current(stn_id)
        if cur and cur.get("temp_f") is not None:
            current_readings.append(cur)
            print(f"  {stn_id}: {cur['temp_f']:.1f}F at {cur['valid']}  ({name})")
        elif cur:
            print(f"  {stn_id}: no current temp  ({name})")

    # --- Interpolation ---
    from interpolatornyc.calibration import apply_peak_bias, blend_now_estimate, get_official_latest

    official_latest = get_official_latest(knyc_aligned, now)
    estimates = []
    for cur in current_readings:
        stn = cur["station"]
        row = stats_df[stats_df["station"] == stn]
        if row.empty:
            continue
        row = row.iloc[0]
        est = apply_peak_bias(row["slope"] * cur["temp_f"] + row["intercept"], cur["temp_f"], peak_bias)
        weight = row["r"] ** 2 / (row["rmse"] ** 2 + 0.01)
        estimates.append(
            {
                "station": stn,
                "current_temp": cur["temp_f"],
                "estimate": est,
                "weight": weight,
                "r": row["r"],
                "bias": row["bias"],
            }
        )

    if not estimates:
        print("\nNo estimates possible.")
        return

    est_df = pd.DataFrame(estimates)
    est_df["w_norm"] = est_df["weight"] / est_df["weight"].sum()

    weighted_est = (est_df["estimate"] * est_df["w_norm"]).sum()
    simple_bias_est = (est_df["current_temp"] + est_df["bias"]).mean()
    median_est = est_df["estimate"].median()

    print("\n=== KNYC Temperature Interpolation (NOW) ===")
    print("Per-station estimates (slope*PWS_temp + intercept):")
    for _, row in est_df.sort_values("weight", ascending=False).iterrows():
        name = PWS_STATIONS.get(row["station"], row["station"])
        print(
            f"  {row['station']:14s}  PWS={row['current_temp']:5.1f}F  "
            f"-> KNYC est={row['estimate']:5.1f}F  (r={row['r']:.3f}, w={row['w_norm']:.2%})  {name}"
        )

    print()
    print(f"  Weighted regression estimate:  {weighted_est:.1f}F")
    print(f"  Simple bias-corrected mean:    {simple_bias_est:.1f}F")
    print(f"  Median regression estimate:    {median_est:.1f}F")
    print(f"  Official KNYC latest obs:      {knyc_latest['temp_f']:.1f}F  ({knyc_latest['valid']})")

    # Delta nowcast: apply PWS change since last KNYC hour to latest KNYC obs
    last_knyc_hour = knyc_aligned["hour"].max()
    last_knyc_temp = knyc_aligned.loc[knyc_aligned["hour"] == last_knyc_hour, "knyc_temp"].iloc[0]
    delta_estimates = []
    for cur in current_readings:
        stn = cur["station"]
        hist = proxy_aligned[(proxy_aligned["station"] == stn) & (proxy_aligned["hour"] == last_knyc_hour)]
        row = stats_df[stats_df["station"] == stn]
        if hist.empty or row.empty:
            continue
        pws_then = hist["proxy_temp"].iloc[0]
        pws_delta = cur["temp_f"] - pws_then
        delta_est = last_knyc_temp + pws_delta * row.iloc[0]["slope"]
        delta_estimates.append({"station": stn, "delta_est": delta_est, "r": row.iloc[0]["r"]})

    if delta_estimates:
        delta_df = pd.DataFrame(delta_estimates)
        delta_df["w"] = delta_df["r"] ** 2
        delta_df["w"] /= delta_df["w"].sum()
        delta_nowcast = (delta_df["delta_est"] * delta_df["w"]).sum()
        print(f"  Delta nowcast (from {last_knyc_hour} KNYC={last_knyc_temp:.0f}F): {delta_nowcast:.1f}F")

    delta_val = delta_nowcast if delta_estimates else None
    final_est = blend_now_estimate(weighted_est, official_latest, delta_val, now)

    lo = min(est_df["estimate"].min(), delta_df["delta_est"].min() if delta_estimates else est_df["estimate"].min())
    hi = max(est_df["estimate"].max(), delta_df["delta_est"].max() if delta_estimates else est_df["estimate"].max())
    if official_latest:
        hi = max(hi, official_latest["temp_f"])
    print(f"\n  >>> INTERPOLATED KNYC NOW: ~{final_est:.0f}F  (range {lo:.0f}-{hi:.0f}F across stations)")
    if official_latest:
        print(f"      (PWS+peak-bias: {weighted_est:.1f}F, official anchor: {official_latest['temp_f']:.0f}F)")
    print(f"      Last official KNYC hourly:  {last_knyc_temp:.0f}F ({format_hour_ending(last_knyc_hour)})")

    recent = knyc.sort_values("valid").tail(6)
    print("\n=== Recent KNYC Hourly (official, preceding-hour max) ===")
    for _, row in recent.iterrows():
        print(f"  {format_hour_ending(row['valid'])}: {row['temp_f']:.0f}F")

    # --- Today's peak ---
    peak = find_today_peak(stats_df, proxy_aligned, knyc, now, peak_bias)
    if peak:
        print(f"\n=== KNYC Peak So Far Today ({peak['today']}) ===")
        p = peak["interp_peak"]
        print(f"  Interpolated peak: {p['knyc_est']:.1f}F ({format_hour_ending(p['hour'])})")
        print(f"    (range across stations: {p['knyc_est_min']:.1f}-{p['knyc_est_max']:.1f}F, {int(p['n_stations'])} stations)")
        if peak["official_peak"]:
            op = peak["official_peak"]
            print(f"  Official KNYC peak:  {op['temp_f']:.0f}F ({op.get('label', format_hour_ending(op['time']))})")
            print(f"    (ASOS :51 = max in preceding hour)")
        print("\n  Interpolated trace by KNYC period (today):")
        for _, row in peak["hourly"].iterrows():
            marker = " <-- PEAK" if row["hour"] == p["hour"] else ""
            print(
                f"    {format_hour_ending(row['hour'])}: {row['knyc_est']:.1f}F"
                f" ({row['knyc_est_min']:.0f}-{row['knyc_est_max']:.0f}){marker}"
            )

    _print_intraday_section(stats_df, now, peak["interp_peak"]["knyc_est"] if peak else None)


def _print_intraday_section(stats_df, now, hourly_interp_peak):
    try:
        from interpolatornyc.intraday import analyze_intraday, print_intraday_report

        analysis = analyze_intraday(stats_df, now, hourly_interp_peak)
        print_intraday_report(analysis)
    except Exception as e:
        print(f"\n  (Intra-hour analysis skipped: {e})")


def run_now():
    """Quick interpolated KNYC temp: recency-weighted PWS + peak bias + official blend."""
    from interpolatornyc.calibration import blend_now_estimate, calibrate, estimate_from_pws

    now = datetime.now(TZ).replace(tzinfo=None)
    cal = calibrate(now)
    if cal is None:
        print("Calibration failed.")
        return

    stats_df = cal["stats_df"]
    peak_bias = cal["peak_bias"]
    official_latest = cal["official_latest"]
    knyc_aligned = cal["knyc_aligned"]
    proxy_aligned = cal["proxy_aligned"]

    print(f"Interpolated KNYC NOW ({now.strftime('%I:%M %p EDT')})")
    print(f"  Peak bias: +{peak_bias:.1f}F  |  Recency half-life: 12h\n")

    estimates = []
    current_readings = []
    for stn_id, name in PWS_STATIONS.items():
        cur = fetch_pws_current(stn_id)
        if not cur:
            continue
        current_readings.append(cur)
        est = estimate_from_pws(stats_df, peak_bias, stn_id, cur["temp_f"])
        if est is None:
            continue
        row = stats_df[stats_df["station"] == stn_id].iloc[0]
        w = row["r"] ** 2 / (row["rmse"] ** 2 + 0.01)
        estimates.append((name, cur["valid"], cur["temp_f"], est, w))
        print(f"  {name:20s} PWS={cur['temp_f']:.0f}F  -> {est:.1f}F")

    if not estimates:
        print("No estimates possible.")
        return
    wsum = sum(e[4] for e in estimates)
    weighted = sum(e[3] * e[4] for e in estimates) / wsum

    # Delta nowcast from official anchor
    delta_val = None
    if official_latest and knyc_aligned is not None:
        last_h = official_latest["hour"]
        last_t = official_latest["temp_f"]
        deltas = []
        for cur in current_readings:
            stn = cur["station"]
            hist = proxy_aligned[(proxy_aligned["station"] == stn) & (proxy_aligned["hour"] == last_h)]
            row = stats_df[stats_df["station"] == stn]
            if hist.empty or row.empty:
                continue
            deltas.append(last_t + (cur["temp_f"] - hist["proxy_temp"].iloc[0]) * row.iloc[0]["slope"])
        if deltas:
            delta_val = float(np.mean(deltas))

    final = blend_now_estimate(weighted, official_latest, delta_val, now)
    print(f"\n  PWS + peak bias:  {weighted:.1f}F")
    if official_latest:
        print(f"  Official anchor:  {official_latest['temp_f']:.0f}F ({format_hour_ending(official_latest['hour'])})")
        print(f"    (preceding-hour max per ASOS :51 convention)")
    if delta_val is not None:
        print(f"  Delta nowcast:    {delta_val:.1f}F")
    print(f"\n  >>> Interpolated KNYC: {final:.1f}F")


def run_peak():
    """Interpolated peak so far today."""
    from interpolatornyc.calibration import calibrate

    now = datetime.now(TZ).replace(tzinfo=None)
    cal = calibrate(now)
    if cal is None:
        print("Calibration failed.")
        return
    stats_df = cal["stats_df"]
    proxy_aligned = cal["proxy_aligned"]
    knyc = enrich_knyc_precise_temps(fetch_knyc_hourly(now - timedelta(hours=48), now))

    peak = find_today_peak(stats_df, proxy_aligned, knyc, now, cal["peak_bias"])
    if not peak:
        print("No peak data.")
        return
    p = peak["interp_peak"]
    print(f"Interpolated KNYC peak so far ({peak['today']})")
    print(f"  Peak: {p['knyc_est']:.1f}F ({format_hour_ending(p['hour'])})")
    print(f"  Range: {p['knyc_est_min']:.1f}-{p['knyc_est_max']:.1f}F")
    if peak["official_peak"]:
        op = peak["official_peak"]
        print(f"  Official KNYC peak: {op['temp_f']:.0f}F ({op.get('label', format_hour_ending(op['time']))})")
        print(f"  (ASOS :51 records max in preceding hour)")

    _print_intraday_section(stats_df, now, p["knyc_est"])