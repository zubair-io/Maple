#!/usr/bin/env python3
"""Measure the tone-distribution anchors the AUTO tone calibration targets (#1376).

`stages::auto_adjustments_tone` solves each of the five tone sliders so that one
percentile of the rendered frame lands on an anchor. This script is where those
anchor constants come from, and it is how they are re-derived when the reference
set or the view transform changes.

It reports, per percentile, the sRGB-encoded luma of

  * the ACR reference render of each fixture (`<ref>/test_NNNN/down/baseline.png`)
  * optionally, Maple's own render of the same fixture, when a candidate
    directory from `test_color_pipeline.sh` (run with `KEEP_TMP=1`) is supplied

and the population median of each. The ACR column is the ground truth for what a
professionally rendered photograph's tone distribution looks like. The Maple
column carries that statement into the domain the sliders actually operate in:
the two renderers' view transforms differ by a scene-independent offset that the
color-parity budgets already own, and AUTO must not spend a user-visible slider
correcting it. The committed anchors are therefore the MAPLE medians; the ACR
medians and the offset between them are printed so the choice stays auditable.

Usage:

    python3 src/scripts/acr_tone_anchors.py test-fixtures/references
    python3 src/scripts/acr_tone_anchors.py test-fixtures/references /tmp/candidates

Needs numpy + Pillow (same dependency set as `compare_images.py`).
"""

import glob
import os
import sys

import numpy as np
from PIL import Image

# The percentiles the five sliders are anchored on. `contrast` targets the
# p75 - p25 spread; the other four each target a single point.
QUANTILES = [0.5, 10.0, 25.0, 75.0, 95.0, 99.5]
LABELS = ["p0.5", "p10", "p25", "p75", "p95", "p99.5"]
# Rec.709 / sRGB luma weights — the encoded output is sRGB primaries.
LUMA = (0.2126, 0.7152, 0.0722)


def anchors_of(png_path):
    a = np.asarray(Image.open(png_path).convert("RGB")).astype(np.float32) / 255.0
    y = LUMA[0] * a[..., 0] + LUMA[1] * a[..., 1] + LUMA[2] * a[..., 2]
    return np.percentile(y, QUANTILES)


def collect(paths_by_fixture):
    rows = {}
    for fixture, path in sorted(paths_by_fixture.items()):
        rows[fixture] = anchors_of(path)
    return rows


def print_table(title, rows):
    print(f"\n== {title} ==")
    print(f"{'fixture':14}" + "".join(f"{h:>9}" for h in LABELS) + f"{'p75-p25':>9}")
    for fixture, v in rows.items():
        spread = v[3] - v[2]
        print(f"{fixture:14}" + "".join(f"{x:9.4f}" for x in v) + f"{spread:9.4f}")
    arr = np.array(list(rows.values()))
    med = np.median(arr, axis=0)
    spread_med = np.median(arr[:, 3] - arr[:, 2])
    print(f"{'MEDIAN':14}" + "".join(f"{x:9.4f}" for x in med) + f"{spread_med:9.4f}")
    return med, spread_med


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    references = sys.argv[1]
    candidates = sys.argv[2] if len(sys.argv) > 2 else None

    acr = {
        p.split(os.sep)[-3]: p
        for p in sorted(glob.glob(os.path.join(references, "test_*", "down", "baseline.png")))
    }
    if not acr:
        print(f"no ACR baseline renders under {references} — fixtures absent, skipping")
        return 0
    acr_med, acr_spread = print_table("ACR reference renders", collect(acr))

    if not candidates:
        print("\n(no candidate dir given — pass one from `KEEP_TMP=1 FILTER=baseline "
              "src/scripts/test_color_pipeline.sh` to get the Maple-domain anchors)")
        return 0

    maple = {}
    for fixture in acr:
        for pattern in (
            os.path.join(candidates, f"{fixture}_baseline.png"),
            os.path.join(candidates, f"{fixture}", "baseline.png"),
            os.path.join(candidates, f"{fixture}-baseline.png"),
        ):
            hits = glob.glob(pattern)
            if hits:
                maple[fixture] = hits[0]
                break
    if not maple:
        print(f"\nno Maple candidates matched under {candidates}")
        return 1
    maple_med, maple_spread = print_table("Maple renders (same scenes)", collect(maple))

    print("\n== anchors ==")
    print(f"{'':14}" + "".join(f"{h:>9}" for h in LABELS) + f"{'p75-p25':>9}")
    print(f"{'ACR median':14}" + "".join(f"{x:9.4f}" for x in acr_med) + f"{acr_spread:9.4f}")
    print(f"{'Maple median':14}" + "".join(f"{x:9.4f}" for x in maple_med) + f"{maple_spread:9.4f}")
    print(
        f"{'offset':14}"
        + "".join(f"{x:9.4f}" for x in (maple_med - acr_med))
        + f"{maple_spread - acr_spread:9.4f}"
    )
    print("\nCommitted anchors (auto_adjustments_tone.rs) are the Maple medians above.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
