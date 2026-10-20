#!/usr/bin/env python3
"""
auto_profile_diff.py — per-luma-band per-channel bias diff.

Compares Maple's `Profile = Auto` render against the RAW's embedded JPEG.
Emits per-luma-band (5 bands) per-channel signed bias. Fails if any
band exceeds the budget.

The signed-bias metric alone is not an image-quality acceptance test. Positive
and negative errors can cancel within each band. It does not establish
spatial color accuracy, clipping safety, detail preservation or absence of
posterization. The #5000 LUT calibration passed it despite visible damage.
The CLI also enforces auto_profile_quality.py non-cancelling checks.
Full-fixture visual review is still required.
Companion: src/scripts/test_auto_profile_match.sh drives this script
fixture-by-fixture and aggregates pass/fail counts.
"""

import argparse
import json
import math
import sys

import numpy as np
from PIL import Image

LUMA_BANDS = [
    (0.00, 0.10),  # deep shadows
    (0.10, 0.25),  # shadows
    (0.25, 0.50),  # mids-low
    (0.50, 0.75),  # mids-high
    (0.75, 1.00),  # highlights
]


def load(path):
    """Load an image as float64 RGB in [0, 1]. Accepts 8/16-bit; gray→RGB.

    Uses Pillow (consistent with src/scripts/compare_images.py) so the
    harness has no OpenCV dependency. 16-bit PNGs load as mode "I;16" /
    "I" — we normalise by the actual per-dtype max rather than always /255.
    """
    try:
        im = Image.open(path)
    except FileNotFoundError:
        raise SystemExit(f"missing {path}")
    im.load()

    # Pillow opens 16-bit single-channel PNGs as "I"/"I;16" and 16-bit RGB
    # as-is; numpy preserves the dtype. Convert palette/gray/alpha modes up
    # to RGB only for 8-bit; 16-bit grayscale we handle via the array path.
    if im.mode in ("RGB", "RGBA", "L", "P"):
        arr = np.asarray(im.convert("RGB"))
    else:
        # 16-bit ("I", "I;16", "I;16B") or other: take the raw array.
        arr = np.asarray(im)
        if arr.ndim == 2:
            arr = np.repeat(arr[..., None], 3, axis=2)
        elif arr.shape[2] == 4:
            arr = arr[..., :3]

    if np.issubdtype(arr.dtype, np.integer):
        mx = float(np.iinfo(arr.dtype).max)
    else:
        mx = 1.0
    return arr.astype(np.float64) / mx


def match_shape(src, tgt):
    """Resize `src` to `tgt`'s H×W. No-op when shapes match.

    Performs aspect-ratio center-cropping before resizing to prevent stretching
    and ensure correct spatial alignment between RAW and JPEG.
    """
    if src.shape[:2] == tgt.shape[:2]:
        return src

    src_h, src_w = src.shape[:2]
    tgt_h, tgt_w = tgt.shape[:2]
    src_aspect = src_w / src_h
    tgt_aspect = tgt_w / tgt_h

    if abs(src_aspect - tgt_aspect) > 0.001:
        if src_aspect > tgt_aspect:
            # Source is wider: crop width
            new_w = round(src_h * tgt_aspect)
            crop_x = (src_w - new_w) // 2
            src = src[:, crop_x : crop_x + new_w]
        else:
            # Source is taller: crop height
            new_h = round(src_w / tgt_aspect)
            crop_y = (src_h - new_h) // 2
            src = src[crop_y : crop_y + new_h, :]

    h, w = tgt.shape[:2]
    # Round-trip through Pillow in float32; BOX = area-averaging downscale.
    pil = Image.fromarray((src * 255.0).round().clip(0, 255).astype(np.uint8))
    pil = pil.resize((w, h), resample=Image.Resampling.BOX)
    return np.asarray(pil).astype(np.float64) / 255.0


def per_band_bias(cand, ref, valid=None):
    """Signed mean per-channel bias inside each luma band of `ref`.

    Both inputs are display-encoded sRGB (the Auto Profile render and the
    camera's embedded JPEG), so luma uses Rec.709 / sRGB coefficients — the
    correct weights for display-referred pixels, NOT Maple's scene-linear
    Rec.2020 working-space weights. Skips bands with fewer than 100 pixels
    to avoid noisy means on tiny crops.
    """
    diff = cand - ref
    luma = 0.2126 * ref[..., 0] + 0.7152 * ref[..., 1] + 0.0722 * ref[..., 2]
    out = {}
    n_bands = len(LUMA_BANDS)
    for i, (lo, hi) in enumerate(LUMA_BANDS):
        # Earlier bands are half-open [lo, hi) to avoid double-counting a
        # pixel on a band boundary. The LAST band is closed [lo, hi] so
        # pure-white pixels (luma == 1.0) aren't dropped from highlights.
        if i == n_bands - 1:
            m = (luma >= lo) & (luma <= hi)
        else:
            m = (luma >= lo) & (luma < hi)
        if valid is not None:
            if valid.shape != luma.shape:
                raise ValueError("invalid band comparison support")
            m &= valid
        if m.sum() < 100:
            continue
        out[f"{lo:.2f}-{hi:.2f}"] = {
            "n": int(m.sum()),
            "R": float(diff[..., 0][m].mean()),
            "G": float(diff[..., 1][m].mean()),
            "B": float(diff[..., 2][m].mean()),
        }
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("candidate", help="Maple Auto-Profile render (PNG/TIFF/JPEG)")
    ap.add_argument("reference", help="RAW embedded JPEG (PNG/JPEG)")
    ap.add_argument(
        "--budget",
        type=float,
        default=0.05,
        help="Per-band per-channel absolute bias budget (default 0.05).",
    )
    args = ap.parse_args()
    if not math.isfinite(args.budget) or args.budget < 0:
        ap.error("budget must be finite and nonnegative")

    from auto_profile_match import compare

    result = compare(args.candidate, args.reference, args.budget)
    print(json.dumps(result, indent=2))
    if result["status"] != "passed":
        print("FAIL: bias or full-frame image-quality checks", file=sys.stderr)
        sys.exit(1)
    print("PASS: numeric checks; visual review still required")


if __name__ == "__main__":
    main()
