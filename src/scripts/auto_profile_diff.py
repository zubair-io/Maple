#!/usr/bin/env python3
"""
auto_profile_diff.py — per-luma-band per-channel bias diff.

Compares Maple's `Profile = Auto` render against the RAW's embedded JPEG.
Emits per-luma-band (5 bands) per-channel signed bias. Fails if any
band exceeds the budget.

NO aggregate ΔE/RMSE/MAE. Those metrics mask the structural per-channel
errors we care about. See the L2.7 failure lesson:
median-LUT introduced a global green cast that an aggregate ΔE happily
averaged away — but per-luma-band per-channel bias would have flagged it
immediately as a "+0.04 in G across all bands" structural error.

Companion: src/scripts/test_auto_profile_match.sh drives this script
fixture-by-fixture and aggregates pass/fail counts.
"""
import sys
import json
import argparse
import numpy as np
import cv2

LUMA_BANDS = [
    (0.00, 0.10),  # deep shadows
    (0.10, 0.25),  # shadows
    (0.25, 0.50),  # mids-low
    (0.50, 0.75),  # mids-high
    (0.75, 1.00),  # highlights
]


def load(path):
    """Load an image as float64 RGB in [0, 1]. Accepts 8/16-bit; gray→RGB."""
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED | cv2.IMREAD_ANYDEPTH)
    if img is None:
        raise SystemExit(f"missing {path}")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        img = img[..., :3]
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    if np.issubdtype(img.dtype, np.integer):
        mx = float(np.iinfo(img.dtype).max)
    else:
        mx = 1.0
    return img.astype(np.float64) / mx


def match_shape(src, tgt):
    """Resize `src` to `tgt`'s H×W via INTER_AREA. No-op when shapes match."""
    if src.shape[:2] == tgt.shape[:2]:
        return src
    h, w = tgt.shape[:2]
    return cv2.resize(src, (w, h), interpolation=cv2.INTER_AREA)


def per_band_bias(cand, ref):
    """Signed mean per-channel bias inside each luma band of `ref`.

    Luma uses BT.2020 coefficients (matches Maple's working space). Skips
    bands with fewer than 100 pixels to avoid noisy means on tiny crops.
    """
    diff = cand - ref
    luma = 0.2627 * ref[..., 0] + 0.6780 * ref[..., 1] + 0.0593 * ref[..., 2]
    out = {}
    for lo, hi in LUMA_BANDS:
        m = (luma >= lo) & (luma < hi)
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

    ref = load(args.reference)
    cand = match_shape(load(args.candidate), ref)
    bias = per_band_bias(cand, ref)
    print(json.dumps(bias, indent=2))

    failed = []
    for band, vals in bias.items():
        for ch in "RGB":
            if abs(vals[ch]) > args.budget:
                failed.append(
                    f"band {band} channel {ch} bias={vals[ch]:+.4f} "
                    f"(budget ±{args.budget})"
                )
    if failed:
        print("FAIL:", file=sys.stderr)
        for f in failed:
            print("  " + f, file=sys.stderr)
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
