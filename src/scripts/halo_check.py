#!/usr/bin/env python3
"""Halo / overshoot detector for a synthetic dark-disk stage-dump.

Usage:
    halo_check.py <dump_dir> [--json <out.json>] [--stage <stage>]

Reads the post-AgX EXR (or `--stage`) of a `halo_disk` render and samples
the radial intensity profile from the disk centre outward (along +x).
Reports the max overshoot percentage above the asymptotic background
level just outside the disk edge.

A clean local-contrast algorithm shows < 2 % overshoot. An
unsharp-mask-based clarity / dehaze rolls the brightness over the
nominal background level on the way out, producing a clear "halo"
peak; the harness gets a number it can ratchet down as the algorithms
get fixed.

This is a diagnostic, not a gate — exit 0 always.
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
DEFAULT_STAGE = "16_agx"


def load_exr_rgb(path: Path) -> np.ndarray:
    """Return (H, W, 3) float32 RGB."""
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
                raise ValueError(f"{path}: missing channel {name_upper!r}")
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


def radial_profile(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (radii_px, luma_at_radius) walking +x from the centre
    along the middle row. The synthetic disk is centred and achromatic,
    so a single radial cut is enough — we don't need to average over
    annuli."""
    h, w = rgb.shape[:2]
    cx = (w - 1) / 2.0
    cy = (h - 1) / 2.0
    row = rgb[int(round(cy)), :, :]
    luma = (row * REC2020_LUM).sum(axis=-1)
    # Walk from centre to the right edge.
    xs = np.arange(w, dtype=np.float32)
    radii = xs - cx
    mask = radii >= 0
    return radii[mask], luma[mask]


def halo_overshoot(radii: np.ndarray, luma: np.ndarray) -> dict:
    """Find the disk's apparent radius (last sample with luma <
    midpoint), the asymptotic background level (mean of the outermost
    25 % of the profile), and the max overshoot above background in
    the transition band immediately outside the edge.

    Returns:
        {
          "background": float,         # background asymptote
          "min_inside":  float,        # min luma inside (disk centre)
          "edge_radius_px": float,     # pixel distance from centre where luma crosses midpoint
          "max_overshoot_abs": float,  # max(luma) - background in band
          "max_overshoot_pct": float,  # 100 * that / background
          "peak_radius_px":   float,   # pixel distance from centre where overshoot peaks
        }

    `radii` and `luma` are matched 1D arrays from `radial_profile` — the
    `radii` entries are true pixel distances from the image centre, so we
    look up `radii[idx]` to convert any sample index into a px-from-cx
    value before reporting.
    """
    if luma.size < 8:
        return {"error": f"radial profile too short: {luma.size}"}
    mid = (luma.min() + luma.max()) / 2.0
    # Edge index = first sample past centre where luma >= midpoint.
    edge_idx = int(np.argmax(luma >= mid))
    edge_radius_px = float(radii[edge_idx])
    # Background = mean of the outermost 25 % of the profile (well past
    # the edge so any overshoot/ringing has died out).
    tail = max(1, luma.size // 4)
    background = float(luma[-tail:].mean())
    # Overshoot band: 1 → 4 disk-edge widths past the edge (in indices).
    edge_width = max(2, edge_idx // 8)
    band_start = edge_idx + 1
    band_end = min(luma.size, edge_idx + 1 + 4 * edge_width)
    if band_end - band_start < 2:
        # The disk fills the whole image. Bail.
        return {
            "background": background,
            "min_inside": float(luma.min()),
            "edge_radius_px": edge_radius_px,
            "max_overshoot_abs": 0.0,
            "max_overshoot_pct": 0.0,
            "peak_radius_px": 0.0,
            "note": "edge too close to image boundary for an overshoot band",
        }
    band = luma[band_start:band_end]
    peak_local = int(np.argmax(band))
    peak_idx = band_start + peak_local
    max_in_band = float(band.max())
    overshoot_abs = max_in_band - background
    overshoot_pct = 100.0 * overshoot_abs / max(background, 1e-6)
    return {
        "background": background,
        "min_inside": float(luma.min()),
        "edge_radius_px": edge_radius_px,
        "max_overshoot_abs": overshoot_abs,
        "max_overshoot_pct": overshoot_pct,
        "peak_radius_px": float(radii[peak_idx]),
    }


def main() -> int:
    p = argparse.ArgumentParser(
        description="Halo detector for a synthetic dark-disk MAPLE_STAGE_DUMP.",
    )
    p.add_argument("dump_dir", type=Path)
    p.add_argument("--stage", default=DEFAULT_STAGE,
                   help=f"stage to analyse (default: {DEFAULT_STAGE})")
    p.add_argument("--json", type=Path)
    args = p.parse_args()

    if not args.dump_dir.is_dir():
        print(f"error: {args.dump_dir} is not a directory", file=sys.stderr)
        return 2

    exr_path = args.dump_dir / f"{args.stage}.exr"
    if not exr_path.exists():
        print(f"error: no EXR for stage {args.stage!r} in {args.dump_dir}",
              file=sys.stderr)
        return 0  # diagnostic — never block

    rgb = load_exr_rgb(exr_path)
    radii, luma = radial_profile(rgb)
    res = halo_overshoot(radii, luma)

    print(f"# Halo detector — stage {args.stage} ({rgb.shape[1]}x{rgb.shape[0]})")
    print()
    if "error" in res:
        print(f"error: {res['error']}")
        return 0
    print(f"  background luma (asymptote): {res['background']:.4f}")
    print(f"  inside luma (disk centre):   {res['min_inside']:.4f}")
    print(f"  edge radius (px from cx):    {res['edge_radius_px']:.1f}")
    print(f"  max overshoot (abs):         {res['max_overshoot_abs']:+.4f}")
    print(f"  max overshoot (pct of bg):   {res['max_overshoot_pct']:+.2f} %")
    print(f"  peak radius (px from cx):    {res['peak_radius_px']:.1f}")
    if res.get("note"):
        print(f"  note: {res['note']}")
    print()
    print("# A clean local-contrast algorithm overshoots < 2 %; "
          "unsharp-mask-based clarity/dehaze overshoots 5–15 %.")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({
            "stage": args.stage,
            "shape": list(rgb.shape),
            "profile_samples": int(luma.size),
            "overshoot": res,
        }, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
