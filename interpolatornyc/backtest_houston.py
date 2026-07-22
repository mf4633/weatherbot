"""14-day backtest: PWS-interpolated KHOU daily max vs actual CLIHOU settlement high.

Method per day D (Jul 7-20):
  1. Calibrate at 12:00 local: recency-weighted PWS->KHOU regressions on prior 48h
     (KHOU METARs paired with PWS tempHigh in each preceding-hour window).
  2. Predict day-D max: per-station regression estimates from PWS tempHigh for
     each hour-end 09:53-20:53, weighted by r^2/RMSE^2, + learned peak bias;
     prediction = max over hour-ends.
  3. Ground truth: CLIHOU high from IEM's CLI archive (the Kalshi settlement value).
Buckets are Kalshi-style even 2-degree pairs (98-99 -> anchor 98).
"""
import sys
from datetime import date, datetime, timedelta

from pathlib import Path as _P
sys.path.insert(0, str(_P(__file__).resolve().parents[1]))  # parent of the package dir

import json
import urllib.request

import numpy as np
import pandas as pd

import interpolatornyc.core as core

CITY_PWS = {
    "KTXHOUST4910": "Houston 4910",
    "KTXSOUTH79": "South Houston 79",
    "KTXSOUTH173": "South Houston 173",
    "KTXHOUST4608": "Houston 4608",
    "KTXHOUST3557": "Houston 3557",
    "KTXHOUST5249": "Houston 5249",
    "KTXHOUST5216": "Houston 5216",
}
core.PWS_STATIONS.clear()
core.PWS_STATIONS.update(CITY_PWS)

from interpolatornyc.calibration import (  # noqa: E402
    apply_peak_bias,
    compute_station_stats,
    fit_peak_bias,
)
from interpolatornyc.core import merge_knyc_pws_periods  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
API_KEY = core.API_KEY

FIRST_DAY = date(2026, 7, 7)
LAST_DAY = date(2026, 7, 20)
FETCH_START = datetime(2026, 7, 4, 12, 0)
FETCH_END = datetime(2026, 7, 21, 0, 0)


def fetch_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


print("Fetching KHOU METARs (IEM, one call)...")
url = (
    "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?"
    f"station=HOU&data=tmpf&year1={FETCH_START.year}&month1={FETCH_START.month}&day1={FETCH_START.day}"
    f"&hour1=0&year2={FETCH_END.year}&month2={FETCH_END.month}&day2={FETCH_END.day}"
    f"&hour2=23&tz=America/Chicago&format=onlycomma&latlon=no&elev=no"
    "&missing=M&trace=T&direct=no&report_type=3&report_type=4"
)
khou = pd.read_csv(url)
khou["valid"] = pd.to_datetime(khou["valid"])
khou = khou.rename(columns={"tmpf": "temp_f"})
khou["temp_f"] = pd.to_numeric(khou["temp_f"], errors="coerce")
khou = khou.dropna(subset=["temp_f"])[["valid", "temp_f"]]
print(f"  {len(khou)} obs")

print("Fetching CLIHOU settlement highs (IEM CLI archive)...")
cli = fetch_json("https://mesonet.agron.iastate.edu/json/cli.py?station=KHOU&year=2026")
cli_high = {}
for r in cli["results"]:
    d = r["valid"]
    if r.get("high") is not None:
        cli_high[d] = r["high"]

print("Fetching PWS hourly history (tempHigh), 7 stations x 17 days...")
pws_frames = []
for stn in CITY_PWS:
    d = FETCH_START.date()
    n = 0
    while d <= LAST_DAY:
        u = (
            f"https://api.weather.com/v2/pws/history/hourly?stationId={stn}"
            f"&format=json&units=e&date={d.strftime('%Y%m%d')}&apiKey={API_KEY}&numericPrecision=decimal"
        )
        try:
            data = fetch_json(u)
            for obs in data.get("observations", []):
                v = obs["imperial"]["tempHigh"]
                if v is None:
                    continue
                pws_frames.append(
                    {"valid": pd.to_datetime(obs["obsTimeLocal"]), "station": stn, "temp_f": v}
                )
                n += 1
        except Exception:
            pass
        d += timedelta(days=1)
    print(f"  {stn}: {n} hourly obs")
