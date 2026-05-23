#!/usr/bin/env python3
"""apple_render_diff.py — measure Apple-rendered candidates against reference
renders, report per-region metrics, and DERIVE a least-squares 3x3 affine
correction matrix from the data.

Sibling to compare_images.py and calibrate_color_pipeline.sh — different
scope. Where the calibration script measures the Rust path
(`maple-cli` PNG vs reference render), this one measures the Apple path
(diagnostics/apple_path/<stem>_baseline.png vs reference render) — i.e. what the
real Metal kernel chain produces, after the Apple-side test harness
(`AppleRenderHarnessTests.testAppleRenderHarness_baselineSweep`) has
written its candidates.

Usage:

    src/apple/Packages/MapleCore && \\
        MAPLE_REFERENCES_ROOT=$PWD/../../../../test-fixtures/references \\
        MAPLE_VISUAL_FIXTURE_ROOT=$PWD/../../../../test-fixtures/raws \\
        MAPLE_APPLE_DIAG_ROOT=$PWD/../../../../test-fixtures/diagnostics/apple_path \\
        MAPLE_APPLE_RENDER_BUDGET=999 swift test --filter AppleRenderHarnessTests

    python3 src/scripts/apple_render_diff.py
    python3 src/scripts/apple_render_diff.py --solve-matrix
    python3 src/scripts/apple_render_diff.py --filter test_0002 --regions

What this prints:

  1. Per-fixture global ΔE row (mirrors calibrate_color_pipeline.sh
     formatting so reviewers can side-by-side the two paths).
  2. Per-region metrics — when `--regions` is set, each fixture is
     additionally split into N=4 luminance bins (shadows / midtone /
     highlight / saturated) and per-bin mean ΔE + per-channel bias is
     reported. The worst region per fixture is annotated with `<<`.
     Lets us see "skin tones look pink at midtone but the global mean
     says fine."
  3. Solved 3x3 affine matrix M — when `--solve-matrix` is set,
     least-squares fits `M @ apple ≈ acr` over the sampled pixel set,
     prints M with 6-decimal precision, and reports the grand-mean ΔE
     residual before and after applying M to every candidate. If the
     improvement is meaningful (e.g. > 2 ΔE points), wire M as a
     final scene-linear stage in ImageEditPipeline before AgX.
  4. Optional `--per-fixture-matrix` — also solves a separate M per
     fixture so the variation can guide whether a single global M is
     enough, or per-camera keying is needed.

Inputs (defaults map to <repoRoot>/test-fixtures/...):

  --apple-dir   diagnostics/apple_path/   (PNG candidates from the harness)
  --refs-dir    references/test_*/down/   (reference-rendered baseline.png refs)
  --filter      substring filter on stem (e.g. test_0002)
  --regions     compute and print per-region metrics
  --solve-matrix
                fit & report a single global 3x3 affine M
  --per-fixture-matrix
                also fit a separate M per fixture
  --sample      pixels per fixture used for the matrix solve
                (defaults to 200_000; full-image solve is unnecessary
                — the affine fit is rank-3, so 200k uniform samples
                across 16 fixtures gives a rock-solid 3.2M-row system).
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image
import colour

# 4000x2667 reference renders trip Pillow's decompression-bomb heuristic. They're
# the ground truth.
Image.MAX_IMAGE_PIXELS = None


def repo_root() -> Path:
    """Walk from this file up to the repo root."""
    return Path(__file__).resolve().parent.parent.parent


def diff_inline(cand_arr: np.ndarray, ref_arr: np.ndarray) -> dict:
    """Same maths as compare_images.py; takes pre-loaded sRGB float arrays
    in [0,1] (gamma-encoded). Returns CIEDE2000 + per-channel bias."""
    if cand_arr.shape != ref_arr.shape:
        return {"error": f"shape mismatch: {cand_arr.shape} vs {ref_arr.shape}"}
    cand_xyz = colour.sRGB_to_XYZ(cand_arr)
    ref_xyz = colour.sRGB_to_XYZ(ref_arr)
    cand_lab = colour.XYZ_to_Lab(cand_xyz)
    ref_lab = colour.XYZ_to_Lab(ref_xyz)
    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")
    bias = (cand_arr - ref_arr).mean(axis=tuple(range(cand_arr.ndim - 1)))
    return {
        "mean_deltaE": float(np.mean(dE)),
        "p95_deltaE": float(np.percentile(dE, 95)),
        "max_deltaE": float(np.max(dE)),
        "bias_r": float(bias[0]),
        "bias_g": float(bias[1]),
        "bias_b": float(bias[2]),
        "n_pixels": int(cand_arr.size // cand_arr.shape[-1]),
    }


def load_srgb(path: Path) -> np.ndarray:
    """PNG → numpy float32 in [0,1] (gamma-encoded sRGB)."""
    im = Image.open(path).convert("RGB")
    return np.asarray(im, dtype=np.float32) / 255.0


def resize_to(arr: np.ndarray, target_h: int, target_w: int) -> np.ndarray:
    """Lanczos resize via Pillow. Used when a candidate drifts ±1 px from
    the ref grid due to the Lanczos prescale's `floor()` clamp."""
    h, w = arr.shape[:2]
    if h == target_h and w == target_w:
        return arr
    pil = Image.fromarray((arr * 255.0).clip(0, 255).astype(np.uint8))
    pil = pil.resize((target_w, target_h), Image.LANCZOS)
    return np.asarray(pil, dtype=np.float32) / 255.0


