"""Show what's in today's calibration training set."""
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from interpolatornyc.calibration import build_merged_pws_calibration, calibrate
from interpolatornyc.core import format_hour_ending

now = datetime.now(ZoneInfo("America/New_York")).replace(tzinfo=None)
cal = calibrate(now)
merged, knyc, _ = build_merged_pws_calibration(now)
today = now.date()

print("=== KNYC hourly in training set (today, preceding-hour max) ===")
if knyc is not None:
    t = knyc[knyc["hour"].dt.date == today].sort_values("hour")
    for _, r in t.iterrows():
        print(f"  {format_hour_ending(r.hour)}: {r.knyc_temp:.0f}F")
    if not t.empty:
        print(f"\nPeak in training data today: {t.knyc_temp.max():.0f}F")

print(f"\nLearned peak bias: +{cal['peak_bias']:.1f}F")
warm = cal["merged"][cal["merged"]["knyc_temp"] >= 90]
print(f"Training pairs: {len(cal['merged'])} total, {len(warm)} warm (>=90F)")

if merged is not None:
    hot = merged[merged["knyc_temp"] >= 99].sort_values("knyc_temp", ascending=False)
    if not hot.empty:
        print("\nTraining rows with KNYC >= 99F:")
        for _, r in hot.drop_duplicates(["hour", "station"]).head(8).iterrows():
            print(
                f"  {format_hour_ending(r.hour)} {r.station}: "
                f"PWS_max={r.proxy_temp:.0f}F KNYC={r.knyc_temp:.0f}F"
            )