"""Native source/guide separation and donor-support invariants for #3941."""

import unittest

import numpy as np
from guided_native_patches import refine


class GuidedNativePatchTests(unittest.TestCase):
    def test_native_one_pixel_texture_survives_without_copying_hole_or_guide(self):
        y, x = np.indices((128, 128))
        truth = np.repeat((0.3 + 0.4 * ((x + y) % 2))[:, :, None], 3, axis=2).astype(
            np.float32
        )
        hole = np.zeros((128, 128), dtype=np.bool_)
        hole[32:96, 32:96] = True
        source = truth.copy()
        source[hole] = [1, 0, 1]
        guide = np.full_like(source, 0.5)
        actual, report = refine(source, hole, guide)
        np.testing.assert_allclose(actual[hole], truth[hole], atol=1e-6, rtol=0)
        np.testing.assert_array_equal(actual[~hole], source[~hole])
        self.assertGreater(float(np.std(actual[hole])), 0.19)
        self.assertEqual(report["invalid_donors"], 0)
        self.assertEqual(report["outside_changed_samples"], 0)
        self.assertFalse(report["release_qualified"])
        again, repeated = refine(source, hole, guide)
        np.testing.assert_array_equal(actual, again)
        self.assertEqual(report, repeated)

    def test_edge_and_partial_blocks_preserve_every_unmasked_sample(self):
        source = np.random.default_rng(3941).random((48, 64, 3), dtype=np.float32)
        hole = np.zeros((48, 64), dtype=np.bool_)
        hole[0:19, 0:13] = True
        actual, report = refine(source, hole, np.full_like(source, 0.5))
        np.testing.assert_array_equal(actual[~hole], source[~hole])
        self.assertTrue(np.isfinite(actual).all())
        self.assertEqual(report["selected_source_pixels"], 19 * 13)
        self.assertEqual(report["invalid_donors"], 0)
        self.assertLessEqual(report["final_guide_mse"], report["initial_guide_mse"])

    def test_known_guide_values_are_replaced_by_actual_source(self):
        source = np.random.default_rng(3941).random((64, 64, 3), dtype=np.float32)
        hole = np.zeros((64, 64), dtype=np.bool_)
        hole[24:40, 24:40] = True
        guide = np.full_like(source, 0.5)
        changed = guide.copy()
        changed[~hole] = 1
        actual, _ = refine(source, hole, guide)
        again, _ = refine(source, hole, changed)
        np.testing.assert_array_equal(actual, again)

    def test_missing_donors_and_invalid_contexts_refuse(self):
        source = np.full((32, 32, 3), 0.5, dtype=np.float32)
        hole = np.ones((32, 32), dtype=np.bool_)
        with self.assertRaisesRegex(ValueError, "known native donor"):
            refine(source, hole, source)
        hole[:] = False
        with self.assertRaisesRegex(ValueError, "nonempty"):
            refine(source, hole, source)
        hole[12:16, 12:16] = True
        for invalid in [source.astype(np.float64), source * 3, source * np.nan]:
            with (
                self.subTest(
                    dtype=invalid.dtype, finite=bool(np.isfinite(invalid).all())
                ),
                self.assertRaises(ValueError),
            ):
                refine(invalid, hole, source)
        with self.assertRaises(ValueError):
            refine(source, hole.astype(np.uint8), source)
        with self.assertRaises(ValueError):
            refine(source[:31], hole[:31], source[:31])
        with self.assertRaises(ValueError):
            refine(source, hole, source[:16])
        with self.assertRaises(ValueError):
            refine(source, hole, source.astype(np.float64))


if __name__ == "__main__":
    unittest.main()
