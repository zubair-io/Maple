#!/usr/bin/env python3
"""Per-pixel CIEDE2000 heatmap between two sRGB PNGs.

Usage:
    diff_heatmap.py <candidate.png> <reference.png> <out_dir>

Writes:
    <out_dir>/dE_heatmap.png      — color-coded ΔE per pixel
    <out_dir>/dE_threshold_3.png  — black where ΔE ≤ 3, candidate where > 3
    <out_dir>/cand_resized.png    — candidate resized to reference dims
    <out_dir>/ref_resized.png     — reference at native dims (for side-by-side)
    <out_dir>/quadrants.json      — per-quadrant mean / max ΔE
    stdout: same JSON as compare_images.py + quadrant breakdown.

Honors the candidate PNG's ICC profile (Display P3 etc.) by going
through Pillow's ImageCms when present. References are assumed sRGB.
"""

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageCms
import colour


def load_srgb_with_profile(path: str) -> np.ndarray:
    """Load PNG, color-match to sRGB if it carries a wider profile.

    Returns float32 [0,1] HxWx3.
    """
    im = Image.open(path)
    icc = im.info.get("icc_profile")
    if icc:
        src_profile = ImageCms.ImageCmsProfile(io_or_path_from_bytes(icc))
        srgb_profile = ImageCms.createProfile("sRGB")
        im = ImageCms.profileToProfile(im, src_profile, srgb_profile,
                                       outputMode="RGB")
    else:
        im = im.convert("RGB")
    return np.asarray(im, dtype=np.float32) / 255.0


def io_or_path_from_bytes(b: bytes):
    import io
    return io.BytesIO(b)


def heatmap_rgb(dE: np.ndarray, max_dE: float = 50.0) -> np.ndarray:
    """ΔE heatmap. Blue (low) → green (mid) → yellow → red (high)."""
    norm = np.clip(dE / max_dE, 0.0, 1.0)
    # 4-stop gradient: 0=blue, 0.33=green, 0.66=yellow, 1.0=red.
    # Linear interpolation in RGB.
    stops = np.array([
        [0.0, 0.0, 0.6],     # navy
        [0.0, 0.7, 0.0],     # green
        [1.0, 1.0, 0.0],     # yellow
        [1.0, 0.1, 0.0],     # red
    ])
    positions = np.array([0.0, 0.33, 0.66, 1.0])
    rgb = np.zeros(norm.shape + (3,), dtype=np.float32)
    for i in range(3):
        rgb[..., i] = np.interp(norm, positions, stops[:, i])
    return (rgb * 255).astype(np.uint8)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("candidate")
    p.add_argument("reference")
    p.add_argument("out_dir")
    p.add_argument("--max-de", type=float, default=50.0,
                   help="ΔE that maps to red (default 50).")
    args = p.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)

    cand = load_srgb_with_profile(args.candidate)
    ref = load_srgb_with_profile(args.reference)

    # Resize candidate to reference's exact dims. PIL resize on the
    # already-decoded uint8 buffer.
    if cand.shape != ref.shape:
        ref_h, ref_w = ref.shape[:2]
        cand_im = Image.fromarray(
            (cand * 255).astype(np.uint8)
        ).resize((ref_w, ref_h), Image.LANCZOS)
        cand = np.asarray(cand_im, dtype=np.float32) / 255.0

    # Save resized inputs for side-by-side review.
    Image.fromarray((cand * 255).astype(np.uint8)).save(
        os.path.join(args.out_dir, "cand_resized.png"))
    Image.fromarray((ref * 255).astype(np.uint8)).save(
        os.path.join(args.out_dir, "ref_resized.png"))

    cand_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(cand))
    ref_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(ref))
    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")

    # Heatmap
    Image.fromarray(heatmap_rgb(dE, max_dE=args.max_de)).save(
        os.path.join(args.out_dir, "dE_heatmap.png"))

    # Threshold view: blackout where ΔE ≤ 3, show candidate where > 3.
    thresh = (cand * 255).astype(np.uint8).copy()
    mask = dE <= 3.0
    thresh[mask] = [0, 0, 0]
    Image.fromarray(thresh).save(
        os.path.join(args.out_dir, "dE_threshold_3.png"))

    # Quadrant breakdown (rough spatial story)
    h, w = dE.shape
    half_h, half_w = h // 2, w // 2
    quads = {
        "TL": dE[:half_h, :half_w],
        "TR": dE[:half_h, half_w:],
        "BL": dE[half_h:, :half_w],
        "BR": dE[half_h:, half_w:],
    }
    quad_stats = {
        name: {
            "mean": float(np.mean(q)),
            "p95":  float(np.percentile(q, 95)),
            "max":  float(np.max(q)),
        }
        for name, q in quads.items()
    }

    bias = (cand - ref).mean(axis=(0, 1))
    out = {
        "mean_deltaE": float(np.mean(dE)),
        "p95_deltaE":  float(np.percentile(dE, 95)),
        "max_deltaE":  float(np.max(dE)),
        "bias_r":      float(bias[0]),
        "bias_g":      float(bias[1]),
        "bias_b":      float(bias[2]),
        "n_pixels":    int(cand.shape[0] * cand.shape[1]),
        "size":        [int(cand.shape[1]), int(cand.shape[0])],
        "quadrants":   quad_stats,
    }
    with open(os.path.join(args.out_dir, "quadrants.json"), "w") as f:
        json.dump(out, f, indent=2)
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
