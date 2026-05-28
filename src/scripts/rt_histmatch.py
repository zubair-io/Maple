#!/usr/bin/env python3
"""Port of RawTherapee's auto-matched tone curve (rtengine/histmatching.cc).

Takes Maple's neutral render and the embedded JPEG, fits the same
luminance-CDF curve RT would derive, applies it to the neutral, then
returns the per-fixture ΔE2000 of (rt-on-neutral vs JPEG). This is
the "RT baseline" the goal calibration requires.

Algorithm (from rtengine/histmatching.cc):
  1. Compute 256-bin CDFs of source (neutral) and target (JPEG) luma.
  2. For each target intensity i in [0, 255], find the source intensity
     j whose CDF value is closest to tcdf[i] (histogram match).
  3. Build a monotonic curve from the mapping (simplified: piecewise
     linear; RT's spline pass is an additional smoothing step we skip
     for the baseline since we're measuring achievable quality, not
     stylistic shaping).
  4. Apply the curve (per RT: as a single luminance-derived tone curve
     on the display-encoded sRGB; we apply identically to R/G/B since
     that's RT's behavior).
  5. Measure ΔE2000 vs JPEG.

Usage:
    rt_histmatch.py <neutral_render.png> <embedded_jpeg.jpg>
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image
import colour


def load_u8(p):
    return np.asarray(Image.open(p).convert("RGB"), dtype=np.uint8)


def get_cdf(img_u8):
    """RT-style: luma per pixel, build 256-bin cumulative."""
    luma = np.clip(
        0.2126 * img_u8[..., 0].astype(np.int32)
        + 0.7152 * img_u8[..., 1].astype(np.int32)
        + 0.0722 * img_u8[..., 2].astype(np.int32),
        0,
        255,
    )
    hist, _ = np.histogram(luma.ravel(), bins=256, range=(0, 256))
    cdf = np.cumsum(hist)
    nz = np.nonzero(hist)[0]
    min_val = int(nz[0]) if len(nz) else 0
    max_val = int(nz[-1]) if len(nz) else 255
    return cdf, min_val, max_val


def find_match(target_val, source_cdf, j):
    """Bidirectional linear search to nearest source intensity whose
    CDF value matches target_val."""
    n = len(source_cdf)
    if source_cdf[j] <= target_val:
        while j < n:
            if source_cdf[j] == target_val:
                return j
            if source_cdf[j] > target_val:
                if j > 0:
                    return j if source_cdf[j] - target_val <= target_val - source_cdf[j - 1] else j - 1
                return j
            j += 1
        return n - 1
    else:
        while j >= 0:
            if source_cdf[j] == target_val:
                return j
            if source_cdf[j] < target_val:
                if j + 1 < n:
                    return j if target_val - source_cdf[j] <= source_cdf[j + 1] - target_val else j + 1
                return j
            j -= 1
        return 0


def fit_mapping(neutral_u8, target_u8):
    """RT mapping[i] = source intensity that maps to target intensity i."""
    scdf, smin, smax = get_cdf(neutral_u8)
    tcdf, tmin, tmax = get_cdf(target_u8)
    mapping = np.full(256, -1, dtype=np.int32)
    j = 0
    for i in range(256):
        j = find_match(tcdf[i], scdf, j)
        if tmin <= i <= tmax and smin <= j <= smax:
            mapping[i] = j
    return mapping


def mapping_to_lut(mapping):
    """Invert mapping[target_i] -> source_j into a LUT[source_j] -> target_i,
    with linear interpolation for gaps. This is the LUT applied to the
    source's pixels: LUT[neutral[x,y]] = output."""
    lut = np.full(256, -1, dtype=np.int32)
    for i in range(256):
        j = mapping[i]
        if j >= 0:
            if lut[j] < 0 or i < lut[j]:
                lut[j] = i
    # Fill gaps with linear interpolation between known points
    known = np.nonzero(lut >= 0)[0]
    if len(known) < 2:
        return np.arange(256, dtype=np.int32)
    # Endpoints
    if known[0] > 0:
        lut[:known[0]] = lut[known[0]]
    if known[-1] < 255:
        lut[known[-1] + 1:] = lut[known[-1]]
    # Interior gaps
    for k in range(len(known) - 1):
        a, b = known[k], known[k + 1]
        if b - a > 1:
            lut[a:b + 1] = np.linspace(lut[a], lut[b], b - a + 1).astype(np.int32)
    # Enforce monotonicity
    for i in range(1, 256):
        if lut[i] < lut[i - 1]:
            lut[i] = lut[i - 1]
    return lut.clip(0, 255).astype(np.uint8)


def apply_rt_curve(neutral_u8, lut):
    """RT applies the luma-derived curve identically to R/G/B (it's a
    tone curve, not a luma transform — hue is restored by other stages
    in RT's pipeline). Returns RGB uint8."""
    return lut[neutral_u8]


def measure_de(cand, ref):
    cand_img = Image.fromarray(cand).convert("RGB")
    ref_img = Image.fromarray(ref).convert("RGB")
    if cand_img.size != ref_img.size:
        cand_img = cand_img.resize(ref_img.size, Image.LANCZOS)
    c = np.asarray(cand_img, dtype=np.float32) / 255.0
    r = np.asarray(ref_img, dtype=np.float32) / 255.0
    c_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(c)).reshape(-1, 3)
    r_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(r)).reshape(-1, 3)
    dE = colour.delta_E(c_lab, r_lab, method="CIE 2000")
    return float(dE.mean()), float(np.percentile(dE, 95))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("neutral")
    ap.add_argument("jpeg")
    args = ap.parse_args()

    neutral_full = load_u8(args.neutral)
    jpeg_full = load_u8(args.jpeg)

    # Resize neutral to JPEG dims for fitting (per RT, both at thumbnail scale).
    neutral_img = Image.fromarray(neutral_full)
    if neutral_img.size != Image.fromarray(jpeg_full).size:
        neutral_img = neutral_img.resize(
            Image.fromarray(jpeg_full).size, Image.LANCZOS
        )
        neutral = np.asarray(neutral_img, dtype=np.uint8)
    else:
        neutral = neutral_full

    mapping = fit_mapping(neutral, jpeg_full)
    lut = mapping_to_lut(mapping)
    rt_output = apply_rt_curve(neutral, lut)

    rt_de_mean, rt_de_p95 = measure_de(rt_output, jpeg_full)
    neutral_de_mean, neutral_de_p95 = measure_de(neutral, jpeg_full)

    print(json.dumps({
        "rt_mean_dE": rt_de_mean,
        "rt_p95_dE": rt_de_p95,
        "neutral_mean_dE": neutral_de_mean,
        "neutral_p95_dE": neutral_de_p95,
        "rt_vs_neutral_delta": rt_de_mean - neutral_de_mean,
    }, indent=2))


if __name__ == "__main__":
    sys.exit(main())
