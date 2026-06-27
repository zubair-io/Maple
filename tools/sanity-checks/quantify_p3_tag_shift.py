#!/usr/bin/env python3
"""Quantify the GPU-live canvas color shift caused by the sRGB-bytes-in-a-P3-tag
mismatch, independent of any display or screenshot.

The GPU-live present path writes sRGB-primary / sRGB-gamma bytes into a
CAMetalLayer tagged Display-P3, with no sRGB->P3 conversion. On a P3 display the
tag is identity, so the panel shows each byte value as if it were Display-P3.
This script computes, per patch, the perceived color (value interpreted as
Display-P3) vs the intended color (value as sRGB), and the CIEDE2000 between
them. Pure colorimetry — no app, no display, no screenshot.

This is the shift that hits EVERY image (raw and non-raw alike), because it
lives in the shared present step.

Usage: quantify_p3_tag_shift.py <color_target.json>
"""

import json
import sys

import numpy as np
import colour

NEUTRALS = {"K_black", "N20", "N40", "N60", "N80", "W_white", "gray18", "gray50"}
PRIMARIES = {"red", "green", "blue", "cyan", "magenta", "yellow"}

SRGB = colour.RGB_COLOURSPACES["sRGB"]
P3 = colour.RGB_COLOURSPACES["Display P3"]


def lab_as(space, v01):
    xyz = colour.RGB_to_XYZ(v01, space)
    return colour.XYZ_to_Lab(xyz)


def main() -> int:
    meta = json.load(open(sys.argv[1]))
    rows = []
    for p in meta["patches"]:
        v01 = np.array(p["srgb"], dtype=np.float64) / 255.0
        intended = lab_as(SRGB, v01)  # value shown as sRGB (correct)
        perceived = lab_as(P3, v01)  # value shown as Display-P3 (the bug)
        dE = float(colour.delta_E(intended[None, :], perceived[None, :], method="CIE 2000")[0])
        rows.append({"name": p["name"], "srgb": p["srgb"], "dE": round(dE, 2)})

    def grp(names):
        v = [r["dE"] for r in rows if r["name"] in names]
        return round(float(np.mean(v)), 2) if v else None

    allE = np.array([r["dE"] for r in rows])
    print(f"{'patch':>11}  {'sRGB':>15}  {'perceived ΔE (sRGB shown as P3)':>32}", file=sys.stderr)
    for r in sorted(rows, key=lambda r: -r["dE"]):
        print(f'{r["name"]:>11}  {str(r["srgb"]):>15}  {r["dE"]:>32}', file=sys.stderr)
    summary = {
        "model": "sRGB byte values displayed through a Display-P3 layer tag (P3 panel, identity)",
        "mean_dE": round(float(allE.mean()), 2),
        "p95_dE": round(float(np.percentile(allE, 95)), 2),
        "max_dE": round(float(allE.max()), 2),
        "neutral_mean_dE": grp(NEUTRALS),
        "primary_mean_dE": grp(PRIMARIES),
    }
    print(
        f'\nmean ΔE={summary["mean_dE"]}  p95={summary["p95_dE"]}  max={summary["max_dE"]}'
        f'  | neutral ΔE={summary["neutral_mean_dE"]}  primary ΔE={summary["primary_mean_dE"]}',
        file=sys.stderr,
    )
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
