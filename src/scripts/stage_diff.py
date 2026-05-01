#!/usr/bin/env python3
"""Compare two stage-trace dirs and print a per-stage ΔE table.

Usage:
    stage_diff.py <dir_a> <dir_b> [--heatmaps <out_dir>]

For each EXR present in both <dir_a> and <dir_b>:
  1. Load both buffers as float32 RGB.
  2. Convert scene-linear Rec.2020 → Lab via colour-science.
  3. Compute CIEDE2000 per pixel; emit mean / p95 / max + per-channel bias.
  4. Optionally write a heatmap PNG per stage when --heatmaps is given.

Output: column-aligned table sorted by filename (which sorts in pipeline
order due to the NN_ prefix). Largest mean-ΔE row is annotated.

Exit code 0 always — this is a diagnostic, not a gate.

EXR loader note: imageio.v3 returns uint8 on this platform (Pillow-backed
EXR path). Instead we use the OpenEXR Python binding directly, which reads
f32 channels exactly as written by raw-core's exr crate.
"""

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import colour

try:
    import OpenEXR
    import Imath
    _OPENEXR_AVAILABLE = True
except ImportError:
    _OPENEXR_AVAILABLE = False

try:
    import imageio.v3 as iio
    _IMAGEIO_AVAILABLE = True
except ImportError:
    _IMAGEIO_AVAILABLE = False


def load_exr_rec2020(path: Path) -> np.ndarray:
    """Load an EXR and return its pixels as (H, W, 3) float32 in
    scene-linear Rec.2020 D65 (the working colorspace of raw-core).

    Prefers the OpenEXR Python binding (reads f32 channels exactly).
    Falls back to imageio.v3 if OpenEXR is unavailable, but warns
    that imageio may silently downcast to uint8 on some platforms.
    """
    if _OPENEXR_AVAILABLE:
        return _load_exr_openexr(path)
    if _IMAGEIO_AVAILABLE:
        return _load_exr_imageio(path)
    raise RuntimeError("Neither OpenEXR nor imageio.v3 is available. "
                       "Install one: pip install openexr  OR  pip install imageio")


def _load_exr_openexr(path: Path) -> np.ndarray:
    """Read EXR via the OpenEXR C binding — float32 exact."""
    f = OpenEXR.InputFile(str(path))
    hdr = f.header()
    dw = hdr["dataWindow"]
    w = dw.max.x - dw.min.x + 1
    h = dw.max.y - dw.min.y + 1
    pt = Imath.PixelType(Imath.PixelType.FLOAT)
    channels = hdr["channels"]
    # raw-core writes R, G, B. Handle both upper-case and lower-case names.
    def read_chan(name_upper: str) -> np.ndarray:
        name = name_upper if name_upper in channels else name_upper.lower()
        if name not in channels:
            raise ValueError(f"{path}: expected channel '{name_upper}', "
                             f"got channels {list(channels.keys())}")
        buf = f.channel(name, pt)
        return np.frombuffer(buf, dtype=np.float32).reshape(h, w)
    r = read_chan("R")
    g = read_chan("G")
    b = read_chan("B")
    return np.stack([r, g, b], axis=-1)


def _load_exr_imageio(path: Path) -> np.ndarray:
    """Fallback: read EXR via imageio.v3. May silently return uint8 on
    platforms where Pillow handles the EXR decode; caller should verify."""
    arr = iio.imread(str(path))
    if arr.ndim != 3 or arr.shape[2] < 3:
        raise ValueError(f"{path}: expected 3-channel EXR, got shape {arr.shape}")
    arr = arr[:, :, :3]
    if arr.dtype == np.uint8:
        import warnings
        warnings.warn(
            f"{path}: imageio returned uint8 (Pillow path) — values will be "
            "normalised to [0,1] but precision is lost. Install the OpenEXR "
            "Python package for exact f32 readback.",
            RuntimeWarning, stacklevel=3,
        )
        arr = arr.astype(np.float32) / 255.0
    return arr.astype(np.float32)


