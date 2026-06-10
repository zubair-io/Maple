#!/usr/bin/env python3
"""Pano stitching metrics: candidate panorama vs reference (+ optional report).

This is the ONE pano diff implementation (Maple Pano M0b, #1120).
`test_pano_pipeline.sh` imports `diff()` in-process for the per-set gates and
invokes `--self-test` as its always-on validation; the standalone CLI below
wraps the same code. Dependencies: numpy + Pillow only (a subset of
compare_images.py's deps; no new packages).

Usage:
    pano_metrics.py --candidate cand.png --reference ref.png
        [--report stitch_report.json] [--long-edge 2048] [--seam-percentile P]
    pano_metrics.py --self-test [--fixture-root path/to/test-fixtures]

Output (stdout, single-line JSON):
    { "rmse": float, "rmse_r"/"rmse_g"/"rmse_b": float,
      "seam_energy": float, "seam_excess_percentile": float,
      "wrap_closure_px": float | null, "wrap_closure_ncc": float,
      "candidate_size"/"reference_size"/"normalized_size": [w, h],
      "size_mismatch": bool, "n_pixels": int,
      "report": {"available": bool, ...} }

Metric definitions (v1)
-----------------------
Size-normalized RMSE
    Both images are downscaled (Lanczos) so their long edge equals
    --long-edge (default 2048) BEFORE differencing; images already at or
    below that size are left at native resolution (no upscaling). A candidate
    whose normalized dimensions still differ from the reference's (canvas
    sizing / crop differences) is then resized to the reference's normalized
    W x H so the grids align — `size_mismatch` records that this happened.
    RMSE = sqrt(mean((cand - ref)^2)) over all pixels and channels, pixel
    values in [0, 1]. Images are compared in their on-disk encoding; both
    sides share it, so the encoding cancels. rmse_r/g/b are the per-channel
    variants on the same grids.
Seam-line gradient energy (v1)
    Detects gradient structure present in the candidate but absent at the
    same location in the reference — visible stitch seams, exposure steps and
    misalignment edges create exactly that. On the normalized grids:
        L_c, L_r    = Rec.709 luma of candidate / reference
        G_c, G_r    = |grad L| via np.gradient (central differences)
        excess      = max(G_c - G_r, 0)         elementwise
        tau         = percentile(excess, P)     P = --seam-percentile (99.5)
        seam_energy = sum(excess[excess >= tau]) / n_pixels
    Summing only the >= tau outliers focuses the metric on sparse, localized
    seam lines rather than broad texture differences. When fewer than
    (100 - P)% of pixels carry any excess, tau degenerates to 0 and the sum
    covers all excess — by design (true seam lines are sparse; an identical
    pair still yields exactly 0.0).
360-degree wrap-edge closure error
    A property of the CANDIDATE alone, computed at native resolution: in an
    equirect/cylindrical 360-degree pano the left and right edge columns
    depict adjacent scene content, so vertical drift accumulated around the
    loop appears as a vertical offset between the two edges. We take the
    mean luma of a strip of edge columns on each side, zero-normalized
    cross-correlate the two 1-D signals over integer vertical shifts
    (+/- max(8, H/10), capped so the overlap stays >= H/2), refine the peak
    with a 3-point parabolic fit, and report |best_shift| in native canvas
    px plus the peak NCC. For non-360 output the two edges are unrelated
    scene content and the peak NCC is low — the value is still reported;
    per-set budgets decide whether it gates (only 360 sets should carry a
    wrap_closure_px budget). Degenerate edges (near-zero variance) yield
    wrap_closure_px = null with note "degenerate-edges".
StitchReport passthrough
    With --report, mean/max reprojection error (px) and horizon tilt (deg)
    are read from the StitchReport JSON written by `maple-cli pano stitch`
    (tech-spec section 6 keys: mean_reproj_error_px, max_reproj_error_px,
    horizon_tilt_deg). Keys absent from the report come back as null and are
    listed in "missing_keys". Without --report the block is
    {"available": false, "reason": "unavailable: no report"} — never
    fabricated.
Self-test (--self-test)
    (a) reference vs itself           -> rmse ~ 0 and seam_energy ~ 0
    (b) reference vs perturbed copy   -> clearly non-zero rmse + seam_energy
        (perturbation = np.roll shift + brightness step on the right half)
    (c) wrap-closure shift recovery on a procedural wrap-consistent image:
        rolling the right half vertically by 5 px must be detected within
        1.5 px; the unperturbed image must close within 1.5 px. Always runs
        on the procedural image (real fixture edges may be low-texture).
    (a)/(b) use test-fixtures/references/pano_01/pano_01.png when present
    (downscaled to long edge 1024 first to bound memory), otherwise the
    procedural image — the self-test always runs.
Exit code 0 on success, 1 on self-test failure, 2 on usage / IO error.
"""

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

