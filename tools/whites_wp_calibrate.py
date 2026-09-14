#!/usr/bin/env python3
"""Historical surrogate calibration experiment for #3601; NOT a shipping gate.

This script models pixel tone positions by inverting ACR's baseline through
Maple's AgX LUT. Its errors (including 4.19 L*) therefore are not measured
Maple rendering errors, even when its image statistic comes from a real RAW.
It also fits an obsolete global stretch, not the shipping bump shape.

Use tone_sprint.rs and tone_sprint_report.py for actual production renders.
Retained to reproduce the earlier experiment and its limitation; no output
from this script is sufficient evidence for production constants.

Usage: python3 tools/whites_wp_calibrate.py [--stride N] [--min-bin-pixels N]
Requires numpy, scipy, Pillow. No production code is touched by this script.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.optimize import minimize

# ---------------------------------------------------------------------------
# Repo layout / constants
# ---------------------------------------------------------------------------

REPO_ROOT = Path("/Users/riabuz/Projects/_Maple/.claude/worktrees/whites-remap")
RAW_PIPELINE = REPO_ROOT / "src/raw-pipeline"
MANIFEST_PATH = REPO_ROOT / "test-fixtures/references/manifest.json"
LUT_PATH = RAW_PIPELINE / "raw-core/src/view/agx_lut.bin"
DUMP_BIN = RAW_PIPELINE / "target/release/examples/dump_scene_linear"
REFERENCES_ROOT = REPO_ROOT / "test-fixtures/references"

AGX_MIN_EV = -10.0
AGX_MAX_EV = 6.5
AGX_MID_GRAY = 0.18

PERCENTILE_LABELS = ["P90", "P95", "P97", "P98", "P99", "P99.5", "P99.9", "P100"]

# The 18 fixtures with whites_max/whites_min references (test_0016 does not
# exist; test_0019/test_0020 have baseline references but no whites cases).
FIXTURES = [f"test_{i:04d}" for i in range(16)] + ["test_0017", "test_0018"]

BIN_EDGES = np.arange(0.0, 100.0001, 5.0)  # 0-5, 5-10, ..., 95-100
BIN_CENTERS = (BIN_EDGES[:-1] + BIN_EDGES[1:]) / 2.0


# ---------------------------------------------------------------------------
# Step 1: true scene-linear percentiles (drives the Rust example, or reads
# already-produced dumps if present in the cache dir)
# ---------------------------------------------------------------------------


def load_manifest_raw_paths() -> dict[str, str]:
    manifest = json.loads(MANIFEST_PATH.read_text())
    raws: dict[str, str] = {}
    for case in manifest["cases"]:
        name = case["name"]
        if not name.endswith("/baseline"):
            continue
        fixture = name.split("/")[0]
        raws[fixture] = case["raw"]
    return raws


def measure_scene_linear_percentiles(cache_dir: Path) -> dict[str, dict[str, float]]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    raws = load_manifest_raw_paths()
    percentiles: dict[str, dict[str, float]] = {}
    for fixture in FIXTURES:
        cache_path = cache_dir / f"{fixture}.json"
        if cache_path.exists():
            percentiles[fixture] = json.loads(cache_path.read_text())
            continue
        raw_path = raws[fixture]
        proc = subprocess.run(
            [str(DUMP_BIN), raw_path],
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"dump_scene_linear failed for {fixture} ({raw_path}):\n{proc.stderr[-4000:]}"
            )
        m = re.search(r"PERCENTILES_JSON: (\{.*\})", proc.stdout)
        if not m:
            raise RuntimeError(f"no PERCENTILES_JSON in dump output for {fixture}")
        data = json.loads(m.group(1))
        cache_path.write_text(json.dumps(data, indent=1))
        percentiles[fixture] = data
    return percentiles


# ---------------------------------------------------------------------------
# Step 2: ACR's measured response from the committed reference PNGs
# ---------------------------------------------------------------------------


def lstar(y: np.ndarray) -> np.ndarray:
    y = np.clip(y, 0.0, None)
    return np.where(y > 0.008856, 116.0 * np.cbrt(y) - 16.0, 903.3 * y)


def srgb_to_linear(a: np.ndarray) -> np.ndarray:
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def load_png_linear_luma(path: Path, stride: int) -> np.ndarray:
    arr = (
        np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)[
            ::stride, ::stride
        ]
        / 255.0
    )
    lin = srgb_to_linear(arr)
    # Rec.709 (sRGB primaries) luma — the reference PNGs are standard 8-bit
    # sRGB exports, same assumption the reverted bump-form calibrator used.
    return 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]


def load_lut() -> tuple[np.ndarray, np.ndarray]:
    lut = np.frombuffer(LUT_PATH.read_bytes(), dtype="<f4").astype(np.float64)
    grid = np.linspace(0.0, 1.0, len(lut))
    return grid, lut


@dataclass
class FixtureData:
    name: str
    ev_white_by_p: dict[str, float]
    base_l: np.ndarray  # ACR baseline L*, flattened, subsampled
    n: np.ndarray  # per-pixel AgX log-encode coordinate, recovered from baseline
    acr_delta_max: np.ndarray  # ACR whites_max L* - baseline L*
    acr_delta_min: np.ndarray  # ACR whites_min L* - baseline L*
    bin_mask: list[np.ndarray]  # one boolean mask per 5-point L* bin


def build_fixture_data(
    fixture: str,
    percentiles: dict[str, float],
    grid: np.ndarray,
    lut: np.ndarray,
    stride: int,
    min_bin_pixels: int,
) -> FixtureData:
    ref_dir = REFERENCES_ROOT / fixture / "down"
    base_y = load_png_linear_luma(ref_dir / "baseline.png", stride).ravel()
    max_y = load_png_linear_luma(ref_dir / "whites_max.png", stride).ravel()
    min_y = load_png_linear_luma(ref_dir / "whites_min.png", stride).ravel()

    base_l = lstar(base_y)
    max_l = lstar(max_y)
    min_l = lstar(min_y)

    n = np.interp(base_y, lut, grid)  # invert Maple's AgX LUT

    bin_mask = []
    for lo, hi in pairwise(BIN_EDGES):
        mask = (base_l >= lo) & (base_l < hi if hi < 100.0 else base_l <= hi)
        if mask.sum() < min_bin_pixels:
            mask = np.zeros_like(mask)  # exclude sparsely-populated bins
        bin_mask.append(mask)

    return FixtureData(
        name=fixture,
        ev_white_by_p=percentiles,
        base_l=base_l,
        n=n,
        acr_delta_max=max_l - base_l,
        acr_delta_min=min_l - base_l,
        bin_mask=bin_mask,
    )


# ---------------------------------------------------------------------------
# Step 3: the model + fit
# ---------------------------------------------------------------------------

WHITES_POS = 100.0
WHITES_NEG = -100.0
GUARD_MARGIN_EV = 0.5  # required headroom of effective_max_ev above AGX_MIN_EV


def effective_max_ev(
    whites: float, ev_white_img: np.ndarray, alpha: float, beta: float
) -> np.ndarray:
    return AGX_MAX_EV - (whites / 100.0) * (alpha * (AGX_MAX_EV - ev_white_img) + beta)


def k_scale(
    whites: float, ev_white_img: np.ndarray, alpha: float, beta: float
) -> np.ndarray:
    eff = effective_max_ev(whites, ev_white_img, alpha, beta)
    return (AGX_MAX_EV - AGX_MIN_EV) / (eff - AGX_MIN_EV)


def predicted_delta_l(
    fx: FixtureData,
    whites: float,
    ev_white_img: float,
    alpha: float,
    beta: float,
    grid: np.ndarray,
    lut: np.ndarray,
) -> np.ndarray:
    k = k_scale(whites, np.array(ev_white_img), alpha, beta)
    n_pred = np.minimum(fx.n * k, 1.0)
    pred_y = np.interp(n_pred, grid, lut)
    pred_l = lstar(pred_y)
    return pred_l - fx.base_l


def per_fixture_bin_curve(delta: np.ndarray, bin_mask: list[np.ndarray]) -> np.ndarray:
    out = np.full(len(bin_mask), np.nan)
    for i, mask in enumerate(bin_mask):
        if mask.any():
            out[i] = delta[mask].mean()
    return out


def sign_loss(
    params: np.ndarray,
    fixtures: list[FixtureData],
    p_label: str,
    whites: float,
    acr_delta_attr: str,
    grid: np.ndarray,
    lut: np.ndarray,
) -> tuple[float, dict[str, float], float]:
    """Returns (mean per-fixture MAE across bins, per-fixture MAE dict, min guard margin)."""
    alpha, beta = params
    per_fixture_err: dict[str, float] = {}
    min_margin = float("inf")
    for fx in fixtures:
        ev_white_img = fx.ev_white_by_p[p_label]
        eff = float(effective_max_ev(whites, np.array(ev_white_img), alpha, beta))
        margin = eff - AGX_MIN_EV
        min_margin = min(min_margin, margin)

        acr_delta = getattr(fx, acr_delta_attr)
        pred_delta = predicted_delta_l(fx, whites, ev_white_img, alpha, beta, grid, lut)

        acr_curve = per_fixture_bin_curve(acr_delta, fx.bin_mask)
        pred_curve = per_fixture_bin_curve(pred_delta, fx.bin_mask)
        valid = ~np.isnan(acr_curve) & ~np.isnan(pred_curve)
        err = (
            float(np.mean(np.abs(pred_curve[valid] - acr_curve[valid])))
            if valid.any()
            else float("nan")
        )
        per_fixture_err[fx.name] = err

    mean_err = float(np.mean(list(per_fixture_err.values())))
    penalty = 0.0
    if min_margin < GUARD_MARGIN_EV:
        penalty = 1000.0 * (GUARD_MARGIN_EV - min_margin) ** 2
    return mean_err + penalty, per_fixture_err, min_margin


def fit_sign(
    fixtures: list[FixtureData],
    p_label: str,
    whites: float,
    acr_delta_attr: str,
    grid: np.ndarray,
    lut: np.ndarray,
    x0: tuple[float, float],
) -> dict:
    def obj(params):
        loss, _, _ = sign_loss(
            params, fixtures, p_label, whites, acr_delta_attr, grid, lut
        )
        return loss

    # Bounded to the design's own semantics ("a fraction... plus a constant
    # EV pull" implies ALPHA in [0,1]-ish, BETA non-negative). An
    # UNCONSTRAINED run is also reported: it reliably drives BETA sharply
    # negative — diagnostic in itself (see report), not a sensible
    # operating point, so it is not what "the fit" means here.
    opts = {"xatol": 1e-4, "fatol": 1e-5, "maxiter": 2000}
    res = minimize(
        obj,
        x0=np.array(x0),
        method="Nelder-Mead",
        bounds=[(0.0, 1.5), (0.0, 3.0)],
        options=opts,
    )
    alpha, beta = res.x
    loss, per_fixture_err, min_margin = sign_loss(
        res.x, fixtures, p_label, whites, acr_delta_attr, grid, lut
    )
    unconstrained = minimize(obj, x0=np.array(x0), method="Nelder-Mead", options=opts)
    u_loss, _, u_margin = sign_loss(
        unconstrained.x, fixtures, p_label, whites, acr_delta_attr, grid, lut
    )
    return {
        "alpha": float(alpha),
        "beta": float(beta),
        "mean_abs_error": loss,
        "per_fixture_error": per_fixture_err,
        "min_guard_margin_ev": min_margin,
        "unconstrained_alpha": float(unconstrained.x[0]),
        "unconstrained_beta": float(unconstrained.x[1]),
        "unconstrained_mean_abs_error": u_loss,
        "unconstrained_min_guard_margin_ev": u_margin,
    }


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--stride", type=int, default=6, help="subsample stride over the 'down' PNGs"
    )
    ap.add_argument("--min-bin-pixels", type=int, default=30)
    ap.add_argument(
        "--cache-dir",
        type=Path,
        default=REPO_ROOT / ".calibration-cache/production-scene-linear-percentiles",
    )
    args = ap.parse_args()

    print("Building dump_scene_linear (release)...", file=sys.stderr)
    subprocess.run(
        [
            "cargo",
            "build",
            "--release",
            "-p",
            "raw-core",
            "--example",
            "dump_scene_linear",
        ],
        cwd=RAW_PIPELINE,
        check=True,
    )

    print("Step 1: measuring true scene-linear percentiles...", file=sys.stderr)
    percentiles = measure_scene_linear_percentiles(args.cache_dir)

    print("Loading AgX LUT...", file=sys.stderr)
    grid, lut = load_lut()

    print(
        "Step 2: building per-fixture ACR data (baseline/whites_max/whites_min)...",
        file=sys.stderr,
    )
    fixtures = [
        build_fixture_data(
            fx, percentiles[fx], grid, lut, args.stride, args.min_bin_pixels
        )
        for fx in FIXTURES
    ]

    print("Step 3: sweeping P, fitting ALPHA/BETA per sign...", file=sys.stderr)
    results = []
    for p_label in PERCENTILE_LABELS:
        pos = fit_sign(
            fixtures, p_label, WHITES_POS, "acr_delta_max", grid, lut, x0=(0.7, 0.6)
        )
        neg = fit_sign(
            fixtures, p_label, WHITES_NEG, "acr_delta_min", grid, lut, x0=(0.5, 0.3)
        )
        combined = 0.5 * (pos["mean_abs_error"] + neg["mean_abs_error"])
        results.append({"p": p_label, "pos": pos, "neg": neg, "combined": combined})
        print(
            f"  P={p_label:>5}: pos_mae={pos['mean_abs_error']:.3f} "
            f"(alpha={pos['alpha']:.4f}, beta={pos['beta']:.4f}, margin={pos['min_guard_margin_ev']:.3f}EV)  "
            f"neg_mae={neg['mean_abs_error']:.3f} "
            f"(alpha={neg['alpha']:.4f}, beta={neg['beta']:.4f}, margin={neg['min_guard_margin_ev']:.3f}EV)  "
            f"combined={combined:.3f}",
            file=sys.stderr,
        )

    best = min(results, key=lambda r: r["combined"])

    print("\n=== WINNER (bounded: ALPHA in [0,1.5], BETA in [0,3]) ===")
    print(json.dumps(best, indent=1))

    print("\n=== per-fixture scene-linear percentiles (winning P) ===")
    for fx in FIXTURES:
        print(
            f"{fx}: ev_white_img(P={best['p']}) = {percentiles[fx][best['p']]:+.4f} EV"
        )

    print(
        "\n=== per-bin curves at the winning fit (ACR vs predicted), all 18 fixtures ==="
    )
    per_bin_curves = {}
    for fx in fixtures:
        ev = fx.ev_white_by_p[best["p"]]
        acr_pos_curve = per_fixture_bin_curve(fx.acr_delta_max, fx.bin_mask)
        pred_pos_curve = per_fixture_bin_curve(
            predicted_delta_l(
                fx, WHITES_POS, ev, best["pos"]["alpha"], best["pos"]["beta"], grid, lut
            ),
            fx.bin_mask,
        )
        acr_neg_curve = per_fixture_bin_curve(fx.acr_delta_min, fx.bin_mask)
        pred_neg_curve = per_fixture_bin_curve(
            predicted_delta_l(
                fx, WHITES_NEG, ev, best["neg"]["alpha"], best["neg"]["beta"], grid, lut
            ),
            fx.bin_mask,
        )
        per_bin_curves[fx.name] = {
            "bin_centers": BIN_CENTERS.tolist(),
            "acr_delta_max": [
                None if np.isnan(v) else round(float(v), 3) for v in acr_pos_curve
            ],
            "pred_delta_max": [
                None if np.isnan(v) else round(float(v), 3) for v in pred_pos_curve
            ],
            "acr_delta_min": [
                None if np.isnan(v) else round(float(v), 3) for v in acr_neg_curve
            ],
            "pred_delta_min": [
                None if np.isnan(v) else round(float(v), 3) for v in pred_neg_curve
            ],
        }

        def fmt(v: float) -> str:
            return f"{v:8.2f}" if not np.isnan(v) else f"{'--':>8}"

        print(f"-- {fx.name} (ev_white_img={ev:+.3f} EV) --")
        print(f"{'binL*':>7} {'ACR+':>8} {'pred+':>8}   {'ACR-':>8} {'pred-':>8}")
        for i, c in enumerate(BIN_CENTERS):
            print(
                f"{c:7.1f} {fmt(acr_pos_curve[i])} {fmt(pred_pos_curve[i])}   {fmt(acr_neg_curve[i])} {fmt(pred_neg_curve[i])}"
            )

    out = {
        "winner_p": best["p"],
        "pos": best["pos"],
        "neg": best["neg"],
        "all_p_sweep": [
            {
                "p": r["p"],
                "pos_mae": r["pos"]["mean_abs_error"],
                "neg_mae": r["neg"]["mean_abs_error"],
                "combined": r["combined"],
                "pos_unconstrained_mae": r["pos"]["unconstrained_mean_abs_error"],
                "pos_unconstrained_alpha": r["pos"]["unconstrained_alpha"],
                "pos_unconstrained_beta": r["pos"]["unconstrained_beta"],
            }
            for r in results
        ],
        "scene_linear_percentiles": percentiles,
        "per_bin_curves_at_winner": per_bin_curves,
    }
    out_path = REPO_ROOT / ".calibration-cache/whites_wp_calibrate_result.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=1))
    print(f"\nFull result written to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
