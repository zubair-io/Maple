#!/usr/bin/env python3
"""Compare two sRGB PNG images: CIEDE2000 + per-channel bias, optionally with
per-tonal-zone and per-hue-angle breakdowns.

This is the ONE diff implementation. `test_color_pipeline.sh` imports `diff()`
in-process; the standalone CLI below wraps it.

Usage:
    compare_images.py <candidate.png> <reference.png> [--zones] [--hue-bins N]

Output (stdout, single-line JSON), global block always present:
    {
      "mean_deltaE": float, "p95_deltaE": float, "max_deltaE": float,
      "bias_r": float, "bias_g": float, "bias_b": float, "n_pixels": int
    }
With --zones, adds "zones": {shadow|mid|highlight: {n, mean_deltaE, p95_deltaE,
max_deltaE, bias_r, bias_g, bias_b}} keyed on the REFERENCE's L*.
With --hue-bins N, adds "hue_bins": {"neutral": {...}, "bins": [{bin_deg, n,
mean_deltaE, a_shift, b_shift}, ...]} keyed on the REFERENCE's Lab hue angle;
low-chroma pixels (C* < NEUTRAL_CHROMA) go to the neutral bucket.

Exit code 0 on success, non-zero on any error.
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image
import colour

# 4000x2667 (down) and 12288x8192 (full) ACR refs trip Pillow's
# decompression-bomb heuristic. They're our ground truth; suppress.
Image.MAX_IMAGE_PIXELS = None

# L*-based tonal zones (perceptual; matches the Lab space ΔE lives in).
ZONE_NAMES = ("shadow", "mid", "highlight")
ZONE_EDGES = (0.0, 33.3, 66.6, 100.001)
NEUTRAL_CHROMA = 5.0  # C* below this -> hue is ill-defined, goes to neutral bucket


def _lab(srgb: np.ndarray) -> np.ndarray:
    return colour.XYZ_to_Lab(colour.sRGB_to_XYZ(srgb))


def _zone_stats(dE, ref_lab, cand, ref) -> dict:
    L = ref_lab[..., 0].ravel()
    dEf = dE.ravel()
    cf = cand.reshape(-1, 3)
    rf = ref.reshape(-1, 3)
    zones = {}
    for name, lo, hi in zip(ZONE_NAMES, ZONE_EDGES[:-1], ZONE_EDGES[1:]):
        m = (L >= lo) & (L < hi)
        n = int(m.sum())
        if n == 0:
            zones[name] = {"n": 0}
            continue
        b = (cf[m] - rf[m]).mean(axis=0)
        zones[name] = {
            "n": n,
            "mean_deltaE": float(dEf[m].mean()),
            "p95_deltaE": float(np.percentile(dEf[m], 95)),
            "max_deltaE": float(dEf[m].max()),
            "bias_r": float(b[0]), "bias_g": float(b[1]), "bias_b": float(b[2]),
        }
    return zones


def _hue_stats(dE, cand_lab, ref_lab, n_bins: int) -> dict:
    a = ref_lab[..., 1].ravel()
    b = ref_lab[..., 2].ravel()
    C = np.hypot(a, b)
    dEf = dE.ravel()
    da = (cand_lab[..., 1] - ref_lab[..., 1]).ravel()
    db = (cand_lab[..., 2] - ref_lab[..., 2]).ravel()

    neu = C < NEUTRAL_CHROMA
    if neu.any():
        neutral = {"n": int(neu.sum()), "mean_deltaE": float(dEf[neu].mean()),
                   "a_shift": float(da[neu].mean()), "b_shift": float(db[neu].mean())}
    else:
        neutral = {"n": 0}

    hue = np.degrees(np.arctan2(b, a)) % 360.0
    width = 360.0 / n_bins
    chromatic = ~neu
    bins = []
    for i in range(n_bins):
        lo, hi = i * width, (i + 1) * width
        m = chromatic & (hue >= lo) & (hue < hi)
        n = int(m.sum())
        if n == 0:
            bins.append({"bin_deg": [round(lo, 1), round(hi, 1)], "n": 0})
            continue
        bins.append({
            "bin_deg": [round(lo, 1), round(hi, 1)], "n": n,
            "mean_deltaE": float(dEf[m].mean()),
            "a_shift": float(da[m].mean()), "b_shift": float(db[m].mean()),
        })
    return {"neutral": neutral, "bins": bins}


def diff(cand_path: str, ref_path: str, *, zones: bool = False,
         hue_bins: int = 0) -> dict:
    """ΔE2000 + per-channel bias of candidate vs reference, optionally with
    per-tonal-zone and per-hue-angle breakdowns. Candidate is Lanczos-resized
    to the reference dims. All binning is on the reference's Lab."""
    ref_im = Image.open(ref_path).convert("RGB")
    cand_im = Image.open(cand_path).convert("RGB")
    if cand_im.size != ref_im.size:
        cand_im = cand_im.resize(ref_im.size, Image.LANCZOS)
    cand = np.asarray(cand_im, dtype=np.float32) / 255.0
    ref = np.asarray(ref_im, dtype=np.float32) / 255.0

    cand_lab = _lab(cand)
    ref_lab = _lab(ref)
    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")
    bias = (cand - ref).mean(axis=(0, 1))

    out = {
        "mean_deltaE": float(np.mean(dE)),
        "p95_deltaE": float(np.percentile(dE, 95)),
        "max_deltaE": float(np.max(dE)),
        "bias_r": float(bias[0]), "bias_g": float(bias[1]), "bias_b": float(bias[2]),
        "n_pixels": int(cand.shape[0] * cand.shape[1]),
    }
    if zones:
        out["zones"] = _zone_stats(dE, ref_lab, cand, ref)
    if hue_bins:
        out["hue_bins"] = _hue_stats(dE, cand_lab, ref_lab, hue_bins)
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("candidate")
    p.add_argument("reference")
    p.add_argument("--zones", action="store_true")
    p.add_argument("--hue-bins", type=int, default=0)
    args = p.parse_args()
    try:
        out = diff(args.candidate, args.reference,
                   zones=args.zones, hue_bins=args.hue_bins)
    except Exception as e:  # noqa: BLE001 — CLI surfaces error as JSON
        print(json.dumps({"error": str(e)}))
        return 2
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
