# low_screen.py — screen ALL Kalshi daily-LOW temperature markets for tonight/tomorrow
# and rank opportunities. Public endpoints only (no auth needed). Origin: ad-hoc
# screen built 2026-07-22 in ~/low_screen/, transcribed here so the logic is durable.
#
# Usage:
#   python low_screen.py                    # dates = today + tomorrow (US/Eastern)
#   python low_screen.py 26JUL22 26JUL23    # explicit Kalshi date codes
#
# Pipeline:
#   1. ROSTER    — discover every KXLOW* series via GET /series?category=Climate and
#                  Weather, keep those with open markets for the target dates. The
#                  settlement station is read from the rules text: regex CLI([A-Z]{3})
#                  on rules_secondary is ground truth (CLINYC=Central Park, CLIMDW,
#                  CLIATT=Camp Mabry, ...). ASOS id == CLI code for all current cities.
#                  All series settle on the NWS Daily Climatological Report
#                  calendar-day min (midnight-to-midnight LOCAL) — verified per rules.
#   2. OBS       — IEM asos.py, last ~26 h, report_type=3,4, UTC -> station tz.
#                  Extract current T/Td/wind/gust/sky/wx, 3 h trend, today's running
#                  min, and a convective flag (TS/SQ/+RA or gust >=25 kt in last 6 h).
#   3. BOOKS     — GET /markets/{tk}/orderbook. NOTE July-2026 API format: response
#                  key is "orderbook_fp" with yes_dollars/no_dollars = string dollar
#                  prices ASCENDING (best bid = max), quantities are DOLLAR notionals
#                  (fractional values occur), not contract counts. The market-list
#                  endpoint returns null yes_bid/yes_ask/volume unauthenticated, so
#                  the per-market book call is mandatory. yes_ask = 100 - best_no_bid.
#                  Implied distribution = normalized bid/ask mids across an event's bins.
#   4. SCORE     — three heuristics, each emits (ticker, ask, note):
#
#   UNDERCUT-LIVE (today's contract only): the calendar-day min is usually set at
#     dawn; a radiational evening can undercut it before local midnight. Gates:
#     current T within 6 F of running min, >=3 h to local midnight, sky <= SCT,
#     wind <= 10 kt, no active precip. Target ONLY the 1-2 bins immediately below
#     the running min (deep tails are lottos, not undercuts), ask 1-30c.
#     score = (30-ask) + 4*max(0, 6-gap) + 2*min(hrs_to_mid,6) + 3*(2-sky) + (10-wind)
#
#   JAGGED-TRACE (either date): active/recent convection means the settlement min
#     (continuous trace) undercuts what hourly displays show. If the convective flag
#     is on, buy the bin ONE colder than the market mode when its ask <= 25c.
#     For today's contract, require the needed drop (T_now - target cap) to be
#     achievable: <= 6 F/h over remaining hours (TS outflow can do ~10-20 F fast,
#     but 6 F/h sustained-to-midnight is the credibility ceiling).
#     score = (25-ask) + 10
#
#   MISPRICED-MODE (tomorrow's contract): physics floor = dewpoint - 1 (radiational
#     cooling stalls near Td). Expected-low BAND from tonight's obs:
#       band_lo = max(floor, T - 0.85*(T-Td))            (strong radiational)
#       band_hi = max(floor, T - (0.45 if clear/calm else 0.30)*(T-Td))
#     Flag only when the market mode bin lies entirely OUTSIDE the band (+-1 F slack)
#     AND the mode also disagrees with PERSISTENCE (today's running min) by >2 F.
#     The persistence gate is essential: the fixed-fraction band is miscalibrated
#     for desert/marine stations (e.g. LAS: band said <=81 was live; persistence 86
#     agreed with the market's >=87 mode — no trade). Target the bin containing the
#     band endpoint nearest the mode (the conservative disagreement), ask <= 40c.
#     Market mass priced below the physics floor is reported (fade candidate).
#     score = 0.6*(40-ask) + 6*|target_mid - mode_mid|/2 + (6 if clear/calm else 0)
#
# Caveats baked into interpretation, not code:
#   - CLI settlement can print ~1 F colder than the ASOS ob floor at deg-C rounding
#     boundaries (see feedback_weatherbot_cli_settlement) — favors the colder bin
#     on marginal plays.
#   - Book sizes are dollar notionals; several attractive asks are near-empty.
#   - Rate limits: Kalshi unauthenticated 429s fast (~5 req/s sustained OK with
#     backoff); IEM asos.py 429s above ~1.4 req/s. Both throttled per-host below.
import json, re, sys, csv, io, urllib.request, urllib.parse, urllib.error
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.stdout.reconfigure(encoding="utf-8")
API = "https://api.elections.kalshi.com/trade-api/v2"
IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
UTC = timezone.utc
NOW = datetime.now(UTC)

