"""Rigorous 30-day walk-forward backtest: PWS-interpolated KLAX daily max vs CLI
settlement high (the Kalshi truth), with per-station attribution to derive weights.

Per day D:
  1. Calibrate at 12:00 local on the prior 48h (recency-weighted PWS->KLAX
     regressions, tool-faithful: merge_knyc_pws_periods + compute_station_stats).
  2. Predict day-D max = max over hour-end windows 09:53-20:53 of the weighted
     per-station regression estimates (weights r^2/rmse^2 + learned peak bias).
  3. Truth = CLI LAX high from IEM's CLI archive.

Station attribution:
  - SOLO: each station alone as the whole ensemble.
  - LOO:  ensemble with that station left out (delta vs full = its contribution).
  - Regime split: marine-capped days (CLI high < 78) vs clear days (>= 78) —
    LAX bucket trades live or die on the capped days, so weight for those.

Output: per-station table + suggested WEIGHT_MULT (inverse solo-MSE, capped-day
weighted, normalized) for run_lax.py.

PWS history is cached to _cache_lax_pws.csv next to this script (231 API calls
on the first run, threaded; free afterward).
"""
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

from pathlib import Path as _P
sys.path.insert(0, str(_P(__file__).resolve().parents[1]))  # parent of the package dir

import json
import urllib.request

import numpy as np
import pandas as pd

import interpolatornyc.core as core

