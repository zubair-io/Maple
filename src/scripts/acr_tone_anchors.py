#!/usr/bin/env python3
"""Measure the ACR side of the AUTO tone anchors (#1376).

`stages::auto_adjustments_tone` solves each of the five tone sliders so that one
percentile of the rendered frame lands on an anchor. Two populations feed those
anchors, and this script measures the first one:

  * ACR's default rendering of each reference scene
    (`test-fixtures/references/test_NNNN/down/baseline.png`) — printed here.
  * Maple's own rendering of the same scenes, in the state the tone stage
    actually receives (AUTO's exposure and white balance applied, tone sliders
    still at rest). That one needs a develop, so it is measured in Rust by
    `committed_anchors_match_the_reference_population`:

        cd src/raw-pipeline
        cargo test --release -p raw-core --lib --features fixtures \\
          committed_anchors_match_the_reference_population -- --nocapture

The four ENDPOINT anchors (p0.5, p10, p95, p99.5) are level-sensitive: the gap
between the two populations at those percentiles is dominated by the AgX
shoulder being more compressive than ACR's tone curve, plus AUTO's conservative
exposure rule. Neither is auto-tone's job, so those anchors are taken from the
Maple population. The MIDTONE SPREAD (p75 - p25) is level-invariant, the two
populations agree closely, and that anchor is taken from the ACR median printed
below.

Usage:

    python3 src/scripts/acr_tone_anchors.py test-fixtures/references

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


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    references = sys.argv[1]

    paths = sorted(glob.glob(os.path.join(references, "test_*", "down", "baseline.png")))
    if not paths:
        print(f"no ACR baseline renders under {references} — fixtures absent, skipping")
        return 0

    print(f"{'fixture':14}" + "".join(f"{h:>9}" for h in LABELS) + f"{'p75-p25':>9}")
    rows = []
    for path in paths:
        fixture = path.split(os.sep)[-3]
        v = anchors_of(path)
        rows.append(v)
        print(f"{fixture:14}" + "".join(f"{x:9.4f}" for x in v) + f"{v[3] - v[2]:9.4f}")

    arr = np.array(rows)
    med = np.median(arr, axis=0)
    spread_med = np.median(arr[:, 3] - arr[:, 2])
    print(f"{'MEDIAN':14}" + "".join(f"{x:9.4f}" for x in med) + f"{spread_med:9.4f}")
    print(
        f"\nANCHOR_MID_SPREAD (committed in auto_adjustments_tone.rs) = {spread_med:.4f}"
        "\nThe four endpoint anchors come from the Maple population — see the Rust"
        "\ntest named in this script's docstring."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