# Shared luminance bins. Per-pixel Y = 0.2126 R + 0.7152 G + 0.0722 B
# (Rec.709 luma — same coefficients colour-science uses). The bin
# boundaries divide [0,1] into four regions of equal *luminance bandwidth*,
# which is closer to perceptually-uniform than equal pixel-count quartiles
# for typical photographic content. Fine-tune later if the boundaries
# cluster too many pixels in one bin for some fixtures.
LUMA_BINS = [
    ("shadows",   0.00, 0.20),
    ("midtone",   0.20, 0.55),
    ("highlight", 0.55, 0.85),
    ("saturated", 0.85, 1.00),
]


def per_region_metrics(cand_arr: np.ndarray, ref_arr: np.ndarray) -> list[dict]:
    """Split (cand, ref) by REFERENCE luminance into N bins; compute global-
    style metrics on each. Splitting on the reference's luma (not the
    candidate's) keeps the bins stable across runs of the harness — the
    reference doesn't change between calibration cycles. Returns a list
    of dicts (one per bin) in LUMA_BINS order; bins with < 1024 px are
    skipped (annotated as `n_pixels=0`)."""
    luma = (0.2126 * ref_arr[..., 0] +
            0.7152 * ref_arr[..., 1] +
            0.0722 * ref_arr[..., 2])
    rows: list[dict] = []
    for name, lo, hi in LUMA_BINS:
        mask = (luma >= lo) & (luma < hi) if hi < 1.0 \
            else (luma >= lo) & (luma <= hi)
        n = int(mask.sum())
        if n < 1024:
            rows.append({"region": name, "n_pixels": n})
            continue
        cand_bin = cand_arr[mask]                 # (n, 3) gamma-encoded sRGB
        ref_bin = ref_arr[mask]
        cand_xyz = colour.sRGB_to_XYZ(cand_bin)
        ref_xyz = colour.sRGB_to_XYZ(ref_bin)
        cand_lab = colour.XYZ_to_Lab(cand_xyz)
        ref_lab = colour.XYZ_to_Lab(ref_xyz)
        dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")
        bias = (cand_bin - ref_bin).mean(axis=0)
        rows.append({
            "region": name,
            "mean_deltaE": float(np.mean(dE)),
            "p95_deltaE": float(np.percentile(dE, 95)),
            "max_deltaE": float(np.max(dE)),
            "bias_r": float(bias[0]),
            "bias_g": float(bias[1]),
            "bias_b": float(bias[2]),
            "n_pixels": n,
        })
    return rows


def discover_pairs(apple_dir: Path, refs_dir: Path,
                   stem_filter: Optional[str]) -> list[tuple[str, Path, Path]]:
    """Return [(stem, apple_png, ref_png), ...] for every candidate PNG
    that has a matching reference baseline."""
    out: list[tuple[str, Path, Path]] = []
    if not apple_dir.exists():
        return out
    for apple_png in sorted(apple_dir.glob("*_baseline.png")):
        stem = apple_png.stem.removesuffix("_baseline")
        if stem_filter and stem_filter not in stem:
            continue
        ref_png = refs_dir / stem / "down" / "baseline.png"
        if not ref_png.exists():
            continue
        out.append((stem, apple_png, ref_png))
    return out


