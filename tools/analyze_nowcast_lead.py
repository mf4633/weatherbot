#!/usr/bin/env python3
r"""DEFINITIVE lead test: does the PWS nowcast at :50 (pre-METAR) know the settlement
direction that the :50 MARKET PRICE does not?

For each (city, day, daytime hour h):
  - nowcast_peak@:50  reconstructed from PWS up to h:50 (calibrate on prior 48h)   [interpolatornyc]
  - implied@:50       market-implied high from 1-min candles at h:50               [weatherbot backfill]
  - settle            settling-bucket center                                       [candles]
Signals & tests (TRAIN early dates / TEST late, no peeking):
  - edge = nowcast_peak@:50 - implied@:50   (we think high is above/below the market)
  - market_err = settle - implied@:50
  - corr(edge, market_err): does the nowcast predict what the market got wrong?
  - market convergence: does implied move TOWARD the nowcast over the next hour?
  - fee-aware directional P&L on TEST: bet when |edge|>=EDGE_F, hold to settle,
    price the 'settle above implied' event at 0.5, pay taker fee.

Run:  PYTHONUTF8=1 python tools/analyze_nowcast_lead.py --dir data/backfill
"""
import sys, os, glob, json, re, math
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from zoneinfo import ZoneInfo
import numpy as np
import pandas as pd

INTERP = r"C:\Users\michael.flynn\interpolatornyc"
sys.path.insert(0, os.path.dirname(INTERP))   # import interpolatornyc.*
sys.path.insert(0, INTERP)                     # import backtest_all
import interpolatornyc.core as core
from interpolatornyc.core import merge_knyc_pws_periods
from interpolatornyc.calibration import (compute_station_stats, fit_peak_bias, apply_peak_bias,
                                         fit_hourly_bias, hourly_bias)
import backtest_all as B
from interpolatornyc.cities import BY_CLI

SERIES_CLI = {
    "KXHIGHNY": "NYC", "KXHIGHLAX": "LAX", "KXHIGHDEN": "DEN", "KXHIGHTBOS": "BOS",
    "KXHIGHTHOU": "HOU", "KXHIGHCHI": "MDW", "KXHIGHTPHX": "PHX", "KXHIGHTDAL": "DFW",
    "KXHIGHTSEA": "SEA",
}
MON = {m: i + 1 for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}

# NWS forecast high per (cli,date,hour) from the staged Claude-decision dump.
_CDEC = os.path.join(INTERP, "research", "_data", "cdec")
nws_by = {}
if os.path.isdir(_CDEC):
    for _f in glob.glob(os.path.join(_CDEC, "*.json")):
        for _d in json.load(open(_f)).get("decs", []):
            if _d.get("nws") is not None:
                nws_by[(_d.get("cli"), _d.get("date"), _d.get("hour"))] = _d["nws"]


def nws_lookup(cli, date_iso, hour):
    """NWS forecast high; fall back to the nearest logged hour that day."""
    v = nws_by.get((cli, date_iso, hour))
    if v is not None:
        return v
    cand = [(abs(h - hour), h) for (c, d, h) in nws_by if c == cli and d == date_iso]
    if cand:
        return nws_by[(cli, date_iso, min(cand)[1])]
    return None


def centre(floor, cap):
    if floor is not None and cap is not None: return (floor + cap) / 2
    if floor is None and cap is not None: return cap - 1
    if floor is not None and cap is None: return floor + 1
    return None


def parse_day(code):  # 26JUL11 -> date(2026,7,11)
    m = re.match(r"(\d{2})([A-Z]{3})(\d{2})", code)
    if not m: return None
    return datetime(2000 + int(m.group(1)), MON[m.group(2)], int(m.group(3))).date()


# ---- load candles: (series,day) -> minute -> implied ; + settle center ------
argv = sys.argv[1:]
files = sorted(glob.glob(os.path.join(argv[argv.index("--dir") + 1], "*.jsonl"))) if "--dir" in argv \
    else [a for a in argv if a.endswith(".jsonl")]
book_min = defaultdict(lambda: defaultdict(list))
final_px = defaultdict(dict)
for f in files:
    for line in open(f, encoding="utf-8"):
        if not line.strip(): continue
        try: r = json.loads(line)
        except Exception: continue
        if not r.get("ts") or not r.get("ticker") or r["series"] not in SERIES_CLI: continue
        key = (r["series"], daycode := re.search(r"-(\d{2}[A-Z]{3}\d{2})-", r["ticker"]).group(1))
        book_min[key][r["ts"][:16]].append(r)
        c = centre(r.get("floor"), r.get("cap"))
        if c is not None:
            mid = ((r.get("yes_bid") or 0) + (r.get("yes_ask") or 0)) / 2
            p = final_px[key].get(r["ticker"])
            if p is None or r["ts"] > p[0]:
                final_px[key][r["ticker"]] = (r["ts"], mid, c)