import threading, time
_throttle_lock = threading.Lock()
_last_req = {"kalshi": 0.0, "mesonet": 0.0}
_INTERVAL = {"kalshi": 0.18, "mesonet": 0.7}

def get(url, timeout=20, tries=5):
    host = "kalshi" if "kalshi" in url else ("mesonet" if "mesonet" in url else None)
    for i in range(tries):
        if host:
            with _throttle_lock:
                wait = _last_req[host] + _INTERVAL[host] - time.monotonic()
                if wait > 0: time.sleep(wait)
                _last_req[host] = time.monotonic()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "low-screen/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429 and i < tries - 1:
                time.sleep(1.5 * (i + 1))
                continue
            print(f"  !! fetch failed {url[:110]}: {e}", file=sys.stderr)
            return None
        except Exception as e:
            if i == tries - 1:
                print(f"  !! fetch failed {url[:110]}: {e}", file=sys.stderr)
                return None
    return None

def get_json(url, **kw):
    b = get(url, **kw)
    return json.loads(b) if b else None

# ---------------- STEP 1: ROSTER ----------------
STATION_INFO = {
    "NYC": ("NY_ASOS", "America/New_York",    "NYC Central Park"),
    "MDW": ("IL_ASOS", "America/Chicago",     "Chicago Midway"),
    "DEN": ("CO_ASOS", "America/Denver",      "Denver Intl"),
    "AUS": ("TX_ASOS", "America/Chicago",     "Austin Bergstrom"),
    "ATT": ("TX_ASOS", "America/Chicago",     "Austin Camp Mabry"),
    "HOU": ("TX_ASOS", "America/Chicago",     "Houston Hobby"),
    "IAH": ("TX_ASOS", "America/Chicago",     "Houston Bush"),
    "DFW": ("TX_ASOS", "America/Chicago",     "Dallas-Fort Worth"),
    "SAT": ("TX_ASOS", "America/Chicago",     "San Antonio Intl"),
    "PHX": ("AZ_ASOS", "America/Phoenix",     "Phoenix Sky Harbor"),
    "LAX": ("CA_ASOS", "America/Los_Angeles", "Los Angeles Intl"),
    "SFO": ("CA_ASOS", "America/Los_Angeles", "San Francisco Intl"),
    "SEA": ("WA_ASOS", "America/Los_Angeles", "Seattle-Tacoma"),
    "BOS": ("MA_ASOS", "America/New_York",    "Boston Logan"),
    "PHL": ("PA_ASOS", "America/New_York",    "Philadelphia Intl"),
    "DCA": ("VA_ASOS", "America/New_York",    "Washington Reagan"),
    "MIA": ("FL_ASOS", "America/New_York",    "Miami Intl"),
    "MSP": ("MN_ASOS", "America/Chicago",     "Minneapolis-St Paul"),
    "ATL": ("GA_ASOS", "America/New_York",    "Atlanta Hartsfield"),
    "MSY": ("LA_ASOS", "America/Chicago",     "New Orleans Armstrong"),
    "LAS": ("NV_ASOS", "America/Los_Angeles", "Las Vegas Harry Reid"),
    "OKC": ("OK_ASOS", "America/Chicago",     "Oklahoma City Will Rogers"),
}