# Pano canvases (e.g. the 18189x6464 pano_01 reference) trip Pillow's
# decompression-bomb heuristic; they're our ground truth — suppress.
Image.MAX_IMAGE_PIXELS = None

DEFAULT_LONG_EDGE = 2048
DEFAULT_SEAM_PERCENTILE = 99.5
EDGE_STRIP_PX = 8
SELF_TEST_LONG_EDGE = 1024
_LUMA = (0.2126, 0.7152, 0.0722)  # Rec.709


def _luma(rgb: np.ndarray) -> np.ndarray:
    return _LUMA[0] * rgb[..., 0] + _LUMA[1] * rgb[..., 1] + _LUMA[2] * rgb[..., 2]


def _grad_mag(luma: np.ndarray) -> np.ndarray:
    gy, gx = np.gradient(luma)
    return np.hypot(gx, gy)


def _normalize(im: Image.Image, long_edge: int) -> Image.Image:
    """Downscale so the long edge equals `long_edge`; never upscale."""
    w, h = im.size
    scale = long_edge / max(w, h)
    if scale >= 1.0:
        return im
    return im.resize((max(1, round(w * scale)), max(1, round(h * scale))),
                     Image.LANCZOS)


def seam_energy(cand: np.ndarray, ref: np.ndarray,
                percentile: float = DEFAULT_SEAM_PERCENTILE) -> float:
    """Seam-line gradient-energy metric — exact formula in the module doc."""
    excess = np.maximum(_grad_mag(_luma(cand)) - _grad_mag(_luma(ref)), 0.0)
    tau = np.percentile(excess, percentile)
    return float(excess[excess >= tau].sum() / excess.size)


