"""Known boundary, generated-detail and signed/HDR correction invariants."""

import unittest

import numpy as np
from native_seam_correction import correct


class NativeSeamCorrectionTests(unittest.TestCase):
    def test_flat_offset_recovers_signed_hdr_without_touching_known_bits(self):
        source = np.full((31, 37, 3), [-0.25, 0.18, 8.0], dtype=np.float32)
        domain = np.zeros((31, 37), dtype=bool)
        domain[3:25, 5:30] = True
        prediction = source + np.array([0.1, -0.06, 1.5], dtype=np.float32)
        result, report = correct(source, prediction, domain)
        self.assertLess(float(np.abs(result - source).max()), 1e-6)
        self.assertTrue(
            np.array_equal(
                result[~domain].view(np.uint32), source[~domain].view(np.uint32)
            )
        )
        self.assertFalse(report["clipped"])

    def test_disconnected_domains_follow_boundary_and_keep_generated_detail(self):
        y, x = np.mgrid[:41, :47]
        surface = (0.1 + x * 0.005 + y * 0.002).astype(np.float32)
        source = np.repeat(surface[:, :, None], 3, axis=2)
        domain = np.zeros((41, 47), dtype=bool)
        domain[3:16, 4:20] = True
        domain[22:35, 27:40] = True
        detail = np.zeros_like(source)
        detail[10, 12] = [0.1, -0.05, 0.2]
        prediction = source + np.float32(0.08) + detail
        result, _ = correct(source, prediction, domain)
        self.assertLess(float(np.abs(result - source - detail).max()), 1e-6)
        hidden_changed = source.copy()
        hidden_changed[domain] = [23, -11, 15]
        unchanged, _ = correct(hidden_changed, prediction, domain)
        self.assertTrue(np.array_equal(result[domain], unchanged[domain]))

    def test_no_correction_when_native_prediction_already_matches(self):
        source = np.arange(29 * 33 * 3, dtype=np.float32).reshape(29, 33, 3) / 1000
        domain = np.zeros((29, 33), dtype=bool)
        domain[8:19, 5:25] = True
        result, _ = correct(source, source.copy(), domain)
        self.assertTrue(np.array_equal(result.view(np.uint32), source.view(np.uint32)))

    def test_edge_nonfinite_or_invalid_geometry_refuses_before_solving(self):
        source = np.ones((17, 21, 3), dtype=np.float32)
        domain = np.zeros((17, 21), dtype=bool)
        domain[3:12, 4:15] = True
        for source_value, prediction_value, mask in [
            (source.astype(np.float64), source, domain),
            (source, source * np.nan, domain),
            (source, source, np.ones_like(domain)),
            (source, source, np.zeros_like(domain)),
        ]:
            with self.assertRaisesRegex(ValueError, "bounded interior domain"):
                correct(source_value, prediction_value, mask)


if __name__ == "__main__":
    unittest.main()