def resolve_station_cli(m):
    txt = " ".join(filter(None, [m.get("rules_secondary"), m.get("rules_primary")]))
    mm = re.search(r"\bCLI([A-Z]{3})\b", txt)
    if mm:
        code = mm.group(1)
        info = STATION_INFO.get(code)
        if info:
            return code, info[0], info[1], info[2], "CLI code"
        return code, None, None, None, "CLI code (UNMAPPED - add to STATION_INFO)"
    return None, None, None, None, "no CLI code in rules"

def extract_window(m):
    txt = " ".join(filter(None, [m.get("rules_primary"), m.get("rules_secondary")]))
    low = txt.lower()
    if "climatological report" in low or "climate report" in low or re.search(r"\bcli\b", low):
        kind = "CLI calendar-day min (midnight-to-midnight local)"
    elif re.search(r"\d{1,2}:\d{2}\s*(am|pm)", low):
        kind = "explicit clock window (see rules)"
    else:
        kind = "unspecified - check rules"
    return kind, txt

if len(sys.argv) >= 3:
    TARGET_DATES = [sys.argv[1].upper(), sys.argv[2].upper()]
else:
    et_today = NOW.astimezone(ZoneInfo("America/New_York")).date()
    TARGET_DATES = [d.strftime("%y%b%d").upper() for d in (et_today, et_today + timedelta(days=1))]
TODAY_CODE = TARGET_DATES[0]
print(f"[dates] today={TARGET_DATES[0]} tomorrow={TARGET_DATES[1]}")

series_j = get_json(API + "/series?category=" + urllib.parse.quote("Climate and Weather"))
low_series = sorted({s["ticker"] for s in series_j["series"] if "LOW" in s["ticker"]})
print(f"[roster] {len(low_series)} LOW series in API: {', '.join(low_series)}\n")

def fetch_series_markets(st):
    j = get_json(f"{API}/markets?series_ticker={st}&status=open&limit=200")
    return st, (j.get("markets", []) if j else [])

roster = {}  # (series, datecode) -> event dict
with ThreadPoolExecutor(12) as ex:
    for fut in as_completed([ex.submit(fetch_series_markets, s) for s in low_series]):
        st, mkts = fut.result()
        for m in mkts:
            dm = re.match(rf"^{st}-(\d\d[A-Z]{{3}}\d\d)-", m["ticker"])
            if not dm or dm.group(1) not in TARGET_DATES:
                continue
            e = roster.setdefault((st, dm.group(1)), {"series": st, "date": dm.group(1), "markets": []})
            e["markets"].append(m)

for key, e in sorted(roster.items()):
    m0 = e["markets"][0]
    sid, net, tz, name, how = resolve_station_cli(m0)
    wkind, rules = extract_window(m0)
    e.update({"location": name, "how": how, "station": sid, "network": net, "tz": tz,
              "window": wkind, "title": m0.get("title", ""), "rules": rules})

print(f"{'SERIES':14}| {'DATE':8}| {'STATION':8}| {'TZ':20}| {'#BINS':5}| WINDOW / LOCATION")
print("-" * 118)
for key, e in sorted(roster.items()):
    print(f"{e['series']:14}| {e['date']:8}| {str(e['station']):8}| {str(e['tz']):20}| "
          f"{len(e['markets']):5}| {e['window']}  <<{e['location']}>>")
unresolved = [k for k, e in roster.items() if not e["network"]]
if unresolved:
    print("!! UNRESOLVED STATIONS:", unresolved)

# ---------------- STEP 2: OBS (IEM) ----------------
stations = {}
for e in roster.values():
    if e["network"]:
        stations[e["station"]] = (e["network"], e["tz"])

