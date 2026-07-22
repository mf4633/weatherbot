# Vendored snapshot of mf4633/interpolatornyc

Canonical repo: https://github.com/mf4633/interpolatornyc (this copy: main@4a4d4ab,
2026-07-22). PWS-regression nowcasters for the Kalshi temperature stations:

    python interpolatornyc/run_lax.py       # KLAX  (weighted fleet + CLI +1.7F banner)
    python interpolatornyc/run_boston.py    # KBOS Logan
    python interpolatornyc/run_houston.py   # KHOU Hobby
    python interpolatornyc/run_denver.py    # KDEN
    python -m interpolatornyc full          # KNYC (from this directory's parent)
    python interpolatornyc/backtest_lax.py  # 30-day walk-forward + station weights

Runners resolve imports relative to their own path — they run from this checkout
as-is (needs Python 3.11+, pandas, numpy). Pure tooling: the Netlify build
ignores this directory. To update: pull the canonical repo and re-copy, or edit
here and push the same change upstream.