def diff_stage(a: np.ndarray, b: np.ndarray) -> dict:
    """Compute mean/p95/max ΔE₀₀ + per-channel bias between two
    scene-linear Rec.2020 buffers. Both must be the same shape."""
    if a.shape != b.shape:
        return {"error": f"shape mismatch: {a.shape} vs {b.shape}"}

    # Rec.2020 scene-linear → CIE XYZ → Lab. colour-science's RGB_to_XYZ
    # with Rec.2020 colourspace handles the matrix.
    cs = colour.RGB_COLOURSPACES["ITU-R BT.2020"]
    a_xyz = colour.RGB_to_XYZ(a.clip(0, None), cs.whitepoint, cs.whitepoint, cs.matrix_RGB_to_XYZ)
    b_xyz = colour.RGB_to_XYZ(b.clip(0, None), cs.whitepoint, cs.whitepoint, cs.matrix_RGB_to_XYZ)
    a_lab = colour.XYZ_to_Lab(a_xyz)
    b_lab = colour.XYZ_to_Lab(b_xyz)
    dE = colour.delta_E(a_lab, b_lab, method="CIE 2000")
    bias = (a - b).mean(axis=(0, 1))
    return {
        "mean_dE":  float(np.mean(dE)),
        "p95_dE":   float(np.percentile(dE, 95)),
        "max_dE":   float(np.max(dE)),
        "bias_r":   float(bias[0]),
        "bias_g":   float(bias[1]),
        "bias_b":   float(bias[2]),
        "dE_array": dE,  # used by heatmap writer
    }


def write_heatmap(stage: str, dE: np.ndarray, out_dir: Path) -> Path:
    """Write a viridis-style heatmap PNG. Caps at ΔE=10 for color stability."""
    if not _IMAGEIO_AVAILABLE:
        raise RuntimeError("imageio.v3 is required for --heatmaps. "
                           "Install it: pip install imageio")
    cap = 10.0
    norm = np.clip(dE / cap, 0.0, 1.0)
    # Cheap viridis-ish: blue (low) → green → yellow → red (high).
    r = np.clip(norm * 2.0 - 0.5, 0, 1)
    g = np.clip(np.where(norm < 0.5, norm * 2, 2 - norm * 2), 0, 1)
    b = np.clip(1.0 - norm * 2.0, 0, 1)
    rgb = (np.stack([r, g, b], axis=-1) * 255).astype(np.uint8)
    out_path = out_dir / f"{stage}_dE.png"
    iio.imwrite(str(out_path), rgb)
    return out_path


def main() -> int:
    p = argparse.ArgumentParser(
        description="Compare two MAPLE_STAGE_DUMP dirs and print a per-stage ΔE table.",
    )
    p.add_argument("dir_a", type=Path)
    p.add_argument("dir_b", type=Path)
    p.add_argument("--heatmaps", type=Path, help="optional output directory for ΔE heatmap PNGs")
    args = p.parse_args()

    if not args.dir_a.is_dir() or not args.dir_b.is_dir():
        print(f"error: both {args.dir_a} and {args.dir_b} must exist", file=sys.stderr)
        return 2

    if args.heatmaps:
        args.heatmaps.mkdir(parents=True, exist_ok=True)

    a_files = {f.name for f in args.dir_a.glob("*.exr")}
    b_files = {f.name for f in args.dir_b.glob("*.exr")}
    common = sorted(a_files & b_files)
    only_a = sorted(a_files - b_files)
    only_b = sorted(b_files - a_files)

    print(f"{'stage':<32} {'mean':>7} {'p95':>7} {'max':>8} {'bR':>9} {'bG':>9} {'bB':>9}")
    print("-" * 92)

    rows = []
    for name in common:
        try:
            a = load_exr_rec2020(args.dir_a / name)
            b = load_exr_rec2020(args.dir_b / name)
            res = diff_stage(a, b)
        except Exception as e:
            print(f"{name:<32} ERROR {e}")
            continue
        if "error" in res:
            print(f"{name:<32} {res['error']}")
            continue

        stage = name[:-4]  # strip .exr
        rows.append((stage, res))
        print(f"{stage:<32} {res['mean_dE']:7.3f} {res['p95_dE']:7.3f} {res['max_dE']:8.3f} "
              f"{res['bias_r']:+9.5f} {res['bias_g']:+9.5f} {res['bias_b']:+9.5f}")

        if args.heatmaps:
            write_heatmap(stage, res["dE_array"], args.heatmaps)

    if rows:
        worst_stage, worst = max(rows, key=lambda r: r[1]["mean_dE"])
        print("-" * 92)
        print(f"# worst-mean stage: {worst_stage} ({worst['mean_dE']:.3f})")

    if only_a:
        print(f"# only in {args.dir_a}: {', '.join(only_a)}")
    if only_b:
        print(f"# only in {args.dir_b}: {', '.join(only_b)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