pws_all = pd.DataFrame(pws_frames)

print("\nBacktesting...\n")
results = []
for i in range((LAST_DAY - FIRST_DAY).days + 1):
    day = FIRST_DAY + timedelta(days=i)
    fit_now = datetime.combine(day, datetime.min.time()) + timedelta(hours=12)
    train_start = fit_now - timedelta(hours=48)

    k_train = khou[(khou["valid"] >= train_start) & (khou["valid"] <= fit_now)]
    p_train = pws_all[(pws_all["valid"] >= train_start) & (pws_all["valid"] <= fit_now)]
    merged = merge_knyc_pws_periods(k_train, p_train)
    if merged.empty:
        continue

    stats = []
    for stn in CITY_PWS:
        s = compute_station_stats(merged, stn, fit_now)
        if s:
            stats.append(s)
    if not stats:
        continue
    stats_df = pd.DataFrame(stats)
    peak_bias = fit_peak_bias(merged, stats_df, fit_now)

    # Predict day max from PWS tempHigh, hour-ends 09:53-20:53 local
    day0 = datetime.combine(day, datetime.min.time())
    hourly_est = []
    for h in range(9, 21):
        end = day0 + timedelta(hours=h, minutes=53)
        start = end - timedelta(hours=1)
        win = pws_all[(pws_all["valid"] > start) & (pws_all["valid"] <= end)]
        ests, ws = [], []
        for stn, grp in win.groupby("station"):
            row = stats_df[stats_df["station"] == stn]
            if row.empty:
                continue
            row = row.iloc[0]
            proxy = grp["temp_f"].max()
            est = apply_peak_bias(row["slope"] * proxy + row["intercept"], proxy, peak_bias)
            ests.append(est)
            ws.append(row["r"] ** 2 / (row["rmse"] ** 2 + 0.01))
        if ests:
            w = np.array(ws) / np.sum(ws)
            hourly_est.append(float(np.dot(ests, w)))
    if not hourly_est:
        continue
    pred = max(hourly_est)

    actual = cli_high.get(day.isoformat())
    metar_max = khou[(khou["valid"] >= day0) & (khou["valid"] < day0 + timedelta(days=1))]["temp_f"].max()
    results.append(
        {
            "day": day.isoformat(),
            "pred": pred,
            "cli_high": actual,
            "metar_max": metar_max,
            "n_stn": len(stats_df),
            "peak_bias": peak_bias,
        }
    )

df = pd.DataFrame(results)
df["err"] = df["pred"] - df["cli_high"]
df["pred_r"] = df["pred"].round().astype(int)
df["bucket_pred"] = (df["pred_r"] // 2) * 2
df["bucket_act"] = (df["cli_high"] // 2) * 2
df["bucket_hit"] = df["bucket_pred"] == df["bucket_act"]
df["within1"] = df["err"].abs() <= 1.0

print(f"{'day':12s} {'pred':>6s} {'CLI':>4s} {'METARmax':>8s} {'err':>6s} {'bucket':>10s} {'hit':>4s}")
for _, r in df.iterrows():
    print(
        f"{r['day']:12s} {r['pred']:6.1f} {r['cli_high']:4.0f} {r['metar_max']:8.0f} "
        f"{r['err']:+6.1f} {int(r['bucket_pred']):>4d}v{int(r['bucket_act']):<4d} "
        f"{'Y' if r['bucket_hit'] else '.':>3s}"
    )

print()
print(f"Days: {len(df)}")
print(f"MAE:  {df['err'].abs().mean():.2f}F   bias: {df['err'].mean():+.2f}F")
print(f"Within 1F of CLI high: {df['within1'].sum()}/{len(df)} ({df['within1'].mean():.0%})")
print(f"Kalshi 2-deg bucket hit: {df['bucket_hit'].sum()}/{len(df)} ({df['bucket_hit'].mean():.0%})")
print(f"CLI high vs METAR max mismatch days: {(df['cli_high'] != df['metar_max']).sum()}")
