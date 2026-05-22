#!/usr/bin/env python3
"""Banding detector for a synthetic-ramp stage-dump.

Usage:
    banding_check.py <dump_dir> [--json <out.json>] [--stage <stage>]

Given a `MAPLE_STAGE_DUMP` directory produced by rendering a synthetic
neutral 0→1 ramp through `maple-cli synthetic --kind neutral-ramp`,
report three sanity metrics on the post-AgX EXR (or any other stage
selected via `--stage`):

  1. Per-row R/G/B equality — `max |R - G|` and `max |R - B|` over
     every row. The input is achromatic by construction, so anything
     above floating-point noise means a per-channel stage rotated the
     ramp.

  2. Per-channel monotonicity — count of decreasing steps along the
     ramp axis (x). A working sigmoid is monotone; any decrease
     points at a LUT bug, a quantisation artefact, or the dreaded
     "tone-curve crossing zero" symptom.

  3. Shadow histogram-gap count — number of empty 0.001-wide bins
     between filled bins in the `Y < 0.1` region. Shadow banding
     appears as periodic gaps from a too-coarse LUT.

This is a diagnostic, not a gate — exit 0 always. Same EXR loader and
dependency set as `stage_stats.py` / `stage_diff.py` (OpenEXR first,
imageio fallback).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

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


REC2020_LUM = np.array([0.2627, 0.6780, 0.0593], dtype=np.float32)
SHADOW_LUMA = 0.10
HIST_BIN = 0.001
DEFAULT_STAGE = "16_agx"


def load_exr_rgb(path: Path) -> np.ndarray:
    """Return (H, W, 3) float32 RGB. Same loader as stage_stats.py."""
    if _OPENEXR_AVAILABLE:
        f = OpenEXR.InputFile(str(path))
        hdr = f.header()
        dw = hdr["dataWindow"]
        w = dw.max.x - dw.min.x + 1
        h = dw.max.y - dw.min.y + 1
        pt = Imath.PixelType(Imath.PixelType.FLOAT)
        channels = hdr["channels"]

        def read_chan(name_upper: str) -> np.ndarray:
            name = name_upper if name_upper in channels else name_upper.lower()
            if name not in channels:
                raise ValueError(
                    f"{path}: expected channel {name_upper!r}, got {list(channels.keys())}"
                )
            buf = f.channel(name, pt)
            return np.frombuffer(buf, dtype=np.float32).reshape(h, w)

        return np.stack([read_chan("R"), read_chan("G"), read_chan("B")], axis=-1)

    if _IMAGEIO_AVAILABLE:
        arr = iio.imread(str(path))
        if arr.ndim != 3 or arr.shape[2] < 3:
            raise ValueError(f"{path}: expected 3-channel EXR, got shape {arr.shape}")
        arr = arr[:, :, :3]
        if arr.dtype == np.uint8:
            arr = arr.astype(np.float32) / 255.0
        return arr.astype(np.float32)

    raise RuntimeError(
        "Neither OpenEXR nor imageio.v3 is available. "
        "Install one: pip install openexr  OR  pip install imageio"
    )


def per_row_rgb_drift(rgb: np.ndarray) -> dict:
    """Per-row R/G/B equality, aggregated across rows.

    For each row, take the max |R-G|, |R-B|, |G-B| within that row.
    Then report the max-across-rows (worst row) and mean-across-rows
    (typical row). The synthetic ramp is achromatic per row by
    construction, so anything above 1e-6 in the pre-quantize EXR
    points at a per-channel stage that rotated the input. Reporting
    per-row keeps the metric diagnostic — a single bad row pulls the
    max up without diluting the mean across all the clean rows.
    """
    r = rgb[..., 0]
    g = rgb[..., 1]
    b = rgb[..., 2]
    per_row_rg = np.abs(r - g).max(axis=1)
    per_row_rb = np.abs(r - b).max(axis=1)
    per_row_gb = np.abs(g - b).max(axis=1)
    return {
        "max_abs_rg": float(per_row_rg.max()),
        "max_abs_rb": float(per_row_rb.max()),
        "max_abs_gb": float(per_row_gb.max()),
        "mean_abs_rg": float(per_row_rg.mean()),
        "mean_abs_rb": float(per_row_rb.mean()),
        "mean_abs_gb": float(per_row_gb.mean()),
    }


def per_channel_monotonicity(rgb: np.ndarray) -> dict:
    """Count steps along x where the channel value strictly decreased.
    Walks every row; sums into a per-channel total. A working AgX over
    a monotone input has zero such steps."""
    out: dict[str, int] = {}
    for i, name in enumerate("rgb"):
        ch = rgb[..., i]  # (H, W)
        # diff along x; negative diffs are descending steps.
        diff = np.diff(ch, axis=1)
        out[name] = int((diff < -1e-7).sum())
    return out


def shadow_histogram_gaps(rgb: np.ndarray) -> dict:
    """Count empty histogram bins (width = HIST_BIN) between filled bins
    in the shadow region (luma < SHADOW_LUMA). On a quantised /
    too-coarsely-LUT'd sigmoid, the post-AgX shadow shows up as a comb
    of filled-empty-filled-empty bins. We count how many empty bins sit
    between filled ones, per channel.
    """
    luma = (rgb * REC2020_LUM).sum(axis=-1)
    mask = luma < SHADOW_LUMA
    out: dict[str, dict] = {}
    for i, name in enumerate("rgb"):
        vals = rgb[..., i][mask]
        if vals.size < 4:
            out[name] = {"gap_bins": 0, "n_samples": int(vals.size)}
            continue
        lo, hi = float(vals.min()), float(vals.max())
        if hi - lo < HIST_BIN * 2:
            out[name] = {"gap_bins": 0, "n_samples": int(vals.size)}
            continue
        n_bins = int(np.ceil((hi - lo) / HIST_BIN)) + 1
        hist, _ = np.histogram(vals, bins=n_bins, range=(lo, lo + n_bins * HIST_BIN))
        filled = hist > 0
        if filled.sum() < 2:
            out[name] = {"gap_bins": 0, "n_samples": int(vals.size)}
            continue
        first = int(np.argmax(filled))
        last = len(filled) - 1 - int(np.argmax(filled[::-1]))
        gap_bins = int((~filled[first:last + 1]).sum())
        out[name] = {
            "gap_bins": gap_bins,
            "n_samples": int(vals.size),
            "first_bin": first,
            "last_bin": last,
            "total_bins_in_range": int(last - first + 1),
        }
    return out


def main() -> int:
    p = argparse.ArgumentParser(
        description="Banding detector for a synthetic-ramp MAPLE_STAGE_DUMP.",
    )
    p.add_argument("dump_dir", type=Path, help="directory of NN_stage.exr files")
    p.add_argument("--stage", default=DEFAULT_STAGE,
                   help=f"stage to analyse (default: {DEFAULT_STAGE})")
    p.add_argument("--json", type=Path, help="optional path to write JSON metrics")
    args = p.parse_args()

    if not args.dump_dir.is_dir():
        print(f"error: {args.dump_dir} is not a directory", file=sys.stderr)
        return 2

    exr_path = args.dump_dir / f"{args.stage}.exr"
    if not exr_path.exists():
        print(f"error: no EXR for stage {args.stage!r} in {args.dump_dir}", file=sys.stderr)
        print(f"  expected: {exr_path}", file=sys.stderr)
        available = sorted(p.name for p in args.dump_dir.glob("*.exr"))
        print(f"  available: {available}", file=sys.stderr)
        return 0  # diagnostic — never fail the harness on missing dumps

    rgb = load_exr_rgb(exr_path)
    drift = per_row_rgb_drift(rgb)
    monot = per_channel_monotonicity(rgb)
    gaps = shadow_histogram_gaps(rgb)

    print(f"# Banding detector — stage {args.stage} ({rgb.shape[1]}x{rgb.shape[0]})")
    print()
    print(f"R/G/B equality (max abs diff over all pixels):")
    print(f"  |R - G|:  max={drift['max_abs_rg']:.6f}  mean={drift['mean_abs_rg']:.6f}")
    print(f"  |R - B|:  max={drift['max_abs_rb']:.6f}  mean={drift['mean_abs_rb']:.6f}")
    print(f"  |G - B|:  max={drift['max_abs_gb']:.6f}  mean={drift['mean_abs_gb']:.6f}")
    print()
    print(f"Monotonicity (count of decreasing steps along x):")
    for name, count in monot.items():
        print(f"  {name}: {count} decreasing steps")
    print()
    print(f"Shadow histogram gaps (luma < {SHADOW_LUMA}, bin width = {HIST_BIN}):")
    for name, g in gaps.items():
        if g.get("total_bins_in_range") is None:
            print(f"  {name}: no shadow samples (n={g['n_samples']})")
        else:
            tot = g["total_bins_in_range"]
            gap = g["gap_bins"]
            pct = (gap / tot * 100.0) if tot else 0.0
            print(
                f"  {name}: {gap} empty bins out of {tot} "
                f"({pct:.1f}%, n={g['n_samples']})"
            )

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({
            "stage": args.stage,
            "shape": list(rgb.shape),
            "rgb_drift": drift,
            "monotonicity": monot,
            "shadow_gaps": gaps,
        }, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
