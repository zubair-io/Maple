"""Native selection admission without loading a model or producing an edit."""

import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
from probe_guided_native import run, source_hole


class GuidedNativeProbeTests(unittest.TestCase):
    def test_native_mask_and_rectangle_select_the_same_source_pixels(self):
        rectangle = (101, 401, 701, 1201)
        expected = source_hole(rectangle, None)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mask.png"
            Image.fromarray(expected.astype(np.uint8) * 255).save(path)
            np.testing.assert_array_equal(source_hole(None, path), expected)
        self.assertEqual(int(expected.sum()), 701 * 1201)
        self.assertFalse(expected[400, 101])
        self.assertFalse(expected[401, 802])

    def test_refuses_resized_rgb_gray_empty_and_full_masks(self):
        invalid = [
            np.zeros((1024, 1024), dtype=np.uint8),
            np.zeros((2048, 2048, 3), dtype=np.uint8),
            np.full((2048, 2048), 128, dtype=np.uint8),
            np.zeros((2048, 2048), dtype=np.uint8),
            np.full((2048, 2048), 255, dtype=np.uint8),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.png"
            for values in invalid:
                Image.fromarray(values).save(path)
                with (
                    self.subTest(shape=values.shape, value=values.flat[0]),
                    self.assertRaises(ValueError),
                ):
                    source_hole(None, path)

    def test_selection_refusal_precedes_model_io_and_output_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            with self.assertRaisesRegex(ValueError, "inside"):
                run(root / "absent.onnx", root / "absent.png", (0, 0, 2049, 10), output)
            self.assertFalse(output.exists())

    def test_refuses_conflicting_missing_and_outside_selections(self):
        with self.assertRaisesRegex(ValueError, "Choose one"):
            source_hole(None, None)
        with self.assertRaisesRegex(ValueError, "Choose one"):
            source_hole((0, 0, 10, 10), Path("unused.png"))
        for rectangle in [(-1, 0, 10, 10), (0, 0, 0, 10), (0, 0, 10, 2049)]:
            with self.subTest(rectangle=rectangle), self.assertRaises(ValueError):
                source_hole(rectangle, None)


if __name__ == "__main__":
    unittest.main()