def implied_at(key, minute_iso):
    rows = book_min[key].get(minute_iso)
    if not rows: return None
    w = acc = 0.0
    for r in rows:
        c = centre(r.get("floor"), r.get("cap"))
        if c is None: continue
        p = ((r.get("yes_bid") or 0) + (r.get("yes_ask") or 0)) / 2
        if p <= 0: continue
        w += p; acc += p * c
    return acc / w if w > 0 else None


def settle_of(key):
    best = None
    for tk, (ts, mid, c) in final_px[key].items():
        if best is None or mid > best[0]: best = (mid, c)
    return best[1] if best and best[0] >= 0.6 else None


# ---- 5-minute PWS fetch (history/all, tempAvg) with disk cache -------------
import urllib.request, time as _time
_C5 = os.path.join(INTERP, "_cache_5min"); os.makedirs(_C5, exist_ok=True)
_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def fetch_pws_5min(station, start_day, last_day):
    rows = []
    d = start_day
    while d <= last_day:
        ds = d.strftime("%Y%m%d")
        fp = os.path.join(_C5, f"{station}_{ds}.json")
        data = None
        if os.path.exists(fp):
            try: data = json.load(open(fp))
            except Exception: data = None
        else:
            url = (f"https://api.weather.com/v2/pws/history/all?stationId={station}"
                   f"&format=json&units=e&date={ds}&apiKey={core.API_KEY}&numericPrecision=decimal")
            for _a in range(4):
                try:
                    req = urllib.request.Request(url, headers=_UA)
                    with urllib.request.urlopen(req, timeout=30) as r:
                        txt = r.read().decode()
                    json.loads(txt)  # validate
                    open(fp, "w").write(txt); data = json.loads(txt); _time.sleep(0.15); break
                except Exception:
                    _time.sleep(2)
        if data:
            for o in data.get("observations", []):
                t = (o.get("imperial") or {}).get("tempAvg")
                if t is None: continue
                rows.append({"valid": pd.to_datetime(o["obsTimeLocal"]), "station": station, "temp_f": t})
        d += timedelta(days=1)
    return rows


# ---- nowcast reconstruction as-of an arbitrary datetime --------------------
_frames = {}
def frames(cli):
    if cli in _frames: return _frames[cli]
    city = BY_CLI[cli]
    stp = os.path.join(INTERP, "stations", f"{cli}.json")
    curated = json.load(open(stp)).get("curated", []) if os.path.exists(stp) else []
    if not curated: _frames[cli] = None; return None
    core.PWS_STATIONS.clear(); core.PWS_STATIONS.update({s: s for s in curated})
    asos = B.fetch_asos_hourly(city)
    rows = []           # hourly PWS tempHigh -> calibration
    for sid in curated: rows.extend(B.fetch_pws_history(city, sid))
    pws = pd.DataFrame(rows) if rows else pd.DataFrame(columns=["valid", "station", "temp_f"])
    r5 = []             # 5-min PWS tempAvg -> between-METAR nowcast evaluation
    for sid in curated:
        r5.extend(fetch_pws_5min(sid, B.FETCH_START.date(), B.LAST_DAY))
    pws5 = pd.DataFrame(r5) if r5 else pd.DataFrame(columns=["valid", "station", "temp_f"])
    _frames[cli] = (curated, asos, pws, pws5)
    return _frames[cli]