def fetch_obs(sid, net, tzname):
    t1 = NOW - timedelta(hours=26)
    p = {
        "station": sid, "network": net, "data": "tmpf,dwpf,sknt,gust,skyc1,skyc2,skyc3,skyc4,wxcodes",
        "year1": t1.year, "month1": t1.month, "day1": t1.day, "hour1": t1.hour, "minute1": 0,
        "year2": NOW.year, "month2": NOW.month, "day2": NOW.day, "hour2": 23, "minute2": 59,
        "tz": "Etc/UTC", "format": "onlycomma", "latlon": "no", "missing": "M", "trace": "T",
        "report_type": "3,4",
    }
    b = get(IEM + "?" + urllib.parse.urlencode(p, doseq=True), timeout=45)
    rows = []
    if b:
        rdr = csv.DictReader(io.StringIO(b.decode("utf-8", "replace")))
        for r in rdr:
            try:
                t = datetime.strptime(r["valid"], "%Y-%m-%d %H:%M").replace(tzinfo=UTC)
            except Exception:
                continue
            def f(k):
                try: return float(r.get(k, "M"))
                except Exception: return None
            rows.append({"t": t, "tmpf": f("tmpf"), "dwpf": f("dwpf"), "sknt": f("sknt"),
                         "gust": f("gust"), "wx": r.get("wxcodes", "") or "",
                         "sky": [r.get(k, "") for k in ("skyc1", "skyc2", "skyc3", "skyc4")]})
    return sid, rows

SKY_RANK = {"CLR": 0, "SKC": 0, "FEW": 1, "SCT": 2, "BKN": 3, "OVC": 4, "VV": 4}
obs = {}
with ThreadPoolExecutor(10) as ex:
    for fut in as_completed([ex.submit(fetch_obs, s, n, t) for s, (n, t) in stations.items()]):
        sid, rows = fut.result()
        obs[sid] = rows

def summarize(sid, tzname):
    rows = [r for r in obs.get(sid, []) if r["tmpf"] is not None]
    if not rows:
        return None
    tz = ZoneInfo(tzname)
    rows.sort(key=lambda r: r["t"])
    cur = rows[-1]
    lnow = NOW.astimezone(tz)
    today = lnow.date()
    today_rows = [r for r in rows if r["t"].astimezone(tz).date() == today]
    run_min = min((r["tmpf"] for r in today_rows), default=None)
    run_min_t = None
    if run_min is not None:
        run_min_t = min((r for r in today_rows if r["tmpf"] == run_min), key=lambda r: r["t"])["t"].astimezone(tz)
    ago3 = [r for r in rows if r["t"] >= NOW - timedelta(hours=3, minutes=10)]
    trend3 = (cur["tmpf"] - ago3[0]["tmpf"]) if len(ago3) > 1 else None
    last6 = [r for r in rows if r["t"] >= NOW - timedelta(hours=6)]
    conv = any(("TS" in r["wx"] or "SQ" in r["wx"] or "+RA" in r["wx"]) for r in last6) or \
           any((r["gust"] or 0) >= 25 for r in last6)
    precip_now = bool(re.search(r"RA|SN|DZ|TS|GS|PL|UP", cur["wx"]))
    covers = [c for c in cur["sky"] if c]
    sky_worst = max((SKY_RANK.get(c, 0) for c in covers), default=0)
    midnight = datetime.combine(today + timedelta(days=1), datetime.min.time(), tz)
    hrs_to_mid = (midnight - lnow).total_seconds() / 3600
    return {"sid": sid, "tz": tzname, "local_now": lnow, "obs_t": cur["t"].astimezone(tz),
            "temp": cur["tmpf"], "dwpt": cur["dwpf"], "wind": cur["sknt"] or 0, "gust": cur["gust"],
            "sky": "/".join(covers) or "CLR", "sky_worst": sky_worst, "wx": cur["wx"],
            "trend3": trend3, "run_min": run_min, "run_min_t": run_min_t,
            "conv": conv, "precip_now": precip_now, "hrs_to_mid": hrs_to_mid}

