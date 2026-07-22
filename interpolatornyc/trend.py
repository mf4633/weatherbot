"""Analyze whether KNYC has started trending down."""
import json
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

API_KEY = "e1f10a1e78da46f5b10a1e78da96f525"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
TZ = ZoneInfo("America/New_York")

PWS = ["KNYNEWYO270", "KNYNEWYO2109", "KNYNEWYO1686", "KNYNEWYO1596", "KNYNEWYO1931", "INEWYO2"]
NAMES = {
    "KNYNEWYO270": "AMNH",
    "KNYNEWYO2109": "UWS",
    "KNYNEWYO1686": "Tempest",
    "KNYNEWYO1596": "1596",
    "KNYNEWYO1931": "1931",
    "INEWYO2": "INEWYO2",
}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def fetch_pws_day(stn, date):
    url = (
        f"https://api.weather.com/v2/pws/history/hourly?stationId={stn}"
        f"&format=json&units=e&date={date.strftime('%Y%m%d')}&apiKey={API_KEY}&numericPrecision=decimal"
    )
    rows = []
    for obs in fetch(url).get("observations", []):
        rows.append(
            {
                "valid": pd.to_datetime(obs["obsTimeLocal"]),
                "station": stn,
                "avg": obs["imperial"]["tempAvg"],
                "high": obs["imperial"]["tempHigh"],
            }
        )
    return pd.DataFrame(rows)


