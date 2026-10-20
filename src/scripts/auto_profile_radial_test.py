"""Radial alignment preserves pixels, invertibility, coverage and damage gates."""

import unittest

import auto_profile_radial_geometry as geometry
import numpy as np


class RadialGeometryTests(unittest.TestCase):
    def setUp(self):
        self.identity = np.array([[1.0, 0, 0], [0, 1.0, 0]])
        self.size = np.array([80, 64])
        self.coefficients = np.array([0.1, 0.2, -0.1, 0.2, -0.1, 0.3, 0.003])

    def test_identity_preserves_pixels_and_full_support(self):
        image = np.random.default_rng(3).random((64, 80, 3))
        sampled, valid = geometry.resample(image, self.identity, np.zeros(7), self.size)
        np.testing.assert_allclose(sampled, image, atol=1e-12)
        self.assertTrue(valid.all())

    def test_inverse_roundtrip(self):
        points = np.random.default_rng(3).random((1000, 2))
        affine = np.array([[1.01, 0.001, -0.005], [0.002, 0.99, 0.004]])
        mapped = geometry.forward(points, affine, self.coefficients, self.size)
        restored = geometry.inverse(mapped, affine, self.coefficients, self.size)
        np.testing.assert_allclose(restored, points, atol=1e-10)

    def test_excessive_crop_fails_existing_limits(self):
        affine = np.array([[1.0, 0, 0.2], [0, 1.0, 0]])
        report = geometry.geometry_checks((64, 80), affine, np.zeros(7), self.size)
        self.assertIn("candidate coverage", report["breaches"])
        self.assertIn("reference coverage", report["breaches"])

    def test_folded_map_is_rejected(self):
        affine = np.array([[-1.0, 0, 1.0], [0, 1.0, 0]])
        report = geometry.geometry_checks((64, 80), affine, np.zeros(7), self.size)
        self.assertIn("folded geometry", report["breaches"])

    def test_native_mapping_uses_frozen_fit_coordinates(self):
        # The fit-size stays fixed when sampling a higher-resolution image.
        # Both images encode normalized coordinates as RGB.
        def ramp(w, h):
            y, x = np.mgrid[:h, :w]
            return np.stack([(x + 0.5) / w, (y + 0.5) / h, np.zeros_like(x)], axis=2)

        low, valid = geometry.resample(
            ramp(80, 64), self.identity, self.coefficients, self.size
        )
        points = np.array([[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]])
        mapped = geometry.forward(points, self.identity, self.coefficients, self.size)
        restored = geometry.inverse(mapped, self.identity, self.coefficients, self.size)
        np.testing.assert_allclose(restored, points, atol=1e-10)
        high, _ = geometry.resample(
            ramp(160, 128), self.identity, self.coefficients, self.size
        )
        # Average the 2x2 high-resolution samples to the same pixel centers.
        averaged = high.reshape(64, 2, 80, 2, 3).mean(axis=(1, 3))
        interior = valid.copy()
        interior[:3] = interior[-3:] = False
        interior[:, :3] = interior[:, -3:] = False
        np.testing.assert_allclose(low[interior], averaged[interior], atol=2e-6)


if __name__ == "__main__":
    unittest.main()
