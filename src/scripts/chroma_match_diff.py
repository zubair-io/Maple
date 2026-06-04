#!/usr/bin/env python3
"""Chroma-match gate for the JPEG chroma-match (Feature 2 / RFC §3.2).

Measures how well a render's CHROMA matches the camera's embedded JPEG —
per-tonal-zone and per-hue, in CIE Lab (D65). This is a different bar than the
ACR color-parity gate (compare_images.py): the target is the *manufacturer
JPEG*, and we compare a*/b*/C* (chroma), NOT L (AgX owns tone deliberately, so
the render's L != the JPEG's L by design).

The two checks that matter (per the spec's load-bearing risk):
  1. per-hue chroma deviation render-vs-JPEG should shrink with chroma on, and
  2. the render must NOT over-saturate highlights — highlight-zone mean C*
     must stay at/below the JPEG's (the anti-HSM-collision check).

Usage:
    chroma_match_diff.py <render.png> <jpeg.png> [--jpeg-colorspace adobe|srgb]

`render.png` is Maple's sRGB display output. `jpeg.png` is the extracted
embedded preview; pass --jpeg-colorspace adobe for Adobe-RGB JPEGs (e.g. Canon
test_0003) so the target chroma isn't understated. Both are taken display-
oriented + the render is Lanczos-resized to the JPEG grid.

Emits single-line JSON (and a human table on stderr).
"""
import argparse
import json
import sys

import numpy as np
from PIL import Image
import colour

Image.MAX_IMAGE_PIXELS = None

HIGHLIGHT_L = 66.6  # L* tercile boundary, matches compare_images.py zones
NEUTRAL_CHROMA = 5.0


def to_lab(rgb01: np.ndarray, colourspace: str) -> np.ndarray:
    """rgb01 (H,W,3 in [0,1], display-encoded) -> CIE Lab (D65, 2°)."""
    if colourspace == "srgb":
        xyz = colour.sRGB_to_XYZ(rgb01)
    else:  # adobe
        cs = colour.RGB_COLOURSPACES["Adobe RGB (1998)"]
        xyz = colour.RGB_to_XYZ(rgb01, cs, apply_cctf_decoding=True)
    return colour.XYZ_to_Lab(xyz)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("render")
    p.add_argument("jpeg")
    p.add_argument("--jpeg-colorspace", choices=["adobe", "srgb"], default="adobe")
    p.add_argument("--hue-bins", type=int, default=12)
    args = p.parse_args()

    jpeg_img = Image.open(args.jpeg).convert("RGB")
    render_img = Image.open(args.render).convert("RGB")
    if render_img.size != jpeg_img.size:
        render_img = render_img.resize(jpeg_img.size, Image.LANCZOS)

    render = np.asarray(render_img, dtype=np.float32) / 255.0
    jpeg = np.asarray(jpeg_img, dtype=np.float32) / 255.0

    r_lab = to_lab(render, "srgb")
    j_lab = to_lab(jpeg, args.jpeg_colorspace)

    rL, ra, rb = r_lab[..., 0].ravel(), r_lab[..., 1].ravel(), r_lab[..., 2].ravel()
    jL, ja, jb = j_lab[..., 0].ravel(), j_lab[..., 1].ravel(), j_lab[..., 2].ravel()
    rC = np.hypot(ra, rb)
    jC = np.hypot(ja, jb)
    # per-pixel chroma deviation render-vs-JPEG (a/b Euclidean).
    dev = np.hypot(ra - ja, rb - jb)

    out = {
        "n_pixels": int(rL.size),
        "chroma_dev_mean": float(dev.mean()),
        "chroma_dev_p95": float(np.percentile(dev, 95)),
    }

    # Per-zone (by the RENDER's L* — "is the render over-saturated where IT is
    # bright?"). Highlight C* is the load-bearing over-saturation check.
    zones = {}
    for name, lo, hi in (("shadow", 0.0, 33.3), ("mid", 33.3, HIGHLIGHT_L), ("highlight", HIGHLIGHT_L, 1e9)):
        m = (rL >= lo) & (rL < hi)
        n = int(m.sum())
        if n == 0:
            zones[name] = {"n": 0}
            continue
        zones[name] = {
            "n": n,
            "chroma_dev_mean": float(dev[m].mean()),
            "render_C_mean": float(rC[m].mean()),
            "jpeg_C_mean": float(jC[m].mean()),
            "C_over": float(rC[m].mean() - jC[m].mean()),  # >0 => render MORE saturated than JPEG
        }
    out["zones"] = zones

    # Per-hue (by the JPEG/target hue angle), chromatic pixels only.
    chrom = jC >= NEUTRAL_CHROMA
    hue = np.degrees(np.arctan2(jb, ja)) % 360.0
    width = 360.0 / args.hue_bins
    bins = []
    for i in range(args.hue_bins):
        m = chrom & (hue >= i * width) & (hue < (i + 1) * width)
        n = int(m.sum())
        bins.append(
            {"bin_deg": [round(i * width, 1), round((i + 1) * width, 1)], "n": n,
             "chroma_dev_mean": (float(dev[m].mean()) if n else 0.0)}
        )
    out["hue_bins"] = bins

    # Human-readable summary on stderr.
    hz = zones.get("highlight", {})
    print(
        f"chroma_dev_mean={out['chroma_dev_mean']:.2f}  "
        f"highlight: render_C={hz.get('render_C_mean', 0):.2f} jpeg_C={hz.get('jpeg_C_mean', 0):.2f} "
        f"C_over={hz.get('C_over', 0):+.2f} {'OVER-SATURATED' if hz.get('C_over', 0) > 0.5 else 'ok'}",
        file=sys.stderr,
    )
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
