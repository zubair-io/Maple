#!/usr/bin/env python3
"""Distribution-level comparison between candidate and reference images.

Pixel-position-INDEPENDENT (so insensitive to demosaic, sharpening,
sub-pixel registration, small crop differences). Captures what the eye
actually compares between two renderings of the same scene:

  - Per-channel CDF distance (EMD): "are the brightness distributions equal?"
  - LAB chromaticity centroid + spread: "is there a color cast / desat?"
  - Per-channel mean / p5 / p95: "where does each channel live?"
  - Saturation (LAB chroma) distribution: "is one more vivid than the other?"

Usage:
    distribution_match.py <candidate> <reference>
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image
import colour


def load_srgb(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0


def cdf_distance(a, b, bins=256):
    """Earth-mover-style L1 between two 1D distributions.
    Both arrays are samples (not pre-binned). Range assumed [0, 1].
    Returns mean abs distance in [0, 1] units between CDFs."""
    a_hist, edges = np.histogram(a.clip(0, 1), bins=bins, range=(0, 1), density=True)
    b_hist, _ = np.histogram(b.clip(0, 1), bins=bins, range=(0, 1), density=True)
    a_cdf = np.cumsum(a_hist) / a_hist.sum()
    b_cdf = np.cumsum(b_hist) / b_hist.sum()
    return float(np.abs(a_cdf - b_cdf).mean())


def percentile_stats(x):
    return {
        "p5": float(np.percentile(x, 5)),
        "p50": float(np.percentile(x, 50)),
        "p95": float(np.percentile(x, 95)),
        "mean": float(x.mean()),
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("candidate")
    p.add_argument("reference")
    args = p.parse_args()

    cand = load_srgb(args.candidate)
    ref = load_srgb(args.reference)

    out = {
        "shapes": {"candidate": list(cand.shape), "reference": list(ref.shape)},
    }

    # --- per-channel CDF distance ---
    # Rotation/crop invariant: pure histogram comparison.
    cdf_ch = {}
    for i, name in enumerate("RGB"):
        cdf_ch[name] = cdf_distance(cand[..., i].ravel(), ref[..., i].ravel())
    out["cdf_distance_per_channel"] = cdf_ch

    # --- per-channel percentile stats ---
    pct = {}
    for i, name in enumerate("RGB"):
        pct[name] = {
            "cand": percentile_stats(cand[..., i]),
            "ref": percentile_stats(ref[..., i]),
        }
    out["percentile_stats"] = pct

    # --- LAB chromaticity centroid + spread ---
    # If candidate's (a*, b*) centroid is shifted from reference, that's a
    # color cast — independent of any spatial alignment. The spread tells
    # us saturation (small spread = desaturated; large = vivid).
    cand_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(cand)).reshape(-1, 3)
    ref_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(ref)).reshape(-1, 3)
    # LAB chroma C* = sqrt(a^2 + b^2). Mean chroma is the canonical "saturation".
    cand_chroma = np.sqrt(cand_lab[:, 1] ** 2 + cand_lab[:, 2] ** 2)
    ref_chroma = np.sqrt(ref_lab[:, 1] ** 2 + ref_lab[:, 2] ** 2)
    out["lab_chromaticity"] = {
        "candidate_a_mean": float(cand_lab[:, 1].mean()),
        "candidate_b_mean": float(cand_lab[:, 2].mean()),
        "reference_a_mean": float(ref_lab[:, 1].mean()),
        "reference_b_mean": float(ref_lab[:, 2].mean()),
        "color_cast_a_shift": float(cand_lab[:, 1].mean() - ref_lab[:, 1].mean()),
        "color_cast_b_shift": float(cand_lab[:, 2].mean() - ref_lab[:, 2].mean()),
        "candidate_chroma_mean": float(cand_chroma.mean()),
        "reference_chroma_mean": float(ref_chroma.mean()),
        "saturation_ratio": float(cand_chroma.mean() / max(ref_chroma.mean(), 1e-6)),
        "candidate_L_mean": float(cand_lab[:, 0].mean()),
        "reference_L_mean": float(ref_lab[:, 0].mean()),
        "lightness_shift": float(cand_lab[:, 0].mean() - ref_lab[:, 0].mean()),
    }

    # --- per-channel CDF tail check ---
    # Per-channel saturation distance at high values (top 10%) reveals if
    # candidate clips/rolls off highlights differently than reference.
    tail = {}
    for i, name in enumerate("RGB"):
        c_top = np.percentile(cand[..., i], [90, 95, 99, 99.9]).tolist()
        r_top = np.percentile(ref[..., i], [90, 95, 99, 99.9]).tolist()
        tail[name] = {"cand_p90_95_99_999": c_top, "ref_p90_95_99_999": r_top,
                      "delta_p99": float(c_top[2] - r_top[2])}
    out["highlight_tail"] = tail

    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