def nowcast_peak_asof(cli, fit_now):
    fr = frames(cli)
    if fr is None: return None
    curated, asos, pws, pws5 = fr
    core.PWS_STATIONS.clear(); core.PWS_STATIONS.update({s: s for s in curated})
    tstart = fit_now - timedelta(hours=48)
    k = asos[(asos["valid"] >= tstart) & (asos["valid"] <= fit_now)]
    p = pws[(pws["valid"] >= tstart) & (pws["valid"] <= fit_now) & (pws["station"].isin(curated))]
    merged = merge_knyc_pws_periods(k, p)
    if merged.empty: return None
    stats = [s for s in (compute_station_stats(merged, sid, fit_now) for sid in curated) if s]
    if not stats: return None
    sdf = pd.DataFrame(stats); pb = fit_peak_bias(merged, sdf, fit_now)
    # Hour-of-day offset (weighted regression + peak_bias + diurnal residual; a4a20ad),
    # fit on the hourly ASOS<-PWS pairs, then APPLIED to the 5-min PWS readings so the
    # nowcast captures the true temperature BETWEEN METARs.
    coefs = fit_hourly_bias(merged, sdf, fit_now, pb)
    day0 = fit_now.replace(hour=0, minute=0, second=0, microsecond=0)
    p5 = pws5[pws5["station"].isin(curated)]

    def latest5(sid, when, lookback_min=20):
        w = p5[(p5["station"] == sid) & (p5["valid"] <= when)
               & (p5["valid"] > when - timedelta(minutes=lookback_min))]
        return w.sort_values("valid")["temp_f"].iloc[-1] if len(w) else None

    def max5(sid, when):
        w = p5[(p5["station"] == sid) & (p5["valid"] <= when) & (p5["valid"] >= day0)]
        return w["temp_f"].max() if len(w) else None

    now_es, now_ws, pk_es, pk_ws = [], [], [], []
    for sid in curated:
        row = sdf[sdf["station"] == sid]
        if row.empty: continue
        row = row.iloc[0]
        wt = row["r"] ** 2 / (row["rmse"] ** 2 + 0.01)
        cur = latest5(sid, fit_now)
        if cur is not None:
            now_es.append(apply_peak_bias(row["slope"] * cur + row["intercept"], cur, pb)
                          + hourly_bias(coefs, sid, fit_now))
            now_ws.append(wt)
        mx = max5(sid, fit_now)
        if mx is not None:
            pk_es.append(apply_peak_bias(row["slope"] * mx + row["intercept"], mx, pb))
            pk_ws.append(wt)
    now_temp = float(np.dot(now_es, np.array(now_ws) / np.sum(now_ws))) if now_es else None
    peak = float(np.dot(pk_es, np.array(pk_ws) / np.sum(pk_ws))) if pk_es else None
    if now_temp is not None and peak is not None:
        peak = max(peak, now_temp)
    return peak, now_temp


# ---- join + test -----------------------------------------------------------
rows = []
for key in book_min:
    series, dcode = key
    cli = SERIES_CLI[series]
    if cli not in BY_CLI: continue
    day = parse_day(dcode)
    if day is None: continue
    settle = settle_of(key)
    if settle is None: continue
    tz = ZoneInfo(B.BY_CLI[cli].tz) if hasattr(B, "BY_CLI") else ZoneInfo(BY_CLI[cli].tz)
    for h in range(9, 20):
        # local hour h -> UTC minute :50
        local_dt = datetime(day.year, day.month, day.day, h, 50, tzinfo=tz)
        utc = local_dt.astimezone(timezone.utc)
        minute_iso = utc.strftime("%Y-%m-%dT%H:%M")
        imp = implied_at(key, minute_iso)
        if imp is None: continue
        res = nowcast_peak_asof(cli, datetime(day.year, day.month, day.day, h, 50))
        if res is None: continue
        nc, nc_now = res
        if nc is None: continue
        # market price 1h later (convergence check)
        utc2 = (local_dt + timedelta(hours=1)).astimezone(timezone.utc)
        imp_next = implied_at(key, utc2.strftime("%Y-%m-%dT%H:%M"))
        # capture the tradeable bucket ladder at :50 (floor,cap,yes_ask,yes_bid)
        ladder = []
        for r in book_min[key].get(minute_iso, []):
            c = centre(r.get("floor"), r.get("cap"))
            if c is None: continue
            ladder.append({"floor": r.get("floor"), "cap": r.get("cap"), "centre": c,
                           "yes_ask": r.get("yes_ask"), "yes_bid": r.get("yes_bid")})
        rows.append({"cli": cli, "date": day.isoformat(), "hour": h,
                     "implied": imp, "nowcast": nc, "nowcast_now": nc_now, "settle": settle,
                     "implied_next": imp_next,
                     "nws": nws_lookup(cli, day.isoformat(), h),
                     "ladder": ladder})

df = pd.DataFrame(rows)
print(f"joined rows: {len(df)}   cities: {sorted(df['cli'].unique()) if len(df) else []}")
if df.empty:
    sys.exit(0)
# dump joined rows (with ladder) for the real-spread bucket backtest
json.dump(rows, open(os.path.join(os.path.dirname(__file__), "_lead_rows.json"), "w"))
print(f"dumped {len(rows)} rows -> tools/_lead_rows.json")
df["edge"] = df["nowcast"] - df["implied"]
df["mkt_err"] = df["settle"] - df["implied"]
df["mkt_move"] = df["implied_next"] - df["implied"]

