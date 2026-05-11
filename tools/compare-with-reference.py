#!/usr/bin/env python3
"""Compare a Maple pano output against the ACR-rendered reference.

Companion to ``src/scripts/compare_images.py`` (which expects same-size
inputs). This tool handles the panorama case: Maple and ACR commonly
disagree on canvas aspect / field-of-view, so we resize both to the
same long-edge before measuring.

Three metrics are reported, plus the per-channel bias and ΔE summary
stats from ``compare_images.py``:

  delta_e_mean / delta_e_p95 / delta_e_max
      CIEDE2000 over a sample grid of pixels that are valid (non-padded)
      in BOTH images, after both are resized to a common long-edge.

  gamut_area_pct
      Percent of valid candidate pixels that are clipping (any sRGB
      channel ≥ 0.99) or that match the chroma-imbalance proxy
      (min(R,G,B) < 0.01 ∧ max(R,G,B) > 0.5). The proxy catches the
      magenta / cyan bloom defects (one channel saturated, another
      crushed) that we want to gate against.

  seam_visibility
      Mean luma gradient inside an 8 px band around seam paths minus
      mean luma gradient outside. Positive = seams are visible.
      Seam paths are derived from validity transitions in the candidate
      OR from a separate label PNG when --candidate-labels is given.
      When no seam information is available the metric is null.

The script reuses ``src/scripts/compare_images.py``'s helpers
(load_srgb, sRGB→Lab path) so its ΔE numbers are line-for-line
comparable with the existing color-pipeline harness.

Usage:

  tools/compare-with-reference.py CAND.png REF.png \\
      [--budgets PATH] \\
      [--long-edge 2000] \\
      [--candidate-labels PATH] \\
      [--json-out PATH]

Exit codes:
  0  metrics computed successfully
  1  budgets file given AND at least one metric is over its ceiling
  2  any other error (missing input, unreadable, etc.)
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import warnings
from pathlib import Path
from typing import Any

# Silence colour-science's optional-dep warnings for clean JSON output.
with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    import colour  # noqa: F401  (used after import_existing_helper)

import numpy as np
from PIL import Image

# Real panoramas easily blow past PIL's 178 MP guard. We trust our own
# inputs.
Image.MAX_IMAGE_PIXELS = None


# ---------------------------------------------------------------------------
# Reuse the existing compare_images.py helpers.
# ---------------------------------------------------------------------------

def _import_compare_images() -> Any:
    """Load src/scripts/compare_images.py as a module so we share its
    sRGB-to-Lab path verbatim (rather than duplicating the colour-science
    plumbing that the rest of the repo already trusts).
    """
    here = Path(__file__).resolve()
    candidates = [
        here.parent.parent / "src" / "scripts" / "compare_images.py",
        Path.cwd() / "src" / "scripts" / "compare_images.py",
    ]
    for candidate in candidates:
        if candidate.is_file():
            spec = importlib.util.spec_from_file_location(
                "_maple_compare_images", str(candidate)
            )
            assert spec is not None and spec.loader is not None
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise RuntimeError(
        "could not locate src/scripts/compare_images.py to reuse its "
        "sRGB→Lab pipeline"
    )


_COMPARE = _import_compare_images()
load_srgb = _COMPARE.load_srgb  # (path: str) -> np.ndarray[H, W, 3] in [0, 1]


# ---------------------------------------------------------------------------
# Geometry helpers — resize, validity mask, cropping black bars.
# ---------------------------------------------------------------------------

def srgb_to_linear(srgb: np.ndarray) -> np.ndarray:
    """Standard piecewise sRGB EOTF, vectorised to f32 [0, 1]."""
    a = 0.055
    threshold = 0.04045
    low = srgb / 12.92
    high = ((srgb + a) / (1 + a)) ** 2.4
    return np.where(srgb <= threshold, low, high).astype(np.float32)


def resize_to_long_edge(arr: np.ndarray, long_edge: int) -> np.ndarray:
    """Lanczos-resample a [H, W, 3] f32 image to the given long edge.
    Preserves aspect ratio.
    """
    h, w = arr.shape[:2]
    scale = long_edge / max(h, w)
    if scale >= 1.0:
        return arr
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    # Pillow needs a uint8 round-trip for high-quality Lanczos; for the
    # ΔE path we need float, so route through PIL with float multiplication.
    img = Image.fromarray(np.clip(arr * 255.0 + 0.5, 0, 255).astype(np.uint8))
    img = img.resize((new_w, new_h), Image.LANCZOS)
    out = np.asarray(img, dtype=np.float32) / 255.0
    return out


def validity_mask(arr: np.ndarray, threshold: float = 1.0 / 255.0) -> np.ndarray:
    """Binary mask of "valid content" pixels: at least one channel above
    a tiny threshold. The padded-canvas regions of a Maple pano sit at
    exactly 0; ACR renders sometimes have a 1-px black border; the
    threshold lets us tag both as invalid.
    """
    return arr.max(axis=-1) > threshold


# ---------------------------------------------------------------------------
# ΔE on the intersection mask.
# ---------------------------------------------------------------------------

def compute_delta_e(
    cand_srgb: np.ndarray, ref_srgb: np.ndarray, mask: np.ndarray
) -> dict[str, float]:
    """Sample-grid ΔE2000 over valid pixels.

    Both images are sRGB f32 in [0, 1] at the same dimensions; mask is
    a boolean [H, W] selecting pixels valid in both. We decode sRGB to
    XYZ→Lab via colour-science (matching compare_images.py exactly).
    """
    if not mask.any():
        return {"mean": float("nan"), "p95": float("nan"), "max": float("nan")}

    # Sample at most 1M pixels to keep the colour-science Lab call fast
    # on 180 MP panoramas. Random subsample with a fixed seed so the
    # numbers are deterministic.
    ys, xs = np.where(mask)
    n = len(ys)
    cap = 1_000_000
    if n > cap:
        rng = np.random.default_rng(seed=12345)
        idx = rng.choice(n, cap, replace=False)
        ys = ys[idx]
        xs = xs[idx]

    cand_pix = cand_srgb[ys, xs]
    ref_pix = ref_srgb[ys, xs]

    # Clip to [0,1] before colour-science to avoid out-of-domain warnings
    # on the rare negative-after-resize pixel.
    cand_pix = np.clip(cand_pix, 0.0, 1.0)
    ref_pix = np.clip(ref_pix, 0.0, 1.0)

    cand_xyz = colour.sRGB_to_XYZ(cand_pix)
    ref_xyz = colour.sRGB_to_XYZ(ref_pix)
    cand_lab = colour.XYZ_to_Lab(cand_xyz)
    ref_lab = colour.XYZ_to_Lab(ref_xyz)

    de = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")
    return {
        "mean": float(np.mean(de)),
        "p95": float(np.percentile(de, 95)),
        "max": float(np.max(de)),
    }


# ---------------------------------------------------------------------------
# Out-of-gamut / chroma-imbalance metric (the magenta-blob detector).
# ---------------------------------------------------------------------------

def compute_gamut_area_pct(
    cand_srgb: np.ndarray, mask: np.ndarray
) -> float:
    """Percent of valid candidate pixels that look out-of-gamut.

    "Out of gamut" here means EITHER:
      - any sRGB channel ≥ 0.99 (clipped highlight)
      - min(R,G,B) < 0.01 AND max(R,G,B) > 0.5 (chroma imbalance —
        e.g. a magenta bloom where green is crushed but red+blue are
        bright; or a cyan bloom where red is crushed but green+blue
        are bright).

    Returns the percent of valid pixels that match either rule.
    """
    if not mask.any():
        return 0.0

    valid = mask
    pix = cand_srgb[valid]
    rmax = pix.max(axis=-1)
    rmin = pix.min(axis=-1)

    clipped = rmax >= 0.99
    imbalanced = (rmin < 0.01) & (rmax > 0.5)
    bad = clipped | imbalanced

    return 100.0 * float(bad.sum()) / float(valid.sum())


# ---------------------------------------------------------------------------
# Seam-visibility metric.
# ---------------------------------------------------------------------------

def luma(srgb: np.ndarray) -> np.ndarray:
    """Rec.709 luma for f32 sRGB pixels in [0, 1]."""
    return (
        0.2126 * srgb[..., 0]
        + 0.7152 * srgb[..., 1]
        + 0.0722 * srgb[..., 2]
    ).astype(np.float32)


def luma_gradient_magnitude(L: np.ndarray) -> np.ndarray:
    """3×3 finite-difference Sobel magnitude on a [H, W] luma plane."""
    # Pad and use vectorised slicing — avoid scipy/cv2 dependency.
    pad = np.pad(L, 1, mode="edge")
    gx = (
        -pad[:-2, :-2] - 2 * pad[1:-1, :-2] - pad[2:, :-2]
        + pad[:-2, 2:] + 2 * pad[1:-1, 2:] + pad[2:, 2:]
    )
    gy = (
        -pad[:-2, :-2] - 2 * pad[:-2, 1:-1] - pad[:-2, 2:]
        + pad[2:, :-2] + 2 * pad[2:, 1:-1] + pad[2:, 2:]
    )
    return np.sqrt(gx * gx + gy * gy).astype(np.float32)


def detect_seam_paths(
    cand_srgb: np.ndarray,
    mask: np.ndarray,
    label_path: Path | None = None,
) -> np.ndarray:
    """Return a binary [H, W] map: 1 inside an 8-px band around any
    seam, 0 elsewhere.

    Two sources of seam information are tried in order:

      1. ``label_path``: a PNG where pixel value = label index for each
         image. Seam pixels are those whose label differs from any
         4-neighbour. (Pano-smoke can write a label map; this branch
         is what we'd switch to once that lands.)

      2. Validity transitions in the candidate. A pixel is on a seam
         if it is valid AND any of its 4-neighbours is NOT valid (i.e.
         we're at the boundary between a frame's contribution and
         empty canvas). For multi-frame panoramas this catches every
         frame-edge that touches the canvas boundary; for
         seam-zone-blended outputs it catches the outline of the
         union of all frames plus any internal validity holes.

    Returns an empty mask (all zeros) if neither source is available.
    """
    H, W = mask.shape

    # --- branch 1: label map --------------------------------------------
    if label_path is not None and label_path.is_file():
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            label_im = Image.open(str(label_path))
            if label_im.size[::-1] != (H, W):
                # Resize labels with NEAREST so label values are preserved.
                label_im = label_im.resize(
                    (W, H), Image.NEAREST
                )
            labels = np.asarray(label_im.convert("L"), dtype=np.int32)
        diff_left = labels[:, 1:] != labels[:, :-1]
        diff_top = labels[1:, :] != labels[:-1, :]
        seam_pixels = np.zeros_like(mask, dtype=bool)
        seam_pixels[:, :-1] |= diff_left
        seam_pixels[:, 1:] |= diff_left
        seam_pixels[:-1, :] |= diff_top
        seam_pixels[1:, :] |= diff_top
        return _dilate(seam_pixels, radius=8)

    # --- branch 2: validity transitions ---------------------------------
    if not mask.any():
        return np.zeros_like(mask, dtype=bool)

    # boundary = mask pixel adjacent to a non-mask pixel.
    boundary = np.zeros_like(mask, dtype=bool)
    boundary[1:, :] |= mask[1:, :] & ~mask[:-1, :]
    boundary[:-1, :] |= mask[:-1, :] & ~mask[1:, :]
    boundary[:, 1:] |= mask[:, 1:] & ~mask[:, :-1]
    boundary[:, :-1] |= mask[:, :-1] & ~mask[:, 1:]

    return _dilate(boundary, radius=8)


def _dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    """Square-kernel binary dilation with the given radius. Pure
    NumPy — uses repeated max-pooling over a 1-D kernel which is a
    standard equivalent to a square dilation.
    """
    if radius <= 0:
        return mask.copy()
    out = mask.astype(bool)
    # Two 1-D dilations approximate a square-radius dilation cheaply.
    for axis in (0, 1):
        if not out.any():
            break
        cumulative = out.copy()
        for shift in range(1, radius + 1):
            shifted = np.zeros_like(out)
            if axis == 0:
                shifted[shift:, :] = out[:-shift, :]
                cumulative |= shifted
                shifted[:] = False
                shifted[:-shift, :] = out[shift:, :]
                cumulative |= shifted
            else:
                shifted[:, shift:] = out[:, :-shift]
                cumulative |= shifted
                shifted[:] = False
                shifted[:, :-shift] = out[:, shift:]
                cumulative |= shifted
        out = cumulative
    return out


def compute_seam_visibility(
    cand_srgb: np.ndarray,
    mask: np.ndarray,
    seam_band: np.ndarray,
) -> float | None:
    """Mean luma gradient inside the seam band minus mean outside.

    Both averages are taken only over pixels valid (mask=True). When
    the seam band is empty, returns None.
    """
    if not seam_band.any():
        return None
    L = luma(cand_srgb)
    grad = luma_gradient_magnitude(L)
    inside = mask & seam_band
    outside = mask & ~seam_band
    if not inside.any() or not outside.any():
        return None
    return float(grad[inside].mean() - grad[outside].mean())


# ---------------------------------------------------------------------------
# Top-level entry point.
# ---------------------------------------------------------------------------

def compute_metrics(
    candidate_path: Path,
    reference_path: Path,
    long_edge: int,
    candidate_labels: Path | None,
) -> dict[str, Any]:
    cand = load_srgb(str(candidate_path))
    ref = load_srgb(str(reference_path))

    cand_r = resize_to_long_edge(cand, long_edge)
    ref_r = resize_to_long_edge(ref, long_edge)

    # Both must end up at the same shape for the per-pixel mask. If the
    # aspect ratios differ (Maple FoV ≠ ACR FoV — which is the actual
    # state today), we resize both independently to ``long_edge``, which
    # leaves the aspect intact but the dimensions different. To get a
    # comparable canvas, force-resample each to a common (long_edge ×
    # long_edge) box; the per-pixel ΔE numbers are still well-defined
    # because both images are content-bearing in their own coordinates,
    # and the box-resample preserves the relative content.
    target = (long_edge, long_edge)
    cand_box = _resize_to_box(cand_r, target)
    ref_box = _resize_to_box(ref_r, target)

    cand_mask = validity_mask(cand_box)
    ref_mask = validity_mask(ref_box)
    intersection = cand_mask & ref_mask

    # ΔE
    de = compute_delta_e(cand_box, ref_box, intersection)

    # Bias (channel mean diff over the intersection)
    bias = (cand_box - ref_box)
    if intersection.any():
        bias_per_channel = bias[intersection].mean(axis=0)
    else:
        bias_per_channel = np.zeros(3, dtype=np.float32)

    # Gamut excursion / chroma imbalance — measured on candidate only
    # (the reference is the target, by construction within-gamut for ACR).
    gamut_pct = compute_gamut_area_pct(cand_box, cand_mask)

    # Seam visibility — measured on candidate only.
    seam_band = detect_seam_paths(cand_box, cand_mask, candidate_labels)
    seam_vis = compute_seam_visibility(cand_box, cand_mask, seam_band)

    return {
        "delta_e_mean": de["mean"],
        "delta_e_p95": de["p95"],
        "delta_e_max": de["max"],
        "bias_r": float(bias_per_channel[0]),
        "bias_g": float(bias_per_channel[1]),
        "bias_b": float(bias_per_channel[2]),
        "gamut_area_pct": float(gamut_pct),
        "seam_visibility": (None if seam_vis is None else float(seam_vis)),
        "long_edge": int(long_edge),
        "candidate_pixels": int(cand_mask.sum()),
        "reference_pixels": int(ref_mask.sum()),
        "intersection_pixels": int(intersection.sum()),
    }


def _resize_to_box(arr: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Force-resample an [H, W, 3] f32 array to (W=size[0], H=size[1])
    via Lanczos. Preserves channel count.
    """
    target_w, target_h = size
    if arr.shape[0] == target_h and arr.shape[1] == target_w:
        return arr
    img = Image.fromarray(np.clip(arr * 255.0 + 0.5, 0, 255).astype(np.uint8))
    img = img.resize((target_w, target_h), Image.LANCZOS)
    return np.asarray(img, dtype=np.float32) / 255.0


def gate_against_budgets(
    metrics: dict[str, Any], budgets: dict[str, Any]
) -> list[str]:
    """Return list of failure messages — empty list = all pass.
    Only metrics present in budgets are checked."""
    fails: list[str] = []
    for key in (
        "delta_e_mean",
        "delta_e_p95",
        "delta_e_max",
        "gamut_area_pct",
        "seam_visibility",
    ):
        if key not in budgets:
            continue
        val = metrics.get(key)
        if val is None:
            continue
        ceiling = budgets[key]
        if val > ceiling:
            fails.append(f"{key} {val:.3f} > {ceiling:.3f}")
    return fails


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("candidate", type=Path, help="Maple-produced PNG.")
    p.add_argument("reference", type=Path, help="ACR-rendered PNG.")
    p.add_argument(
        "--budgets",
        type=Path,
        default=None,
        help=(
            "Optional JSON budgets file. When given, exit 1 if any "
            "metric exceeds its ceiling."
        ),
    )
    p.add_argument(
        "--long-edge",
        type=int,
        default=2000,
        help="Resize both inputs to this long edge before measuring.",
    )
    p.add_argument(
        "--candidate-labels",
        type=Path,
        default=None,
        help=(
            "Optional path to a per-pixel image label PNG written by "
            "pano-smoke. When present, seam paths are derived from "
            "label transitions instead of validity transitions."
        ),
    )
    p.add_argument(
        "--json-out",
        type=Path,
        default=None,
        help="Also write the metrics JSON to this path.",
    )
    args = p.parse_args()

    if not args.candidate.is_file():
        print(
            f"ERROR: candidate not found: {args.candidate}", file=sys.stderr
        )
        return 2
    if not args.reference.is_file():
        print(
            f"ERROR: reference not found: {args.reference}", file=sys.stderr
        )
        return 2

    metrics = compute_metrics(
        args.candidate,
        args.reference,
        long_edge=args.long_edge,
        candidate_labels=args.candidate_labels,
    )

    out_json = json.dumps(metrics, indent=2, sort_keys=True)
    print(out_json)

    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(out_json)

    if args.budgets is not None:
        if not args.budgets.is_file():
            print(
                f"ERROR: budgets file not found: {args.budgets}",
                file=sys.stderr,
            )
            return 2
        try:
            budgets_full = json.loads(args.budgets.read_text())
        except json.JSONDecodeError as exc:
            print(f"ERROR: invalid JSON in {args.budgets}: {exc}", file=sys.stderr)
            return 2
        # Strip _comment-prefixed keys before gating.
        budgets = {
            k: v for k, v in budgets_full.items()
            if not k.startswith("_") and not isinstance(v, str)
        }
        fails = gate_against_budgets(metrics, budgets)
        if fails:
            print(
                "BUDGET FAIL: " + "; ".join(fails),
                file=sys.stderr,
            )
            return 1
        print(
            "BUDGET OK: all metrics within ceilings",
            file=sys.stderr,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
