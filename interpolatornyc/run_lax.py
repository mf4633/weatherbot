"""Run the interpolatornyc pipeline against KLAX (Los Angeles Intl) with nearby PWS.

Kalshi's LA max-temp market (KXHIGHLAX) settles on the LAX CLI (CLILAX = KLAX ASOS).
Same patching strategy as run_boston.py / run_houston.py.

PWS set chosen 2026-07-22 from api.weather.com v3 location/near (qcStatus=1),
all within 3.3 km. Marine-layer geometry matters here: the El Segundo sites sit
in the same beach-adjacent stratus regime as the airport, while Hawthorne (3.2 km
inland) clears first on burn-off days — a coastal/inland split with Hawthorne
running warm is the burn-off arriving; everything pinned together under overcast
is the cap holding. KLAX is a standard ASOS: hourly METAR temp is instantaneous
(the ":51 = preceding-hour max" framing is a KNYC-only quirk).
"""
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from pathlib import Path as _P
sys.path.insert(0, str(_P(__file__).resolve().parents[1]))  # parent of the package dir

import json
import re
import urllib.request

import pandas as pd

import interpolatornyc.core as core

TARGET = "KLAX"
IEM_ID = "LAX"
CITY_TZ = ZoneInfo("America/Los_Angeles")
TZ_LABEL = "PDT"
IEM_TZ = "America/Los_Angeles"

CITY_PWS = {
    "KCAELSEG28": "El Segundo 28 (1.8 km)",
    "KCALOSAN961": "Los Angeles 961 (2.7 km)",
    "KCAELSEG23": "El Segundo 23 (2.9 km)",
    "KCALOSAN1102": "Los Angeles 1102 (2.9 km)",
    "KCALOSAN698": "Los Angeles 698 (3.1 km)",
    "KCAHAWTH17": "Hawthorne 17 (3.2 km, inland burn-off sentinel)",
}
# KCALOSAN958 dropped 2026-07-22: zero rows of hourly history over the 30-day
# backtest window and no current temp live — dead sensor.

# 30-day walk-forward backtest (backtest_lax.py, Jun 22 - Jul 21) station weights:
# marine-weighted inverse debiased solo-MSE, mean 1. El Segundo 23 was the clear
# laggard (debiased solo MAE 1.22F vs 0.62-0.73F for the rest) -> down-weighted.
# Applied by scaling each station's fitted RMSE by 1/sqrt(mult) (weight ~ r^2/rmse^2),
# so the displayed RMSE column is weight-adjusted, not raw.
WEIGHT_MULT = {
    "KCALOSAN961": 1.29,
    "KCALOSAN698": 1.21,
    "KCALOSAN1102": 1.11,
    "KCAHAWTH17": 0.99,
    "KCAELSEG28": 0.98,
    "KCAELSEG23": 0.42,
}

core.TZ = CITY_TZ
core.PWS_STATIONS.clear()
core.PWS_STATIONS.update(CITY_PWS)
core.NEARBY_ASOS = []

_orig_station_stats = core.compute_station_stats
def _weighted_station_stats(merged, station, now=None):
    s = _orig_station_stats(merged, station, now)
    if s and station in WEIGHT_MULT and s.get("rmse"):
        s = dict(s)
        s["rmse"] = s["rmse"] / (WEIGHT_MULT[station] ** 0.5)
    return s
core.compute_station_stats = _weighted_station_stats


def _iem_url(station, start_dt, end_dt):
    return (
        "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?"
        f"station={station}&data=tmpf&year1={start_dt.year}&month1={start_dt.month}&day1={start_dt.day}"
        f"&hour1={start_dt.hour}&year2={end_dt.year}&month2={end_dt.month}&day2={end_dt.day}"
        f"&hour2={end_dt.hour}&tz={IEM_TZ}&format=onlycomma&latlon=no&elev=no"
        "&missing=M&trace=T&direct=no&report_type=3&report_type=4"
    )


def fetch_city_hourly(start_dt, end_dt):
    import time
    import urllib.error

    url = _iem_url(IEM_ID, start_dt, end_dt)
    for attempt in range(5):
        try:
            df = pd.read_csv(url)
            break
        except urllib.error.HTTPError as e:
            if attempt < 4 and e.code in (429, 503):
                time.sleep(5 * (attempt + 1))
                continue
            raise
    df["valid"] = pd.to_datetime(df["valid"])
    df = df.rename(columns={"tmpf": "temp_f"})
    df["station"] = TARGET
    return df[["valid", "station", "temp_f"]]


