#!/usr/bin/env python3
"""Measure a rendered color-target image against the known sRGB patch values.

Given a render of the target produced by make_color_target.py (either a headless
maple-cli output PNG, or a SCREENSHOT cropped to just the patch grid), sample
each patch center and report per-patch CIEDE2000 + per-channel delta vs the
documented sRGB value.

Color management: if the rendered image carries an ICC profile (a macOS Retina
screenshot is usually display-P3), it is transformed to sRGB BEFORE comparison,
so the reported shift is the app's, not the measurement's. Pass
--assume-srgb to skip this when you know the input is already sRGB.

The render is assumed to contain ONLY the patch grid (same 6x4 layout); patches
are located by the proportional centers in the sidecar JSON, so absolute size /
Retina scaling does not matter. Use --crop x0,y0,x1,y1 to first crop a full
screenshot down to the canvas rectangle.

Output: a human table to stderr and a single-line JSON summary to stdout. The
summary splits NEUTRAL vs SATURATED-PRIMARY mean ΔE — a large primary delta with
near-zero neutral delta points to a wide-gamut canvas-tag mismatch; large deltas
everywhere incl. neutrals points to a view-transform / tone issue.

Usage:
    measure_color_target.py <rendered.png> <color_target.json> [--crop x0,y0,x1,y1] [--assume-srgb]
"""

import argparse
import io
import json
import sys

import numpy as np
from PIL import Image, ImageCms
import colour

NEUTRALS = {"K_black", "N20", "N40", "N60", "N80", "W_white", "gray18", "gray50"}
PRIMARIES = {"red", "green", "blue", "cyan", "magenta", "yellow"}
SAMPLE_HALF = 8  # average a (2*half+1)^2 window at each center to denoise


def _to_srgb(im: Image.Image, assume_srgb: bool) -> Image.Image:
    icc = im.info.get("icc_profile")
    if assume_srgb or not icc:
        return im.convert("RGB")
    src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
    dst = ImageCms.createProfile("sRGB")
    return ImageCms.profileToProfile(im, src, dst, outputMode="RGB")


def _lab(rgb01: np.ndarray) -> np.ndarray:
    return colour.XYZ_to_Lab(colour.sRGB_to_XYZ(rgb01))


def measure(render_path: str, meta_path: str, crop, assume_srgb: bool) -> dict:
    with open(meta_path) as f:
        meta = json.load(f)
    with Image.open(render_path) as src:
        had_icc = bool(src.info.get("icc_profile"))
        im = _to_srgb(src, assume_srgb)  # returns a new, independent image
    if crop:
        im = im.crop(crop)
    arr = np.asarray(im, dtype=np.uint8)
    H, W = arr.shape[:2]

    rows = []
    for p in meta["patches"]:
        fx, fy = p["center_frac"]
        cx, cy = int(round(fx * W)), int(round(fy * H))
        x0, x1 = max(0, cx - SAMPLE_HALF), min(W, cx + SAMPLE_HALF + 1)
        y0, y1 = max(0, cy - SAMPLE_HALF), min(H, cy + SAMPLE_HALF + 1)
        got = arr[y0:y1, x0:x1].reshape(-1, 3).mean(axis=0)
        exp = np.array(p["srgb"], dtype=np.float64)
        dE = float(
            colour.delta_E(
                _lab(exp[None, :] / 255.0), _lab(got[None, :] / 255.0), method="CIE 2000"
            )[0]
        )
        d = (got - exp)
        rows.append(
            {
                "name": p["name"],
                "expect": exp.astype(int).tolist(),
                "got": [round(float(v), 1) for v in got],
                "dE": round(dE, 2),
                "dr": round(float(d[0]), 1),
                "dg": round(float(d[1]), 1),
                "db": round(float(d[2]), 1),
            }
        )

    def grp(names):
        v = [r["dE"] for r in rows if r["name"] in names]
        return round(float(np.mean(v)), 2) if v else None

    allE = np.array([r["dE"] for r in rows])
    summary = {
        "had_icc_profile": had_icc,
        "color_managed_to_srgb": had_icc and not assume_srgb,
        "n_patches": len(rows),
        "mean_dE": round(float(allE.mean()), 2),
        "p95_dE": round(float(np.percentile(allE, 95)), 2),
        "max_dE": round(float(allE.max()), 2),
        "neutral_mean_dE": grp(NEUTRALS),
        "primary_mean_dE": grp(PRIMARIES),
        "worst": sorted(rows, key=lambda r: -r["dE"])[:5],
    }
    return {"summary": summary, "patches": rows}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("render")
    ap.add_argument("meta")
    ap.add_argument("--crop", default=None, help="x0,y0,x1,y1 pixel crop of a full screenshot")
    ap.add_argument("--assume-srgb", action="store_true")
    a = ap.parse_args()
    crop = tuple(int(v) for v in a.crop.split(",")) if a.crop else None
    out = measure(a.render, a.meta, crop, a.assume_srgb)

    s = out["summary"]
    print(f"{'patch':>11}  {'expect':>15}  {'got':>17}  {'dE':>6}  {'dr':>6} {'dg':>6} {'db':>6}", file=sys.stderr)
    for r in out["patches"]:
        flag = "  <<<" if r["dE"] >= 3.0 else ""
        print(f'{r["name"]:>11}  {str(r["expect"]):>15}  {str(r["got"]):>17}  {r["dE"]:>6}  {r["dr"]:>6} {r["dg"]:>6} {r["db"]:>6}{flag}', file=sys.stderr)
    print(
        f'\nICC profile on render: {s["had_icc_profile"]}  | color-managed->sRGB: {s["color_managed_to_srgb"]}\n'
        f'mean ΔE={s["mean_dE"]}  p95={s["p95_dE"]}  max={s["max_dE"]}  '
        f'| neutral ΔE={s["neutral_mean_dE"]}  primary ΔE={s["primary_mean_dE"]}',
        file=sys.stderr,
    )
    print(json.dumps(out["summary"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
