#!/usr/bin/env python3
"""
derive_look_lut.py — refit the empirical Maple Look LUT from (neutral, ACR) pairs.

Methodology (ticket #522 / epic #505):

The Look LUT is a per-channel `u8 -> u8` 1D LUT applied after AgX + sRGB
encode + quantize. Its job is to close the systematic bias gap between
Maple's scene-referred AgX output and Adobe Camera Raw's rendered targets.

Pipeline (mirrors `fit_curves.py`, aggregated across the fixture set):

  1. Load all (look_neutral JPEG, ACR PNG) pairs as float [0, 1] in RGB.
  2. Match geometry per fixture (downscale neutral to ACR resolution).
  3. Mask high-frequency regions when resampled (Sobel grad) — resize
     smears color at edges, sampling there poisons the per-channel fit.
  4. Per fixture, per channel: binned-median curve at 64 bins
     (`fit_transfer_curve` in `fit_curves.py`). Output is sparse — bins
     with < min_count samples are dropped.
  5. Sample each fixture's piecewise-linear curve at 256 fixed query
     positions `k/255` for `k in 0..256`. Clamp ends with `apply_curve`'s
     left/right semantics. This makes every fixture vote at every output
     index even where its bin coverage was sparse.
  6. Per output index: take the MEDIAN across fixtures (outlier-robust —
     handles compromised fixtures like test_0000).
  7. Enforce monotone non-decreasing via running-max — required by
     `lut_arrays_are_monotone_nondecreasing` in `view::look::tests`.
  8. Multiply by 255, round, clip to u8.
  9. Sanity-assert endpoints (< 50 at index 0, > 200 at index 255).
 10. Emit a new `look_lut.rs` with the three `[u8; 256]` arrays.

Source data:

  ~/Desktop/maple-color-tests/post-L2-look-applied-20260526-170349/
    look_neutral/test_NNNN.jpg     — Maple post-AgX-neutral (LUT input)
    acr_reference/test_NNNN_acr.png — ACR-rendered target

Fixture list: 17 fixtures (test_0000..test_0015, test_0017). test_0016 is
X-Trans Foveon and unsupported by the pipeline.

Determinism: median + linear interp + running max + np.round; given the
same source renders this script produces the same bytes every time.

Output:

  src/raw-pipeline/raw-core/src/view/look_lut.rs   — new LUT bytes
  Stdout: per-fixture before/after RMSE comparison table.

Usage:

  python3 src/scripts/derive_look_lut.py \\
      --neutral-dir ~/Desktop/maple-color-tests/post-L2-look-applied-20260526-170349/look_neutral \\
      --acr-dir     ~/Desktop/maple-color-tests/post-L2-look-applied-20260526-170349/acr_reference \\
      --out         src/raw-pipeline/raw-core/src/view/look_lut.rs
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import cv2


FIXTURES = [
    "test_0000", "test_0001", "test_0002", "test_0003", "test_0004",
    "test_0005", "test_0006", "test_0007", "test_0008", "test_0009",
    "test_0010", "test_0011", "test_0012", "test_0013", "test_0014",
    "test_0015", "test_0017",
]


# ----------------------------------------------------------------------
# IO — mirrors fit_curves.py
# ----------------------------------------------------------------------
def load_float(path: str) -> np.ndarray:
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED | cv2.IMREAD_ANYDEPTH)
    if img is None:
        raise SystemExit(f"could not read {path}")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        img = img[..., :3]
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    maxval = np.iinfo(img.dtype).max if np.issubdtype(img.dtype, np.integer) else 1.0
    return img.astype(np.float64) / maxval


def match_geometry(src: np.ndarray, tgt: np.ndarray) -> tuple[np.ndarray, bool]:
    if src.shape[:2] == tgt.shape[:2]:
        return src, False
    h, w = tgt.shape[:2]
    return cv2.resize(src, (w, h), interpolation=cv2.INTER_AREA), True


def low_freq_mask(img: np.ndarray, thresh: float = 0.04) -> np.ndarray:
    gray = img.mean(axis=2).astype(np.float32)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.sqrt(gx * gx + gy * gy)
    return grad < thresh


# ----------------------------------------------------------------------
# Per-fixture per-channel curve fit (mirrors fit_curves.fit_transfer_curve)
# ----------------------------------------------------------------------
def fit_transfer_curve(s: np.ndarray, t: np.ndarray,
                       n_bins: int = 64, min_count: int = 25
                       ) -> tuple[np.ndarray, np.ndarray]:
    bins = np.linspace(0.0, 1.0, n_bins + 1)
    idx = np.clip(np.digitize(s, bins) - 1, 0, n_bins - 1)
    xs, ys = [], []
    for b in range(n_bins):
        m = idx == b
        if m.sum() < min_count:
            continue
        xs.append(0.5 * (bins[b] + bins[b + 1]))
        ys.append(np.median(t[m]))
    if len(xs) < 2:
        raise RuntimeError("too few populated bins")
    return np.asarray(xs), np.asarray(ys)


def apply_curve(channel: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    return np.interp(channel, xs, ys, left=ys[0], right=ys[-1])


# ----------------------------------------------------------------------
# Old-LUT-from-source: parse the current look_lut.rs into 3 arrays so we
# can report (old vs new) per-fixture RMSE without rebuilding the crate.
# ----------------------------------------------------------------------
def parse_existing_lut(path: Path) -> dict[str, np.ndarray] | None:
    if not path.exists():
        return None
    text = path.read_text()
    luts: dict[str, np.ndarray] = {}
    for name in ("LUT_R", "LUT_G", "LUT_B"):
        # Match `pub(super) const NAME: [u8; 256] = [ ... ];`
        head = f"const {name}: [u8; 256] = ["
        i = text.find(head)
        if i < 0:
            return None
        j = text.find("];", i)
        if j < 0:
            return None
        body = text[i + len(head):j]
        nums = [int(tok) for tok in body.replace(",", " ").split() if tok.strip().isdigit()]
        if len(nums) != 256:
            return None
        luts[name[-1]] = np.asarray(nums, dtype=np.uint8)
    return luts


# ----------------------------------------------------------------------
# Aggregate fit
# ----------------------------------------------------------------------
def per_fixture_curves(neutral_dir: Path, acr_dir: Path
                       ) -> list[tuple[str, dict[str, tuple[np.ndarray, np.ndarray]], np.ndarray, np.ndarray, np.ndarray]]:
    """Returns per fixture: (name, {ch: (xs, ys)}, src_arr, tgt_arr, mask)."""
    out = []
    for fx in FIXTURES:
        neutral = neutral_dir / f"{fx}.jpg"
        acr = acr_dir / f"{fx}_acr.png"
        if not neutral.exists() or not acr.exists():
            print(f"[skip] {fx}: missing files", file=sys.stderr)
            continue
        src = load_float(str(neutral))
        tgt = load_float(str(acr))
        src, resampled = match_geometry(src, tgt)
        mask = low_freq_mask(src) if resampled else np.ones(src.shape[:2], bool)
        per_ch: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        for c, name in enumerate("RGB"):
            xs, ys = fit_transfer_curve(src[..., c][mask], tgt[..., c][mask])
            per_ch[name] = (xs, ys)
        out.append((fx, per_ch, src, tgt, mask))
        print(f"[fit] {fx}: {mask.sum():,}/{mask.size:,} px sampled", file=sys.stderr)
    return out


def aggregate_lut(curves: list[tuple[str, dict[str, tuple[np.ndarray, np.ndarray]], np.ndarray, np.ndarray, np.ndarray]]
                  ) -> dict[str, np.ndarray]:
    """Sample each fixture's curve at 256 query positions, then median across
    fixtures, then enforce monotonicity, then quantize to u8."""
    queries = np.linspace(0.0, 1.0, 256)
    out: dict[str, np.ndarray] = {}
    for c_name in "RGB":
        # (n_fixtures, 256) — each row is one fixture's curve sampled at queries
        rows = []
        for _fx, per_ch, *_ in curves:
            xs, ys = per_ch[c_name]
            rows.append(np.interp(queries, xs, ys, left=ys[0], right=ys[-1]))
        stack = np.vstack(rows)
        median = np.median(stack, axis=0)
        # Enforce monotone non-decreasing (required by Rust tests).
        median = np.maximum.accumulate(median)
        # Quantize.
        u8 = np.clip(np.round(median * 255.0), 0, 255).astype(np.uint8)
        # Enforce monotonicity AGAIN post-quantize (rounding can produce
        # micro-dips between adjacent equal-float values).
        u8 = np.maximum.accumulate(u8)
        out[c_name] = u8
    # Endpoint sanity — these must pass the lut_endpoints_are_plausible test.
    for c_name in "RGB":
        u8 = out[c_name]
        assert u8[0] < 50, f"LUT_{c_name}[0] = {u8[0]} (test requires < 50)"
        assert u8[255] > 200, f"LUT_{c_name}[255] = {u8[255]} (test requires > 200)"
    # Per-channel independence sanity at index 128.
    r, g, b = out["R"][128], out["G"][128], out["B"][128]
    assert not (r == g == b), f"channels collapsed at idx 128: ({r}, {g}, {b})"
    return out


# ----------------------------------------------------------------------
# Apply a u8 LUT to a float[0,1] image. Replicates the Rust apply().
# ----------------------------------------------------------------------
def apply_u8_lut(img_float: np.ndarray, lut_r: np.ndarray, lut_g: np.ndarray,
                 lut_b: np.ndarray) -> np.ndarray:
    """Mirrors raw-core view::look::apply on a float image: round to u8,
    look up per channel, return as float[0,1]."""
    u8 = np.clip(np.round(img_float * 255.0), 0, 255).astype(np.uint8)
    out = np.empty_like(u8)
    out[..., 0] = lut_r[u8[..., 0]]
    out[..., 1] = lut_g[u8[..., 1]]
    out[..., 2] = lut_b[u8[..., 2]]
    return out.astype(np.float64) / 255.0


def rmse(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.sqrt(np.mean((a - b) ** 2)))


# ----------------------------------------------------------------------
# Emit the Rust source.
# ----------------------------------------------------------------------
def format_row(values: list[int]) -> str:
    return ", ".join(f"{v:3d}" for v in values)


def emit_rust(luts: dict[str, np.ndarray], path: Path) -> None:
    lines = [
        "//! Empirical DisplayLookCurve LUT data — 3 channels x 256 entries each.",
        "//!",
        "//! Refit 2026-05-26 via `src/scripts/derive_look_lut.py` (ticket #522,",
        "//! epic #505). Methodology: per-fixture binned-median curve at 64 bins,",
        "//! resample to 256 query positions, median across 17 fixtures, enforce",
        "//! monotonicity via running-max, quantize to u8.",
        "//!",
        "//! Training fixtures: test_0000..test_0015 + test_0017 (test_0016 is",
        "//! X-Trans Foveon, unsupported). Source renders captured 2026-05-26:",
        "//!   ~/Desktop/maple-color-tests/post-L2-look-applied-20260526-170349/",
        "//!     look_neutral/  (Maple Look=Neutral output, the LUT input)",
        "//!     acr_reference/ (Adobe Camera Raw target)",
        "//!",
        "//! The shape — strong shadow lift, mid-tone preserved, gentle highlight",
        "//! shoulder, slight blue boost — comes from the ACR data; we just",
        "//! recover it robustly. To re-derive, re-render the neutrals and run",
        "//! `python3 src/scripts/derive_look_lut.py`. The Rust API",
        "//! (`Look` enum, `apply` fn) is unchanged.",
        "//!",
        "//! Split out from `look.rs` so the function-level logic stays under the",
        "//! file-budget soft limit even with the full 768-byte payload inline.",
        "",
    ]
    for ch in "RGB":
        arr = luts[ch].tolist()
        lines.append(f"pub(super) const LUT_{ch}: [u8; 256] = [")
        for row in range(16):
            chunk = arr[row * 16:(row + 1) * 16]
            lines.append(f"    {format_row(chunk)},")
        lines.append("];")
        lines.append("")
    path.write_text("\n".join(lines))


# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    default_root = Path.home() / "Desktop" / "maple-color-tests" / "post-L2-look-applied-20260526-170349"
    ap.add_argument("--neutral-dir", default=str(default_root / "look_neutral"))
    ap.add_argument("--acr-dir", default=str(default_root / "acr_reference"))
    ap.add_argument("--out", default="src/raw-pipeline/raw-core/src/view/look_lut.rs",
                    help="path to write the new look_lut.rs")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the LUT but don't write the Rust file")
    args = ap.parse_args()

    neutral_dir = Path(args.neutral_dir).expanduser()
    acr_dir = Path(args.acr_dir).expanduser()
    out_path = Path(args.out)

    print(f"neutral dir: {neutral_dir}", file=sys.stderr)
    print(f"acr dir:     {acr_dir}", file=sys.stderr)
    print(f"out:         {out_path}", file=sys.stderr)

    old_luts = parse_existing_lut(out_path)
    if old_luts is None:
        print("[warn] could not parse existing look_lut.rs — old/new RMSE table",
              "will compare against 'no LUT' only.", file=sys.stderr)

    curves = per_fixture_curves(neutral_dir, acr_dir)
    if not curves:
        raise SystemExit("no fixtures fit")
    new_luts = aggregate_lut(curves)

    # ------------------------------------------------------------------
    # Per-fixture RMSE: (1) no-LUT vs ACR, (2) old-LUT vs ACR, (3) new-LUT vs ACR.
    # ------------------------------------------------------------------
    print()
    print(f"{'fixture':<12}  {'no-LUT':>8}  {'old-LUT':>8}  {'new-LUT':>8}  "
          f"{'Δ(new vs old)':>16}  verdict")
    print("-" * 80)
    rows = []
    any_regress = False
    for fx, _per_ch, src, tgt, _mask in curves:
        baseline = rmse(src, tgt)
        old_applied = None
        if old_luts is not None:
            old_img = apply_u8_lut(src, old_luts["R"], old_luts["G"], old_luts["B"])
            old_applied = rmse(old_img, tgt)
        new_img = apply_u8_lut(src, new_luts["R"], new_luts["G"], new_luts["B"])
        new_applied = rmse(new_img, tgt)

        old_str = f"{old_applied:.4f}" if old_applied is not None else "    n/a"
        if old_applied is None:
            delta_pct = (baseline - new_applied) / baseline * 100.0
            delta_str = f"{delta_pct:+.1f}% vs base"
            verdict = "n/a (no old LUT)"
        else:
            delta_pct = (old_applied - new_applied) / old_applied * 100.0
            delta_str = f"{delta_pct:+.1f}%"
            if new_applied > old_applied * 1.05:
                verdict = "REGRESSION (>5%)"
                any_regress = True
            elif new_applied > old_applied:
                verdict = "slight regress"
            elif new_applied < old_applied * 0.95:
                verdict = "improved"
            else:
                verdict = "neutral"
        print(f"{fx:<12}  {baseline:>8.4f}  {old_str:>8}  {new_applied:>8.4f}  "
              f"{delta_str:>16}  {verdict}")
        rows.append((fx, baseline, old_applied, new_applied))

    print()
    if any_regress:
        print("[warn] one or more fixtures regress > 5% RMSE vs the old LUT.",
              "Investigate before committing.", file=sys.stderr)

    # ------------------------------------------------------------------
    # Emit.
    # ------------------------------------------------------------------
    if args.dry_run:
        print("[dry-run] not writing", file=sys.stderr)
    else:
        emit_rust(new_luts, out_path)
        print(f"\nwrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
