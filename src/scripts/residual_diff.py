#!/usr/bin/env python3
"""Per-pixel residual-diff diagnostic harness for the color pipeline.

Complement to ``compare_images.py``: that script reduces a pair of PNGs to
scalar (mean/p95/max/bias) metrics suitable for CI gates. This one emits
spatially-resolved residual maps + a frequency split, so a human (or a
follow-up tuning ticket) can attribute a residual to a specific operator
class — sharpening, LUT/Look, highlight recovery, local tone, etc.

Usage:
    residual_diff.py CAND_PNG REF_PNG --out OUTDIR [options]

Outputs in OUTDIR:
    summary.txt              one-line summary + scalar table
    residual_luma.png        signed grayscale per-luma residual (128 = zero)
    residual_r.png _g _b     per-channel signed residual
    residual_lowpass.png     signed Gaussian-blurred (sigma=4) diff
    residual_highpass.png    signed high-frequency residual
    delta_e_heatmap.png      DeltaE2000 per pixel, black-to-hot colormap
    value_scatter.csv        candidate-value -> (ref p5, p50, p95, count)

Conventions:
- All math runs in sRGB-encoded (8-bit normalized) space — the same space
  the residual MAE is reported in. Gain/offset fits are reported in those
  units so the reader can apply them directly to inspect 8-bit PNGs.
- Signed residual: ref - cand. Bright = ref-higher (cand under-shoots).
  Mapped to PNG via +128 and clipped to [0,255]; residuals beyond +/-128
  saturate, which we surface in the summary.
- Border mask is rendered as mid-gray (128, the "zero" sentinel for signed
  PNGs). The summary reports the masked fraction so it's unambiguous.

This is a diagnostic. It does not gate CI.
"""

from __future__ import annotations

import argparse
import csv
import io
import os
import sys
import warnings
from dataclasses import dataclass
from typing import Optional

import numpy as np

# colour-science prints a noisy ColourUsageWarning at import time when
# matplotlib isn't around. We never touch the plotting API; mute the whole
# colour.* namespace before the import fires the warning.
warnings.filterwarnings("ignore", message=r".*Matplotlib.*")
warnings.filterwarnings("ignore", module=r"colour.*")
import colour  # noqa: E402
from PIL import Image, ImageCms  # noqa: E402
from scipy import fftpack  # noqa: E402
from scipy.ndimage import gaussian_filter  # noqa: E402


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def _load_with_profile(path: str) -> np.ndarray:
    """Load PNG as float32 [0,1] sRGB HxWx3, honoring an embedded ICC profile.

    If the source carries a wider profile (Display P3, ProPhoto, etc.) we
    color-match to sRGB so the residual is in a consistent space. References
    without a profile are taken as sRGB by convention.
    """
    im = Image.open(path)
    icc = im.info.get("icc_profile")
    if icc:
        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        dst = ImageCms.createProfile("sRGB")
        im = ImageCms.profileToProfile(im, src, dst, outputMode="RGB")
    else:
        im = im.convert("RGB")
    return np.asarray(im, dtype=np.float32) / 255.0


def _save_uint8(arr: np.ndarray, path: str) -> None:
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(path)


# ---------------------------------------------------------------------------
# Preprocessing — resize, register, gain/offset, border
# ---------------------------------------------------------------------------

def _resize_smaller_to_larger(
    cand: np.ndarray, ref: np.ndarray
) -> tuple[np.ndarray, np.ndarray, tuple[int, int]]:
    """Lanczos-resize the SMALLER image up to the LARGER's dimensions."""
    ch, cw = cand.shape[:2]
    rh, rw = ref.shape[:2]
    if (ch, cw) == (rh, rw):
        return cand, ref, (cw, ch)

    cand_px = ch * cw
    ref_px = rh * rw
    if cand_px < ref_px:
        target_w, target_h = rw, rh
        cand = _lanczos(cand, target_w, target_h)
    else:
        target_w, target_h = cw, ch
        ref = _lanczos(ref, target_w, target_h)
    return cand, ref, (target_w, target_h)


