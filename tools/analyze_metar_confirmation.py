#!/usr/bin/env python3
r"""Test the 'market confirms on the hourly METAR' thesis at 1-minute resolution.

Mean |Δ implied high| (analyze_reprice_ticks.js) averages continuous 'news' noise with
the big confirmation moves, so it can't see confirmation timing. This measures what the
thesis actually claims:

  A. VOLUME / Δopen-interest by minute-of-hour -- do position CHANGES concentrate at the
     METAR minute (:53-:57)? If size lands there, the market is confirming on the METAR.
  B. MOMENTUM THROUGH THE METAR -- does the pre-METAR implied-high drift CONTINUE across
     the :53 post (market lagging the confirmation => front-runnable), measured as
     corr(drift[:45->:52], drift[:52->:59]) and compared to a non-METAR placebo boundary
     (corr across :15). Positive & > placebo => a lag you could trade.
  C. INFORMATION TIMING -- does |implied - settlement| drop more at :53-:57 than mid-hour?

Reads the JSONL from tools/backfill_candles.js / book_poller.js.
US ASOS routine METARs: :53, disseminate :53-:57.

Run:  PYTHONUTF8=1 python tools/analyze_metar_confirmation.py --dir data/backfill
"""
import sys, os, glob, json, math
from datetime import datetime, timezone
from collections import defaultdict
from zoneinfo import ZoneInfo
import numpy as np

TZ = {
    "KXHIGHNY": "America/New_York", "KXHIGHLAX": "America/Los_Angeles",
    "KXHIGHDEN": "America/Denver", "KXHIGHTBOS": "America/New_York",
    "KXHIGHTHOU": "America/Chicago", "KXHIGHCHI": "America/Chicago",
    "KXHIGHPHIL": "America/New_York", "KXHIGHTDC": "America/New_York",
    "KXHIGHTSEA": "America/Los_Angeles", "KXHIGHTPHX": "America/Phoenix",
    "KXHIGHTDAL": "America/Chicago", "KXHIGHTSATX": "America/Chicago", "KXHIGHAUS": "America/Chicago",
}

argv = sys.argv[1:]
files = [a for a in argv if a.endswith(".jsonl")]
if "--dir" in argv:
    d = argv[argv.index("--dir") + 1]
    files = sorted(glob.glob(os.path.join(d, "*.jsonl")))
if not files:
    print("no input"); sys.exit(1)


def centre(floor, cap):
    lo, hi = floor, cap
    if lo is not None and hi is not None: return (lo + hi) / 2
    if lo is None and hi is not None: return hi - 1
    if lo is not None and hi is None: return lo + 1
    return None


def daycode(ticker):
    import re
    m = re.search(r"-(\d{2}[A-Z]{3}\d{2})-", ticker or "")
    return m.group(1) if m else "?"


# (series, day) -> minute-iso -> list[row];  also track per-ticker final price for settle
events = defaultdict(lambda: defaultdict(list))
final_px = defaultdict(dict)   # (series,day) -> ticker -> (last_ts, mid, centre)
rows_read = 0
for f in files:
    for line in open(f, encoding="utf-8"):
        if not line.strip(): continue
        try: r = json.loads(line)
        except Exception: continue
        if not r.get("ts") or not r.get("ticker"): continue
        rows_read += 1
        key = (r["series"], daycode(r["ticker"]))
        minute = r["ts"][:16]
        events[key][minute].append(r)
        c = centre(r.get("floor"), r.get("cap"))
        if c is not None:
            bid, ask = r.get("yes_bid") or 0, r.get("yes_ask") or 0
            mid = (bid + ask) / 2
            prev = final_px[key].get(r["ticker"])
            if prev is None or r["ts"] > prev[0]:
                final_px[key][r["ticker"]] = (r["ts"], mid, c)

print(f"rows read: {rows_read:,}   event-days: {len(events)}")


def implied(rows):
    w = acc = 0.0
    for r in rows:
        c = centre(r.get("floor"), r.get("cap"))
        if c is None: continue
        p = ((r.get("yes_bid") or 0) + (r.get("yes_ask") or 0)) / 2
        if p <= 0: continue
        w += p; acc += p * c
    return acc / w if w > 0 else None


def minute_volume(rows):
    return sum((r.get("volume") or 0) for r in rows)


def settle_centre(key):
    """Center of the bucket whose final mid-price is highest (~the settling bucket)."""
    best = None
    for tk, (ts, mid, c) in final_px[key].items():
        if best is None or mid > best[0]:
            best = (mid, c)
    return best[1] if best and best[0] >= 0.6 else None


def lh(series, ts):
    tz = ZoneInfo(TZ.get(series, "America/New_York"))
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(tz).hour


