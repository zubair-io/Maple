#!/usr/bin/env python3
"""Banding gate for a synthetic-ramp stage-dump (#1627).

Usage:
    banding_check.py <dump_dir> [--stage <stage>] [--json <out.json>]
                      [--budget-key <key>] [--budgets <budgets.json>]
                      [--ramp-axis {chroma,luma}]

Given a `MAPLE_STAGE_DUMP` directory produced by rendering a synthetic ramp
(`maple-cli synthetic --kind {neutral-ramp,chroma-ramp}`) through the view
transform, this is a REAL CI gate (not a diagnostic): it measures the
**second difference** of the ramp's chroma (or luma) along the ramp axis and
fails when the peak spike magnitude exceeds a budget recorded in
`test-fixtures/banding_budgets.json`.

Why second difference, not first-difference monotonicity: a hard clip-to-hull
(the #1621 defect) turns a smooth ramp into "...smoothly rising, then a dead
flat plateau" — the FIRST difference goes from some positive step straight to
zero and stays there, which a naive "count decreasing steps" check (the
pre-#1627 diagnostic below) never sees, because the plateau is not a
decrease. The SECOND difference is nonzero exactly once, at the elbow where
the curve's slope discontinuously drops — a single large spike. A smooth
soft-knee compressor (the #1621 fix) has a bounded, small second difference
everywhere because the curve is C1-continuous by construction (a Reinhard
knee has no slope discontinuity). This is the "no derivative discontinuities
before the single smooth compression event" property from the #1733
competitive-review note.

For a **chroma ramp** (`chroma_ramp` fixture, achromatic-to-saturated at
constant L/hue), the natural axis is Oklab chroma `sqrt(a^2 + b^2)` computed
from the stage's RGB triple (the working space differs per stage — see
`_STAGE_OKLAB` below). For a **neutral ramp** there is no chroma to speak of
(it's zero everywhere by construction pre-pipeline; post-pipeline any
non-zero chroma is itself a defect the R/G/B-equality check below already
catches), so the natural axis is luma.

Same EXR loader and dependency set as `stage_stats.py` / `stage_diff.py`
(OpenEXR first, imageio fallback).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

try:
    import OpenEXR
    import Imath
    _OPENEXR_AVAILABLE = True
except ImportError:
    _OPENEXR_AVAILABLE = False

try:
    import imageio.v3 as iio
    _IMAGEIO_AVAILABLE = True
except ImportError:
    _IMAGEIO_AVAILABLE = False


REC2020_LUM = np.array([0.2627, 0.6780, 0.0593], dtype=np.float32)
SHADOW_LUMA = 0.10
HIST_BIN = 0.001
DEFAULT_STAGE = "16_agx"

# Oklab forward matrices (Ottosson 2020), duplicated from
# raw-core/src/color/oklab.rs so this gate has no Rust FFI dependency —
# pure-Python numpy re-implementation, values copy-pasted verbatim.
_M1_SRGB_TO_LMS = np.array([
    [0.412_221_47, 0.536_332_54, 0.051_445_99],
    [0.211_903_50, 0.680_699_55, 0.107_396_96],
    [0.088_302_46, 0.281_718_84, 0.629_978_70],
], dtype=np.float64)
_M2_LMS_TO_LAB = np.array([
    [0.210_454_26, 0.793_617_79, -0.004_072_05],
    [1.977_998_50, -2.428_592_21, 0.450_593_71],
    [0.025_904_04, 0.782_771_77, -0.808_675_77],
], dtype=np.float64)
_M_REC2020_TO_SRGB = np.array([
    [1.6605, -0.5876, -0.0728],
    [-0.1246, 1.1329, -0.0083],
    [-0.0182, -0.1006, 1.1187],
], dtype=np.float64)

# Which working-space-to-Oklab transform applies to each stage this gate
# understands. `16_agx` is Rec.2020 (AgX operates and emits Rec.2020,
# pre-`rec2020_to_srgb`); `17_srgb_linear` is already linear sRGB (post
# `rec2020_to_srgb`'s own Oklab gamut compress) — see
# `raw-core/src/view/encode.rs::rec2020_to_display`. Sweeping BOTH is the
# #1627 scope addition: the AgX post-outset compressor and the display-encode
# compressor are two independent call sites of the same
# `compress_to_unit_cube_oklab` algorithm and can regress independently.
_STAGE_WORKING_SPACE = {
    "16_agx": "rec2020",
    "16a_split_tone": "rec2020",
    "16b_grain": "rec2020",
    "17_srgb_linear": "srgb_linear",
    # The Auto Profile tail (`maple-cli auto-tail-ramp`, #1740 M1) operates
    # on and emits gamma-encoded display sRGB — decoded to linear before any
    # metric so the second-difference gate measures the same perceptual axes
    # as the other stages.
    "18_auto_tail": "srgb_gamma",
}


def _srgb_gamma_decode(rgb: np.ndarray) -> np.ndarray:
    """IEC 61966-2-1 sRGB EOTF (gamma decode), matching
    `raw-core/src/view/agx_inverse.rs::srgb_gamma_inv` exactly: inputs are
    clamped to [0, 1] (the Rust reference clamps, and tail dumps can carry
    small float overshoots) and the linear-segment breakpoint is the same
    0.040449936 constant the Rust side uses."""
    x = np.clip(rgb.astype(np.float64), 0.0, 1.0)
    return np.where(x <= 0.040449936, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def _to_oklab(rgb: np.ndarray, working_space: str) -> np.ndarray:
    """(H, W, 3) working-space RGB -> (H, W, 3) Oklab (L, a, b), float64."""
    flat = rgb.reshape(-1, 3).astype(np.float64)
    if working_space == "rec2020":
        flat = flat @ _M_REC2020_TO_SRGB.T
    elif working_space == "srgb_gamma":
        flat = _srgb_gamma_decode(flat)
    elif working_space != "srgb_linear":
        raise ValueError(f"unknown working space {working_space!r}")
    lms = flat @ _M1_SRGB_TO_LMS.T
    lms_cbrt = np.sign(lms) * np.abs(lms) ** (1.0 / 3.0)
    lab = lms_cbrt @ _M2_LMS_TO_LAB.T
    return lab.reshape(rgb.shape)


def load_exr_rgb(path: Path) -> np.ndarray:
    """Return (H, W, 3) float32 RGB. Same loader as stage_stats.py."""
    if _OPENEXR_AVAILABLE:
        f = OpenEXR.InputFile(str(path))
        hdr = f.header()
        dw = hdr["dataWindow"]
        w = dw.max.x - dw.min.x + 1
        h = dw.max.y - dw.min.y + 1
        pt = Imath.PixelType(Imath.PixelType.FLOAT)
        channels = hdr["channels"]

        def read_chan(name_upper: str) -> np.ndarray:
            name = name_upper if name_upper in channels else name_upper.lower()
            if name not in channels:
                raise ValueError(
                    f"{path}: expected channel {name_upper!r}, got {list(channels.keys())}"
                )
            buf = f.channel(name, pt)
            return np.frombuffer(buf, dtype=np.float32).reshape(h, w)

        return np.stack([read_chan("R"), read_chan("G"), read_chan("B")], axis=-1)

    if _IMAGEIO_AVAILABLE:
        arr = iio.imread(str(path))
        if arr.ndim != 3 or arr.shape[2] < 3:
            raise ValueError(f"{path}: expected 3-channel EXR, got shape {arr.shape}")
        arr = arr[:, :, :3]
        if arr.dtype == np.uint8:
            arr = arr.astype(np.float32) / 255.0
        return arr.astype(np.float32)

    raise RuntimeError(
        "Neither OpenEXR nor imageio.v3 is available. "
        "Install one: pip install openexr  OR  pip install imageio"
    )


def per_row_rgb_drift(rgb: np.ndarray) -> dict:
    """Per-row R/G/B equality, aggregated across rows. Only meaningful for
    an achromatic (neutral-ramp) input — a chroma ramp is R != G != B by
    construction, so callers gate this only for `--ramp-axis luma`."""
    r = rgb[..., 0]
    g = rgb[..., 1]
    b = rgb[..., 2]
    per_row_rg = np.abs(r - g).max(axis=1)
    per_row_rb = np.abs(r - b).max(axis=1)
    per_row_gb = np.abs(g - b).max(axis=1)
    return {
        "max_abs_rg": float(per_row_rg.max()),
        "max_abs_rb": float(per_row_rb.max()),
        "max_abs_gb": float(per_row_gb.max()),
        "mean_abs_rg": float(per_row_rg.mean()),
        "mean_abs_rb": float(per_row_rb.mean()),
        "mean_abs_gb": float(per_row_gb.mean()),
    }


def shadow_histogram_gaps(rgb: np.ndarray) -> dict:
    """Count empty histogram bins (width = HIST_BIN) between filled bins
    in the shadow region (luma < SHADOW_LUMA). Diagnostic only — reported
    in the JSON output but not gated (no established budget shape)."""
    luma = (rgb * REC2020_LUM).sum(axis=-1)
    mask = luma < SHADOW_LUMA
    out: dict[str, dict] = {}
    for i, name in enumerate("rgb"):
        vals = rgb[..., i][mask]
        if vals.size < 4:
            out[name] = {"gap_bins": 0, "n_samples": int(vals.size)}
            continue
        lo, hi = float(vals.min()), float(vals.max())
        if hi - lo < HIST_BIN * 2:
            out[name] = {"gap_bins": 0, "n_samples": int(vals.size)}
            continue
        n_bins = int(np.ceil((hi - lo) / HIST_BIN)) + 1
        hist, _ = np.histogram(vals, bins=n_bins, range=(lo, lo + n_bins * HIST_BIN))
        filled = hist > 0
        if filled.sum() < 2:
            out[name] = {"gap_bins": 0, "n_samples": int(vals.size)}
            continue
        first = int(np.argmax(filled))
        last = len(filled) - 1 - int(np.argmax(filled[::-1]))
        gap_bins = int((~filled[first:last + 1]).sum())
        out[name] = {
            "gap_bins": gap_bins,
            "n_samples": int(vals.size),
            "first_bin": first,
            "last_bin": last,
            "total_bins_in_range": int(last - first + 1),
        }
    return out


def ramp_axis_values(rgb: np.ndarray, stage: str, axis: str) -> np.ndarray:
    """Return the (H, W) scalar field the second-difference metric runs
    over: Oklab chroma for `axis == "chroma"`, Rec.2020 luma for
    `axis == "luma"`."""
    working_space = _STAGE_WORKING_SPACE.get(stage, "srgb_linear")
    if axis == "luma":
        lin = _srgb_gamma_decode(rgb) if working_space == "srgb_gamma" else rgb
        return (lin * REC2020_LUM).sum(axis=-1).astype(np.float64)
    if axis == "chroma":
        lab = _to_oklab(rgb, working_space)
        return np.sqrt(lab[..., 1] ** 2 + lab[..., 2] ** 2)
    raise ValueError(f"unknown ramp axis {axis!r}")


def second_difference_spike(values: np.ndarray) -> dict:
    """The #1627 gate metric: second difference of `values` along axis=1
    (the ramp direction), aggregated across rows.

    `d2[x] = v[x+1] - 2*v[x] + v[x-1]`. A perfectly linear or smoothly
    curving (C1) ramp has small, roughly-constant `d2`; a derivative
    discontinuity (a hard clip's elbow, or a plateau's onset/exit) produces
    one or two large `|d2|` spikes standing well above the rest of the row.

    Returns both the raw peak (`max_abs_d2`) and its row-normalized form
    (`max_abs_d2` divided by the row's peak first-difference step) so a gate
    reader can express "the spike is at most K times the ramp's own step
    size" independent of how many samples the ramp has.
    """
    d1 = np.diff(values, axis=1)
    d2 = np.diff(d1, axis=1)
    abs_d2 = np.abs(d2)
    per_row_max = abs_d2.max(axis=1)
    # Row-normalize by the row's own peak |d1| (the ramp's typical step) so
    # the spike ratio is comparable across stages/rows with different overall
    # chroma spans. A floor avoids divide-by-zero on a degenerate flat row.
    per_row_step = np.abs(d1).max(axis=1)
    per_row_step_floor = np.maximum(per_row_step, 1e-6)
    per_row_ratio = per_row_max / per_row_step_floor
    return {
        "max_abs_d2": float(abs_d2.max()),
        "mean_abs_d2": float(abs_d2.mean()),
        "max_spike_ratio": float(per_row_ratio.max()),
        "mean_spike_ratio": float(per_row_ratio.mean()),
    }


def flat_run(values: np.ndarray, eps: float = 1e-6) -> dict:
    """Longest run of consecutive first-difference steps with |d1| <= eps,
    as a fraction of the row's step count — the PLATEAU metric (#1740 M1).

    The second-difference spike above catches a HARD clip's elbow, but a
    tone mapping can also destroy a range smoothly: approach saturation with
    a soft shoulder, then sit exactly flat (the Auto 2.0 posterized-highlight
    defect on test_0000 — everything above ~0.74 input collapsed onto output
    1.0 with no sharp elbow anywhere, max_abs_d2 stayed tiny). A flat run
    IS the posterization: every input in the run renders identically. A
    healthy compressive tail keeps a strictly positive (if small) slope, so
    its longest |d1|<=eps run is ~0.
    """
    d1 = np.abs(np.diff(values, axis=1))
    flat = d1 <= eps
    max_frac = 0.0
    for row in flat:
        run = best = 0
        for f in row:
            run = run + 1 if f else 0
            best = max(best, run)
        max_frac = max(max_frac, best / row.shape[0])
    return {"max_flat_run_frac": float(max_frac), "flat_eps": eps}


def load_budgets(path: Path) -> dict:
    """Load `test-fixtures/banding_budgets.json`. Matches the
    `{"version": 1, "fixtures": {...}}` wrapper convention shared with
    `test-fixtures/budgets.json` / `pano-budgets.json` — the flat map of
    `"<fixture>/<stage>/<axis>"` -> `{max_abs_d2, max_spike_ratio}` lives
    under the `fixtures` key."""
    if not path.exists():
        return {}
    doc = json.loads(path.read_text())
    return doc.get("fixtures", doc)


def check_budget(metrics: dict, budget: dict | None) -> tuple[bool, list[str]]:
    """Compare `metrics` against `budget` (both dicts with `max_abs_d2` /
    `max_spike_ratio` keys). Returns (passed, [failure messages]). No budget
    entry -> (True, []) — caller decides whether that's itself a failure
    (see `--require-budget`)."""
    if budget is None:
        return True, []
    failures = []
    for key in ("max_abs_d2", "max_spike_ratio", "max_flat_run_frac"):
        if key not in budget:
            continue
        ceiling = budget[key]
        value = metrics[key]
        if value > ceiling:
            failures.append(f"{key}: {value:.6g} > budget ceiling {ceiling:.6g}")
    return len(failures) == 0, failures


def main() -> int:
    p = argparse.ArgumentParser(
        description="Second-difference banding gate for a synthetic-ramp MAPLE_STAGE_DUMP.",
    )
    p.add_argument("dump_dir", type=Path, help="directory of NN_stage.exr files")
    p.add_argument("--stage", default=DEFAULT_STAGE,
                   help=f"stage to analyse (default: {DEFAULT_STAGE})")
    p.add_argument("--ramp-axis", choices=["chroma", "luma"], default="chroma",
                   help="scalar field the second-difference metric runs over (default: chroma)")
    p.add_argument("--json", type=Path, help="optional path to write JSON metrics")
    p.add_argument("--budgets", type=Path,
                   default=Path(__file__).resolve().parents[2] / "test-fixtures" / "banding_budgets.json",
                   help="budgets JSON (default: test-fixtures/banding_budgets.json)")
    p.add_argument("--budget-key", help="key into the budgets JSON for this case "
                                        "(default: '<dump_dir.name>/<stage>/<ramp-axis>')")
    p.add_argument("--require-budget", action="store_true",
                   help="fail (not skip) when --budget-key has no entry in --budgets")
    args = p.parse_args()

    if not args.dump_dir.is_dir():
        print(f"error: {args.dump_dir} is not a directory", file=sys.stderr)
        return 2

    exr_path = args.dump_dir / f"{args.stage}.exr"
    if not exr_path.exists():
        print(f"error: no EXR for stage {args.stage!r} in {args.dump_dir}", file=sys.stderr)
        print(f"  expected: {exr_path}", file=sys.stderr)
        available = sorted(p.name for p in args.dump_dir.glob("*.exr"))
        print(f"  available: {available}", file=sys.stderr)
        return 2

    rgb = load_exr_rgb(exr_path)
    values = ramp_axis_values(rgb, args.stage, args.ramp_axis)
    spike = second_difference_spike(values)
    plateau = flat_run(values)
    drift = per_row_rgb_drift(rgb) if args.ramp_axis == "luma" else None
    gaps = shadow_histogram_gaps(rgb)

    print(f"# Banding gate — stage {args.stage} axis={args.ramp_axis} ({rgb.shape[1]}x{rgb.shape[0]})")
    print()
    print("Second-difference spike (the #1627 gate metric):")
    print(f"  max_abs_d2:       {spike['max_abs_d2']:.6f}")
    print(f"  mean_abs_d2:      {spike['mean_abs_d2']:.6f}")
    print(f"  max_spike_ratio:  {spike['max_spike_ratio']:.6f}  (spike / row's own peak step)")
    print(f"  mean_spike_ratio: {spike['mean_spike_ratio']:.6f}")
    print()
    print(f"Flat run (plateau / posterization metric, |d1| <= {plateau['flat_eps']:g}):")
    print(f"  max_flat_run_frac: {plateau['max_flat_run_frac']:.6f}  (longest flat run / ramp steps)")
    print()
    if drift is not None:
        print("R/G/B equality (max abs diff over all pixels):")
        print(f"  |R - G|:  max={drift['max_abs_rg']:.6f}  mean={drift['mean_abs_rg']:.6f}")
        print(f"  |R - B|:  max={drift['max_abs_rb']:.6f}  mean={drift['mean_abs_rb']:.6f}")
        print(f"  |G - B|:  max={drift['max_abs_gb']:.6f}  mean={drift['mean_abs_gb']:.6f}")
        print()
    print(f"Shadow histogram gaps (luma < {SHADOW_LUMA}, bin width = {HIST_BIN}):")
    for name, g in gaps.items():
        if g.get("total_bins_in_range") is None:
            print(f"  {name}: no shadow samples (n={g['n_samples']})")
        else:
            tot = g["total_bins_in_range"]
            gap = g["gap_bins"]
            pct = (gap / tot * 100.0) if tot else 0.0
            print(f"  {name}: {gap} empty bins out of {tot} ({pct:.1f}%, n={g['n_samples']})")

    budgets = load_budgets(args.budgets)
    budget_key = args.budget_key or f"{args.dump_dir.name}/{args.stage}/{args.ramp_axis}"
    budget = budgets.get(budget_key)
    passed, failures = check_budget({**spike, **plateau}, budget)

    print()
    if budget is None:
        msg = f"# no budget entry for key {budget_key!r} in {args.budgets}"
        if args.require_budget:
            print(f"{msg} — FAIL (--require-budget)", file=sys.stderr)
            passed = False
        else:
            print(f"{msg} — not gated")
    elif passed:
        print(f"# PASS — {budget_key} within budget {budget}")
    else:
        print(f"# FAIL — {budget_key}", file=sys.stderr)
        for f in failures:
            print(f"#   {f}", file=sys.stderr)

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({
            "stage": args.stage,
            "ramp_axis": args.ramp_axis,
            "shape": list(rgb.shape),
            "second_difference": spike,
            "flat_run": plateau,
            "rgb_drift": drift,
            "shadow_gaps": gaps,
            "budget_key": budget_key,
            "budget": budget,
            "passed": passed,
        }, indent=2))

    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
