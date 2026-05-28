#!/usr/bin/env python3
"""Per-luma-band bias + ΔE2000 of candidate vs reference.

Bins reference pixels by luminance into 10 buckets. For each bucket,
reports mean per-channel bias (cand - ref) and mean CIEDE2000.
Pixel-position-aware: requires aligned (same shape) inputs. Run
align-orientation + resize upstream.

Usage:
    per_luma_band.py <candidate.png> <reference.png>
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image
import colour


def load_srgb(path):
    im = Image.open(path).convert("RGB")
    return np.asarray(im, dtype=np.float32) / 255.0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("candidate")
    p.add_argument("reference")
    p.add_argument("--bands", type=int, default=10)
    args = p.parse_args()

    cand = load_srgb(args.candidate)
    ref = load_srgb(args.reference)
    if cand.shape != ref.shape:
        print(json.dumps({"error": f"shape mismatch: {cand.shape} vs {ref.shape}"}))
        return 2

    # Rec.709 luma on the reference, since reference is sRGB.
    ref_luma = (0.2126 * ref[..., 0] + 0.7152 * ref[..., 1] + 0.0722 * ref[..., 2]).flatten()
    flat_cand = cand.reshape(-1, 3)
    flat_ref = ref.reshape(-1, 3)

    cand_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(cand)).reshape(-1, 3)
    ref_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(ref)).reshape(-1, 3)
    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")

    bands = []
    edges = np.linspace(0.0, 1.0, args.bands + 1)
    for i in range(args.bands):
        lo, hi = edges[i], edges[i + 1]
        m = (ref_luma >= lo) & (ref_luma < hi if i < args.bands - 1 else ref_luma <= hi)
        n = int(m.sum())
        if n < 100:
            bands.append({"lo": float(lo), "hi": float(hi), "n": n})
            continue
        bias = (flat_cand[m] - flat_ref[m]).mean(axis=0)
        bands.append({
            "lo": float(lo), "hi": float(hi), "n": n,
            "bias_r": float(bias[0]), "bias_g": float(bias[1]), "bias_b": float(bias[2]),
            "mean_dE": float(dE[m].mean()),
        })

    overall = {
        "mean_dE": float(dE.mean()),
        "p95_dE": float(np.percentile(dE, 95)),
        "bias_r": float((flat_cand[:, 0] - flat_ref[:, 0]).mean()),
        "bias_g": float((flat_cand[:, 1] - flat_ref[:, 1]).mean()),
        "bias_b": float((flat_cand[:, 2] - flat_ref[:, 2]).mean()),
        "n": int(flat_cand.shape[0]),
    }
    print(json.dumps({"overall": overall, "bands": bands}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
