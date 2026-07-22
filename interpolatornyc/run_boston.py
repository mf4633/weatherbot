"""Run the interpolatornyc pipeline against KBOS (Boston Logan) with nearby PWS.

Kalshi's Boston max-temp market (KXHIGHTBOS) settles on CLIBOS = Boston-Logan ASOS.
Same patching strategy as run_houston.py / run_denver.py.

PWS set chosen 2026-07-22 from api.weather.com v3 location/near (qcStatus=1),
all within 2.5 km of the Logan ASOS. Logan is a sea-breeze station: East
Boston / Winthrop sites bracket it on the harbor side, so the fleet should
see onshore pushes at roughly the same time the airport does.
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

TARGET = "KBOS"
IEM_ID = "BOS"
CITY_TZ = ZoneInfo("America/New_York")
TZ_LABEL = "EDT"
IEM_TZ = "America/New_York"

CITY_PWS = {
    "KMAEASTB68": "East Boston (1.7 km)",
    "KMAWINTH27": "Winthrop 27 (1.8 km)",
    "KMABOSTO198": "Boston 198 (2.0 km)",
    "KMABOSTO297": "Boston 297 (2.1 km)",
    "KMAWINTH38": "Winthrop 38 (2.1 km)",
    "KMAEASTB73": "East Boston 73 (2.2 km)",
    "KMAEASTB53": "East Boston 53 (2.2 km)",
}

core.TZ = CITY_TZ
core.PWS_STATIONS.clear()
core.PWS_STATIONS.update(CITY_PWS)
core.NEARBY_ASOS = []


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
print(f"  INTERPOLATOR — BOSTON (KBOS / Logan) adaptation")
print(f"  Target: {TARGET} (Kalshi Boston settlement: CLIBOS)")
print("=" * 64)
print()

core.run_full()
