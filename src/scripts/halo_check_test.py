#!/usr/bin/env python3
"""Tests for halo_check.py. Run: python3 src/scripts/halo_check_test.py"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import imageio.v3 as iio

# Add current dir to sys.path to import halo_check
REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "src/scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import halo_check


def test_radial_profile():
    """Test that radial_profile correctly extracts the luma profile from the center row."""
    # 5x5 image, center is (2.0, 2.0)
    # REC2020_LUM = np.array([0.2627, 0.6780, 0.0593], dtype=np.float32)
    rgb = np.zeros((5, 5, 3), dtype=np.float32)
    # Middle row is index 2
    rgb[2, :, 0] = np.arange(5, dtype=np.float32)  # R channel: [0, 1, 2, 3, 4]

    radii, luma = halo_check.radial_profile(rgb)

    # radii should be [0.0, 1.0, 2.0] because center is at x=2.0
    # xs = [0, 1, 2, 3, 4], cx = 2.0, radii = xs - cx = [-2, -1, 0, 1, 2]
    # mask = radii >= 0 -> [0, 1, 2]
    expected_radii = np.array([0, 1, 2], dtype=np.float32)
    assert np.allclose(radii, expected_radii)

    # luma = (row * REC2020_LUM).sum(axis=-1)
    # row = [[2,0,0], [3,0,0], [4,0,0]] for indices 2, 3, 4
    # luma = [2*0.2627, 3*0.2627, 4*0.2627]
    expected_luma = np.array([2, 3, 4], dtype=np.float32) * 0.2627
    assert np.allclose(luma, expected_luma)


def test_halo_overshoot_no_overshoot():
    """Test halo_overshoot with a simple step function (no overshoot)."""
    radii = np.arange(40, dtype=np.float32)
    # Step function: 0.1 for radii < 10, 1.0 for radii >= 10
    luma = np.where(radii < 10, 0.1, 1.0)

    res = halo_check.halo_overshoot(radii, luma)
    assert res["max_overshoot_pct"] == 0.0
    assert res["edge_radius_px"] == 10.0
    assert np.isclose(res["background"], 1.0)


def test_halo_overshoot_with_overshoot():
    """Test halo_overshoot with a profile that has a clear overshoot peak."""
    radii = np.arange(100, dtype=np.float32)
    luma = np.full_like(radii, 1.0)  # background
    luma[:20] = 0.2  # inside disk
    luma[25] = 1.2  # overshoot peak at radius 25

    res = halo_check.halo_overshoot(radii, luma)
    assert res["max_overshoot_abs"] > 0.19  # 1.2 - 1.0 = 0.2
    assert res["peak_radius_px"] == 25.0
    # background is mean of last 25 samples (100 // 4 = 25)
    assert np.isclose(res["background"], 1.0)
    assert np.isclose(res["max_overshoot_pct"], 20.0)


def test_integration():
    """Integration test: write a synthetic EXR and run halo_check.py."""
    with tempfile.TemporaryDirectory() as tmp:
        dump_dir = Path(tmp)
        stage = "16_agx"
        exr_path = dump_dir / f"{stage}.exr"

        # Create a synthetic disk image
        # 64x64, center (31.5, 31.5)
        h, w = 64, 64
        y, x = np.ogrid[:h, :w]
        dist = np.sqrt((x - (w - 1) / 2.0) ** 2 + (y - (h - 1) / 2.0) ** 2)

        # Disk radius 10, background 0.5, disk 0.1, overshoot peak at radius 15
        img = np.full((h, w, 3), 0.5, dtype=np.float32)
        img[dist < 10] = 0.1
        # Add a halo
        halo_mask = (dist >= 14) & (dist <= 16)
        img[halo_mask] = 0.6

        iio.imwrite(str(exr_path), img)

        json_out = dump_dir / "out.json"
        cmd = [sys.executable, str(SCRIPTS_DIR / "halo_check.py"), str(dump_dir), "--json", str(json_out)]
        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            print(f"STDOUT: {result.stdout}")
            print(f"STDERR: {result.stderr}")
            result.check_returncode()

        assert json_out.is_file()
        with open(json_out, "r") as f:
            data = json.load(f)

        assert data["stage"] == stage
        assert data["overshoot"]["max_overshoot_pct"] > 0
        assert 14 <= data["overshoot"]["peak_radius_px"] <= 16


def main():
    test_functions = [
        test_radial_profile,
        test_halo_overshoot_no_overshoot,
        test_halo_overshoot_with_overshoot,
        test_integration,
    ]

    failed = False
    for fn in test_functions:
        try:
            fn()
            print(f"ok  {fn.__name__}")
        except Exception:
            print(f"FAIL {fn.__name__}")
            import traceback
            traceback.print_exc()
            failed = True

    if failed:
        sys.exit(1)
    print("all halo_check tests passed")


if __name__ == "__main__":
    main()
