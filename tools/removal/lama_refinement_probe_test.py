"""Admission and saved native-pixel invariants for the feature-refinement probe."""

import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
from probe_lama_refinement import native_context, save_result, upstream_helpers


class LaMaRefinementProbeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.image_path = self.root / "image.png"
        self.mask_path = self.root / "mask.png"
        self.source = np.random.default_rng(3941).integers(
            0, 256, (2048, 2048, 3), dtype=np.uint8
        )
        self.mask = np.zeros((2048, 2048), dtype=np.uint8)
        self.mask[600:1790, 700:1100] = 255
        Image.fromarray(self.source).save(self.image_path)
        Image.fromarray(self.mask).save(self.mask_path)

    def test_native_crop_preserves_source_samples_and_complete_mask(self):
        source, hole = native_context(
            self.image_path, self.mask_path, (384, 384, 1024, 1536)
        )
        np.testing.assert_array_equal(source, self.source[384:1920, 384:1408])
        np.testing.assert_array_equal(hole, self.mask[384:1920, 384:1408] == 255)
        self.assertEqual(int(hole.sum()), 1190 * 400)

    def test_refuses_partial_selection_and_context_resizing(self):
        for crop in [
            (650, 384, 512, 1536),
            (0, 0, 1024, 1024),
            (0, 0, 2048, 2048),
            (384, 384, 1025, 1536),
            (-1, 384, 1024, 1536),
            (384, 384, 256, 1536),
            (1400, 384, 1024, 1536),
        ]:
            with self.subTest(crop=crop), self.assertRaises(ValueError):
                native_context(self.image_path, self.mask_path, crop)

    def test_refuses_nonbinary_rgb_and_incompatible_masks(self):
        for mask in [
            np.zeros((1024, 1024), dtype=np.uint8),
            np.zeros((2048, 2048, 3), dtype=np.uint8),
            np.full((2048, 2048), 128, dtype=np.uint8),
            np.zeros((2048, 2048), dtype=np.uint8),
        ]:
            Image.fromarray(mask).save(self.mask_path)
            with (
                self.subTest(shape=mask.shape, value=mask.flat[0]),
                self.assertRaises(ValueError),
            ):
                native_context(self.image_path, self.mask_path, (384, 384, 1024, 1536))

    def test_saved_float_and_png_preserve_every_known_sample(self):
        source = self.source[:32, :32].astype(np.float32) / np.float32(255)
        hole = np.zeros((32, 32), dtype=np.bool_)
        hole[3:21, 7:29] = True
        generated = np.full_like(source, np.nan)
        generated[hole] = 0.25
        report = save_result(self.root, "result", generated, source, hole)
        saved = np.fromfile(self.root / "result.f32", dtype="<f4").reshape(source.shape)
        with Image.open(self.root / "result.png") as image:
            saved_u8 = np.asarray(image)
        np.testing.assert_array_equal(
            saved[~hole].view(np.uint32), source[~hole].view(np.uint32)
        )
        np.testing.assert_array_equal(saved_u8[~hole], self.source[:32, :32][~hole])
        np.testing.assert_array_equal(saved[hole], np.full_like(saved[hole], 0.25))
        self.assertEqual(report["outside_float_bits_changed"], 0)
        self.assertEqual(report["outside_u8_samples_changed"], 0)
        generated[hole] = np.nan
        with self.assertRaises(ValueError):
            save_result(self.root, "invalid", generated, source, hole)
        self.assertFalse((self.root / "invalid.f32").exists())

    def test_unpinned_helper_source_is_rejected_before_execution(self):
        source = self.root / "changed.py"
        sentinel = self.root / "executed"
        source.write_text(
            f"from pathlib import Path\nPath({str(sentinel)!r}).touch()\n"
        )
        with self.assertRaisesRegex(ValueError, "Unexpected upstream"):
            upstream_helpers(source)
        self.assertFalse(sentinel.exists())


if __name__ == "__main__":
    unittest.main()