summ = {}
print("\n[obs] station snapshot (IEM, report_type 3+4, converted to local tz)")
print(f"{'ST':5}| {'local now':17}| {'T':6}| {'Td':6}| {'wind':9}| {'sky':14}| {'wx':10}| "
      f"{'3h trend':9}| {'run min (time)':17}| {'conv':4}| hrs->mid")
print("-" * 130)
for sid, (net, tzname) in sorted(stations.items()):
    s = summarize(sid, tzname)
    if not s:
        print(f"{sid:5}| NO OBS")
        continue
    summ[sid] = s
    print(f"{sid:5}| {s['local_now']:%m-%d %H:%M}      | {s['temp']:5.1f} | {s['dwpt'] if s['dwpt'] is not None else -99:5.1f} | "
          f"{s['wind']:3.0f}kt{('G%.0f' % s['gust']) if s['gust'] else '':4}| {s['sky']:14}| {s['wx']:10}| "
          f"{('%+.1f' % s['trend3']) if s['trend3'] is not None else '  n/a':9}| "
          f"{('%5.1f @%s' % (s['run_min'], s['run_min_t'].strftime('%H:%M'))) if s['run_min'] is not None else 'n/a':17}| "
          f"{'YES' if s['conv'] else 'no':4}| {s['hrs_to_mid']:4.1f}")

# ---------------- STEP 3: ORDERBOOKS ----------------
def bin_label(m):
    st_ = m.get("strike_type")
    fl, cp = m.get("floor_strike"), m.get("cap_strike")
    if st_ == "between": return f"{fl}-{cp}", (fl + cp) / 2
    if st_ in ("less", "less_or_equal"): return f"<={cp}", cp - 0.5
    if st_ in ("greater", "greater_or_equal"): return f">={fl}", fl + 0.5
    return m.get("yes_sub_title", "?"), fl if fl is not None else (cp if cp is not None else 0)

def fetch_book(tk):
    j = get_json(f"{API}/markets/{tk}/orderbook")
    return tk, ((j.get("orderbook") or j.get("orderbook_fp")) if j else None)

books = {}
all_tks = [m["ticker"] for e in roster.values() for m in e["markets"]]
with ThreadPoolExecutor(12) as ex:
    for fut in as_completed([ex.submit(fetch_book, t) for t in all_tks]):
        tk, ob = fut.result()
        books[tk] = ob

def _levels(ob, side):
    """normalize to [(price_cents, qty)]; qty is dollars in _fp format, contracts in legacy"""
    if ob.get(side + "_dollars") is not None:
        return [(round(float(p) * 100), float(q)) for p, q in ob[side + "_dollars"]]
    return [(int(p), float(q)) for p, q in (ob.get(side) or [])]

def book_stats(tk):
    ob = books.get(tk) or {}
    yes = _levels(ob, "yes")
    no = _levels(ob, "no")
    yb, ybs = max(yes, key=lambda x: x[0]) if yes else (None, 0)
    nb, nbs = max(no, key=lambda x: x[0]) if no else (None, 0)
    ya = (100 - nb) if nb is not None else None
    return {"yes_bid": yb, "yes_bid_sz": ybs, "yes_ask": ya, "yes_ask_sz": nbs}

for e in roster.values():
    bins = []
    for m in e["markets"]:
        lbl, mid = bin_label(m)
        bs = book_stats(m["ticker"])
        yb, ya = bs["yes_bid"], bs["yes_ask"]
        p = (yb + ya) / 2 if (yb is not None and ya is not None) else \
            (ya if ya is not None else (yb if yb is not None else m.get("last_price") or 0))
        bins.append({"tk": m["ticker"], "label": lbl, "mid": mid, **bs, "p": p,
                     "floor": m.get("floor_strike"), "cap": m.get("cap_strike"),
                     "stype": m.get("strike_type"), "vol": m.get("volume") or 0})
    bins.sort(key=lambda b: b["mid"])
    tot = sum(b["p"] for b in bins) or 1
    for b in bins:
        b["imp"] = 100 * b["p"] / tot
    e["bins"] = bins
    e["mode"] = max(bins, key=lambda b: b["p"]) if bins else None

