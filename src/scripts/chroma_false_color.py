#!/usr/bin/env python3
"""Measures false chroma injected into near-neutral regions.

Given a render PNG and the embedded JPEG, counts the % of pixels that the JPEG
renders near-neutral (C* < 5 in CIE Lab) but the render gives C* > 15.
This is the Phase-1 blotching metric: root-polynomial blowup injected false
chroma into 10.7% of near-neutral pixels (neutral baseline: ~3.3%).

Usage:
    chroma_false_color.py <render.png> <jpeg.png> [--jpeg-colorspace adobe|srgb]

Emits JSON: {"near_neutral_pct": <pct of JPEG pixels with C*<5>,
             "false_chroma_pct": <pct of those with render C*>15>,
             "n_pixels": <total>}
"""
import argparse, json, sys
import numpy as np
from PIL import Image
import colour

Image.MAX_IMAGE_PIXELS = None
JPEG_NEUTRAL_C = 5.0    # below this the JPEG says "near neutral"
RENDER_FALSE_C = 15.0   # above this in the render = false chroma injected


def to_lab(rgb01, colorspace):
    if colorspace == "srgb":
        xyz = colour.sRGB_to_XYZ(rgb01)
    else:
        cs = colour.RGB_COLOURSPACES["Adobe RGB (1998)"]
        xyz = colour.RGB_to_XYZ(rgb01, cs, apply_cctf_decoding=True)
    return colour.XYZ_to_Lab(xyz)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("render")
    p.add_argument("jpeg")
    p.add_argument("--jpeg-colorspace", choices=["adobe", "srgb"], default="srgb")
    args = p.parse_args()

    jpeg_im = Image.open(args.jpeg).convert("RGB")
    render_im = Image.open(args.render).convert("RGB")
    if render_im.size != jpeg_im.size:
        render_im = render_im.resize(jpeg_im.size, Image.LANCZOS)

    j = np.asarray(jpeg_im, dtype=np.float32) / 255.0
    r = np.asarray(render_im, dtype=np.float32) / 255.0

    j_lab = to_lab(j, args.jpeg_colorspace)
    r_lab = to_lab(r, "srgb")

    jC = np.hypot(j_lab[..., 1], j_lab[..., 2]).ravel()
    rC = np.hypot(r_lab[..., 1], r_lab[..., 2]).ravel()

    near_neutral = jC < JPEG_NEUTRAL_C
    false_chroma = near_neutral & (rC > RENDER_FALSE_C)

    result = {
        "n_pixels": int(jC.size),
        "near_neutral_pct": float(100.0 * near_neutral.mean()),
        "false_chroma_pct": float(100.0 * (false_chroma.sum() / near_neutral.sum()
                                           if near_neutral.any() else 0.0)),
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
