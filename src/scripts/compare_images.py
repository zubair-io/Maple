#!/usr/bin/env python3
"""Compare two sRGB PNG images: CIEDE2000 + per-channel bias, optionally with
per-tonal-zone and per-hue-angle breakdowns.

This is the ONE diff implementation. `test_color_pipeline.sh` imports `diff()`
in-process; the standalone CLI below wraps it.

Usage:
    compare_images.py <candidate.png> <reference.png> [--zones] [--hue-bins N]
                       [--source-primaries {srgb,p3}] [--roi mask.png]
    compare_images.py --self-test

Output (stdout, single-line JSON), global block always present:
    {
      "mean_deltaE": float, "p95_deltaE": float, "max_deltaE": float,
      "bias_r": float, "bias_g": float, "bias_b": float, "n_pixels": int
    }
With --zones, adds "zones": {shadow|mid|highlight: {n, mean_deltaE, p95_deltaE,
max_deltaE, bias_r, bias_g, bias_b}} keyed on the REFERENCE's L*.
With --hue-bins N, adds "hue_bins": {"neutral": {...}, "bins": [{bin_deg, n,
mean_deltaE, a_shift, b_shift}, ...]} keyed on the REFERENCE's Lab hue angle;
low-chroma pixels (C* < NEUTRAL_CHROMA) go to the neutral bucket.

`--source-primaries p3` (#1339, P3 phase 3) declares the CANDIDATE was
rendered with Display P3 primaries (`maple-cli render --target-primaries
p3`) rather than sRGB. ACR references stay sRGB — there is no separate P3
reference set (the rotation is exact, not perceptual, so nothing is lost
converting through it) — so the candidate is rotated P3 -> sRGB primaries
before the diff runs, same references, same metric, same budgets. Default
`srgb` is a no-op: existing callers see byte-identical behaviour.

`--roi mask.png` (#3278) restricts every statistic — including zones/hue
bins — to pixels where a grayscale mask (resized nearest-neighbour to the
reference's dims) exceeds 127/255. `n_pixels` then reports the ROI's pixel
count, not the frame's. Omitted (default) is a no-op over the whole frame.

Exit code 0 on success, non-zero on any error.
"""

import argparse
import json
import os
import sys
import tempfile
from typing import Optional

import numpy as np
from PIL import Image
import colour

# 4000x2667 (down) and 12288x8192 (full) ACR refs trip Pillow's
# decompression-bomb heuristic. They're our ground truth; suppress.
Image.MAX_IMAGE_PIXELS = None

# L*-based tonal zones (perceptual; matches the Lab space ΔE lives in).
ZONE_NAMES = ("shadow", "mid", "highlight")
ZONE_EDGES = (0.0, 33.3, 66.6, 100.001)
NEUTRAL_CHROMA = 5.0  # C* below this -> hue is ill-defined, goes to neutral bucket

# Linear sRGB -> linear Display P3 (SMPTE RP 431-2, D65 white point), copied
# from `raw-core/src/color/matrices.rs::M_SRGB_TO_P3` so the harness inverts
# the EXACT matrix the pipeline's own `rec2020_to_display` rotation uses —
# not colour-science's independently-derived equivalent, which agrees to
# ~1e-4 but would make the comparator's own rotation a second, slightly
# different implementation of the thing it's supposed to be checking.
M_SRGB_TO_P3 = np.array([
    [0.8224620, 0.1775380, 0.0],
    [0.0331942, 0.9668058, 0.0],
    [0.0170826, 0.0723974, 0.9105199],
])
M_P3_TO_SRGB = np.linalg.inv(M_SRGB_TO_P3)


def p3_to_srgb_primaries(encoded: np.ndarray) -> np.ndarray:
    """Rotate a Display-P3-primaries, sRGB-gamma-encoded image (what
    `maple-cli render --target-primaries p3` writes — Maple's P3 output
    shares sRGB's OETF, IEC 61966-2-1, per `ColorSpace::DisplayLinearP3`'s
    docs) into sRGB primaries, same encoding. `pixels_srgb = M_P3->sRGB *
    pixels_p3`, applied in LINEAR light: decode the gamma, rotate, re-encode.
    Out-of-[0,1] linear values (P3 can represent saturated colours sRGB
    can't) are clipped after rotation, same as an 8-bit sRGB file would
    have to.
    """
    linear_p3 = colour.cctf_decoding(np.clip(encoded, 0.0, 1.0), function="sRGB")
    linear_srgb = np.clip(linear_p3 @ M_P3_TO_SRGB.T, 0.0, None)
    return np.clip(colour.cctf_encoding(linear_srgb, function="sRGB"), 0.0, 1.0)


def _lab(srgb: np.ndarray) -> np.ndarray:
    return colour.XYZ_to_Lab(colour.sRGB_to_XYZ(srgb))