# ---------------- STEP 4: SCORE ----------------
def bins_below(e, x):
    """bins entirely below temperature x, ascending"""
    out = []
    for b in e["bins"]:
        top = b["cap"] if b["stype"] in ("between", "less", "less_or_equal") else None
        if top is not None and top < x:
            out.append(b)
    return out

def bin_one_colder(e, ref):
    idx = e["bins"].index(ref)
    return e["bins"][idx - 1] if idx > 0 else None

opps = []
for key, e in sorted(roster.items()):
    s = summ.get(e["station"])
    if not s or not e.get("bins"):
        continue
    is_today = e["date"] == TODAY_CODE
    mode = e["mode"]

    # (a) UNDERCUT-LIVE — today's contracts only
    if is_today and s["run_min"] is not None:
        gap = s["temp"] - s["run_min"]
        cond = (gap <= 6 and s["hrs_to_mid"] >= 3 and s["sky_worst"] <= 2
                and s["wind"] <= 10 and not s["precip_now"])
        below = bins_below(e, s["run_min"])[-2:]  # only the 1-2 bins just under run_min
        cheap = [b for b in below if b["yes_ask"] is not None and 1 <= b["yes_ask"] <= 30]
        if cond and cheap:
            best = min(cheap, key=lambda b: b["yes_ask"])
            score = (30 - best["yes_ask"]) + max(0, 6 - gap) * 4 + min(s["hrs_to_mid"], 6) * 2 \
                    + (2 - s["sky_worst"]) * 3 + (10 - s["wind"])
            opps.append({"kind": "UNDERCUT-LIVE", "score": score, "e": e, "s": s, "bin": best,
                         "note": f"run_min {s['run_min']:.0f} @{s['run_min_t']:%H:%M}, now {s['temp']:.0f} "
                                 f"(gap {gap:.1f}F), {s['hrs_to_mid']:.1f}h to midnight, sky {s['sky']}, "
                                 f"wind {s['wind']:.0f}kt -> buy {best['label']} @ {best['yes_ask']}c"})

    # (b) JAGGED-TRACE — either date, convective flag
    if s["conv"] and mode:
        colder = bin_one_colder(e, mode)
        if colder and colder["yes_ask"] is not None and colder["yes_ask"] <= 25:
            reach = ""
            if is_today and colder["cap"] is not None:
                need = s["temp"] - colder["cap"]
                rate = need / max(s["hrs_to_mid"], 0.1)
                reach = f"; needs {need:.0f}F drop in {s['hrs_to_mid']:.1f}h ({rate:.1f}F/h)"
                if rate > 6:  # unreachable even with outflow/rain cooling
                    colder = None
            if colder:
                score = (25 - colder["yes_ask"]) + 10
                opps.append({"kind": "JAGGED-TRACE", "score": score, "e": e, "s": s, "bin": colder,
                             "note": f"convective flag on ({'wx' if not s['precip_now'] else s['wx']}); mode {mode['label']} "
                                     f"-> buy one-colder {colder['label']} @ {colder['yes_ask']}c{reach}"})

    # (c) MISPRICED-MODE — tomorrow's contracts
    if (not is_today) and s["dwpt"] is not None and mode:
        clearcalm = s["sky_worst"] <= 2 and s["wind"] <= 10
        dep = max(0, s["temp"] - s["dwpt"])
        phys_floor = s["dwpt"] - 1          # T rarely radiates below dewpoint
        band_lo = max(phys_floor, s["temp"] - 0.85 * dep)
        band_hi = max(phys_floor, s["temp"] - (0.45 if clearcalm else 0.30) * dep)
        mode_lo = mode["floor"] if mode["floor"] is not None else -999
        mode_hi = mode["cap"] if mode["cap"] is not None else 999
        mass_below_floor = sum(b["imp"] for b in bins_below(e, phys_floor))
        # flag only when the mode is outside the band AND disagrees with persistence
        # (today's run_min) — the band alone is miscalibrated for desert/marine stations
        outside = mode_lo > band_hi + 1 or mode_hi < band_lo - 1
        persist_ok = s["run_min"] is None or not (mode_lo - 2 <= s["run_min"] <= mode_hi + 2)
        if outside and persist_ok:
            claim = band_hi if mode_lo > band_hi else band_lo
            target = None
            for b in e["bins"]:
                lo = b["floor"] if b["floor"] is not None else -999
                hi = b["cap"] if b["cap"] is not None else 999
                if lo <= claim <= hi + 0.999:
                    target = b; break
            if target and target is not mode and target["yes_ask"] is not None and target["yes_ask"] <= 40:
                gap_bins = abs(target["mid"] - mode["mid"]) / 2
                score = (40 - target["yes_ask"]) * 0.6 + gap_bins * 6 + (6 if clearcalm else 0)
                opps.append({"kind": "MISPRICED-MODE", "score": score, "e": e, "s": s, "bin": target,
                             "note": f"exp-low band {band_lo:.0f}-{band_hi:.0f}F (T {s['temp']:.0f}/Td {s['dwpt']:.0f}, "
                                     f"{'clear/calm' if clearcalm else 'mixed'}), floor {phys_floor:.0f}F; market mode "
                                     f"{mode['label']} ({mode['imp']:.0f}%) outside band -> buy {target['label']} @ "
                                     f"{target['yes_ask']}c; mass below floor {mass_below_floor:.0f}%"})