def wrap_closure(im: Image.Image, strip_px: int = EDGE_STRIP_PX) -> dict:
    """360 wrap-edge closure of `im` — exact definition in the module doc."""
    w, h = im.size
    strip = max(2, min(strip_px, w // 4))
    left = np.asarray(im.crop((0, 0, strip, h)).convert("L"),
                      dtype=np.float32) / 255.0
    right = np.asarray(im.crop((w - strip, 0, w, h)).convert("L"),
                       dtype=np.float32) / 255.0
    sig_l = left.mean(axis=1)
    sig_r = right.mean(axis=1)
    if float(sig_l.std()) < 1e-6 or float(sig_r.std()) < 1e-6:
        return {"px": None, "ncc": 0.0, "note": "degenerate-edges"}

    max_shift = max(8, min(h // 10, h // 2 - 1))
    shifts = np.arange(-max_shift, max_shift + 1)
    nccs = np.empty(shifts.shape[0], dtype=np.float64)
    for idx, s in enumerate(shifts):
        lo, hi = max(0, s), min(h, h + s)  # pairs (i, i - s), both in range
        a = sig_l[lo:hi]
        b = sig_r[lo - s:hi - s]
        a0 = a - a.mean()
        b0 = b - b.mean()
        denom = float(np.sqrt((a0 * a0).sum() * (b0 * b0).sum()))
        nccs[idx] = float((a0 * b0).sum() / denom) if denom > 1e-12 else 0.0

    k = int(np.argmax(nccs))
    best = float(shifts[k])
    # 3-point parabolic sub-pixel refinement around the discrete peak.
    if 0 < k < len(shifts) - 1:
        y0, y1, y2 = nccs[k - 1], nccs[k], nccs[k + 1]
        denom = y0 - 2.0 * y1 + y2
        if abs(denom) > 1e-12:
            best += 0.5 * float((y0 - y2) / denom)
    return {"px": abs(best), "ncc": float(nccs[k]), "note": None}


def report_block(report_path) -> dict:
    """StitchReport passthrough — never fabricates values."""
    if not report_path:
        return {"available": False, "reason": "unavailable: no report"}
    with open(report_path) as f:
        data = json.load(f)
    out = {"available": True}
    missing = []
    for src_key, out_key in (("mean_reproj_error_px", "mean_reproj_px"),
                             ("max_reproj_error_px", "max_reproj_px"),
                             ("horizon_tilt_deg", "horizon_tilt_deg")):
        if src_key in data and data[src_key] is not None:
            out[out_key] = float(data[src_key])
        else:
            out[out_key] = None
            missing.append(src_key)
    if missing:
        out["missing_keys"] = missing
    return out


def _metrics_from_images(cand_im: Image.Image, ref_im: Image.Image, *,
                         report_path=None, long_edge: int = DEFAULT_LONG_EDGE,
                         seam_percentile: float = DEFAULT_SEAM_PERCENTILE,
                         edge_strip: int = EDGE_STRIP_PX) -> dict:
    cand_im = cand_im.convert("RGB")
    ref_im = ref_im.convert("RGB")
    cand_size, ref_size = cand_im.size, ref_im.size

    # Wrap closure is measured on the candidate at NATIVE resolution so the
    # budget gate ("<= N px at canvas scale") keeps its meaning.
    wrap = wrap_closure(cand_im, strip_px=edge_strip)

    cand_n = _normalize(cand_im, long_edge)
    ref_n = _normalize(ref_im, long_edge)
    size_mismatch = cand_n.size != ref_n.size
    if size_mismatch:
        cand_n = cand_n.resize(ref_n.size, Image.LANCZOS)

    cand = np.asarray(cand_n, dtype=np.float32) / 255.0
    ref = np.asarray(ref_n, dtype=np.float32) / 255.0

    sq = (cand - ref) ** 2
    per_channel = np.sqrt(sq.mean(axis=(0, 1)))

    return {
        "rmse": float(np.sqrt(sq.mean())),
        "rmse_r": float(per_channel[0]),
        "rmse_g": float(per_channel[1]),
        "rmse_b": float(per_channel[2]),
        "seam_energy": seam_energy(cand, ref, seam_percentile),
        "seam_excess_percentile": float(seam_percentile),
        "wrap_closure_px": wrap["px"],
        "wrap_closure_ncc": wrap["ncc"],
        **({"wrap_closure_note": wrap["note"]} if wrap["note"] else {}),
        "candidate_size": list(cand_size),
        "reference_size": list(ref_size),
        "normalized_size": list(ref_n.size),
        "size_mismatch": bool(size_mismatch),
        "n_pixels": int(ref.shape[0] * ref.shape[1]),
        "report": report_block(report_path),
    }


def diff(cand_path: str, ref_path: str, *, report_path=None,
         long_edge: int = DEFAULT_LONG_EDGE,
         seam_percentile: float = DEFAULT_SEAM_PERCENTILE,
         edge_strip: int = EDGE_STRIP_PX) -> dict:
    """Full metric set for a candidate/reference pair. See module doc."""
    with Image.open(cand_path) as cand_im, Image.open(ref_path) as ref_im:
        return _metrics_from_images(
            cand_im, ref_im, report_path=report_path, long_edge=long_edge,
            seam_percentile=seam_percentile, edge_strip=edge_strip)


# --------------------------------------------------------------------------
# Self-test
# --------------------------------------------------------------------------

def _procedural_image(w: int = 1200, h: int = 420, seed: int = 7) -> np.ndarray:
    """Deterministic structured RGB image in [0,1], HxWx3, with horizontally
    wrap-consistent edges (rightmost 2*EDGE_STRIP_PX columns copy the
    leftmost) so the wrap-closure check has correlated edges like a real
    360-degree pano."""
    rng = np.random.default_rng(seed)

    def octave(div: int) -> np.ndarray:
        small = (rng.random((max(2, h // div), max(2, w // div))) * 255)
        im = Image.fromarray(small.astype(np.uint8)).resize((w, h),
                                                            Image.BICUBIC)
        return np.asarray(im, dtype=np.float32) / 255.0

    base = 0.6 * octave(16) + 0.3 * octave(4) + 0.1 * octave(2)
    yy = np.linspace(0.0, 0.15, h, dtype=np.float32)[:, None]
    base = np.clip(0.1 + 0.75 * base + yy, 0.0, 1.0)
    rgb = np.stack([base,
                    np.roll(base, 11, axis=1),
                    np.roll(base, -7, axis=1)], axis=-1)
    wrap_w = 2 * EDGE_STRIP_PX
    rgb[:, -wrap_w:, :] = rgb[:, :wrap_w, :]
    return rgb.astype(np.float32)


def _to_image(arr: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(arr, 0.0, 1.0) * 255.0 + 0.5)
                           .astype(np.uint8), mode="RGB")


def self_test(fixture_root=None) -> int:
    if fixture_root is None:
        fixture_root = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "..",
            "test-fixtures")
    ref_png = os.path.join(fixture_root, "references", "pano_01",
                           "pano_01.png")

    if os.path.exists(ref_png):
        source = f"fixture:{ref_png}"
        with Image.open(ref_png) as im:
            base_im = _normalize(im.convert("RGB"), SELF_TEST_LONG_EDGE)
        base = np.asarray(base_im, dtype=np.float32) / 255.0
    else:
        source = "procedural (fixture reference not present)"
        base = _procedural_image()
        base_im = _to_image(base)

    h, w = base.shape[0], base.shape[1]
    checks = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        print(f"  {'PASS' if ok else 'FAIL'} {name}: {detail}",
              file=sys.stderr)

    print(f"pano_metrics self-test — source: {source} ({w}x{h})",
          file=sys.stderr)

    # (a) reference vs itself: ~zero RMSE / seam energy.
    m_same = _metrics_from_images(base_im, base_im,
                                  long_edge=SELF_TEST_LONG_EDGE)
    check("identical-rmse", m_same["rmse"] < 1e-9,
          f"rmse={m_same['rmse']:.3e} (< 1e-9)")
    check("identical-seam-energy", m_same["seam_energy"] < 1e-12,
          f"seam_energy={m_same['seam_energy']:.3e} (< 1e-12)")

    # (b) reference vs perturbed copy: clearly non-zero values.
    pert = np.roll(base, shift=(4, 7), axis=(0, 1))
    pert[:, w // 2:, :] = np.clip(pert[:, w // 2:, :] + 0.15, 0.0, 1.0)
    m_pert = _metrics_from_images(_to_image(pert), base_im,
                                  long_edge=SELF_TEST_LONG_EDGE)
    check("perturbed-rmse", m_pert["rmse"] > 0.01,
          f"rmse={m_pert['rmse']:.4f} (> 0.01)")
    check("perturbed-seam-energy", m_pert["seam_energy"] > 1e-7,
          f"seam_energy={m_pert['seam_energy']:.3e} (> 1e-7)")

    # (c) wrap-closure shift recovery — always on the procedural image,
    # whose edges are wrap-consistent by construction.
    proc = _procedural_image()
    ph, pw = proc.shape[0], proc.shape[1]
    m_closed = _metrics_from_images(_to_image(proc), _to_image(proc),
                                    long_edge=SELF_TEST_LONG_EDGE)
    closed_px = m_closed["wrap_closure_px"]
    check("wrap-closed",
          closed_px is not None and closed_px <= 1.5,
          f"wrap_closure_px={closed_px} (<= 1.5, "
          f"ncc={m_closed['wrap_closure_ncc']:.3f})")

    sheared = proc.copy()
    sheared[:, pw // 2:, :] = np.roll(sheared[:, pw // 2:, :], 5, axis=0)
    m_shear = _metrics_from_images(_to_image(sheared), _to_image(proc),
                                   long_edge=SELF_TEST_LONG_EDGE)
    shear_px = m_shear["wrap_closure_px"]
    check("wrap-shift-recovery",
          shear_px is not None and abs(shear_px - 5.0) <= 1.5,
          f"wrap_closure_px={shear_px} (expected 5 +/- 1.5, "
          f"ncc={m_shear['wrap_closure_ncc']:.3f})")

    # Report passthrough contract: absent report must say so, not fake.
    rb = report_block(None)
    check("report-unavailable",
          rb == {"available": False, "reason": "unavailable: no report"},
          f"report_block(None)={rb}")

    ok = all(c["ok"] for c in checks)
    print(json.dumps({"self_test": "pass" if ok else "fail",
                      "source": source, "checks": checks}))
    return 0 if ok else 1


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(
        description="Maple Pano stitch metrics (see module docstring).")
    p.add_argument("--candidate", help="candidate panorama image")
    p.add_argument("--reference", help="reference panorama image")
    p.add_argument("--report", help="StitchReport JSON from maple-cli pano "
                                    "stitch (optional)")
    p.add_argument("--long-edge", type=int, default=DEFAULT_LONG_EDGE,
                   help="common long edge for size-normalized metrics "
                        f"(default {DEFAULT_LONG_EDGE})")
    p.add_argument("--seam-percentile", type=float,
                   default=DEFAULT_SEAM_PERCENTILE,
                   help="outlier percentile for the seam-energy metric "
                        f"(default {DEFAULT_SEAM_PERCENTILE})")
    p.add_argument("--self-test", action="store_true",
                   help="run the built-in validation and exit")
    p.add_argument("--fixture-root",
                   help="test-fixtures root for --self-test (default: "
                        "resolved relative to this script)")
    args = p.parse_args()

    if args.self_test:
        return self_test(args.fixture_root)

    if not args.candidate or not args.reference:
        p.error("--candidate and --reference are required "
                "(or use --self-test)")
    try:
        out = diff(args.candidate, args.reference, report_path=args.report,
                   long_edge=args.long_edge,
                   seam_percentile=args.seam_percentile)
    except Exception as e:  # noqa: BLE001 — CLI surfaces error as JSON
        print(json.dumps({"error": str(e)}))
        return 2
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
