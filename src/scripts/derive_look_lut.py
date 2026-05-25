#!/usr/bin/env python3
"""Derive the 3x256 DisplayLookCurve LUT from (Maple-Neutral, ACR) PNG pairs.

Method (matches #371):
  1. For each training fixture, load candidate (Maple Look=Neutral) and
     reference (ACR) sRGB PNGs. Resize candidate to reference dims with
     Lanczos so the per-pixel pairing is in the same domain the harness
     diffs in.
  2. Flatten to per-pixel u8 pairs per channel.
  3. For each channel, per input bin (0..255), compute the median ACR value
     across all training pixels that land in that bin. Require
     `--min-bin-count` (default 500) samples; empty bins are filled by
     linear interpolation from neighbours.
  4. Isotonic-regress (PAVA, monotone non-decreasing) each channel curve.
  5. Emit:
       - `<out_dir>/lut.json`: human-inspectable per-channel arrays + stats
       - `<out_dir>/look_lut.rs.fragment`: ready-to-paste LUT_R/G/B arrays
     formatted to match `view/look_lut.rs`.

Inputs are the harness candidate dir (printed by KEEP_TMP=1 runs) and the
fixture references at `test-fixtures/references/test_NNNN/down/baseline.png`.

Usage:
    derive_look_lut.py --candidates /tmp/maple-calibrate-XXX/candidates \\
                       --references test-fixtures/references \\
                       --out /tmp/look-lut-derive \\
                       [--training 0000,0001,...] \\
                       [--min-bin-count 500]
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

DEFAULT_TRAIN = [
    "0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007",
    "0009", "0011", "0012", "0013", "0014", "0017",
]


def load_pair(cand_path: Path, ref_path: Path) -> tuple[np.ndarray, np.ndarray]:
    cand = Image.open(cand_path).convert("RGB")
    ref = Image.open(ref_path).convert("RGB")
    if cand.size != ref.size:
        cand = cand.resize(ref.size, Image.LANCZOS)
    return (np.asarray(cand, dtype=np.uint8), np.asarray(ref, dtype=np.uint8))


def median_curve(cand: np.ndarray, ref: np.ndarray, min_bin: int) -> np.ndarray:
    """Per input bin (0..255), median ref value over all pixels at that bin.
    Empty / below-min bins are linearly interpolated from filled bins.
    Returns float64 [256] in [0, 255].
    """
    curve = np.full(256, np.nan, dtype=np.float64)
    counts = np.zeros(256, dtype=np.int64)
    # bucket pixels by candidate value, take median of refs
    order = np.argsort(cand, kind="stable")
    sorted_c = cand[order]
    sorted_r = ref[order]
    # find bin boundaries
    boundaries = np.searchsorted(sorted_c, np.arange(257))
    for b in range(256):
        lo, hi = boundaries[b], boundaries[b + 1]
        n = hi - lo
        counts[b] = n
        if n >= min_bin:
            curve[b] = float(np.median(sorted_r[lo:hi]))
    # interpolate any NaN bins from filled neighbours
    filled = ~np.isnan(curve)
    if filled.sum() < 2:
        raise SystemExit(
            f"too few filled bins ({filled.sum()}) — raise sample count or lower --min-bin-count"
        )
    idx = np.arange(256)
    curve_filled = np.interp(idx, idx[filled], curve[filled])
    return curve_filled, counts


def isotonic_pava(y: np.ndarray) -> np.ndarray:
    """Pool-adjacent-violators algorithm: enforce monotone non-decreasing
    output (weighted equally — every input bin counts once).
    """
    n = len(y)
    out = y.astype(np.float64).copy()
    weights = np.ones(n)
    # active blocks
    blocks_val = list(out)
    blocks_w = list(weights)
    blocks_start = list(range(n))
    i = 1
    while i < len(blocks_val):
        if blocks_val[i] < blocks_val[i - 1]:
            # merge
            w0, w1 = blocks_w[i - 1], blocks_w[i]
            blocks_val[i - 1] = (w0 * blocks_val[i - 1] + w1 * blocks_val[i]) / (w0 + w1)
            blocks_w[i - 1] = w0 + w1
            del blocks_val[i]
            del blocks_w[i]
            del blocks_start[i]
            if i > 1:
                i -= 1
        else:
            i += 1
    # expand back into 256-length array
    blocks_start.append(n)
    result = np.empty(n, dtype=np.float64)
    for k in range(len(blocks_val)):
        result[blocks_start[k]:blocks_start[k + 1]] = blocks_val[k]
    return result


def quantize_u8(curve: np.ndarray) -> np.ndarray:
    return np.clip(np.round(curve), 0, 255).astype(np.uint8)


def emit_rust_array(name: str, arr: np.ndarray) -> str:
    # Match the existing look_lut.rs formatting: 16 entries per row, each
    # padded to width 4 (matches "  7," and "250,").
    lines = [f"pub(super) const {name}: [u8; 256] = ["]
    for row in range(16):
        chunk = arr[row * 16:(row + 1) * 16]
        rendered = ", ".join(f"{v:>3}" for v in chunk.tolist())
        lines.append(f"    {rendered},")
    lines.append("];")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True, type=Path)
    ap.add_argument("--references", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--training", default=",".join(DEFAULT_TRAIN))
    ap.add_argument("--min-bin-count", type=int, default=500)
    args = ap.parse_args()

    train = args.training.split(",")
    args.out.mkdir(parents=True, exist_ok=True)

    # Accumulate per-channel pixels across all fixtures.
    # Each fixture is ~10-12M pixels; 14 fixtures ~ 150M = 450M bytes/channel.
    # Manageable for u8.
    per_channel_cand = [[] for _ in range(3)]
    per_channel_ref = [[] for _ in range(3)]
    n_per_fixture = {}

    for stem in train:
        cand_path = args.candidates / f"test_{stem}_baseline.png"
        ref_path = args.references / f"test_{stem}" / "down" / "baseline.png"
        if not cand_path.exists():
            print(f"  SKIP test_{stem}: no candidate at {cand_path}", file=sys.stderr)
            continue
        if not ref_path.exists():
            print(f"  SKIP test_{stem}: no reference at {ref_path}", file=sys.stderr)
            continue
        cand, ref = load_pair(cand_path, ref_path)
        h, w, _ = cand.shape
        n_per_fixture[stem] = h * w
        print(f"  test_{stem}: {h}x{w} = {h*w:,} pixels", file=sys.stderr)
        for c in range(3):
            per_channel_cand[c].append(cand[..., c].ravel())
            per_channel_ref[c].append(ref[..., c].ravel())

    if not n_per_fixture:
        raise SystemExit("no training fixtures collected")

    # Per-channel: concatenate, compute curve, isotonic, quantize.
    luts = {}
    counts = {}
    raw_medians = {}
    for ch_i, ch_name in enumerate("RGB"):
        cand_all = np.concatenate(per_channel_cand[ch_i])
        ref_all = np.concatenate(per_channel_ref[ch_i])
        print(f"  {ch_name}: {cand_all.size:,} pixel pairs", file=sys.stderr)
        curve_med, ct = median_curve(cand_all, ref_all, args.min_bin_count)
        raw_medians[ch_name] = curve_med.tolist()
        counts[ch_name] = ct.tolist()
        curve_iso = isotonic_pava(curve_med)
        luts[ch_name] = quantize_u8(curve_iso).tolist()

    out_json = {
        "training_fixtures": train,
        "n_per_fixture": n_per_fixture,
        "min_bin_count": args.min_bin_count,
        "method": "median per input bin, linear interp empty bins, isotonic PAVA, quantize u8",
        "raw_medians": raw_medians,
        "bin_counts": counts,
        "lut": luts,
    }
    (args.out / "lut.json").write_text(json.dumps(out_json, indent=2))
    print(f"  wrote {args.out / 'lut.json'}", file=sys.stderr)

    # Emit Rust fragment.
    frag_lines = []
    for ch, name in zip("RGB", ("LUT_R", "LUT_G", "LUT_B")):
        frag_lines.append(emit_rust_array(name, np.array(luts[ch], dtype=np.uint8)))
        frag_lines.append("")
    (args.out / "look_lut.rs.fragment").write_text("\n".join(frag_lines))
    print(f"  wrote {args.out / 'look_lut.rs.fragment'}", file=sys.stderr)

    # Print sanity preview to stdout.
    for ch in "RGB":
        arr = luts[ch]
        print(f"{ch}: lut[0]={arr[0]} lut[64]={arr[64]} lut[128]={arr[128]} lut[192]={arr[192]} lut[255]={arr[255]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