CITY_PWS = {
    "KCAELSEG28": "El Segundo 28",
    "KCALOSAN958": "Los Angeles 958",
    "KCALOSAN961": "Los Angeles 961",
    "KCAELSEG23": "El Segundo 23",
    "KCALOSAN1102": "Los Angeles 1102",
    "KCALOSAN698": "Los Angeles 698",
    "KCAHAWTH17": "Hawthorne 17",
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

LAST_DAY = date(2026, 7, 21)          # last fully settled day
FIRST_DAY = LAST_DAY - timedelta(days=29)
FETCH_START = datetime.combine(FIRST_DAY - timedelta(days=3), datetime.min.time()) + timedelta(hours=12)
FETCH_END = datetime.combine(LAST_DAY + timedelta(days=1), datetime.min.time())
CACHE = Path(__file__).with_name("_cache_lax_pws.csv")


def fetch_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


print("Fetching KLAX METARs (IEM, one call)...")
url = (
    "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?"
    f"station=LAX&data=tmpf&year1={FETCH_START.year}&month1={FETCH_START.month}&day1={FETCH_START.day}"
    f"&hour1=0&year2={FETCH_END.year}&month2={FETCH_END.month}&day2={FETCH_END.day}"
    f"&hour2=23&tz=America/Los_Angeles&format=onlycomma&latlon=no&elev=no"
    "&missing=M&trace=T&direct=no&report_type=3&report_type=4"
)
klax = pd.read_csv(url)
klax["valid"] = pd.to_datetime(klax["valid"])
klax = klax.rename(columns={"tmpf": "temp_f"})
klax["temp_f"] = pd.to_numeric(klax["temp_f"], errors="coerce")
klax = klax.dropna(subset=["temp_f"])[["valid", "temp_f"]]
print(f"  {len(klax)} obs")

print("Fetching CLI LAX settlement highs (IEM CLI archive)...")
cli = fetch_json("https://mesonet.agron.iastate.edu/json/cli.py?station=KLAX&year=2026")
cli_high = {}
for r in cli["results"]:
    if r.get("high") is not None:
        cli_high[r["valid"]] = r["high"]
print(f"  {len(cli_high)} settled days")

if CACHE.exists():
    pws_all = pd.read_csv(CACHE, parse_dates=["valid"])
    print(f"PWS cache hit: {len(pws_all)} rows from {CACHE.name}")
else:
    print(f"Fetching PWS hourly history, {len(CITY_PWS)} stations x {(LAST_DAY - FETCH_START.date()).days + 1} days (threaded)...")

    def fetch_day(args):
        stn, d = args
        u = (
            f"https://api.weather.com/v2/pws/history/hourly?stationId={stn}"
            f"&format=json&units=e&date={d.strftime('%Y%m%d')}&apiKey={API_KEY}&numericPrecision=decimal"
        )
        rows = []
        try:
            for obs in fetch_json(u).get("observations", []):
                v = obs["imperial"]["tempHigh"]
                if v is not None:
                    rows.append({"valid": obs["obsTimeLocal"], "station": stn, "temp_f": v})
        except Exception:
            pass
        return rows

    jobs = []
    for stn in CITY_PWS:
        d = FETCH_START.date()
        while d <= LAST_DAY:
            jobs.append((stn, d))
            d += timedelta(days=1)
    frames = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for rows in ex.map(fetch_day, jobs):
            frames.extend(rows)
    pws_all = pd.DataFrame(frames)
    pws_all["valid"] = pd.to_datetime(pws_all["valid"])
    pws_all.to_csv(CACHE, index=False)
    print(f"  {len(pws_all)} rows cached to {CACHE.name}")
for stn in CITY_PWS:
    n = (pws_all["station"] == stn).sum()
    print(f"  {stn}: {n} hourly obs")


def predict_day(day, stations):
    """Walk-forward one day using only `stations`. Returns pred or None."""
    fit_now = datetime.combine(day, datetime.min.time()) + timedelta(hours=12)
    train_start = fit_now - timedelta(hours=48)
    k_train = klax[(klax["valid"] >= train_start) & (klax["valid"] <= fit_now)]
    p_train = pws_all[(pws_all["valid"] >= train_start) & (pws_all["valid"] <= fit_now)
                      & pws_all["station"].isin(stations)]
    merged = merge_knyc_pws_periods(k_train, p_train)
    if merged.empty:
        return None
    stats = [s for s in (compute_station_stats(merged, stn, fit_now) for stn in stations) if s]
    if not stats:
        return None
    stats_df = pd.DataFrame(stats)
    peak_bias = fit_peak_bias(merged, stats_df, fit_now)
    day0 = datetime.combine(day, datetime.min.time())
    hourly_est = []
    for h in range(9, 21):
        end = day0 + timedelta(hours=h, minutes=53)
        win = pws_all[(pws_all["valid"] > end - timedelta(hours=1)) & (pws_all["valid"] <= end)
                      & pws_all["station"].isin(stations)]
        ests, ws = [], []
        for stn, grp in win.groupby("station"):
            row = stats_df[stats_df["station"] == stn]
            if row.empty:
                continue
            row = row.iloc[0]
            proxy = grp["temp_f"].max()
            ests.append(apply_peak_bias(row["slope"] * proxy + row["intercept"], proxy, peak_bias))
            ws.append(row["r"] ** 2 / (row["rmse"] ** 2 + 0.01))
        if ests:
            w = np.array(ws) / np.sum(ws)
            hourly_est.append(float(np.dot(ests, w)))
    return max(hourly_est) if hourly_est else None


all_stns = list(CITY_PWS)
days = [FIRST_DAY + timedelta(days=i) for i in range((LAST_DAY - FIRST_DAY).days + 1)]
days = [d for d in days if d.isoformat() in cli_high]
print(f"\nBacktesting {len(days)} settled days ({days[0]} .. {days[-1]})...\n")

rows = []
for day in days:
    actual = cli_high[day.isoformat()]
    rec = {"day": day.isoformat(), "cli": actual, "full": predict_day(day, all_stns)}
    for stn in all_stns:
        rec[f"solo_{stn}"] = predict_day(day, [stn])
        rec[f"loo_{stn}"] = predict_day(day, [s for s in all_stns if s != stn])
    rows.append(rec)
    print(f"  {day} CLI={actual:.0f} full={rec['full'] and round(rec['full'], 1)}")

df = pd.DataFrame(rows)
df["marine"] = df["cli"] < 78          # capped-day regime (the tradeable one)


def mae(pred_col, mask=None):
    d = df if mask is None else df[mask]
    e = (d[pred_col] - d["cli"]).abs()
    return e.mean(), len(e.dropna())


def bucket_hit(pred_col, mask=None):
    d = (df if mask is None else df[mask]).dropna(subset=[pred_col])
    p = (d[pred_col].round().astype(int) // 2) * 2
    a = (d["cli"].astype(int) // 2) * 2
    return (p == a).mean() if len(d) else float("nan")


full_mae, n = mae("full")
print(f"\n=== FULL ensemble ({n} days) ===")
print(f"MAE {full_mae:.2f}F  bias {(df['full'] - df['cli']).mean():+.2f}F  "
      f"within1 {((df['full'] - df['cli']).abs() <= 1).mean():.0%}  bucket {bucket_hit('full'):.0%}")

# --- walk-forward CLI-settlement debias -----------------------------------------
# The regression is trained on METARs, but Kalshi settles on CLI (continuous max);
# CLI > METAR-max most days, so the raw prediction runs systematically low. Learn
# the offset walk-forward: rolling mean of (pred - cli) over the PRIOR 10 settled
# days (no lookahead), applied to day D.
df["offset"] = (df["full"] - df["cli"]).shift(1).rolling(10, min_periods=5).mean()
df["debiased"] = df["full"] - df["offset"]
db = df.dropna(subset=["debiased"])
db_err = db["debiased"] - db["cli"]
print(f"\n=== DEBIASED (rolling 10-day offset, walk-forward, {len(db)} days) ===")
print(f"MAE {db_err.abs().mean():.2f}F  bias {db_err.mean():+.2f}F  "
      f"within1 {(db_err.abs() <= 1).mean():.0%}  bucket {bucket_hit('debiased'):.0%}")
print(f"marine bucket {bucket_hit('debiased', df['marine']):.0%}  "
      f"clear bucket {bucket_hit('debiased', ~df['marine']):.0%}  "
      f"(offset ranged {df['offset'].min():+.1f} .. {df['offset'].max():+.1f})")
m_mae, mn = mae("full", df["marine"])
c_mae, cn = mae("full", ~df["marine"])
print(f"marine-capped days (CLI<78, n={mn}): MAE {m_mae:.2f}  bucket {bucket_hit('full', df['marine']):.0%}")
print(f"clear days        (CLI>=78, n={cn}): MAE {c_mae:.2f}  bucket {bucket_hit('full', ~df['marine']):.0%}")

print(f"\n=== Per-station attribution ===")
print(f"{'station':14s} {'soloMAE':>8s} {'soloMar':>8s} {'looMAE':>7s} {'looDelta':>9s}  verdict")
sug = {}
for stn in all_stns:
    s_mae, s_n = mae(f"solo_{stn}")
    # Solo error is bias-dominated like the ensemble — score stations on their
    # DEBIASED solo error (subtract each station's own mean error) so the shared
    # CLI-settlement offset doesn't drown the between-station signal.
    solo_err = (df[f"solo_{stn}"] - df["cli"]).dropna()
    if not len(solo_err):
        print(f"{stn:14s} {'--':>8s} {'--':>8s} {'--':>7s} {'--':>9s}  DROP (no history)")
        continue
    resid = solo_err - solo_err.mean()
    mar_mask = df["marine"].reindex(solo_err.index)
    resid_mar = resid[mar_mask.fillna(False)]
    s_mar = resid_mar.abs().mean() if len(resid_mar) else resid.abs().mean()
    l_mae, _ = mae(f"loo_{stn}")
    delta = l_mae - full_mae            # >0: removing it HURTS (station helps)
    score = 1.0 / (0.7 * s_mar ** 2 + 0.3 * resid.abs().mean() ** 2 + 0.05)
    sug[stn] = score
    verdict = "KEEP" if delta > -0.02 else ("DROP?" if delta < -0.10 else "neutral")
    print(f"{stn:14s} {s_mae:8.2f} {s_mar:8.2f} {l_mae:7.2f} {delta:+9.2f}  {verdict}"
          f"   (debiased-resid MAE {resid.abs().mean():.2f})")

mean_score = np.mean(list(sug.values()))
print(f"\nSuggested WEIGHT_MULT (marine-weighted inverse debiased solo-MSE, mean=1):")
for stn, sc in sorted(sug.items(), key=lambda kv: -kv[1]):
    print(f'    "{stn}": {sc / mean_score:.2f},')

drop = [stn for stn in all_stns if (mae(f"loo_{stn}")[0] - full_mae) < -0.10]
if drop:
    keep = [s for s in all_stns if s not in drop]
    preds = {d: predict_day(date.fromisoformat(d), keep) for d in df["day"]}
    df["trimmed"] = df["day"].map(preds)
    t_mae, _ = mae("trimmed")
    t_mar, _ = mae("trimmed", df["marine"])
    print(f"\nTrimmed ensemble (dropping {', '.join(drop)}):")
    print(f"MAE {t_mae:.2f} (full {full_mae:.2f})  marine {t_mar:.2f} (full {m_mae:.2f})  "
          f"bucket {bucket_hit('trimmed'):.0%} (full {bucket_hit('full'):.0%})")
else:
    print("\nNo station's removal improves the ensemble by >0.10F — keep all 7.")

print(f"\nCLI vs METAR-max gap days: "
      f"{sum(1 for d in days if cli_high[d.isoformat()] != klax[(klax['valid'] >= datetime.combine(d, datetime.min.time())) & (klax['valid'] < datetime.combine(d + timedelta(days=1), datetime.min.time()))]['temp_f'].max())}"
      f" of {len(days)}")
