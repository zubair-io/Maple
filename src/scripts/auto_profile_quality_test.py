#!/usr/bin/env python3
"""Independent acceptance/rejection witnesses for Auto JPEG quality checks."""

import hashlib
import json
import unittest
from pathlib import Path

import auto_profile_diff as legacy
import auto_profile_quality as quality
import numpy as np


class QualityTests(unittest.TestCase):
    def setUp(self):
        self.reference = np.full((128, 128, 3), 0.5)

    def check_damage(self, candidate, metric=None):
        result = quality.evaluate(candidate, self.reference)
        self.assertEqual(result["status"], "failed")
        if metric:
            self.assertIn(metric, [row["metric"] for row in result["breaches"]])

    def test_identical_image_passes(self):
        self.assertEqual(
            quality.evaluate(self.reference, self.reference)["status"], "passed"
        )

    def test_one_code_value_rounding_passes(self):
        self.assertEqual(
            quality.evaluate(self.reference + 1 / 255, self.reference)["status"],
            "passed",
        )

    def test_balanced_errors_no_longer_cancel(self):
        damaged = self.reference.copy()
        damaged[:, :64] += 0.2
        damaged[:, 64:] -= 0.2
        bands = legacy.per_band_bias(damaged, self.reference)
        self.assertLess(
            max(abs(row[ch]) for row in bands.values() for ch in "RGB"), 1e-10
        )
        self.check_damage(damaged, "mean_absolute_channel_error")

    def test_alternating_pixel_damage_is_not_blurred_in_array_checks(self):
        damaged = self.reference.copy()
        damaged[:, ::2] += 0.2
        damaged[:, 1::2] -= 0.2
        self.check_damage(damaged, "gradient_mean_absolute_channel_error")

    def test_native_checkerboard_cannot_disappear_through_display_downsampling(self):
        reference = np.full((2048, 32, 3), 0.5)
        candidate = reference.copy()
        candidate[::2] += 0.2
        candidate[1::2] -= 0.2
        result = quality.native_absolute(candidate, reference, 0.05)
        self.assertEqual(result["status"], "failed")
        self.assertGreater(result["means"]["full-frame"][0], 0.19)

    def test_color_cast(self):
        damaged = self.reference.copy()
        damaged[..., 1] += 0.15
        self.check_damage(damaged, "mean_delta_e_2000")

    def test_local_damage_not_hidden_in_global_mean(self):
        damaged = self.reference.copy()
        damaged[32:48, 32:48, 0] += 0.4
        self.assertLess(np.abs(damaged - self.reference).mean(), 0.01)
        self.check_damage(damaged, "tile_mean_absolute_channel_error")

    def test_border_damage_is_not_discarded(self):
        damaged = self.reference.copy()
        damaged[:8] = 0
        self.check_damage(damaged, "tile_mean_absolute_channel_error")

    def test_crushed_shadows(self):
        self.reference[:] = 0.12
        self.check_damage(
            np.zeros_like(self.reference), "newly_clipped_channel_fraction"
        )

    def test_blown_highlights(self):
        self.reference[:] = 0.85
        self.check_damage(
            np.ones_like(self.reference), "newly_clipped_channel_fraction"
        )

    def test_posterized_ramp(self):
        self.reference = np.repeat(
            np.linspace(0.05, 0.95, 128)[None, :, None], 128, axis=0
        )
        self.reference = np.repeat(self.reference, 3, axis=2)
        self.check_damage(
            np.round(self.reference * 3) / 3, "p95_absolute_channel_error"
        )

    def test_spatially_scrambled_image(self):
        self.reference[:, :64] = [0.1, 0.3, 0.6]
        self.reference[:, 64:] = [0.8, 0.6, 0.2]
        self.check_damage(self.reference[:, ::-1])

    def test_nonfinite_fails_closed(self):
        candidate = self.reference.copy()
        candidate[0, 0, 0] = np.nan
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            quality.evaluate(candidate, self.reference)

    def test_mismatched_geometry_fails_closed(self):
        with self.assertRaises(ValueError):
            quality.evaluate(self.reference[:64], self.reference)

    def test_invalid_range_fails_closed(self):
        with self.assertRaises(ValueError):
            quality.evaluate(self.reference + 1, self.reference)


class PhotographicRegressions(unittest.TestCase):
    def test_all_sixteen_saved_photographs(self):
        root = Path(__file__).resolve().parents[2] / "test-fixtures/auto-jpeg-quality"
        manifest = json.loads((root / "manifest.json").read_text())
        self.assertEqual(len(manifest["cases"]), 16)
        self.assertEqual(len({row["fixture"] for row in manifest["cases"]}), 16)
        for row in manifest["cases"]:
            for file in row["files"].values():
                with (root / file["path"]).open("rb") as stream:
                    self.assertEqual(
                        hashlib.file_digest(stream, "sha256").hexdigest(),
                        file["sha256"],
                    )
            reference = root / row["files"]["reference"]["path"]
            with self.subTest(fixture=row["fixture"], variant="identity"):
                self.assertEqual(
                    quality.compare(reference, reference)["status"], "passed"
                )
            for variant in ["original", "rejected"]:
                with self.subTest(fixture=row["fixture"], variant=variant):
                    result = quality.compare_unaligned(
                        root / row["files"][variant]["path"], reference
                    )
                    self.assertEqual(result["status"], row[variant + "_expected"])


if __name__ == "__main__":
    unittest.main()
