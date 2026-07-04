#!/usr/bin/env python3
"""Tests for banding_check.py (#1627). Run: python3 src/scripts/banding_check_test.py"""

import sys
import tempfile
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "src/scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import banding_check


def write_synthetic_exr(path: Path, rgb: np.ndarray) -> None:
    """Write an (H, W, 3) float32 array as an EXR. Mirrors
    stage_diff_test.write_synthetic_exr / stage_stats_test's helper: try
    imageio first, fall back to the OpenEXR binding if it downcasts."""
    import imageio.v3 as iio
    try:
        iio.imwrite(str(path), rgb.astype(np.float32))
        readback = iio.imread(str(path))
        if readback.dtype != np.float32:
            raise ValueError("imageio downcast — falling back")
    except Exception:
        import OpenEXR
        import Imath
        h, w = rgb.shape[:2]
        header = OpenEXR.Header(w, h)
        header["channels"] = {
            ch: Imath.Channel(Imath.PixelType(Imath.PixelType.FLOAT))
            for ch in ("R", "G", "B")
        }
        out = OpenEXR.OutputFile(str(path), header)
        out.writePixels({
            "R": rgb[:, :, 0].astype(np.float32).tobytes(),
            "G": rgb[:, :, 1].astype(np.float32).tobytes(),
            "B": rgb[:, :, 2].astype(np.float32).tobytes(),
        })
        out.close()


def test_second_difference_zero_on_linear_ramp():
    """A perfectly linear ramp has zero second difference everywhere —
    the metric must not false-positive on a healthy smooth gradient."""
    row = np.linspace(0.0, 1.0, 100, dtype=np.float64)
    values = np.tile(row, (4, 1))
    spike = banding_check.second_difference_spike(values)
    assert spike["max_abs_d2"] < 1e-9, spike
    assert spike["mean_abs_d2"] < 1e-9, spike


