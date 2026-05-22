#!/usr/bin/env python3
"""Hue-stability detector across exposure for saturated primaries.

Usage:
    hue_stability.py <dump_root> [--json <out.json>] [--stage <stage>]

`<dump_root>` is a directory of per-(primary, EV) subdirs, each holding a
`MAPLE_STAGE_DUMP` trace from rendering a synthetic `hue_patch` at that
primary / exposure. The harness script `test_hue_stability.sh` produces
this layout:

    dump_root/
      r_-3/  ← red primary at EV=-3
      r_-1/
      r_0/
      r_+1/
      r_+3/
      r_+5/
      g_-3/
      …

For each primary, the detector reads the post-AgX EXR
(`--stage`, default `16_agx`), converts each EV's display-linear Rec.2020
value into CAM16-UCS via colour-science, takes the hue angle
`atan2(b', a')`, and reports the max angular drift across the six EVs.

A real-Sobotka-AgX render drifts < 3° across the full -3 to +5 EV
sweep. The current Maple sigmoid rotates per-channel and shows large
drifts on the magenta / cyan / red primaries — the signal this
detector is designed to surface.

This is a diagnostic, not a gate — exit 0 always.

Falls back to Oklab hue angle if colour-science's CAM16-UCS path is
unavailable on the platform (prints a `# fallback: oklab` line).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

try:
    import colour
    _COLOUR_AVAILABLE = True
except ImportError:
    _COLOUR_AVAILABLE = False

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


DEFAULT_STAGE = "16_agx"
PRIMARIES = ["r", "g", "b", "c", "m", "y"]


def load_exr_rgb(path: Path) -> np.ndarray:
    """Return (H, W, 3) float32 RGB. Mirrors stage_stats.py."""
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


def hue_angle_cam16ucs(rgb: np.ndarray) -> float:
    """Mean hue angle (degrees) of an (H, W, 3) display-linear Rec.2020
    buffer, computed in CAM16-UCS J'a'b' via colour-science. Hue =
    `atan2(b', a')`.
    """
    cs = colour.RGB_COLOURSPACES["ITU-R BT.2020"]
    rgb_clipped = np.clip(rgb.reshape(-1, 3).astype(np.float64), 0.0, None)
    # Same call shape stage_diff.py uses.
    xyz = colour.RGB_to_XYZ(
        rgb_clipped, cs.whitepoint, cs.whitepoint, cs.matrix_RGB_to_XYZ
    )
    jab = colour.XYZ_to_CAM16UCS(xyz)
    a = jab[..., 1]
    b = jab[..., 2]
    h = np.degrees(np.arctan2(b, a))
    # Mean on the unit circle, not the raw angle (avoid wrap noise).
    sin_mean = np.sin(np.radians(h)).mean()
    cos_mean = np.cos(np.radians(h)).mean()
    return float(np.degrees(np.arctan2(sin_mean, cos_mean)))


def hue_angle_oklab(rgb: np.ndarray) -> float:
    """Fallback hue: Oklab a/b angle when CAM16-UCS isn't available.
    Treats the buffer as display-linear Rec.2020 — same input as
    `hue_angle_cam16ucs`. The default stage is `16_agx`, which is
    post-AgX but pre-`rec2020_to_srgb`, so the BT.2020 RGB→XYZ matrix
    is the right one. (If you switch the harness to `--stage 17_srgb_linear`,
    the buffer becomes display-linear sRGB and this matrix is wrong;
    we accept that mismatch for now — the diagnostic is relative drift
    across exposures, not absolute hue.)"""
    # Linear-Rec.2020 → CIE XYZ via colour-science; then Oklab via
    # the standard transform.
    cs = colour.RGB_COLOURSPACES["ITU-R BT.2020"]
    rgb_clipped = np.clip(rgb.reshape(-1, 3).astype(np.float64), 0.0, None)
    xyz = colour.RGB_to_XYZ(
        rgb_clipped, cs.whitepoint, cs.whitepoint, cs.matrix_RGB_to_XYZ
    )
    oklab = colour.XYZ_to_Oklab(xyz)
    a = oklab[..., 1]
    b = oklab[..., 2]
    h = np.degrees(np.arctan2(b, a))
    sin_mean = np.sin(np.radians(h)).mean()
    cos_mean = np.cos(np.radians(h)).mean()
    return float(np.degrees(np.arctan2(sin_mean, cos_mean)))


def angular_spread(angles: list[float]) -> float:
    """Max pairwise angular distance on the circle (degrees). Wraps at
    ±180°."""
    if len(angles) < 2:
        return 0.0
    max_d = 0.0
    for i in range(len(angles)):
        for j in range(i + 1, len(angles)):
            d = abs(angles[i] - angles[j])
            d = min(d, 360.0 - d)
            if d > max_d:
                max_d = d
    return max_d


def parse_subdir_name(name: str) -> tuple[str, float] | None:
    """`r_+1`, `g_-3`, `m_0` → (primary, ev) or None."""
    m = re.match(r"^([rgbcmy])_([+-]?\d+(?:\.\d+)?)$", name)
    if not m:
        return None
    return m.group(1), float(m.group(2))


def main() -> int:
    p = argparse.ArgumentParser(
        description="Hue-stability detector across exposure for saturated primaries.",
    )
    p.add_argument("dump_root", type=Path)
    p.add_argument("--stage", default=DEFAULT_STAGE,
                   help=f"stage to analyse (default: {DEFAULT_STAGE})")
    p.add_argument("--json", type=Path, help="optional path to write JSON")
    args = p.parse_args()

    if not args.dump_root.is_dir():
        print(f"error: {args.dump_root} is not a directory", file=sys.stderr)
        return 2

    if not _COLOUR_AVAILABLE:
        print("error: colour-science is required (pip install colour-science)",
              file=sys.stderr)
        return 2

    use_oklab = False
    try:
        _ = colour.XYZ_to_CAM16UCS
    except AttributeError:
        use_oklab = True
        print("# fallback: oklab (XYZ_to_CAM16UCS unavailable on this colour-science version)")

    # Gather (primary, ev, dir) triples.
    by_primary: dict[str, list[tuple[float, Path]]] = {p: [] for p in PRIMARIES}
    for sub in sorted(args.dump_root.iterdir()):
        if not sub.is_dir():
            continue
        parsed = parse_subdir_name(sub.name)
        if parsed is None:
            continue
        prim, ev = parsed
        if prim in by_primary:
            by_primary[prim].append((ev, sub))

    if all(len(v) == 0 for v in by_primary.values()):
        print(f"error: no recognised primary_EV subdirs under {args.dump_root}",
              file=sys.stderr)
        return 0

    results: dict = {
        "stage": args.stage,
        "metric": "oklab_hue" if use_oklab else "cam16ucs_hue",
        "primaries": {},
    }

    print(f"# Hue stability detector — stage {args.stage}")
    print(f"# Metric: {'Oklab' if use_oklab else 'CAM16-UCS'} hue angle (degrees)")
    print()
    print(f"{'prim':<6} {'EV':>5} {'hue°':>9}")
    print("-" * 26)

    overall_max = 0.0
    for prim in PRIMARIES:
        entries = sorted(by_primary[prim])
        if not entries:
            continue
        angles: list[float] = []
        ev_to_angle: dict[float, float] = {}
        for ev, sub in entries:
            exr = sub / f"{args.stage}.exr"
            if not exr.exists():
                continue
            rgb = load_exr_rgb(exr)
            h = hue_angle_oklab(rgb) if use_oklab else hue_angle_cam16ucs(rgb)
            angles.append(h)
            ev_to_angle[ev] = h
            print(f"{prim:<6} {ev:+5.1f} {h:+9.3f}")
        spread = angular_spread(angles)
        overall_max = max(overall_max, spread)
        results["primaries"][prim] = {
            "ev_to_hue": ev_to_angle,
            "max_drift_deg": spread,
            "n_samples": len(angles),
        }
        print(f"{prim:<6}  drift across exposures: {spread:.3f}°")
        print()

    print(f"# Worst-primary hue drift: {overall_max:.3f}°")
    print("# (Sobotka AgX target < 3°; values above ~5° indicate per-channel hue rotation.)")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(results, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