def _zone_stats(dE, ref_lab, cand, ref, roi: Optional[np.ndarray] = None) -> dict:
    L = ref_lab[..., 0].ravel()
    dEf = dE.ravel()
    cf = cand.reshape(-1, 3)
    rf = ref.reshape(-1, 3)
    zones = {}
    for name, lo, hi in zip(ZONE_NAMES, ZONE_EDGES[:-1], ZONE_EDGES[1:]):
        m = (L >= lo) & (L < hi)
        if roi is not None:
            m = m & roi.ravel()
        n = int(m.sum())
        if n == 0:
            zones[name] = {"n": 0}
            continue
        b = (cf[m] - rf[m]).mean(axis=0)
        zones[name] = {
            "n": n,
            "mean_deltaE": float(dEf[m].mean()),
            "p95_deltaE": float(np.percentile(dEf[m], 95)),
            "max_deltaE": float(dEf[m].max()),
            "bias_r": float(b[0]), "bias_g": float(b[1]), "bias_b": float(b[2]),
        }
    return zones


def _hue_stats(dE, cand_lab, ref_lab, n_bins: int, roi: Optional[np.ndarray] = None) -> dict:
    a = ref_lab[..., 1].ravel()
    b = ref_lab[..., 2].ravel()
    C = np.hypot(a, b)
    dEf = dE.ravel()
    da = (cand_lab[..., 1] - ref_lab[..., 1]).ravel()
    db = (cand_lab[..., 2] - ref_lab[..., 2]).ravel()

    neu = C < NEUTRAL_CHROMA
    if roi is not None:
        # ROI restricts BOTH the neutral bucket and every chromatic hue bin
        # below (`diff()`'s own contract) — not just the per-bin `m`, or the
        # neutral bucket would silently count pixels outside the ROI.
        neu = neu & roi.ravel()
    if neu.any():
        neutral = {"n": int(neu.sum()), "mean_deltaE": float(dEf[neu].mean()),
                   "a_shift": float(da[neu].mean()), "b_shift": float(db[neu].mean())}
    else:
        neutral = {"n": 0}

    hue = np.degrees(np.arctan2(b, a)) % 360.0
    width = 360.0 / n_bins
    chromatic = ~neu
    if roi is not None:
        chromatic = chromatic & roi.ravel()
    bins = []
    for i in range(n_bins):
        lo, hi = i * width, (i + 1) * width
        m = chromatic & (hue >= lo) & (hue < hi)
        n = int(m.sum())
        if n == 0:
            bins.append({"bin_deg": [round(lo, 1), round(hi, 1)], "n": 0})
            continue
        bins.append({
            "bin_deg": [round(lo, 1), round(hi, 1)], "n": n,
            "mean_deltaE": float(dEf[m].mean()),
            "a_shift": float(da[m].mean()), "b_shift": float(db[m].mean()),
        })
    return {"neutral": neutral, "bins": bins}


def diff(cand_path: str, ref_path: str, *, zones: bool = False,
         hue_bins: int = 0, source_primaries: str = "srgb",
         roi_path: Optional[str] = None) -> dict:
    """ΔE2000 + per-channel bias of candidate vs reference, optionally with
    per-tonal-zone and per-hue-angle breakdowns. Candidate is Lanczos-resized
    to the reference dims. All binning is on the reference's Lab.

    `source_primaries="p3"` rotates the candidate P3 -> sRGB primaries
    (see `p3_to_srgb_primaries`) before anything else runs, so every
    downstream computation — resize, Lab, ΔE, bias, zones, hue bins — sees
    an sRGB-primaries candidate exactly as it would for a plain sRGB
    render. `"srgb"` (default) is a no-op.

    `roi_path`, when set, is a grayscale PNG resized (nearest-neighbour) to
    the reference's dims; every statistic below is computed only over
    pixels where the resized mask exceeds 127/255. `n_pixels` reports the
    ROI's pixel count. Zones/hue-bins (if requested) are ALSO restricted to
    the ROI — a shadow-zone stat with the ROI on means "shadow pixels
    inside the ROI," not "shadow pixels in the whole frame."
    """
    if source_primaries not in ("srgb", "p3"):
        raise ValueError(f"source_primaries must be 'srgb' or 'p3', got {source_primaries!r}")
    ref_im = Image.open(ref_path).convert("RGB")
    cand_im = Image.open(cand_path).convert("RGB")
    if cand_im.size != ref_im.size:
        cand_im = cand_im.resize(ref_im.size, Image.LANCZOS)
    cand = np.asarray(cand_im, dtype=np.float32) / 255.0
    ref = np.asarray(ref_im, dtype=np.float32) / 255.0
    if source_primaries == "p3":
        cand = p3_to_srgb_primaries(cand)

    roi_mask: Optional[np.ndarray] = None
    if roi_path is not None:
        roi_im = Image.open(roi_path).convert("L")
        if roi_im.size != ref_im.size:
            roi_im = roi_im.resize(ref_im.size, Image.NEAREST)
        roi_mask = np.asarray(roi_im, dtype=np.uint8) > 127
        if not roi_mask.any():
            raise ValueError(f"ROI {roi_path!r} selects zero pixels at the reference's size")

    cand_lab = _lab(cand)
    ref_lab = _lab(ref)
    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")

    if roi_mask is not None:
        dE_flat = dE[roi_mask]
        bias = (cand[roi_mask] - ref[roi_mask]).mean(axis=0)
        n_pixels = int(roi_mask.sum())
    else:
        dE_flat = dE.ravel()
        bias = (cand - ref).mean(axis=(0, 1))
        n_pixels = int(cand.shape[0] * cand.shape[1])

    out = {
        "mean_deltaE": float(np.mean(dE_flat)),
        "p95_deltaE": float(np.percentile(dE_flat, 95)),
        "max_deltaE": float(np.max(dE_flat)),
        "bias_r": float(bias[0]), "bias_g": float(bias[1]), "bias_b": float(bias[2]),
        "n_pixels": n_pixels,
    }
    if zones:
        out["zones"] = _zone_stats(dE, ref_lab, cand, ref, roi=roi_mask)
    if hue_bins:
        out["hue_bins"] = _hue_stats(dE, cand_lab, ref_lab, hue_bins, roi=roi_mask)
    return out