# ---------------- OUTPUT ----------------
print("\n\n[markets] implied distribution per event (mid-based, normalized) - * = mode")
for key, e in sorted(roster.items()):
    if not e.get("bins"): continue
    print(f"\n{e['series']}-{e['date']}  [{e['station']}]  {e['title'][:70]}")
    for b in e["bins"]:
        star = "*" if b is e["mode"] else " "
        ya = f"{b['yes_ask']:.0f}" if b["yes_ask"] is not None else " -"
        yb = f"{b['yes_bid']:.0f}" if b["yes_bid"] is not None else " -"
        print(f"  {star} {b['label']:9} bid {yb:>3} ask {ya:>3} (x{b['yes_ask_sz']:<6}) imp {b['imp']:5.1f}%  vol {b['vol']}")

print("\n\n================ RANKED OPPORTUNITIES ================")
opps.sort(key=lambda o: -o["score"])
if not opps:
    print("No qualifying opportunities under the gates tonight.")
for i, o in enumerate(opps, 1):
    e, b = o["e"], o["bin"]
    print(f"\n#{i} [{o['kind']}] score {o['score']:.0f}  {e['series']}-{e['date']} ({e['station']})")
    print(f"   {b['tk']}  ask {b['yes_ask']}c x{b['yes_ask_sz']} (size = book dollars, not contracts)")
    print(f"   {o['note']}")

out_path = "_low_screen_results.json"
with open(out_path, "w") as f:
    json.dump({"generated_utc": NOW.isoformat(),
               "roster": [{k: v for k, v in e.items() if k not in ("markets",)} for e in roster.values()],
               "obs": {k: {kk: (vv.isoformat() if isinstance(vv, datetime) else vv) for kk, vv in v.items()}
                       for k, v in summ.items()},
               "opps": [{"kind": o["kind"], "score": o["score"], "ticker": o["bin"]["tk"],
                         "ask": o["bin"]["yes_ask"], "note": o["note"]} for o in opps]}, f, indent=1, default=str)
print(f"\nsaved {out_path}")
