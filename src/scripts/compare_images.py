#!/usr/bin/env python3
"""Compare two sRGB PNG images and emit CIEDE2000 + per-channel bias JSON.

Usage:
    compare_images.py <candidate.png> <reference.png>

Output (stdout, single-line JSON):
    {
      "mean_deltaE":  float,
      "p95_deltaE":   float,
      "max_deltaE":   float,
      "bias_r":       float,
      "bias_g":       float,
      "bias_b":       float,
      "n_pixels":     int
    }

Exit code 0 on success, non-zero on any error.
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image
import colour


def load_srgb(path: str) -> np.ndarray:
    im = Image.open(path).convert("RGB")
    return np.asarray(im, dtype=np.float32) / 255.0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("candidate")
    p.add_argument("reference")
    args = p.parse_args()

    cand = load_srgb(args.candidate)
    ref = load_srgb(args.reference)
    if cand.shape != ref.shape:
        print(json.dumps({
            "error": f"shape mismatch: {cand.shape} vs {ref.shape}"
        }), file=sys.stdout)
        return 2

    # sRGB → XYZ → Lab via colour-science, under D65 2° observer.
    cand_xyz = colour.sRGB_to_XYZ(cand)
    ref_xyz  = colour.sRGB_to_XYZ(ref)
    cand_lab = colour.XYZ_to_Lab(cand_xyz)
    ref_lab  = colour.XYZ_to_Lab(ref_xyz)

    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")

    bias = (cand - ref).mean(axis=(0, 1))
    out = {
        "mean_deltaE": float(np.mean(dE)),
        "p95_deltaE":  float(np.percentile(dE, 95)),
        "max_deltaE":  float(np.max(dE)),
        "bias_r":      float(bias[0]),
        "bias_g":      float(bias[1]),
        "bias_b":      float(bias[2]),
        "n_pixels":    int(cand.shape[0] * cand.shape[1]),
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
