#!/usr/bin/env python3
"""Per-stage statistics for a MAPLE_STAGE_DUMP trace directory.

Usage:
    stage_stats.py <dump_dir> [--json <out.json>]

For each EXR in <dump_dir>:
  1. Load f32 RGB.
  2. Per-channel min / max / mean / p1 / p50 / p99.
  3. Out-of-gamut counts (negative or >1 channels — signals where the
     pipeline assumed in-gamut values it doesn't have).
  4. Achromatic drift: mean |R-G|, |R-B|, |G-B| (signals per-channel
     asymmetry — the magenta-shadow / highlight-hue-rotation pattern).
  5. Per-region buckets — same drift metrics restricted to shadow
     (luma < 0.05) and highlight (luma > 0.7) pixels.

Output: column-aligned table sorted by filename (which sorts in pipeline
order due to the NN_ prefix). Optional --json for machine consumption.

Exit code 0 always — this is a diagnostic, not a gate. Gates live in the
existing color-parity harness (test_color_pipeline.sh).
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
SHADOW_LUMA = 0.05
HIGHLIGHT_LUMA = 0.7


def load_exr_rgb(path: Path) -> np.ndarray:
    """Return (H, W, 3) float32 RGB. Mirrors src/scripts/stage_diff.py."""
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


def stage_metrics(rgb: np.ndarray) -> dict:
    """Compute the metrics this tool emits for a single EXR buffer."""
    h, w, _ = rgb.shape
    n = h * w

    luma = (rgb * REC2020_LUM).sum(axis=-1)
    shadow_mask = luma < SHADOW_LUMA
    highlight_mask = luma > HIGHLIGHT_LUMA

    def channel_stats(arr: np.ndarray) -> dict:
        return {
            "min":  float(arr.min()),
            "max":  float(arr.max()),
            "mean": float(arr.mean()),
            "p1":   float(np.percentile(arr, 1)),
            "p50":  float(np.percentile(arr, 50)),
            "p99":  float(np.percentile(arr, 99)),
        }

    # Per-channel summary.
    channels = {c: channel_stats(rgb[:, :, i]) for i, c in enumerate("rgb")}

    # Out-of-gamut: any channel < 0 or > 1.
    neg_count = int((rgb < 0.0).any(axis=-1).sum())
    sup_count = int((rgb > 1.0).any(axis=-1).sum())

    # Achromatic drift across the whole image.
    def drift(mask: np.ndarray | None) -> dict:
        if mask is not None:
            if mask.sum() == 0:
                return {"n": 0, "rg": None, "rb": None, "gb": None}
            r = rgb[..., 0][mask]
            g = rgb[..., 1][mask]
            b = rgb[..., 2][mask]
            count = int(mask.sum())
        else:
            r = rgb[..., 0]
            g = rgb[..., 1]
            b = rgb[..., 2]
            count = n
        return {
            "n":  count,
            "rg": float(np.abs(r - g).mean()),
            "rb": float(np.abs(r - b).mean()),
            "gb": float(np.abs(g - b).mean()),
        }

    return {
        "shape": [h, w],
        "n_pixels": n,
        "channels": channels,
        "out_of_gamut": {
            "neg_pixels":     neg_count,
            "neg_pct":        100.0 * neg_count / n,
            "supra_pixels":   sup_count,
            "supra_pct":      100.0 * sup_count / n,
        },
        "drift_all":       drift(None),
        "drift_shadows":   drift(shadow_mask),
        "drift_highlights":drift(highlight_mask),
    }


def format_row(stage: str, m: dict) -> str:
    rs = m["channels"]["r"]
    gs = m["channels"]["g"]
    bs = m["channels"]["b"]
    da = m["drift_all"]
    ds = m["drift_shadows"]
    dh = m["drift_highlights"]
    return (
        f"{stage:<28} "
        f"R[{rs['min']:+7.3f},{rs['max']:+7.3f},{rs['mean']:+7.3f}] "
        f"G[{gs['min']:+7.3f},{gs['max']:+7.3f},{gs['mean']:+7.3f}] "
        f"B[{bs['min']:+7.3f},{bs['max']:+7.3f},{bs['mean']:+7.3f}] "
        f"OOG[-{m['out_of_gamut']['neg_pct']:5.2f}%/+{m['out_of_gamut']['supra_pct']:5.2f}%] "
        f"drift[all={da['rg']:.4f},sh={'-' if ds['rg'] is None else f'{ds['rg']:.4f}'},"
        f"hi={'-' if dh['rg'] is None else f'{dh['rg']:.4f}'}]"
    )


def main() -> int:
    p = argparse.ArgumentParser(
        description="Per-stage per-channel statistics for a MAPLE_STAGE_DUMP trace.",
    )
    p.add_argument("dump_dir", type=Path, help="directory of NN_stage.exr files")
    p.add_argument("--json", type=Path, help="optional path to write JSON metrics")
    args = p.parse_args()

    if not args.dump_dir.is_dir():
        print(f"error: {args.dump_dir} is not a directory", file=sys.stderr)
        return 2

    files = sorted(args.dump_dir.glob("*.exr"))
    if not files:
        print(f"# no EXR files in {args.dump_dir}; nothing to do")
        return 0

    print("# Per-stage statistics — channel [min, max, mean]; out-of-gamut %; mean |R-G| drift")
    print("# Columns: stage / R range / G range / B range / OOG / drift(all, shadows, highlights)")
    print()

    all_metrics: dict[str, dict] = {}
    for f in files:
        stage = f.stem
        try:
            rgb = load_exr_rgb(f)
            m = stage_metrics(rgb)
        except Exception as e:
            print(f"{stage:<28} ERROR {e}", file=sys.stderr)
            continue
        all_metrics[stage] = m
        print(format_row(stage, m))

    # Flag interesting stages (heuristics, not gates).
    interesting: list[str] = []
    for stage, m in all_metrics.items():
        # Per-channel mean drift > 0.005 in shadows = candidate for the
        # "magenta in deep shadow" symptom.
        ds = m["drift_shadows"]
        if ds["rg"] is not None and (ds["rg"] > 0.005 or ds["rb"] > 0.005 or ds["gb"] > 0.005):
            interesting.append(f"  {stage}: shadow drift R-G={ds['rg']:.4f} R-B={ds['rb']:.4f} G-B={ds['gb']:.4f}")
        # Per-channel mean drift > 0.01 in highlights = candidate for
        # the "highlight hue shift" symptom (saturated colours rotating
        # at the per-channel sigmoid shoulder).
        dh = m["drift_highlights"]
        if dh["rg"] is not None and (dh["rg"] > 0.05 or dh["rb"] > 0.05 or dh["gb"] > 0.05):
            interesting.append(f"  {stage}: highlight drift R-G={dh['rg']:.4f} R-B={dh['rb']:.4f} G-B={dh['gb']:.4f}")

    if interesting:
        print()
        print("# Flagged stages (heuristic, not a gate):")
        for line in interesting:
            print(line)

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(all_metrics, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