def sample_pixels(cand_arr: np.ndarray, ref_arr: np.ndarray,
                  n: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Uniform-random sample of pixel pairs. Returned shapes are (n, 3)
    each. We sample the reference grid (cand resized to match), then take
    n random rows. Solving for M in matrix form: A · M.T ≈ B,
    where rows of A are apple pixels, rows of B are acr pixels."""
    h, w = ref_arr.shape[:2]
    flat_cand = cand_arr.reshape(-1, 3)
    flat_ref = ref_arr.reshape(-1, 3)
    total = flat_cand.shape[0]
    n = min(n, total)
    idx = rng.choice(total, size=n, replace=False)
    return flat_cand[idx], flat_ref[idx]


def solve_affine(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """Least-squares solve `A @ M.T ≈ B` ⇔ `M.T = (A^T A)^{-1} A^T B`.
    Returned M is shape (3, 3) so that `apple_after = (M @ apple_pix)`
    for column-vector pixel notation. Uses np.linalg.lstsq for a
    numerically stable pseudoinverse path; conditioning is fine for any
    reasonable photographic input."""
    M_T, residuals, rank, _ = np.linalg.lstsq(A, B, rcond=None)
    return M_T.T  # M maps apple → acr in column-vector form


def apply_affine(arr: np.ndarray, M: np.ndarray) -> np.ndarray:
    """Apply M to every pixel of arr (shape (..., 3)). Result is
    clipped to [0,1] — the matrix is fit on values that already live
    in that range, but any tiny extrapolation is clamped to keep the
    diff numerics consistent with the existing PNG path."""
    flat = arr.reshape(-1, 3)
    out = (M @ flat.T).T
    return np.clip(out, 0.0, 1.0).reshape(arr.shape)


def fmt_row_global(stem: str, m: dict) -> str:
    """One-line `compare_images.py`-shaped row."""
    n = m["n_pixels"]
    nM = n / 1e6
    return (f"{stem:<12} {nM:5.2f}M  "
            f"{m['mean_deltaE']:6.2f} {m['p95_deltaE']:6.2f} {m['max_deltaE']:6.2f}  "
            f"{m['bias_r']:+8.4f} {m['bias_g']:+8.4f} {m['bias_b']:+8.4f}")


def fmt_row_region(rows: list[dict]) -> list[str]:
    """One indented line per region. Worst-mean-ΔE row is flagged with `<<`."""
    valid = [r for r in rows if "mean_deltaE" in r]
    if not valid:
        return ["    (no region had >= 1024 pixels)"]
    worst_mean = max(r["mean_deltaE"] for r in valid)
    out = []
    for r in rows:
        if "mean_deltaE" not in r:
            out.append(f"    {r['region']:<10}  (n_pixels={r['n_pixels']})")
            continue
        flag = "  <<" if r["mean_deltaE"] >= worst_mean - 1e-6 else ""
        out.append(f"    {r['region']:<10}  ΔE {r['mean_deltaE']:6.2f}  "
                   f"bR {r['bias_r']:+7.4f} bG {r['bias_g']:+7.4f} "
                   f"bB {r['bias_b']:+7.4f}  (n={r['n_pixels']:>9}){flag}")
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    repo = repo_root()
    p.add_argument("--apple-dir", type=Path,
                   default=repo / "test-fixtures/diagnostics/apple_path",
                   help="Directory of <stem>_baseline.png candidates from "
                        "AppleRenderHarnessTests.")
    p.add_argument("--refs-dir", type=Path,
                   default=repo / "test-fixtures/references",
                   help="Root containing test_NNNN/down/baseline.png refs.")
    p.add_argument("--filter", type=str, default=None,
                   help="Substring filter on stem (e.g. test_0002).")
    p.add_argument("--regions", action="store_true",
                   help="Also report per-region (luminance-binned) metrics.")
    p.add_argument("--solve-matrix", action="store_true",
                   help="Fit a global 3x3 affine M and report residual ΔE.")
    p.add_argument("--per-fixture-matrix", action="store_true",
                   help="Also fit a separate M per fixture (variance probe).")
    p.add_argument("--sample", type=int, default=200_000,
                   help="Random-pixel sample size per fixture for matrix fit.")
    p.add_argument("--seed", type=int, default=1746,
                   help="RNG seed for reproducible sampling.")
    p.add_argument("--json", action="store_true",
                   help="Also emit a one-line JSON summary on the last line.")
    args = p.parse_args()

    pairs = discover_pairs(args.apple_dir, args.refs_dir, args.filter)
    if not pairs:
        print(f"# No candidate PNGs found under {args.apple_dir} that match "
              f"references in {args.refs_dir}{' (filter='+args.filter+')' if args.filter else ''}.",
              file=sys.stderr)
        return 0

    rng = np.random.default_rng(args.seed)

    print(f"{'fixture':<12} {'n_pix':>9}  "
          f"{'mean':>6} {'p95':>6} {'max':>6}  "
          f"{'bR':>8} {'bG':>8} {'bB':>8}")
    print("-" * 88)

    # Per-fixture cache for the matrix-solve / re-diff pass below.
    per_fixture: list[dict] = []

    for stem, cand_path, ref_path in pairs:
        cand_arr = load_srgb(cand_path)
        ref_arr = load_srgb(ref_path)
        # Realign on the reference grid if Lanczos rounded the candidate
        # off by ±1.
        cand_arr = resize_to(cand_arr, ref_arr.shape[0], ref_arr.shape[1])

        global_metrics = diff_inline(cand_arr, ref_arr)
        print(fmt_row_global(stem, global_metrics))

        region_metrics = per_region_metrics(cand_arr, ref_arr) if args.regions else None
        if region_metrics is not None:
            for line in fmt_row_region(region_metrics):
                print(line)

        per_fixture.append({
            "stem": stem,
            "global": global_metrics,
            "regions": region_metrics,
            "cand_arr": cand_arr,
            "ref_arr": ref_arr,
        })

    # Aggregate row.
    n = len(per_fixture)
    grand_mean = sum(r["global"]["mean_deltaE"] for r in per_fixture) / n
    grand_bR = sum(r["global"]["bias_r"] for r in per_fixture) / n
    grand_bG = sum(r["global"]["bias_g"] for r in per_fixture) / n
    grand_bB = sum(r["global"]["bias_b"] for r in per_fixture) / n
    print("=" * 88)
    print(f"{'GRAND':<12} ({n:>3} fixtures)  {grand_mean:6.2f} {'-':>6} {'-':>6}  "
          f"{grand_bR:+8.4f} {grand_bG:+8.4f} {grand_bB:+8.4f}")

    # ---- Matrix solve --------------------------------------------------
    if args.solve_matrix:
        print()
        print(f"# Solving 3x3 affine M minimising ‖M·apple − acr‖² over "
              f"{n} fixtures × {args.sample} pixel samples each "
              f"(total {n*args.sample:,} rows).")
        # Stack samples from every fixture.
        stacks_a, stacks_b = [], []
        for r in per_fixture:
            a, b = sample_pixels(r["cand_arr"], r["ref_arr"], args.sample, rng)
            stacks_a.append(a)
            stacks_b.append(b)
        A = np.vstack(stacks_a)
        B = np.vstack(stacks_b)
        M = solve_affine(A, B)
        print()
        print("# Solved correction matrix M (apple_pixel @ M.T → acr_pixel):")
        for row in M:
            print(f"  [ {row[0]:+10.6f}  {row[1]:+10.6f}  {row[2]:+10.6f} ]")

        # Residual: ΔE before (=grand_mean above) vs after applying M to
        # every candidate.
        post_means = []
        for r in per_fixture:
            corrected = apply_affine(r["cand_arr"], M)
            post = diff_inline(corrected, r["ref_arr"])
            post_means.append(post["mean_deltaE"])
            r["global_post_M"] = post

        print()
        print(f"# Per-fixture ΔE before → after applying M:")
        print(f"{'fixture':<12} {'mean_before':>12} {'mean_after':>11} "
              f"{'delta':>8}")
        for r, post_mean in zip(per_fixture, post_means):
            d = post_mean - r["global"]["mean_deltaE"]
            print(f"{r['stem']:<12} {r['global']['mean_deltaE']:>12.3f} "
                  f"{post_mean:>11.3f} {d:>+8.3f}")
        grand_post = sum(post_means) / n
        improvement = grand_mean - grand_post
        print(f"{'GRAND':<12} {grand_mean:>12.3f} {grand_post:>11.3f} "
              f"{(grand_post - grand_mean):>+8.3f}")
        print()
        if improvement > 2.0:
            recommend = ("STRONG: a single global M reduces grand-mean ΔE "
                         f"by {improvement:.2f} pts. Worth wiring as a "
                         "scene-linear stage before AgX.")
        elif improvement > 0.5:
            recommend = ("MARGINAL: M reduces grand-mean ΔE by "
                         f"{improvement:.2f} pts. Acceptable as a stop-gap, "
                         "but consider per-camera keying first.")
        else:
            recommend = ("WEAK: M barely moves grand-mean ΔE "
                         f"({improvement:+.2f} pts). The error is non-affine "
                         "or fixture-specific — chase a stage-specific fix.")
        print(f"# Recommendation: {recommend}")

    # ---- Per-fixture matrix variance probe -----------------------------
    if args.per_fixture_matrix:
        print()
        print("# Per-fixture solved M (compare for variance — high variance "
              "implies camera-keyed correction needed).")
        for r in per_fixture:
            a, b = sample_pixels(r["cand_arr"], r["ref_arr"], args.sample, rng)
            Mi = solve_affine(a, b)
            print(f"  {r['stem']}:")
            for row in Mi:
                print(f"    [ {row[0]:+10.6f}  {row[1]:+10.6f}  "
                      f"{row[2]:+10.6f} ]")

    if args.json:
        summary = {
            "n_fixtures": n,
            "grand_mean_deltaE": grand_mean,
            "grand_bias_r": grand_bR,
            "grand_bias_g": grand_bG,
            "grand_bias_b": grand_bB,
        }
        print(json.dumps(summary))

    return 0


if __name__ == "__main__":
    sys.exit(main())