dates = sorted(df["date"].unique())
cut = dates[int(len(dates) * 0.6)]
tr, te = df[df["date"] < cut], df[df["date"] >= cut]
print(f"TRAIN {len(tr)} (<{cut})  TEST {len(te)} (>={cut})")
print(f"\nmarket |err| vs settle @ :50 = {df['mkt_err'].abs().mean():.3f}F   "
      f"edge std = {df['edge'].std():.2f}F")

def rep(name, a, b):
    m = pd.concat([a, b], axis=1).dropna()
    if len(m) < 20 or m.iloc[:, 0].std() == 0: return
    c = m.iloc[:, 0].corr(m.iloc[:, 1])
    print(f"  {name:32s} corr={c:+.3f}  n={len(m)}")

print("\nTRAIN:")
rep("edge -> market_err (predict truth)", tr["edge"], tr["mkt_err"])
rep("edge -> market_move (lead price)", tr["edge"], tr["mkt_move"])
print("TEST (out-of-sample):")
rep("edge -> market_err", te["edge"], te["mkt_err"])
rep("edge -> market_move", te["edge"], te["mkt_move"])

# OOS: does blending nowcast beat the market price at :50?
m = tr[["edge", "mkt_err"]].dropna()
if len(m) >= 20 and m["edge"].std() > 0:
    b, a = np.polyfit(m["edge"], m["mkt_err"], 1)
    mt = te.dropna(subset=["edge", "mkt_err", "settle", "implied"])
    pred = a + b * mt["edge"]
    our_mae = (mt["settle"] - (mt["implied"] + pred)).abs().mean()
    mkt_mae = mt["mkt_err"].abs().mean()
    # fee-aware directional P&L
    fee = lambda p: math.ceil(7 * p * (1 - p)) / 100.0
    pnl = n = wins = 0
    for pe, row in zip(pred.values, mt.itertuples()):
        if abs(pe) < 0.75: continue
        up = pe > 0
        won = (row.settle > row.implied) if up else (row.settle < row.implied)
        pnl += (0.5 - fee(0.5)) if won else (-0.5 - fee(0.5)); wins += int(won); n += 1
    print(f"\nOOS blended MAE {our_mae:.3f}  vs market {mkt_mae:.3f}  (dMAE {our_mae-mkt_mae:+.3f})")
    print(f"OOS directional P&L {pnl:+.2f} over {n} bets, win {wins/n:.0%}" if n else "OOS: no bets cleared 0.75F gate")

# ---- THE SELECTIVE SCENARIO: |nowcast - forecast| > 1F, trade pre-METAR -----
print("\n" + "=" * 70)
print("SELECTIVE: fire only when |nowcast - NWS forecast| > 1F (pre-METAR @ :50)")
print("=" * 70)
d2 = df.dropna(subset=["nws"]).copy()
d2["nc_fc"] = d2["nowcast"] - d2["nws"]          # nowcast vs forecast divergence (the filter)
d2["repriced"] = d2["implied"] - d2["nws"]        # has the market already moved off the forecast?
for thr in (1.0, 1.5, 2.0):
    sub = d2[d2["nc_fc"].abs() >= thr]
    if len(sub) < 10:
        print(f"  |nc-fc|>={thr}: n={len(sub)} (too few)"); continue
    # direction we'd bet = sign(nowcast - implied); win if settle moves that way vs implied
    up = sub["nowcast"] > sub["implied"]
    won = np.where(up, sub["settle"] > sub["implied"], sub["settle"] < sub["implied"])
    push = sub["settle"] == sub["implied"]
    # how much of the nc-fc divergence has the market NOT yet priced (the room to run)
    unpriced = (sub["nc_fc"].abs() - sub["repriced"].where(np.sign(sub["repriced"]) == np.sign(sub["nc_fc"]), 0).abs())
    # settle vs forecast: does the divergence actually predict settle beating forecast?
    settle_beats_fc_dir = np.where(sub["nc_fc"] > 0, sub["settle"] > sub["nws"], sub["settle"] < sub["nws"])
    fee = lambda p: math.ceil(7 * p * (1 - p)) / 100.0
    ev = np.where(won & ~push, 0.5 - fee(0.5), np.where(push, 0.0, -0.5 - fee(0.5))).sum()
    print(f"  |nc-fc|>={thr}: n={len(sub):3d}  "
          f"nowcast-dir wins vs mkt {won.mean():.0%}  "
          f"settle beats forecast in nc dir {settle_beats_fc_dir.mean():.0%}  "
          f"mean |settle-implied| {(sub['settle']-sub['implied']).abs().mean():.2f}F  "
          f"toyP&L {ev:+.1f}/{len(sub)}")
print("  Read: to trade this, nowcast-dir must win >~55% AND settle must beat forecast in")
print("  the nowcast's direction >55% (the market anchored on forecast is wrong our way).")