def _srgb_to_p3_primaries(encoded: np.ndarray) -> np.ndarray:
    """Forward sibling of `p3_to_srgb_primaries`, used only by `--self-test`
    to synthesize a P3-encoded fixture from known sRGB values — the same
    direction `rec2020_to_display(TargetPrimaries::P3)` rotates in."""
    linear_srgb = colour.cctf_decoding(np.clip(encoded, 0.0, 1.0), function="sRGB")
    linear_p3 = np.clip(linear_srgb @ M_SRGB_TO_P3.T, 0.0, None)
    return np.clip(colour.cctf_encoding(linear_p3, function="sRGB"), 0.0, 1.0)


def _self_test() -> int:
    """No fixtures, no files: proves the P3 rotation this comparator adds
    (#1339) is a true inverse of the pipeline's own forward rotation, so a
    `--source-primaries p3` diff measures real pipeline error, not
    round-trip noise the comparator introduced itself.
    """
    failures = []

    def check(name: str, cond: bool):
        if not cond:
            failures.append(name)

    # 1. The two matrices are true inverses (not just "close" — a future
    #    edit to either constant that breaks this would silently corrupt
    #    every P3 comparison).
    identity_check = M_SRGB_TO_P3 @ M_P3_TO_SRGB
    check("matrices are inverses", np.allclose(identity_check, np.eye(3), atol=1e-9))

    # 2. White is invariant (both primaries share the D65 white point) —
    #    exact, not approximate, per `M_SRGB_TO_P3`'s own doc comment.
    white = np.ones((1, 1, 3), dtype=np.float64)
    check("white round-trips exactly",
          np.allclose(p3_to_srgb_primaries(_srgb_to_p3_primaries(white)), white, atol=1e-6))

    # 3. A gradient of in-P3-gamut colours round-trips sRGB -> P3 -> sRGB
    #    within tight numerical tolerance (float64 gamma round-trip noise
    #    only, no clipping should engage for values already inside sRGB's
    #    narrower gamut).
    rng = np.random.default_rng(1339)
    patch = rng.uniform(0.05, 0.95, size=(8, 8, 3)).astype(np.float64)
    roundtrip = p3_to_srgb_primaries(_srgb_to_p3_primaries(patch))
    max_err = float(np.max(np.abs(roundtrip - patch)))
    check(f"in-gamut round-trip within 1e-4 (max err {max_err:.2e})", max_err < 1e-4)

    # 4. A saturated, P3-only primary (pure P3 green: outside sRGB's
    #    gamut) must clip into [0,1] rather than go negative or NaN — the
    #    real-world case the clipping in `p3_to_srgb_primaries` exists for.
    p3_green = np.array([[[0.0, 1.0, 0.0]]], dtype=np.float64)
    rotated = p3_to_srgb_primaries(p3_green)
    check("out-of-gamut P3 primary clips into [0,1], no NaN",
          bool(np.all(np.isfinite(rotated)) and np.all(rotated >= 0.0) and np.all(rotated <= 1.0)))

    # 5. End-to-end through the real `diff()` entry (the code path
    #    `maple-cli diff --source-primaries p3` and `test_color_pipeline.sh`
    #    actually call): a reference PNG and a candidate PNG that is the
    #    SAME image forward-rotated to P3 primaries must diff near-zero
    #    once `source_primaries="p3"` rotates the candidate back — proving
    #    the rotation is wired into `diff()`, not just correct in isolation.
    with tempfile.TemporaryDirectory(prefix="compare_images_selftest_") as tmp:
        ref_path = os.path.join(tmp, "ref.png")
        cand_path = os.path.join(tmp, "cand_p3.png")
        base = rng.uniform(0.1, 0.9, size=(32, 32, 3))
        Image.fromarray((base * 255).round().astype(np.uint8), "RGB").save(ref_path)
        p3_bytes = _srgb_to_p3_primaries(base)
        Image.fromarray((p3_bytes * 255).round().astype(np.uint8), "RGB").save(cand_path)
        result = diff(cand_path, ref_path, source_primaries="p3")
        check(f"diff(source_primaries='p3') mean ΔE00 < 0.5 "
              f"(got {result['mean_deltaE']:.4f})", result["mean_deltaE"] < 0.5)
        result_unrotated = diff(cand_path, ref_path, source_primaries="srgb")
        check(f"same pair WITHOUT rotation reads much worse "
              f"(rotated {result['mean_deltaE']:.4f} vs unrotated "
              f"{result_unrotated['mean_deltaE']:.4f})",
              result_unrotated["mean_deltaE"] > result["mean_deltaE"] + 1.0)

    # 6. An ROI restricted to the left half of a two-tone image reports
    #    statistics computed ONLY over that half — proving the mask actually
    #    gates which pixels enter the metric, not just that it's accepted.
    with tempfile.TemporaryDirectory(prefix="compare_images_selftest_roi_") as tmp:
        ref_path = os.path.join(tmp, "ref.png")
        cand_path = os.path.join(tmp, "cand.png")
        roi_path = os.path.join(tmp, "roi.png")
        h, w = 16, 16
        ref_arr = np.zeros((h, w, 3), dtype=np.uint8)
        ref_arr[:, :w // 2] = [200, 50, 50]   # left half: red-ish
        ref_arr[:, w // 2:] = [50, 50, 200]   # right half: blue-ish
        cand_arr = ref_arr.copy()
        cand_arr[:, :w // 2] = [50, 50, 200]  # left half is WRONG (big ΔE)
        # right half matches — so an ROI over the right half alone should
        # report near-zero error even though the whole-frame diff is large.
        Image.fromarray(ref_arr, "RGB").save(ref_path)
        Image.fromarray(cand_arr, "RGB").save(cand_path)
        roi_arr = np.zeros((h, w), dtype=np.uint8)
        roi_arr[:, w // 2:] = 255
        Image.fromarray(roi_arr, "L").save(roi_path)

        whole = diff(cand_path, ref_path)
        roi = diff(cand_path, ref_path, roi_path=roi_path)
        check(f"whole-frame diff is large (got {whole['mean_deltaE']:.2f})", whole["mean_deltaE"] > 15)
        check(f"ROI-restricted diff is near zero (got {roi['mean_deltaE']:.2f})", roi["mean_deltaE"] < 1.0)
        check(f"ROI n_pixels is half the frame (got {roi['n_pixels']}, want {h * w // 2})",
              roi["n_pixels"] == h * w // 2)

    if failures:
        print(f"compare_images.py self-test: FAIL ({len(failures)}): {', '.join(failures)}")
        return 1
    print("compare_images.py self-test: PASS (6 checks)")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("candidate", nargs="?")
    p.add_argument("reference", nargs="?")
    p.add_argument("--zones", action="store_true")
    p.add_argument("--hue-bins", type=int, default=0)
    p.add_argument("--source-primaries", choices=("srgb", "p3"), default="srgb",
                    help="Primaries the candidate was rendered in (#1339). "
                         "'p3' rotates it to sRGB primaries before diffing "
                         "against the (always-sRGB) ACR reference.")
    p.add_argument("--self-test", action="store_true",
                    help="Run the synthetic P3-rotation self-test and exit; "
                         "ignores candidate/reference.")
    p.add_argument("--roi", type=str, default=None,
                    help="Grayscale PNG restricting the diff to pixels > 127 "
                         "(resized nearest-neighbour to the reference's dims).")
    args = p.parse_args()
    if args.self_test:
        return _self_test()
    if not args.candidate or not args.reference:
        p.error("candidate and reference are required unless --self-test is set")
    try:
        out = diff(args.candidate, args.reference, zones=args.zones,
                   hue_bins=args.hue_bins, source_primaries=args.source_primaries,
                   roi_path=args.roi)
    except Exception as e:  # noqa: BLE001 — CLI surfaces error as JSON
        print(json.dumps({"error": str(e)}))
        return 2
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
