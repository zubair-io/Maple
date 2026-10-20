#!/usr/bin/env python3
"""Geometry correspondence must never conceal color or detail damage (#5000)."""

import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import auto_profile_alignment as alignment
import auto_profile_quality as quality
import auto_profile_registration as registration
import numpy as np


def scene(size=128):
    y, x = np.mgrid[:size, :size] / size
    rng = np.random.default_rng(5000)
    values = np.zeros((size, size))
    for _ in range(45):
        cx, cy, amplitude, radius = (
            rng.uniform(0, 1),
            rng.uniform(0, 1),
            rng.uniform(-1, 1),
            rng.uniform(0.015, 0.10),
        )
        values += amplitude * np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (radius**2))
    values = 0.15 + 0.7 * (values - values.min()) / (values.max() - values.min())
    return np.repeat(values[..., None], 3, axis=2)


class AlignmentTests(unittest.TestCase):
    def test_identity_is_exact_and_full_support(self):
        ref = scene()
        matched, valid, report = alignment.align(ref, ref)
        self.assertIs(matched, ref)
        self.assertTrue(valid.all())
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["candidate_overlap"], 1.0)

    def test_affine_recovers_coordinates_without_modifying_candidate(self):
        ref = scene()
        expected = np.array([[1.005, 0.003, -0.006], [-0.002, 1.003, -0.001]])
        cand, valid = alignment.resample_reference(ref, expected)
        before = cand.copy()
        matched, support, report = alignment.align(cand, ref)
        self.assertEqual(report["status"], "passed", report)
        actual = np.array(report["candidate_to_reference_normalized"])
        grid = np.array([[x, y, 1] for x in (0, 0.5, 1) for y in (0, 0.5, 1)])
        self.assertLess(np.max(np.abs(grid @ (actual - expected).T)) * 128, 0.35)
        self.assertTrue(np.array_equal(cand, before))
        self.assertLess(np.abs(cand - matched)[valid & support].mean(), 0.005)

    def test_cast_and_contrast_changes_remain_failures(self):
        ref = scene()
        for candidate in [np.clip(ref + [0.12, 0, 0], 0, 1), 0.5 + (ref - 0.5) * 0.4]:
            with self.subTest(kind=float(candidate.mean())):
                matched, valid, report = alignment.align(candidate, ref)
                self.assertEqual(report["status"], "passed", report)
                self.assertEqual(
                    quality.evaluate(candidate, matched, valid)["status"], "failed"
                )

    def test_checkerboard_damage_is_not_smoothed_away(self):
        ref = scene()
        y, x = np.indices(ref.shape[:2])
        cand = np.clip(ref + np.where((x + y) % 2, 0.15, -0.15)[..., None], 0, 1)
        matched, valid, _report = alignment.align(cand, ref)
        result = quality.evaluate(cand, matched, valid)
        self.assertEqual(result["status"], "failed")
        self.assertTrue(
            any(
                b["metric"] == "gradient_mean_absolute_channel_error"
                for b in result["breaches"]
            )
        )

    def test_excess_field_loss_fails_both_direction_and_tiles(self):
        ref = scene()
        for warp in [
            np.array([[1.0, 0, 0.12], [0, 1.0, 0]]),
            np.array([[0.8, 0, 0.1], [0, 0.8, 0.1]]),
        ]:
            with patch.object(registration, "estimate", return_value=(warp, [])):
                _, _, report = alignment.align(ref, ref)
            self.assertEqual(report["status"], "failed")
            self.assertTrue(
                any(b["metric"] == "geometry_overlap" for b in report["breaches"])
            )
            self.assertTrue(
                any(b["metric"] == "geometry_tile_overlap" for b in report["breaches"])
            )

    def test_structural_failure_cannot_pass(self):
        ref = scene()
        with patch.object(registration, "estimate", side_effect=ValueError("no match")):
            _, _, report = alignment.align(ref, ref)
        self.assertEqual(report["status"], "failed")

    def test_invalid_pixels_are_not_hidden_by_support(self):
        ref = scene()
        cand = ref.copy()
        cand[0, 0] = np.nan
        valid = np.ones(ref.shape[:2], dtype=bool)
        valid[0, 0] = False
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            quality.evaluate(cand, ref, valid)

    def test_gradients_use_only_adjacent_supported_scene_points(self):
        ref = scene()
        cand = ref.copy()
        cand[:3] = 1 - ref[:3]
        valid = np.ones(ref.shape[:2], dtype=bool)
        valid[:3] = False
        self.assertEqual(quality.evaluate(cand, ref, valid)["status"], "passed")
        self.assertEqual(
            quality.native_absolute(cand, ref, 0.05, valid)["status"], "passed"
        )


class PhotographicAlignmentTests(unittest.TestCase):
    def test_saved_photographs_and_damage_across_all_sixteen_images(self):
        root = Path(__file__).resolve().parents[2] / "test-fixtures/auto-jpeg-quality"
        cases = json.loads((root / "manifest.json").read_text())["cases"]
        self.assertEqual(len(cases), 16)
        numeric_controls = {
            # The 384px original clears fixed display limits once its radial
            # misalignment is removed. The damaged variant must still fail.
            # This is not acceptance of the full-resolution RAF fixture.
            ("test_0005", "original"),
            ("test_0002", "original"),
            ("test_0002", "rejected"),
            ("test_0014", "rejected"),
            ("test_0011", "original"),
        }
        for case in cases:
            for file in case["files"].values():
                self.assertEqual(
                    hashlib.sha256((root / file["path"]).read_bytes()).hexdigest(),
                    file["sha256"],
                )
            reference = root / case["files"]["reference"]["path"]
            for variant in ("original", "rejected"):
                with self.subTest(fixture=case["fixture"], variant=variant):
                    result = quality.compare(
                        root / case["files"][variant]["path"], reference
                    )
                    self.assertEqual(result["alignment"]["status"], "passed")
                    expected = (
                        "passed"
                        if (case["fixture"], variant) in numeric_controls
                        else "failed"
                    )
                    self.assertEqual(result["status"], expected)
            ref, _ = quality.load_display_pair(reference, reference)
            y, x = np.indices(ref.shape[:2])
            damages = {
                "cast": np.clip(ref + [0.15, 0, 0], 0, 1),
                "flat": 0.5 + (ref - 0.5) * 0.35,
                "checkerboard": np.clip(
                    ref + np.where((x + y) % 2, 0.2, -0.2)[..., None], 0, 1
                ),
            }
            for name, cand in damages.items():
                with self.subTest(fixture=case["fixture"], damage=name):
                    matched, valid, _geometry = alignment.align(cand, ref)
                    result = quality.evaluate(cand, matched, valid)
                    self.assertEqual(result["status"], "failed")
                    if name == "checkerboard":
                        self.assertTrue(
                            any(
                                b["metric"] == "gradient_mean_absolute_channel_error"
                                for b in result["breaches"]
                            )
                        )


if __name__ == "__main__":
    unittest.main()
