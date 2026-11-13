"""Verify actual conditioning operator removes selected-detail dependence."""

import unittest

import numpy as np
from klein_erased_conditioning import erase


class KleinErasedConditioningTests(unittest.TestCase):
    def test_selected_object_content_cannot_affect_condition(self):
        y, x = np.mgrid[:32, :48]
        source = np.stack([x / 50, y / 34, (x + y) / 84], axis=-1).astype(np.float32)
        hole = np.zeros(source.shape[:2], dtype=bool)
        hole[5:25, 7:39] = True
        first = source.copy()
        first[hole] = 0.9
        second = source.copy()
        second[hole] = [0.1, 0.7, 0.3]
        a, report = erase(first, hole)
        b, _ = erase(second, hole)
        np.testing.assert_array_equal(a.view(np.uint32), b.view(np.uint32))
        np.testing.assert_array_equal(
            a[~hole].view(np.uint32), source[~hole].view(np.uint32)
        )
        self.assertFalse(report["selected_source_samples_used"])
        self.assertGreater(report["changed_selected_samples"], 0)
        self.assertLess(float(np.abs(a[hole] - source[hole]).max()), 1e-6)

    def test_disconnected_holes_preserve_known_protected_island(self):
        source = np.full((32, 48, 3), 0.25, dtype=np.float32)
        source[10:22, 19:29] = [0.9, 0.1, 0.6]
        hole = np.zeros(source.shape[:2], dtype=bool)
        hole[4:28, 4:16] = True
        hole[4:28, 32:44] = True
        source[hole] = 0.7
        result, report = erase(source, hole)
        np.testing.assert_array_equal(
            result[~hole].view(np.uint32), source[~hole].view(np.uint32)
        )
        np.testing.assert_allclose(result[hole], 0.25, atol=1e-7)
        self.assertEqual(report["known_source_bits_changed"], 0)

    def test_invalid_model_values_or_unbounded_hole_refuse(self):
        source = np.full((32, 32, 3), 0.5, dtype=np.float32)
        hole = np.zeros((32, 32), dtype=bool)
        hole[0:12, 4:20] = True
        with self.assertRaisesRegex(ValueError, "bounded interior"):
            erase(source, hole)
        hole[0] = False
        for value in [np.nan, -0.1, 1.1]:
            changed = source.copy()
            changed[3, 4, 1] = value
            with self.assertRaisesRegex(ValueError, "finite native model"):
                erase(changed, hole)


if __name__ == "__main__":
    unittest.main()