def test_second_difference_flags_a_plateau():
    """The #1621 defect signature: a ramp that rises smoothly then goes
    dead flat. This is what a hard clip-to-hull does to the out-of-gamut
    half of a chroma ramp. The plateau's ONSET produces exactly one large
    second-difference spike — that's what the gate must catch."""
    n = 100
    rising = np.linspace(0.0, 0.5, n // 2, dtype=np.float64)
    flat = np.full(n // 2, 0.5, dtype=np.float64)
    row = np.concatenate([rising, flat])
    values = np.tile(row, (4, 1))
    spike = banding_check.second_difference_spike(values)
    # The elbow's second difference equals the (negated) incoming slope —
    # much larger than the ~0 second difference of either the ramp or the
    # flat plateau on their own.
    assert spike["max_abs_d2"] > 0.005, spike
    assert spike["max_spike_ratio"] > 0.9, spike


def test_second_difference_small_on_smooth_soft_knee():
    """A C1-continuous soft-knee (Reinhard-style, matching #1621's fix)
    must have a bounded, small second difference — no elbow. Mirrors the
    shape of `compress_to_unit_cube_oklab`'s knee without depending on the
    Rust implementation."""
    n = 200
    c_in = np.linspace(0.0, 0.999, n, dtype=np.float64)
    knee = 0.5
    hull = 1.0
    with np.errstate(divide="ignore", invalid="ignore"):
        x = (c_in - knee) / (hull - knee)
        out = np.where(c_in <= knee, c_in, knee + (hull - knee) * (x / (1.0 + x)))
    values = np.tile(out, (4, 1))
    spike = banding_check.second_difference_spike(values)
    # Reinhard's second derivative is bounded and continuous through the
    # knee (no jump discontinuity) — the ratio should sit well under the
    # plateau case's near-1.0 signature.
    assert spike["max_spike_ratio"] < 0.5, spike


def test_ramp_axis_values_chroma_zero_for_achromatic_srgb_linear():
    """An achromatic (R=G=B) triple has Oklab chroma 0 regardless of
    lightness — sanity check for the `_to_oklab` reimplementation."""
    rgb = np.full((2, 2, 3), 0.4, dtype=np.float32)
    chroma = banding_check.ramp_axis_values(rgb, "17_srgb_linear", "chroma")
    assert np.allclose(chroma, 0.0, atol=1e-5), chroma


def test_ramp_axis_values_luma_matches_rec2020_weights():
    rgb = np.zeros((1, 1, 3), dtype=np.float32)
    rgb[0, 0] = [1.0, 0.0, 0.0]
    luma = banding_check.ramp_axis_values(rgb, "16_agx", "luma")
    assert abs(luma[0, 0] - 0.2627) < 1e-4, luma


def test_check_budget_passes_within_ceiling():
    metrics = {"max_abs_d2": 0.001, "max_spike_ratio": 0.5}
    budget = {"max_abs_d2": 0.002, "max_spike_ratio": 1.2}
    passed, failures = banding_check.check_budget(metrics, budget)
    assert passed, failures
    assert failures == []


def test_check_budget_fails_over_ceiling():
    metrics = {"max_abs_d2": 0.5, "max_spike_ratio": 0.5}
    budget = {"max_abs_d2": 0.002, "max_spike_ratio": 1.2}
    passed, failures = banding_check.check_budget(metrics, budget)
    assert not passed
    assert any("max_abs_d2" in f for f in failures)


def test_check_budget_no_entry_passes_by_default():
    passed, failures = banding_check.check_budget({"max_abs_d2": 999.0}, None)
    assert passed
    assert failures == []


def test_load_budgets_reads_fixtures_wrapper():
    """Matches the {"version": 1, "fixtures": {...}} convention shared
    with test-fixtures/budgets.json / pano-budgets.json."""
    import json
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "b.json"
        path.write_text(json.dumps({
            "version": 1,
            "fixtures": {"foo/16_agx/chroma": {"max_abs_d2": 0.01}},
        }))
        budgets = banding_check.load_budgets(path)
        assert "foo/16_agx/chroma" in budgets
        assert budgets["foo/16_agx/chroma"]["max_abs_d2"] == 0.01


def test_load_budgets_missing_file_returns_empty():
    budgets = banding_check.load_budgets(Path("/nonexistent/banding_budgets.json"))
    assert budgets == {}


def test_end_to_end_cli_gates_on_plateau_exr():
    """Integration: write a plateau-defect EXR to disk, run main() via its
    public entry points, confirm it reports a real spike and (with a tight
    budget) would fail the gate."""
    n = 128
    rising = np.linspace(0.0, 0.3, n // 2, dtype=np.float32)
    flat = np.full(n // 2, 0.3, dtype=np.float32)
    row = np.concatenate([rising, flat])
    rgb = np.zeros((4, n, 3), dtype=np.float32)
    for c in range(3):
        rgb[:, :, c] = row  # achromatic plateau — use the luma axis
    with tempfile.TemporaryDirectory() as tmp:
        dump_dir = Path(tmp)
        write_synthetic_exr(dump_dir / "16_agx.exr", rgb)
        loaded = banding_check.load_exr_rgb(dump_dir / "16_agx.exr")
        assert loaded.shape == (4, n, 3)
        values = banding_check.ramp_axis_values(loaded, "16_agx", "luma")
        spike = banding_check.second_difference_spike(values)
        assert spike["max_spike_ratio"] > 0.9, spike
        # A tight budget must fail; a loose one must pass.
        tight_passed, _ = banding_check.check_budget(spike, {"max_spike_ratio": 0.1})
        loose_passed, _ = banding_check.check_budget(spike, {"max_spike_ratio": 10.0})
        assert not tight_passed
        assert loose_passed


def main() -> int:
    tests = [
        test_second_difference_zero_on_linear_ramp,
        test_second_difference_flags_a_plateau,
        test_second_difference_small_on_smooth_soft_knee,
        test_ramp_axis_values_chroma_zero_for_achromatic_srgb_linear,
        test_ramp_axis_values_luma_matches_rec2020_weights,
        test_check_budget_passes_within_ceiling,
        test_check_budget_fails_over_ceiling,
        test_check_budget_no_entry_passes_by_default,
        test_load_budgets_reads_fixtures_wrapper,
        test_load_budgets_missing_file_returns_empty,
        test_end_to_end_cli_gates_on_plateau_exr,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
