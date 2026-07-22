# interpolatornyc

Estimate **KNYC (Central Park ASOS)** temperature by correlating nearby Weather Underground personal weather stations (PWS) over the past 48 hours, then applying weighted linear regression.

PWS sensors often run 3–8°F hotter than the official Central Park station. This tool learns that offset from recent data and produces a corrected KNYC estimate in near real time.

## Why

Official KNYC hourly METARs post at **:51** past each hour and report the **maximum temperature in the preceding hour** (not an instant reading at :51). Nearby PWS update more frequently and can be used to:

- Estimate current KNYC temperature between official reports
- Track today’s peak as it develops
- Flag brief spikes that hourly interpolation can undercount

## Proxy stations

| ID | Location |
|----|----------|
| KNYNEWYO270 | AMNH roof (best correlate, r ≈ 0.98) |
| KNYNEWYO2109 | Upper West Side / 200WEA |
| KNYNEWYO1686 | Tempest 4076 |
| KNYNEWYO1596 | Manhattan PWS |
| KNYNEWYO1931 | Manhattan PWS (cool-biased; soft floor) |
| INEWYO2 | Manhattan PWS |
| KNYNEWYO1024 | Manhattan PWS (added 2026-07-20 after 30-day backtest: r ≈ 0.97, peak within-1°F 62→69%) |

## Method

1. Fetch KNYC hourly ASOS from [IEM](https://mesonet.agron.iastate.edu/) + PWS hourly highs from the Weather.com API
2. Merge by **preceding-hour window** (not naive clock-hour rounding)
3. Fit **recency-weighted** linear regressions (48h window, ~12h half-life)
4. Weight stations by `r² / RMSE²`; apply peak bias on hot hours
5. Blend regression, delta nowcast, and official KNYC anchor for the live estimate

## Install

```powershell
cd path\to\interpolatornyc
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
```

Or with dependencies only (run as a module from the parent directory):

```powershell
pip install -r requirements.txt
```

## Usage

```powershell
# If installed editable, or parent of this package is on PYTHONPATH:
python -m interpolatornyc now       # current interpolated KNYC temp
python -m interpolatornyc peak      # interpolated peak so far today
python -m interpolatornyc intraday  # 5-min PWS + NWS obs vs hourly interp
python -m interpolatornyc trend     # cooling / plateau analysis
python -m interpolatornyc full      # complete report (default)

# Console script after pip install -e .
interpolatornyc full
```

## Data sources

- **KNYC official:** Iowa Environmental Mesonet (IEM) ASOS + `api.weather.gov`
- **PWS:** `api.weather.com/v2/pws/` (browser User-Agent required)

IEM may return HTTP 429 if queried too frequently; space requests or use PWS-only `now` mode when needed.

## Output notes

- Primary answer is the **weighted interpolated temp** (°F, 1 decimal)
- Compare to the latest official KNYC hourly when available
- `intraday` flags undercount when official or 5-min peak exceeds hourly interpolation by ≥1°F
- `intraday` momentum rule: if the last two official hourly deltas are both ≥ +1°F, the peak is NOT in; combined with an undercount flag it prints **PEAK NOT IN — MOMENTUM + UNDERCOUNT** (favor buckets above the current official max — added after the 2026-07-21 KDEN miss, where 89→92→94 momentum was misread as a plateau)

## License

MIT
