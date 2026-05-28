#!/usr/bin/env python3
"""
fit_curves.py — recover the rendering transform from a (RAW, reference) pair.

Philosophy: fit the SIMPLE model first (per-channel 1D curves), then let the
residual tell you whether you need cross-channel terms (a 3x3 matrix). The
error MAP is the diagnostic, not just the scalar score.

Pipeline:
  1. load both images as float [0,1], same shape
  2. (optional) align / downscale ref-matched
  3. fit per-channel transfer curve src->tgt via robust binned medians
  4. fit an optional 3x3 matrix on the curve-corrected result
  5. report error before/after each stage + write residual heatmaps

Usage:
  python3 fit_curves.py raw.tiff reference.jpg --out results/
"""

import argparse
import os
import numpy as np
import cv2


# ----------------------------------------------------------------------
# IO
# ----------------------------------------------------------------------
def load_float(path):
    """Load any image cv2 understands as float RGB in [0,1].
    16-bit TIFFs (typical demosaiced RAW export) are handled correctly."""
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED | cv2.IMREAD_ANYDEPTH)
    if img is None:
        raise SystemExit(f"could not read {path}")
    if img.ndim == 2:                       # grayscale -> 3ch
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:                   # drop alpha
        img = img[..., :3]
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    # normalize by dtype max so 8-bit and 16-bit both land in [0,1]
    maxval = np.iinfo(img.dtype).max if np.issubdtype(img.dtype, np.integer) else 1.0
    return img.astype(np.float64) / maxval


def match_geometry(src, tgt):
    """Resize src to tgt's resolution if they differ. Returns possibly-resized src.
    When sizes differ the reference is usually the smaller/rendered one, so we
    bring the RAW down to it (downscaling is lossy-safe; upscaling invents data)."""
    if src.shape[:2] == tgt.shape[:2]:
        return src
    h, w = tgt.shape[:2]
    print(f"  [geometry] resizing src {src.shape[:2]} -> {(h, w)} (area interp)")
    return cv2.resize(src, (w, h), interpolation=cv2.INTER_AREA)


# ----------------------------------------------------------------------
# Edge mask — skip high-frequency regions when geometry was resampled.
# Resizing smears color at edges; sampling there poisons the fit.
# ----------------------------------------------------------------------
def low_freq_mask(img, thresh=0.04):
    gray = img.mean(axis=2).astype(np.float32)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.sqrt(gx * gx + gy * gy)
    return grad < thresh


# ----------------------------------------------------------------------
# Stage 1: per-channel transfer curve (the cheap, interpretable model)
# ----------------------------------------------------------------------
def fit_transfer_curve(s, t, n_bins=64, min_count=25):
    """One channel. s,t are 1D arrays in [0,1]. Returns (xs, ys) control points.
    Median per source-bin recovers curve SHAPE, immune to the outliers a
    global mean would smear together."""
    bins = np.linspace(0.0, 1.0, n_bins + 1)
    idx = np.clip(np.digitize(s, bins) - 1, 0, n_bins - 1)
    xs, ys = [], []
    for b in range(n_bins):
        m = idx == b
        if m.sum() < min_count:
            continue
        xs.append(0.5 * (bins[b] + bins[b + 1]))
        ys.append(np.median(t[m]))
    xs, ys = np.array(xs), np.array(ys)
    # enforce monotonic-ish endpoints so apply() extrapolates sanely
    if len(xs) < 2:
        raise SystemExit("too few populated bins; check alignment/exposure")
    return xs, ys


def apply_curve(channel, xs, ys):
    """Piecewise-linear LUT apply with clamped extrapolation."""
    return np.interp(channel, xs, ys, left=ys[0], right=ys[-1])


# ----------------------------------------------------------------------
# Stage 2: optional 3x3 matrix on curve-corrected pixels.
# Captures saturation / channel crosstalk that a 1D LUT structurally cannot.
# Solved as least squares:  corrected @ M ≈ target
# ----------------------------------------------------------------------
def fit_matrix(corrected_px, tgt_px):
    """corrected_px, tgt_px: (N,3). Returns 3x3 M and the corrected output."""
    M, *_ = np.linalg.lstsq(corrected_px, tgt_px, rcond=None)
    out = corrected_px @ M
    return M, np.clip(out, 0, 1)


