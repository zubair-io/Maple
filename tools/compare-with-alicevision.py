#!/usr/bin/env python3
"""Compare a Maple-produced panorama against an AliceVision oracle output.

This tool produces THREE metrics aimed at panorama quality, NOT colour
delta-E. AliceVision's colour pipeline (sRGB IEC, no AgX) differs from
Maple's RAW + AgX path, so a large pixelwise dE comes from colour
transforms, not alignment. We compare what the in-house pipeline is
trying to be better at: geometry, seam routing, and ghost-mask area.

Metrics (printed as a table to stdout, JSON to --json-out if given):

  1. Keypoint residuals after warp.
     Detect AKAZE keypoints in BOTH outputs at full resolution. Match
     them with a Hamming brute-force matcher + ratio test. For every
     surviving match, the canvas-pixel disagreement between the two
     images' positions is one residual sample. Report mean and p95;
     these are the geometry-disagreement signal.

  2. Seam route differences.
     If both backends ship a seam-label PNG (per-image label maps),
     load them and compute IoU + an approximate Hausdorff distance
     between corresponding label boundaries. Skips the seam metric
     when label maps aren't available — the harness still completes
     using the other two metrics.

  3. Duplicate / ghost-mask area.
     Pixels where local cross-row colour difference exceeds a threshold
     are tagged as parallax/misalignment evidence. Report the total
     ghost-mask pixel count for each output. The mask uses a small
     local window (5×5) to find pixels that disagree sharply with their
     neighbours — a proxy for the "two halves of one object misaligned"
     signature of bad stitching.

Usage:

  tools/compare-with-alicevision.py MAPLE.png AV.png \\
      [--maple-seams DIR] [--av-seams DIR] \\
      [--json-out PATH] [--max-keypoints 20000]

When --json-out is given, the same metrics are written there in
machine-readable form for CI gating.
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

import numpy as np
from PIL import Image

try:
    import cv2
except ImportError:
    print(
        "ERROR: opencv-python is required. Install: pip install opencv-python",
        file=sys.stderr,
    )
    sys.exit(2)


# Real panoramas easily blow past PIL's 178 MP guard; we trust our own
# inputs.
Image.MAX_IMAGE_PIXELS = None


def load_rgb(path: Path) -> np.ndarray:
    """Load a PNG as uint8 RGB numpy array."""
    im = Image.open(str(path)).convert("RGB")
    return np.asarray(im, dtype=np.uint8)


def to_grey(rgb: np.ndarray) -> np.ndarray:
    """Convert RGB uint8 to greyscale uint8."""
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)


# -----------------------------------------------------------------------------
# Metric 1 — keypoint residuals after warp
# -----------------------------------------------------------------------------


def keypoint_residuals(
    a_rgb: np.ndarray, b_rgb: np.ndarray, max_keypoints: int = 20000
) -> dict[str, Any]:
    """Compare AKAZE keypoint positions between two output panoramas.

    The two panoramas are different rendering backends of the same
    scene — same canvas, same projection, different geometry solves.
    Matched keypoints SHOULD land at the same canvas pixel; the residual
    is the disagreement between i's position and j's position.

    Returns dict with keys: n_matches, mean_px, p95_px, max_px,
    n_keypoints_a, n_keypoints_b. Returns n_matches=0 if either image
    is too featureless to match.
    """
    if a_rgb.shape != b_rgb.shape:
        # Different canvas sizes — nothing to compare. Resize the larger
        # image to the smaller's size; report the rescale.
        ah, aw = a_rgb.shape[:2]
        bh, bw = b_rgb.shape[:2]
        if (ah, aw) != (bh, bw):
            target = (min(aw, bw), min(ah, bh))
            a_rgb = cv2.resize(a_rgb, target, interpolation=cv2.INTER_AREA)
            b_rgb = cv2.resize(b_rgb, target, interpolation=cv2.INTER_AREA)

    a_grey = to_grey(a_rgb)
    b_grey = to_grey(b_rgb)

    detector = cv2.AKAZE_create()
    kpa, desca = detector.detectAndCompute(a_grey, None)
    kpb, descb = detector.detectAndCompute(b_grey, None)

    if desca is None or descb is None or len(kpa) == 0 or len(kpb) == 0:
        return {
            "n_matches": 0,
            "mean_px": None,
            "p95_px": None,
            "max_px": None,
            "n_keypoints_a": len(kpa) if kpa else 0,
            "n_keypoints_b": len(kpb) if kpb else 0,
        }

    # Cap to avoid an O(N²) match step on dense images.
    if len(kpa) > max_keypoints:
        order = np.argsort([-k.response for k in kpa])[:max_keypoints]
        kpa = [kpa[i] for i in order]
        desca = desca[order]
    if len(kpb) > max_keypoints:
        order = np.argsort([-k.response for k in kpb])[:max_keypoints]
        kpb = [kpb[i] for i in order]
        descb = descb[order]

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    raw = matcher.knnMatch(desca, descb, k=2)
    good = []
    for m_pair in raw:
        if len(m_pair) < 2:
            continue
        m, n = m_pair
        if m.distance < 0.75 * n.distance:
            good.append(m)

    if not good:
        return {
            "n_matches": 0,
            "mean_px": None,
            "p95_px": None,
            "max_px": None,
            "n_keypoints_a": len(kpa),
            "n_keypoints_b": len(kpb),
        }

    diffs = []
    for m in good:
        pa = kpa[m.queryIdx].pt
        pb = kpb[m.trainIdx].pt
        d = ((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2) ** 0.5
        diffs.append(d)
    diffs = np.array(diffs, dtype=np.float64)

    return {
        "n_matches": int(len(diffs)),
        "mean_px": float(np.mean(diffs)),
        "p95_px": float(np.percentile(diffs, 95)),
        "max_px": float(np.max(diffs)),
        "n_keypoints_a": len(kpa),
        "n_keypoints_b": len(kpb),
    }


# -----------------------------------------------------------------------------
# Metric 2 — seam route differences
# -----------------------------------------------------------------------------


def discover_label_pairs(maple_dir: Optional[Path], av_dir: Optional[Path]) -> list[tuple[Path, Path]]:
    """Pair up label PNGs by basename. Returns empty list if either
    directory is missing or empty."""
    if maple_dir is None or av_dir is None:
        return []
    if not maple_dir.is_dir() or not av_dir.is_dir():
        return []
    maple_files = {p.stem: p for p in sorted(maple_dir.glob("*.png"))}
    av_files = {p.stem: p for p in sorted(av_dir.glob("*.png"))}
    common = sorted(set(maple_files.keys()) & set(av_files.keys()))
    return [(maple_files[k], av_files[k]) for k in common]


def label_to_mask(path: Path) -> np.ndarray:
    """Load a label PNG as a binary mask (any non-zero pixel = foreground)."""
    im = Image.open(str(path)).convert("L")
    arr = np.asarray(im, dtype=np.uint8)
    return (arr > 0).astype(np.uint8)


def iou(a: np.ndarray, b: np.ndarray) -> float:
    """Intersection-over-Union of two binary masks (same shape)."""
    if a.shape != b.shape:
        # Resize b to a's shape for a fair comparison; round-trip
        # through uint8 to keep the binary semantic.
        b = cv2.resize(
            b.astype(np.uint8),
            (a.shape[1], a.shape[0]),
            interpolation=cv2.INTER_NEAREST,
        )
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    if union == 0:
        return 1.0  # both empty
    return float(inter) / float(union)


def hausdorff_approx(a: np.ndarray, b: np.ndarray, sample: int = 4000) -> float:
    """Approximate one-directed Hausdorff distance from a to b's
    boundary, in pixels. Samples up to `sample` boundary points from
    a, computes their nearest-distance to b's boundary using a
    distance transform of (1-b). For panoramas this is plenty.

    Returns float('inf') if either mask has no boundary."""
    a_edge = cv2.Canny(a * 255, 50, 150)
    b_edge = cv2.Canny(b * 255, 50, 150)
    if a_edge.sum() == 0 or b_edge.sum() == 0:
        return float("inf")
    # Distance from every pixel to nearest b-edge (in pixels).
    dist = cv2.distanceTransform(255 - b_edge, cv2.DIST_L2, 5)
    ys, xs = np.where(a_edge > 0)
    if len(ys) == 0:
        return float("inf")
    if len(ys) > sample:
        idx = np.random.RandomState(seed=12345).choice(len(ys), sample, replace=False)
        ys = ys[idx]
        xs = xs[idx]
    return float(np.max(dist[ys, xs]))


def seam_route_metrics(
    maple_dir: Optional[Path], av_dir: Optional[Path]
) -> dict[str, Any]:
    pairs = discover_label_pairs(maple_dir, av_dir)
    if not pairs:
        return {
            "available": False,
            "n_pairs": 0,
            "mean_iou": None,
            "mean_hausdorff_px": None,
            "per_pair": [],
        }
    per = []
    ious = []
    hauss = []
    for mp, ap in pairs:
        m = label_to_mask(mp)
        a = label_to_mask(ap)
        i = iou(m, a)
        h = hausdorff_approx(m, a)
        per.append(
            {
                "name": mp.stem,
                "iou": i,
                "hausdorff_px": (None if h == float("inf") else h),
            }
        )
        ious.append(i)
        hauss.append(h)
    finite_h = [h for h in hauss if h != float("inf")]
    return {
        "available": True,
        "n_pairs": len(pairs),
        "mean_iou": float(np.mean(ious)) if ious else None,
        "mean_hausdorff_px": (float(np.mean(finite_h)) if finite_h else None),
        "per_pair": per,
    }


# -----------------------------------------------------------------------------
# Metric 3 — duplicate / ghost-mask area
# -----------------------------------------------------------------------------


def ghost_mask_area(rgb: np.ndarray, threshold: int = 64) -> dict[str, Any]:
    """Estimate the count of "ghosted" pixels — those where the local
    colour gradient is high enough to suggest a misregistered overlay.

    Implementation: compute the gradient magnitude of luma (Sobel ksize
    3), threshold at `threshold` (0–255 scale). This approximates the
    area where the two stitched halves disagree at the seam — the
    classic ghosting signature is a step in luminance.

    For a perfectly aligned panorama, gradient peaks come ONLY from
    real scene content. For a misaligned one, every seam contributes
    a surplus of high-gradient pixels. The metric won't separate
    "real edge" from "ghost" perfectly, but as long as both panoramas
    are compared with the same threshold the relative count is
    informative.
    """
    grey = to_grey(rgb)
    gx = cv2.Sobel(grey, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(grey, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.sqrt(gx * gx + gy * gy)
    mask = (mag > threshold).astype(np.uint8)
    return {
        "high_grad_pixels": int(mask.sum()),
        "total_pixels": int(mask.size),
        "fraction": float(mask.sum()) / float(mask.size),
        "threshold": threshold,
    }


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------


def fmt_optional(v: Any, fmt: str = "{:.3f}") -> str:
    return "n/a" if v is None else fmt.format(v)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("maple", help="Path to the Maple-produced panorama PNG.")
    p.add_argument("alicevision", help="Path to the AliceVision-produced PNG.")
    p.add_argument(
        "--maple-seams",
        type=Path,
        default=None,
        help="Optional directory containing Maple's per-image seam label PNGs.",
    )
    p.add_argument(
        "--av-seams",
        type=Path,
        default=None,
        help="Optional directory containing AliceVision's per-image seam label PNGs.",
    )
    p.add_argument(
        "--max-keypoints",
        type=int,
        default=20000,
        help="Cap AKAZE keypoints per image (default 20000) for the residual metric.",
    )
    p.add_argument(
        "--ghost-threshold",
        type=int,
        default=64,
        help="Sobel-gradient threshold (0–255) for the ghost-mask metric.",
    )
    p.add_argument(
        "--json-out",
        type=Path,
        default=None,
        help="Write the full metrics JSON here (in addition to the stdout table).",
    )
    args = p.parse_args()

    maple_path = Path(args.maple)
    av_path = Path(args.alicevision)
    if not maple_path.is_file():
        print(f"ERROR: Maple panorama not found: {maple_path}", file=sys.stderr)
        return 2
    if not av_path.is_file():
        print(f"ERROR: AliceVision panorama not found: {av_path}", file=sys.stderr)
        return 2

    print(f"loading {maple_path}")
    maple_rgb = load_rgb(maple_path)
    print(f"  shape: {maple_rgb.shape}")
    print(f"loading {av_path}")
    av_rgb = load_rgb(av_path)
    print(f"  shape: {av_rgb.shape}")

    print()
    print("computing metric 1: keypoint residuals after warp")
    kp = keypoint_residuals(maple_rgb, av_rgb, max_keypoints=args.max_keypoints)

    print("computing metric 2: seam route differences")
    seams = seam_route_metrics(args.maple_seams, args.av_seams)

    print("computing metric 3: ghost-mask area")
    maple_ghost = ghost_mask_area(maple_rgb, threshold=args.ghost_threshold)
    av_ghost = ghost_mask_area(av_rgb, threshold=args.ghost_threshold)

    out = {
        "inputs": {
            "maple": str(maple_path),
            "alicevision": str(av_path),
        },
        "keypoint_residuals": kp,
        "seam_routes": seams,
        "ghost_masks": {
            "maple": maple_ghost,
            "alicevision": av_ghost,
        },
    }

    print()
    print("=" * 70)
    print(" Metric                                Maple              AliceVision")
    print("-" * 70)
    print(
        f" Keypoint residual mean (px)           "
        f"{'(disagreement: ' + fmt_optional(kp.get('mean_px'), '{:.2f}') + ')':<20} "
    )
    print(
        f" Keypoint residual p95 (px)            "
        f"{'(disagreement: ' + fmt_optional(kp.get('p95_px'), '{:.2f}') + ')':<20} "
    )
    print(f" Keypoint matches                      {kp.get('n_matches', 0)}")
    print()
    if seams.get("available"):
        print(
            f" Seam IoU (mean over {seams['n_pairs']} pairs)             "
            f"{fmt_optional(seams.get('mean_iou'), '{:.3f}')}"
        )
        print(
            f" Seam Hausdorff (px, mean)             "
            f"{fmt_optional(seams.get('mean_hausdorff_px'), '{:.1f}')}"
        )
    else:
        print(" Seam routes:                         (label dirs not provided)")
    print()
    print(
        f" Ghost-mask high-grad pixels            "
        f"{maple_ghost['high_grad_pixels']:>14,}     "
        f"{av_ghost['high_grad_pixels']:>14,}"
    )
    print(
        f"   fraction of total                     "
        f"{maple_ghost['fraction']:.4f}              "
        f"{av_ghost['fraction']:.4f}"
    )
    print("=" * 70)

    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(out, indent=2))
        print(f"wrote {args.json_out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