def fetch_city_latest():
    url = f"https://api.weather.gov/stations/{TARGET}/observations/latest"
    req = urllib.request.Request(url, headers={"User-Agent": "weather-analysis"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    c = data["properties"]["temperature"]["value"]
    ts = pd.to_datetime(data["properties"]["timestamp"]).tz_convert(CITY_TZ).tz_localize(None)
    return {"valid": ts, "temp_f": c * 9 / 5 + 32}


def format_hour_ending_local(dt):
    return f"hour ending {dt.strftime('%I:%M %p')} {TZ_LABEL}"


core.fetch_knyc_hourly = fetch_city_hourly
core.fetch_asos_hourly = lambda station, s, e: pd.DataFrame(columns=["valid", "station", "temp_f"])
core.fetch_knyc_latest = fetch_city_latest
core.format_hour_ending = format_hour_ending_local

import interpolatornyc.intraday as intraday  # noqa: E402


def fetch_city_nws_recent(limit=100):
    url = f"https://api.weather.gov/stations/{TARGET}/observations?limit={limit}"
    req = urllib.request.Request(url, headers={"User-Agent": "weather-analysis"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    rows = []
    for feat in data.get("features", []):
        p = feat["properties"]
        temp_c = p.get("temperature", {}).get("value")
        if temp_c is None:
            continue
        ts = pd.to_datetime(p["timestamp"]).tz_convert(CITY_TZ).tz_localize(None)
        raw = p.get("rawMessage") or ""
        m = re.search(r"\bT(\d{4})(\d{4})\b", raw)
        precise = None
        if m:
            t_tenths = int(m.group(1))
            sign = -1 if t_tenths >= 1000 else 1
            precise = sign * (t_tenths % 1000) / 10.0 * 9 / 5 + 32
        rows.append(
            {
                "valid": ts,
                "temp_f": temp_c * 9 / 5 + 32,
                "precise_f": precise,
                "raw": raw,
                "is_hourly": ts.minute >= 51 or ts.minute <= 4,
                "is_speci": bool(raw) and "AUTO" not in raw[:20] and ts.minute not in (51, 52, 53),
            }
        )
    return pd.DataFrame(rows).sort_values("valid") if rows else pd.DataFrame()


def _fetch_iem_official_today_city(today):
    from datetime import timedelta

    start = datetime.combine(today, datetime.min.time())
    end = start + timedelta(days=1)
    try:
        df = pd.read_csv(_iem_url(IEM_ID, start, end))
    except Exception:
        return None
    if df.empty:
        return None
    df["valid"] = pd.to_datetime(df["valid"])
    df["tmpf"] = pd.to_numeric(df["tmpf"], errors="coerce")
    df = df[(df["valid"].dt.date == today) & df["tmpf"].notna()]
    if df.empty:
        return None
    return df[["valid", "tmpf"]].sort_values("valid")


intraday.fetch_knyc_nws_recent = fetch_city_nws_recent
intraday._fetch_iem_official_today = _fetch_iem_official_today_city
intraday.IEM_STATION = IEM_ID
intraday.IEM_QUERY_TZ = IEM_TZ

print("=" * 64)
print(f"  INTERPOLATOR — LOS ANGELES (KLAX) adaptation")
print(f"  Target: {TARGET} (Kalshi LA settlement: CLI LAX)")
print("=" * 64)
print()

core.run_full()

# CLI-settlement offset (30-day backtest, backtest_lax.py): the interpolated peak
# runs SYSTEMATICALLY LOW vs the CLI high Kalshi settles on — raw bias -1.65F
# (rolling offset ranged -1.4 to -2.0; CLI beat the METAR max on 18/30 days via
# the continuous/1-min max). Walk-forward debiased: MAE 0.67F, within-1F 72%,
# 2-deg bucket hit 72% (marine days 67%, clear 86%).
print()
print("*" * 64)
print("  CLI SETTLEMENT ESTIMATE: add +1.7F to the interpolated peak")
print("  (30-day walk-forward: raw bias -1.65F; debiased bucket hit 72%)")
print("*" * 64)