# ----------------------------------------------------------------------
# Metrics
# ----------------------------------------------------------------------
def errors(a, b):
    diff = a - b
    rmse = float(np.sqrt(np.mean(diff ** 2)))
    mae = float(np.mean(np.abs(diff)))
    # per-channel rmse tells you WHICH channel is off
    per_ch = np.sqrt(np.mean(diff ** 2, axis=0)) if diff.ndim == 2 else \
             np.sqrt(np.mean(diff.reshape(-1, 3) ** 2, axis=0))
    return rmse, mae, per_ch


def save_residual_heatmap(src_corr, tgt, path):
    """The money shot: where is the model wrong? Flat noise = done.
    Structured (tracks edges/sky/skin) = you need more model."""
    res = np.abs(src_corr - tgt).mean(axis=2)
    res_norm = np.clip(res / (res.max() + 1e-9), 0, 1)
    heat = cv2.applyColorMap((res_norm * 255).astype(np.uint8), cv2.COLORMAP_INFERNO)
    cv2.imwrite(path, heat)
    return float(res.mean())


# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("raw")
    ap.add_argument("reference")
    ap.add_argument("--out", default="results")
    ap.add_argument("--bins", type=int, default=64)
    ap.add_argument("--matrix", action="store_true",
                    help="also fit a 3x3 matrix stage and compare")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    src = load_float(args.raw)
    tgt = load_float(args.reference)
    src = match_geometry(src, tgt)

    resampled = src.shape[:2] != tgt.shape[:2]  # (already matched, but flag intent)
    mask = low_freq_mask(src) if resampled else np.ones(src.shape[:2], bool)
    print(f"  sampling {mask.sum():,} / {mask.size:,} pixels")

    # baseline: how far off is the raw, uncorrected?
    rmse0, mae0, pc0 = errors(src.reshape(-1, 3), tgt.reshape(-1, 3))
    print(f"\n[stage 0] raw vs reference   RMSE={rmse0:.4f}  MAE={mae0:.4f}  "
          f"perCh={np.round(pc0,4)}")

    # ---- stage 1: per-channel curves ----
    curves = {}
    corrected = np.empty_like(src)
    for c, name in enumerate("RGB"):
        s = src[..., c][mask]
        t = tgt[..., c][mask]
        xs, ys = fit_transfer_curve(s, t, n_bins=args.bins)
        curves[name] = (xs, ys)
        corrected[..., c] = apply_curve(src[..., c], xs, ys)
        np.savetxt(os.path.join(args.out, f"curve_{name}.csv"),
                   np.column_stack([xs, ys]), delimiter=",",
                   header="src,tgt", comments="")

    rmse1, mae1, pc1 = errors(corrected.reshape(-1, 3), tgt.reshape(-1, 3))
    print(f"[stage 1] + 1D curves        RMSE={rmse1:.4f}  MAE={mae1:.4f}  "
          f"perCh={np.round(pc1,4)}   ({100*(rmse0-rmse1)/rmse0:.1f}% better)")
    r1 = save_residual_heatmap(corrected, tgt,
                               os.path.join(args.out, "residual_stage1.png"))

    # ---- stage 2: optional matrix ----
    if args.matrix:
        cp = corrected.reshape(-1, 3)[mask.ravel()]
        tp = tgt.reshape(-1, 3)[mask.ravel()]
        M, _ = fit_matrix(cp, tp)
        full = np.clip(corrected.reshape(-1, 3) @ M, 0, 1).reshape(src.shape)
        rmse2, mae2, pc2 = errors(full.reshape(-1, 3), tgt.reshape(-1, 3))
        print(f"[stage 2] + 3x3 matrix       RMSE={rmse2:.4f}  MAE={mae2:.4f}  "
              f"perCh={np.round(pc2,4)}   ({100*(rmse1-rmse2)/rmse1:.1f}% better)")
        save_residual_heatmap(full, tgt,
                              os.path.join(args.out, "residual_stage2.png"))
        np.savetxt(os.path.join(args.out, "matrix.csv"), M, delimiter=",")
        print(f"\n  matrix M (rows=in RGB, cols=out RGB):\n{np.round(M,4)}")
        gain = 100 * (rmse1 - rmse2) / rmse1
        verdict = ("matrix barely helped -> your look is tone/WB only, ship the curves"
                   if gain < 5 else
                   "matrix helped meaningfully -> there's real cross-channel grading")
        print(f"\n  VERDICT: {verdict}")

    print(f"\nresiduals + curves written to {args.out}/")
    print("  -> open residual_stage1.png. flat noise = curves are enough.")
    print("     structure (sky/skin/edges glowing) = escalate to --matrix.")


if __name__ == "__main__":
    main()