# ---- A: volume + Δ open-interest by minute-of-hour (daytime) ---------------
vol_mo = np.zeros(60); voln_mo = np.zeros(60); doi_mo = np.zeros(60); doin_mo = np.zeros(60)
# ---- B: cross-boundary momentum -------------------------------------------
# drift pairs at the METAR boundary (:52 center) and a placebo (:22 center)
def build_series(key):
    """minute-iso(sorted) -> (implied, total_volume, oi, local_hour)."""
    out = {}
    for m, rows in events[key].items():
        im = implied(rows)
        if im is None: continue
        oi = sum((r.get("open_interest") or 0) for r in rows)
        series = key[0]
        out[m] = (im, minute_volume(rows), oi, lh(series, m + ":00Z"))
    return dict(sorted(out.items()))


def at(ts_map, base_min, mm):
    """implied at a given YYYY-MM-DDTHH:MM key with minute mm (int), same hour as base."""
    return ts_map.get(base_min[:14] + f"{mm:02d}")


mom_metar = []   # (pre_drift, post_drift) around :53
mom_placebo = []  # around :23
info_by_mo = defaultdict(list)   # minute-of-hour -> list |implied - settle|

for key in events:
    ts_map = build_series(key)
    settle = settle_centre(key)
    # information timing needs settle
    for m, (im, vol, oi, hour) in ts_map.items():
        if not (9 <= hour <= 20): continue
        mo = int(m[14:16])
        if settle is not None:
            info_by_mo[mo].append(abs(im - settle))
    # volume / oi by minute-of-hour, plus momentum boundaries
    prev_oi = {}
    hours_seen = defaultdict(dict)   # (date,hh) -> {mm: implied}
    for m, (im, vol, oi, hour) in ts_map.items():
        if not (9 <= hour <= 20): continue
        mo = int(m[14:16])
        vol_mo[mo] += vol; voln_mo[mo] += 1
        hh_key = m[:13]  # YYYY-MM-DDTHH
        hours_seen[hh_key][int(m[14:16])] = im
    # momentum across boundaries, per hour block
    for hh_key, mm_map in hours_seen.items():
        def imp(mm): return mm_map.get(mm)
        # METAR boundary: pre = :52-:45, post = :59-:52
        a, b, c = imp(45), imp(52), imp(59)
        if a is not None and b is not None and c is not None:
            mom_metar.append((b - a, c - b))
        # placebo boundary at :23: pre = :16-:23, post = :23-:30
        a2, b2, c2 = imp(16), imp(23), imp(30)
        if a2 is not None and b2 is not None and c2 is not None:
            mom_placebo.append((b2 - a2, c2 - b2))

# ---- report ----------------------------------------------------------------
print("\n=== A. VOLUME by minute-of-hour (mean contracts/min, daytime) ===")
mv = np.divide(vol_mo, np.maximum(voln_mo, 1))
metar_v = mv[53:58].mean(); mid_v = np.concatenate([mv[10:45]]).mean()
for base in (0, 20, 40):
    print("  " + "  ".join(f"{i:02d}:{mv[i]:6.1f}" for i in range(base, base + 20)))
print(f"  METAR :53-:57 mean vol = {metar_v:.1f}   mid-hour :10-:44 mean = {mid_v:.1f}   "
      f"ratio {metar_v/mid_v:.2f}x")

print("\n=== B. MOMENTUM THROUGH THE METAR (does pre-drift continue across :53?) ===")
def corr(pairs):
    if len(pairs) < 30: return float("nan"), len(pairs)
    a = np.array([p[0] for p in pairs]); b = np.array([p[1] for p in pairs])
    if a.std() == 0 or b.std() == 0: return float("nan"), len(pairs)
    return float(np.corrcoef(a, b)[0, 1]), len(pairs)
cm, nm = corr(mom_metar); cp, npl = corr(mom_placebo)
print(f"  corr(pre-drift, post-drift) @ METAR :53  = {cm:+.3f}  (n={nm})")
print(f"  corr @ placebo :23 boundary              = {cp:+.3f}  (n={npl})")
print(f"  → momentum continues through METAR more than placebo? {'YES' if (not math.isnan(cm) and not math.isnan(cp) and cm > cp + 0.05) else 'no'}")

print("\n=== C. INFORMATION TIMING: mean |implied - settlement| by minute-of-hour ===")
mo_err = {mo: (np.mean(v), len(v)) for mo, v in info_by_mo.items() if len(v) >= 30}
if mo_err:
    for base in (0, 20, 40):
        print("  " + "  ".join(f"{i:02d}:{mo_err[i][0]:.2f}" if i in mo_err else f"{i:02d}:  -  " for i in range(base, base + 20)))
    metar_e = np.mean([mo_err[i][0] for i in range(53, 58) if i in mo_err])
    mid_e = np.mean([mo_err[i][0] for i in range(10, 45) if i in mo_err])
    print(f"  METAR :53-:57 mean |err| = {metar_e:.3f}   mid-hour = {mid_e:.3f}   "
          f"({'sharper at METAR' if metar_e < mid_e - 0.02 else 'no METAR concentration'})")