def main():
    now = datetime.now(TZ).replace(tzinfo=None)
    start = now - timedelta(hours=48)

    url = (
        "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?"
        f"station=KNYC&data=tmpf&year1={start.year}&month1={start.month}&day1={start.day}"
        f"&hour1={start.hour}&year2={now.year}&month2={now.month}&day2={now.day}"
        f"&hour2={now.hour}&tz=America/New_York&format=onlycomma&latlon=no&elev=no"
        "&missing=M&trace=T&direct=no&report_type=3&report_type=4"
    )
    knyc = pd.read_csv(url)
    knyc["valid"] = pd.to_datetime(knyc["valid"])
    knyc_today = knyc[knyc["valid"].dt.date == now.date()].copy()

    print(f"Analysis: {now.strftime('%I:%M %p EDT, %b %d %Y')}\n")
    print("=== OFFICIAL KNYC TODAY ===")
    for _, r in knyc_today.tail(8).iterrows():
        print(f"  {r.valid.strftime('%I:%M %p')}: {r.tmpf:.0f}F")

    if len(knyc_today) >= 2:
        last = knyc_today.iloc[-1]
        prev = knyc_today.iloc[-2]
        print(f"  Last 2 official hours: {prev.tmpf:.0f}F -> {last.tmpf:.0f}F ({last.tmpf - prev.tmpf:+.0f}F)")

    # Build PWS history (today + yesterday for correlation)
    pws_frames = []
    for d in [now.date(), (now - timedelta(days=1)).date()]:
        for stn in PWS:
            df = fetch_pws_day(stn, datetime.combine(d, datetime.min.time()))
            if not df.empty:
                pws_frames.append(df)
    pws = pd.concat(pws_frames, ignore_index=True)
    pws["hour"] = pws["valid"].dt.round("h")

    knyc["hour"] = knyc["valid"].dt.round("h")
    ka = knyc.groupby("hour", as_index=False)["tmpf"].mean()
    pa = pws.groupby(["hour", "station"], as_index=False).agg(avg=("avg", "mean"))
    merged = pa.merge(ka, on="hour", how="inner")
    merged = merged[merged["hour"] >= start.replace(minute=0, second=0, microsecond=0)]

    stats = []
    for stn in PWS:
        sub = merged[merged["station"] == stn].dropna()
        if len(sub) < 6:
            continue
        slope, intercept = np.polyfit(sub["avg"], sub["tmpf"], 1)
        r = np.corrcoef(sub["avg"], sub["tmpf"])[0, 1]
        rmse = np.sqrt(np.mean((sub["tmpf"] - (slope * sub["avg"] + intercept)) ** 2))
        stats.append({"station": stn, "slope": slope, "intercept": intercept, "r": r, "rmse": rmse})
    sdf = pd.DataFrame(stats)
    sdf["w"] = sdf["r"] ** 2 / (sdf["rmse"] ** 2 + 0.01)
    sdf["w"] /= sdf["w"].sum()

    print("\n=== PWS CURRENT vs RECENT HOURS ===")
    cur_temps = {}
    for stn in PWS:
        obs = fetch(
            f"https://api.weather.com/v2/pws/observations/current?stationId={stn}"
            f"&format=json&units=e&apiKey={API_KEY}"
        )["observations"][0]
        cur = obs["imperial"]["temp"]
        t = pd.to_datetime(obs["obsTimeLocal"])
        cur_temps[stn] = cur
        h_now = t.round("h")
        parts = [f"now={cur:.0f}F"]
        for hrs_ago in [0, 1, 2, 3]:
            h = h_now - timedelta(hours=hrs_ago)
            m = pws[(pws["station"] == stn) & (pws["hour"] == h)]
            if not m.empty:
                parts.append(f"{h.strftime('%I%p')}={m['avg'].iloc[0]:.0f}")
        print(f"  {NAMES[stn]:8s} " + " | ".join(parts))

    print("\n=== INTERPOLATED KNYC (today, recent) ===")
    today_hours = sorted(pws[pws["valid"].dt.date == now.date()]["hour"].unique())
    est_rows = []
    for h in today_hours:
        sub = pws[pws["hour"] == h]
        ests = []
        for _, row in sub.iterrows():
            st = sdf[sdf["station"] == row["station"]]
            if st.empty:
                continue
            st = st.iloc[0]
            ests.append(st["slope"] * row["avg"] + st["intercept"])
        if ests:
            est_rows.append((h, np.average(ests), min(ests), max(ests)))

    for h, mn, lo, hi in est_rows[-6:]:
        print(f"  {h.strftime('%I:%M %p')}: {mn:.1f}F ({lo:.0f}-{hi:.0f})")

    now_ests = []
    for stn, cur in cur_temps.items():
        st = sdf[sdf["station"] == stn].iloc[0]
        now_ests.append(st["slope"] * cur + st["intercept"])
    now_est = np.average(now_ests)
    print(f"  NOW: {now_est:.1f}F ({min(now_ests):.0f}-{max(now_ests):.0f})")

    if len(est_rows) >= 3:
        vals = [x[1] for x in est_rows[-4:]]
        print(f"\n=== INTERPOLATED TREND ===")
        print(f"  Last 4 hourly estimates: {' -> '.join(f'{v:.1f}' for v in vals)}")
        print(f"  Net change (4hr): {vals[-1] - vals[0]:+.1f}F")
        if len(est_rows) >= 2:
            peak_h, peak_v = max(est_rows, key=lambda x: x[1])[:2]
            print(f"  Interpolated peak: {peak_v:.1f}F at {peak_h.strftime('%I:%M %p')}")
            print(f"  Since peak: {now_est - peak_v:+.1f}F")

    print("\n=== PWS: PEAK TODAY vs NOW ===")
    cooling = flat = warming = 0
    for stn in PWS:
        td = pws[(pws["station"] == stn) & (pws["valid"].dt.date == now.date())]
        if td.empty:
            continue
        peak = td["high"].max()
        cur = cur_temps[stn]
        diff = cur - peak
        if diff <= -1:
            status, cooling = "COOLING", cooling + 1
        elif diff >= 1:
            status, warming = "WARMING", warming + 1
        else:
            status, flat = "FLAT", flat + 1
        print(f"  {NAMES[stn]:8s} peak={peak:.0f}F  now={cur:.0f}F  ({diff:+.0f}F)  {status}")
    print(f"  => {cooling} cooling, {flat} flat, {warming} still near peak")

    # Verdict
    print("\n=== VERDICT ===")
    off_down = len(knyc_today) >= 2 and knyc_today.iloc[-1].tmpf <= knyc_today.iloc[-2].tmpf
    interp_down = len(est_rows) >= 2 and now_est < est_rows[-1][1]
    since_peak = len(est_rows) >= 2 and now_est < max(x[1] for x in est_rows) - 0.3
    pws_cooling = cooling >= 3

    if since_peak and pws_cooling:
        verdict = "YES - likely peaking/cooling"
        hold = "Moderate confidence it holds short-term; afternoon sun could still bump temps back up briefly."
    elif since_peak or pws_cooling:
        verdict = "MAYBE - early cooling signal"
        hold = "Too early to call; plateau more likely than sustained drop until mid-afternoon."
    elif flat >= 4:
        verdict = "PLATEAU - not clearly falling yet"
        hold = "Temps appear stuck near daily max; decline usually starts 2-4pm in NYC heat events."
    else:
        verdict = "NO - still near peak"
        hold = "Stations haven't rolled over yet."

    print(f"  Trending down? {verdict}")
    print(f"  Will it hold? {hold}")


if __name__ == "__main__":
    main()