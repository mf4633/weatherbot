"""Run the interpolatornyc pipeline against KDEN (Denver Intl) with Denver-area PWS.

Patches interpolatornyc.core BEFORE importing calibration/intraday so their
`from core import X` bindings pick up the Denver versions.
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

TARGET = "KDEN"
IEM_ID = "DEN"
DEN_TZ = ZoneInfo("America/Denver")

DENVER_PWS = {
    "KCOAUROR870": "Aurora 870 (8.4 km)",
    "KCOAUROR983": "Aurora 983 (8.4 km)",
    "KCOAUROR879": "Aurora 879 (8.9 km)",
    "KCOAUROR940": "Aurora 940 (9.2 km)",
    "KCOAUROR716": "Aurora 716 (9.3 km)",
    "KCODENVE1304": "Denver 1304 (9.8 km)",
    "KCOCOMME103": "Commerce City (9.9 km)",
}

# --- patch core constants (mutate PWS dict in place: other modules hold refs) ---
core.TZ = DEN_TZ
core.PWS_STATIONS.clear()
core.PWS_STATIONS.update(DENVER_PWS)
core.NEARBY_ASOS = []  # airports dropped: IEM rate-limits us and they don't feed the nowcast


def _iem_url(station, start_dt, end_dt):
    return (
        "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?"
        f"station={station}&data=tmpf&year1={start_dt.year}&month1={start_dt.month}&day1={start_dt.day}"
        f"&hour1={start_dt.hour}&year2={end_dt.year}&month2={end_dt.month}&day2={end_dt.day}"
        f"&hour2={end_dt.hour}&tz=America/Denver&format=onlycomma&latlon=no&elev=no"
        "&missing=M&trace=T&direct=no&report_type=3&report_type=4"
    )


def fetch_kden_hourly(start_dt, end_dt):
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


def fetch_asos_hourly_mtn(station, start_dt, end_dt):
    try:
        df = pd.read_csv(_iem_url(station, start_dt, end_dt))
    except Exception:
        return pd.DataFrame(columns=["valid", "station", "temp_f"])
    if df.empty or "tmpf" not in df.columns:
        return pd.DataFrame(columns=["valid", "station", "temp_f"])
    df["valid"] = pd.to_datetime(df["valid"])
    df = df.rename(columns={"tmpf": "temp_f"})
    df["station"] = station
    return df[["valid", "station", "temp_f"]]


def fetch_kden_latest():
    url = f"https://api.weather.gov/stations/{TARGET}/observations/latest"
    req = urllib.request.Request(url, headers={"User-Agent": "weather-analysis"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    c = data["properties"]["temperature"]["value"]
    ts = pd.to_datetime(data["properties"]["timestamp"]).tz_convert(DEN_TZ).tz_localize(None)
    return {"valid": ts, "temp_f": c * 9 / 5 + 32}


def format_hour_ending_mdt(dt):
    return f"hour ending {dt.strftime('%I:%M %p')} MDT"


core.fetch_knyc_hourly = fetch_kden_hourly
core.fetch_asos_hourly = fetch_asos_hourly_mtn
core.fetch_knyc_latest = fetch_kden_latest
core.format_hour_ending = format_hour_ending_mdt

# --- import dependents AFTER core patches so name imports bind Denver versions ---
import interpolatornyc.intraday as intraday  # noqa: E402


def fetch_kden_nws_recent(limit=100):
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
        ts = pd.to_datetime(p["timestamp"]).tz_convert(DEN_TZ).tz_localize(None)
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


def _fetch_iem_official_today_den(today):
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


intraday.fetch_knyc_nws_recent = fetch_kden_nws_recent
intraday._fetch_iem_official_today = _fetch_iem_official_today_den
intraday.IEM_STATION = IEM_ID
intraday.IEM_QUERY_TZ = "America/Denver"

print("=" * 64)
print(f"  INTERPOLATOR — DENVER (KDEN) adaptation of interpolatornyc")
print(f"  Target: {TARGET} (Kalshi Denver settlement station)")
print(f"  Note: KDEN METAR temp is ~instantaneous (:53), not a")
print(f"  preceding-hour max like KNYC; regression absorbs the offset.")
print("=" * 64)
print()

core.run_full()
