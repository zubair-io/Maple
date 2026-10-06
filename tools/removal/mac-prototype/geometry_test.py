"""Real mask/coordinate checks for the native research boundary (#4323)."""

import unittest

import numpy as np
from geometry import expanded_masks, masks, orient, window
from PIL import Image


class GeometryTests(unittest.TestCase):
    def test_all_exif_orientations_round_trip_exact_pixels(self):
        source = np.arange(35, dtype="uint8").reshape(5, 7)
        for orientation in range(1, 9):
            upright = orient(Image.fromarray(source), orientation)
            restored = orient(upright, orientation, inverse=True)
            np.testing.assert_array_equal(source, np.asarray(restored))

    def test_upright_paint_maps_to_correct_native_pixel_for_all_orientations(self):
        native = np.zeros((400, 600), dtype="uint8")
        native[100, 450] = 255
        for orientation in range(1, 9):
            upright = np.asarray(orient(Image.fromarray(native), orientation))
            y, x = np.argwhere(upright)[0]
            h, w = upright.shape
            metadata = {
                "width": 600,
                "height": 400,
                "displayWidth": w,
                "displayHeight": h,
                "orientation": orientation,
            }
            stroke = {
                "mode": "remove",
                "radius": 0.001,
                "points": [[float(x) / (w - 1), float(y) / (h - 1)]],
            }
            selection, protected = masks([stroke], metadata)
            self.assertTrue(selection[100, 450])
            self.assertFalse(protected.any())
            self.assertLess(selection.sum(), 10)

    def test_protection_wins_and_erase_removes_both(self):
        metadata = {"displayWidth": 600, "displayHeight": 400, "orientation": 1}
        remove = {"mode": "remove", "radius": 0.02, "points": [[0.5, 0.5]]}
        protect = {**remove, "mode": "protect"}
        erase = {**remove, "mode": "erase", "radius": 0.03}
        selected, protected = masks([remove, protect, remove], metadata)
        self.assertFalse(selected.any())
        self.assertTrue(protected.any())
        selected, protected = masks([remove, protect, erase], metadata)
        self.assertFalse(selected.any())
        self.assertFalse(protected.any())

    def test_context_contains_complete_selection_and_expansion(self):
        selected = np.zeros((3000, 4000), bool)
        selected[1250:1750, 1700:2100] = True
        x, y, n = window(selected)
        self.assertEqual(n, 1024)
        local = selected[y : y + n, x : x + n]
        protect = np.zeros_like(local)
        protect[500, 500] = True
        expanded, hole = expanded_masks(local, protect, n)
        self.assertFalse(expanded[500, 500])
        self.assertFalse(expanded[[0, -1]].any())
        self.assertFalse(expanded[:, [0, -1]].any())
        self.assertEqual(hole.shape, (512, 512))
        self.assertEqual(local.sum(), selected.sum())

    def test_empty_and_oversize_refuse(self):
        with self.assertRaises(ValueError):
            window(np.zeros((2048, 2048), bool))
        with self.assertRaises(ValueError):
            window(np.ones((4000, 4000), bool))

    def test_invalid_strokes_refuse(self):
        for point in ([float("nan"), 0.5], [-0.1, 0.5], [1.1, 0.5]):
            with self.assertRaises(ValueError):
                masks(
                    [{"mode": "remove", "radius": 0.02, "points": [point]}],
                    {"displayWidth": 600, "displayHeight": 400, "orientation": 1},
                )


if __name__ == "__main__":
    unittest.main()