def _lanczos(arr: np.ndarray, w: int, h: int) -> np.ndarray:
    im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))
    im = im.resize((w, h), Image.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255.0


def _luma(rgb: np.ndarray) -> np.ndarray:
    """Rec.709 luma from sRGB-encoded float32 RGB (we keep the math in the
    same encoded space we report in)."""
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def _phase_correlate(cand: np.ndarray, ref: np.ndarray) -> tuple[int, int]:
    """Integer-pixel shift (dy, dx) that, when applied to candidate via
    ``np.roll``, best aligns it to reference. Operates on luma."""
    a = _luma(cand)
    b = _luma(ref)
    # Remove DC for cleaner correlation peak.
    a = a - a.mean()
    b = b - b.mean()
    fa = fftpack.fft2(a)
    fb = fftpack.fft2(b)
    cross = fa * np.conj(fb)
    # Normalize — phase correlation, not raw cross-correlation.
    mag = np.abs(cross)
    mag[mag == 0] = 1.0
    r = fftpack.ifft2(cross / mag).real
    # Peak position
    py, px = np.unravel_index(np.argmax(r), r.shape)
    h, w = r.shape
    # Convert into signed shift (wrap > N/2 around to negative).
    if py > h // 2:
        py -= h
    if px > w // 2:
        px -= w
    return int(py), int(px)


def _apply_shift(cand: np.ndarray, dy: int, dx: int) -> np.ndarray:
    """Shift candidate by (dy, dx) so that it aligns onto reference."""
    return np.roll(cand, shift=(dy, dx), axis=(0, 1))


@dataclass
class GainOffsetFit:
    gain: tuple[float, float, float]
    offset: tuple[float, float, float]


def _fit_gain_offset(cand: np.ndarray, ref: np.ndarray) -> GainOffsetFit:
    """Per-channel least-squares fit of ``ref = gain * cand + offset``.

    Operates in sRGB-encoded space [0,1] so the reported numbers can be
    eyeballed against the 8-bit PNGs.
    """
    g = [0.0, 0.0, 0.0]
    o = [0.0, 0.0, 0.0]
    for c in range(3):
        x = cand[..., c].ravel()
        y = ref[..., c].ravel()
        A = np.column_stack([x, np.ones_like(x)])
        sol, *_ = np.linalg.lstsq(A, y, rcond=None)
        g[c] = float(sol[0])
        o[c] = float(sol[1])
    return GainOffsetFit(gain=tuple(g), offset=tuple(o))


def _apply_gain_offset(cand: np.ndarray, fit: GainOffsetFit) -> np.ndarray:
    out = np.empty_like(cand)
    for c in range(3):
        out[..., c] = cand[..., c] * fit.gain[c] + fit.offset[c]
    return np.clip(out, 0.0, 1.0)


def _border_mask(shape: tuple[int, int], pct: float) -> np.ndarray:
    """``True`` for valid pixels, ``False`` for the masked rim."""
    h, w = shape
    by = max(int(round(h * pct / 100.0)), 0)
    bx = max(int(round(w * pct / 100.0)), 0)
    m = np.zeros((h, w), dtype=bool)
    m[by:h - by, bx:w - bx] = True
    return m


# ---------------------------------------------------------------------------
# Residual rendering
# ---------------------------------------------------------------------------

def _signed_to_png(signed: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Map a signed residual in sRGB units to a 0..255 PNG with 128 = zero.

    Pixels outside the valid mask are painted mid-gray (128) — the same as
    "no diff," but the summary records masked fraction so the viewer knows.
    """
    out = np.clip(signed * 255.0 + 128.0, 0, 255).astype(np.uint8)
    if signed.ndim == 3:
        # Broadcast the 2-D mask across the channel axis.
        m3 = np.broadcast_to(mask[..., None], out.shape)
        out = np.where(m3, out, 128)
    else:
        out = np.where(mask, out, 128)
    return out


def _delta_e_heatmap(de: np.ndarray, mask: np.ndarray, cap: float = 20.0) -> np.ndarray:
    """Black-to-hot colormap: 0 = black, cap = white-hot.

    Pixels beyond ``cap`` saturate at the top of the colormap. Most
    real-world residuals are <10 sRGB ΔE; clipping at 20 keeps the gradient
    useful instead of compressing everything into the dark end.
    """
    norm = np.clip(de / cap, 0.0, 1.0)
    # Inferno-ish black -> red -> orange -> yellow -> white
    stops_x = np.array([0.0, 0.25, 0.5, 0.75, 1.0])
    stops_rgb = np.array(
        [
            [0.0, 0.0, 0.0],
            [0.55, 0.05, 0.25],
            [0.92, 0.30, 0.10],
            [0.99, 0.78, 0.30],
            [1.0, 1.0, 1.0],
        ]
    )
    rgb = np.zeros(norm.shape + (3,), dtype=np.float32)
    for c in range(3):
        rgb[..., c] = np.interp(norm, stops_x, stops_rgb[:, c])
    out = (rgb * 255.0).astype(np.uint8)
    # Masked rim: mid-gray sentinel so it's distinct from "no diff" black.
    m3 = np.broadcast_to(mask[..., None], out.shape)
    out = np.where(m3, out, 128)
    return out


# ---------------------------------------------------------------------------
# Scalars
# ---------------------------------------------------------------------------

def _clip_pct(img: np.ndarray) -> float:
    """Fraction of pixels with any channel at 0 or 1."""
    clipped = (img <= 0.0) | (img >= 1.0)
    any_chan = clipped.any(axis=-1)
    return float(any_chan.mean()) * 100.0


def _masked_mae(diff: np.ndarray, mask: np.ndarray) -> float:
    sel = np.abs(diff)[mask]
    if sel.size == 0:
        return 0.0
    return float(sel.mean()) * 255.0  # report in sRGB 8-bit units


def _masked_rmse(diff: np.ndarray, mask: np.ndarray) -> float:
    sel = (diff ** 2)[mask]
    if sel.size == 0:
        return 0.0
    return float(np.sqrt(sel.mean())) * 255.0


# ---------------------------------------------------------------------------
# Scatter
# ---------------------------------------------------------------------------

def _value_scatter_rows(
    cand: np.ndarray,
    ref: np.ndarray,
    mask: np.ndarray,
    bin_window: int,
) -> list[tuple[str, int, int, float, float, float]]:
    """For each channel and each integer value 0..255, find pixels in
    candidate within +/-bin_window of that value, then report
    (p5, p50, p95, count) of reference at those pixels."""
    rows: list[tuple[str, int, int, float, float, float]] = []
    cand_u8 = np.clip(cand * 255.0, 0, 255).round().astype(np.int16)
    ref_u8 = np.clip(ref * 255.0, 0, 255).round().astype(np.int16)
    chan_names = ("r", "g", "b")
    for ci, name in enumerate(chan_names):
        c = cand_u8[..., ci][mask]
        r = ref_u8[..., ci][mask]
        # Sort once by candidate value for fast bin lookups.
        order = np.argsort(c, kind="stable")
        c_sorted = c[order]
        r_sorted = r[order]
        # For each value v, find slice in c_sorted within [v-w, v+w].
        for v in range(256):
            lo = np.searchsorted(c_sorted, v - bin_window, side="left")
            hi = np.searchsorted(c_sorted, v + bin_window, side="right")
            count = int(hi - lo)
            if count == 0:
                rows.append((name, v, 0, float("nan"), float("nan"), float("nan")))
                continue
            sl = r_sorted[lo:hi]
            p5, p50, p95 = np.percentile(sl, [5, 50, 95])
            rows.append((name, v, count, float(p5), float(p50), float(p95)))
    return rows


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(args: argparse.Namespace) -> int:
    os.makedirs(args.out, exist_ok=True)

    cand = _load_with_profile(args.cand)
    ref = _load_with_profile(args.ref)
    orig_cand_dim = (cand.shape[1], cand.shape[0])
    orig_ref_dim = (ref.shape[1], ref.shape[0])

    cand, ref, (rw, rh) = _resize_smaller_to_larger(cand, ref)

    # --- Registration ---
    reg_line = "skipped"
    reg_warn = ""
    if args.register:
        dy, dx = _phase_correlate(cand, ref)
        cand = _apply_shift(cand, dy, dx)
        reg_line = f"drift dy={dy:+d}, dx={dx:+d} (px)"
        if abs(dy) > 5 or abs(dx) > 5:
            reg_warn = (
                "  WARNING: drift >5 px exceeds reliable phase-correlation range "
                "— manual investigation suggested."
            )

    # --- Gain/offset ---
    fit_line = "not factored out"
    if args.factor_out_gain:
        # Fit on the unmasked image (border doesn't help here; the fit is
        # global and small areas don't bias a 3-param fit much).
        fit = _fit_gain_offset(cand, ref)
        cand = _apply_gain_offset(cand, fit)
        fit_line = (
            f"R: gain={fit.gain[0]:.4f}, offset={fit.offset[0]:+.4f}  "
            f"G: gain={fit.gain[1]:.4f}, offset={fit.offset[1]:+.4f}  "
            f"B: gain={fit.gain[2]:.4f}, offset={fit.offset[2]:+.4f}"
        )

    # --- Border mask ---
    mask = _border_mask((rh, rw), args.border_pct)
    border_frac = 1.0 - float(mask.mean())

    # --- Per-channel + luma residual (signed) ---
    diff = ref - cand  # ref - cand, in [-1, 1]
    diff_luma = _luma(ref) - _luma(cand)

    _save_uint8(_signed_to_png(diff_luma, mask),
                os.path.join(args.out, "residual_luma.png"))
    _save_uint8(_signed_to_png(diff[..., 0], mask),
                os.path.join(args.out, "residual_r.png"))
    _save_uint8(_signed_to_png(diff[..., 1], mask),
                os.path.join(args.out, "residual_g.png"))
    _save_uint8(_signed_to_png(diff[..., 2], mask),
                os.path.join(args.out, "residual_b.png"))

    # --- Frequency split ---
    sigma = float(args.blur_sigma)
    cand_lo = np.empty_like(cand)
    ref_lo = np.empty_like(ref)
    for c in range(3):
        cand_lo[..., c] = gaussian_filter(cand[..., c], sigma=sigma)
        ref_lo[..., c] = gaussian_filter(ref[..., c], sigma=sigma)
    diff_lo = ref_lo - cand_lo
    diff_hi = (ref - ref_lo) - (cand - cand_lo)  # high-freq residual

    # Render as luma signed PNGs for at-a-glance reading.
    _save_uint8(
        _signed_to_png(_luma(diff_lo + 0.5) - 0.5, mask),  # luma of signed
        os.path.join(args.out, "residual_lowpass.png"),
    )
    _save_uint8(
        _signed_to_png(_luma(diff_hi + 0.5) - 0.5, mask),
        os.path.join(args.out, "residual_highpass.png"),
    )

    # --- ΔE2000 ---
    if not args.quiet:
        print("computing dE2000...", file=sys.stderr)
    cand_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(cand))
    ref_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(ref))
    de = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")

    _save_uint8(_delta_e_heatmap(de, mask), os.path.join(args.out, "delta_e_heatmap.png"))

    de_sel = de[mask]
    de_mean = float(de_sel.mean()) if de_sel.size else 0.0
    de_med = float(np.median(de_sel)) if de_sel.size else 0.0
    de_p95 = float(np.percentile(de_sel, 95)) if de_sel.size else 0.0

    # --- Scalars ---
    mae = _masked_mae(diff, mask)
    rmse = _masked_rmse(diff, mask)
    mae_lo = _masked_mae(diff_lo, mask)
    mae_hi = _masked_mae(diff_hi, mask)
    total = mae_lo + mae_hi
    lo_ratio = (mae_lo / total) if total > 0 else 0.0
    cand_clip = _clip_pct(cand)
    ref_clip = _clip_pct(ref)

    # Saturation of signed PNG: residuals >|0.5| (i.e., >127 sRGB units) clip.
    sat_pct = float((np.abs(diff) > 0.5).any(axis=-1).mean()) * 100.0

    # --- Value-binned scatter ---
    if not args.quiet:
        print("computing value scatter...", file=sys.stderr)
    rows = _value_scatter_rows(cand, ref, mask, args.bin_window)
    with open(os.path.join(args.out, "value_scatter.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["channel", "value", "count", "ref_p5", "ref_p50", "ref_p95"])
        for row in rows:
            w.writerow(row)

    # --- Summary ---
    summary = []
    summary.append(f"residual_diff: {args.cand} vs {args.ref}")
    summary.append(
        f"  dimensions:     CAND {orig_cand_dim[0]}x{orig_cand_dim[1]}  "
        f"REF {orig_ref_dim[0]}x{orig_ref_dim[1]}  resized to {rw}x{rh}"
    )
    summary.append(f"  registration:   {reg_line}")
    if reg_warn:
        summary.append(reg_warn)
    summary.append(f"  gain/offset:    {fit_line}")
    summary.append(
        f"  clipping:       CAND {cand_clip:.2f}%, REF {ref_clip:.2f}%  "
        f"(pixels at 0 or 255 in any channel)"
    )
    summary.append(
        f"  border masked:  {border_frac * 100:.2f}% of pixels excluded"
    )
    summary.append(
        f"  residual >|0.5|: {sat_pct:.3f}% of pixels saturate signed PNG"
    )
    summary.append("")
    summary.append("  overall metrics:")
    summary.append(
        f"    MAE  (mean abs delta, sRGB units, per-channel-averaged):  {mae:.2f}"
    )
    summary.append(
        f"    RMSE (root mean squared, sRGB units):                     {rmse:.2f}"
    )
    summary.append(
        f"    dE2000 mean / median / p95:                               "
        f"{de_mean:.2f} / {de_med:.2f} / {de_p95:.2f}"
    )
    summary.append("")
    summary.append(f"  frequency split (Gaussian sigma={sigma:g} low/high):")
    summary.append(f"    low-freq MAE (the LUT's domain):     {mae_lo:.2f}")
    summary.append(f"    high-freq MAE (sharpening's domain): {mae_hi:.2f}")
    summary.append(f"    low/total ratio:                      {lo_ratio:.2f}")

    text = "\n".join(summary) + "\n"
    with open(os.path.join(args.out, "summary.txt"), "w") as f:
        f.write(text)
    if not args.quiet:
        print(text, end="")
    return 0


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Per-pixel residual-diff diagnostic for the color pipeline.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("cand", help="candidate PNG (the rendered output)")
    p.add_argument("ref", help="reference PNG (the target, typically ACR)")
    p.add_argument("--out", required=True, help="output directory")
    p.add_argument(
        "--register",
        action="store_true",
        help="phase-correlation alignment to handle small drift",
    )
    p.add_argument(
        "--factor-out-gain",
        action="store_true",
        help="fit + remove a global gain+offset before computing residuals",
    )
    p.add_argument(
        "--border-pct",
        type=float,
        default=2.0,
        help="crop N%% off each edge before computing (default 2)",
    )
    p.add_argument(
        "--blur-sigma",
        type=float,
        default=4.0,
        help="Gaussian sigma for low/high split (default 4)",
    )
    p.add_argument(
        "--bin-window",
        type=int,
        default=2,
        help="half-width of value bin in scatter analysis (default 2)",
    )
    p.add_argument(
        "--quiet",
        action="store_true",
        help="suppress per-file progress; just write summary",
    )
    return p.parse_args(argv)


if __name__ == "__main__":
    sys.exit(run(parse_args()))
