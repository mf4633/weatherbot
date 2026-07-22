"""interpolatornyc - Interpolate KNYC (Central Park) temperature from nearby PWS stations."""

import argparse

from interpolatornyc.core import run_full, run_now, run_peak
from interpolatornyc.intraday import run_intraday
from interpolatornyc.trend import main as run_trend


def main():
    parser = argparse.ArgumentParser(
        prog="interpolatornyc",
        description="Interpolate KNYC temperature from nearby PWS using 48hr correlations.",
    )
    parser.add_argument(
        "command",
        nargs="?",
        default="full",
        choices=["full", "now", "peak", "intraday", "trend"],
        help="full=all output, now=current, peak=today's peak, intraday=5-min/SPECI check, trend=cooling",
    )
    args = parser.parse_args()
    if args.command == "full":
        run_full()
    elif args.command == "now":
        run_now()
    elif args.command == "peak":
        run_peak()
    elif args.command == "intraday":
        run_intraday()
    elif args.command == "trend":
        run_trend()