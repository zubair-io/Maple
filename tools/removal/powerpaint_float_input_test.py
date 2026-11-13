"""Verify float precision through the actual pinned upstream image preparation."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch
from diffusers.image_processor import VaeImageProcessor
from native_probe_pixels import digest, float_source
from PIL import Image
from powerpaint_native_pixels import VaeBoundaries, conditioning, raw_candidate
from probe_powerpaint_native import run

SOURCE = Path.home() / ".cache/maple-removal-research/powerpaint-source"


class PowerPaintFloatInputTests(unittest.TestCase):
    def test_legacy_u8_conditioning_retains_native_proxy_samples(self):
        proxy = np.random.default_rng(3941).integers(
            0, 256, (1024, 1024, 3), dtype=np.uint8
        )
        source = proxy.astype(np.float32) / np.float32(255)
        hole = np.zeros((1024, 1024), dtype=bool)
        hole[400:600, 400:600] = True
        image, _, expected, _ = conditioning(
            source,
            hole,
            VaeImageProcessor(vae_scale_factor=8, do_convert_rgb=True),
            False,
        )
        self.assertIsInstance(image, Image.Image)
        self.assertTrue(np.array_equal(np.asarray(image)[~hole], proxy[~hole]))
        self.assertTrue(torch.all(expected[:, :, hole] == -1))

    def test_distinct_sub_u8_pixels_reach_pinned_upstream_unchanged(self):
        if not SOURCE.exists():
            self.skipTest("Actual pinned PowerPaint source is not installed")
        path = "powerpaint/pipelines/pipeline_PowerPaint_Brushnet_CA.py"
        pins = json.loads(
            Path(__file__).with_name("powerpaint-research-models.json").read_text()
        )
        pin = next(row for row in pins["sourceFiles"] if row["path"] == path)
        self.assertEqual(digest(SOURCE / path), pin["sha256"])
        sys.path.insert(0, str(SOURCE))
        from powerpaint.pipelines.pipeline_PowerPaint_Brushnet_CA import (
            StableDiffusionPowerPaintBrushNetPipeline,
        )

        source = np.full((1024, 1024, 3), 0.5, dtype=np.float32)
        source[10, 10] = [0.50001, 0.50002, 0.50003]
        source[10, 11] = [0.50004, 0.50005, 0.50006]
        self.assertTrue(
            np.array_equal(
                np.floor(source[10, 10] * 255 + 0.5),
                np.floor(source[10, 11] * 255 + 0.5),
            )
        )
        hole = np.zeros((1024, 1024), dtype=bool)
        hole[400:600, 400:600] = True
        processor = VaeImageProcessor(vae_scale_factor=8, do_convert_rgb=True)
        image, mask, expected, _ = conditioning(source, hole, processor, True)
        prepared = StableDiffusionPowerPaintBrushNetPipeline.prepare_image(
            SimpleNamespace(image_processor=processor),
            image,
            1024,
            1024,
            1,
            1,
            "cpu",
            torch.float32,
            do_classifier_free_guidance=True,
        )
        self.assertTrue(torch.equal(prepared, expected.repeat(2, 1, 1, 1)))
        self.assertFalse(torch.equal(prepared[0, :, 10, 10], prepared[0, :, 10, 11]))
        self.assertTrue(torch.all(prepared[:, :, hole] == -1))
        prepared_mask = StableDiffusionPowerPaintBrushNetPipeline.prepare_image(
            SimpleNamespace(image_processor=processor),
            mask,
            1024,
            1024,
            1,
            1,
            "cpu",
            torch.float32,
            do_classifier_free_guidance=True,
        )
        known_mask = (prepared_mask.sum(1)[:, None] < 0).numpy()
        self.assertTrue(np.array_equal(known_mask[0, 0], ~hole))

    def test_float_proxy_mismatch_refuses_before_model_io(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image, mask, floats = (
                root / "source.png",
                root / "mask.png",
                root / "input.f32",
            )
            Image.new("RGB", (1024, 1024), (128, 128, 128)).save(image)
            values = np.zeros((1024, 1024), dtype=np.uint8)
            values[400:600, 400:600] = 255
            Image.fromarray(values).save(mask)
            np.full((3, 1024, 1024), 0.1, dtype="<f4").tofile(floats)
            output = root / "output"
            with self.assertRaisesRegex(ValueError, "differs from its native proxy"):
                run(root, root, image, mask, (0, 0, 1024, 1024), output, floats)
            self.assertFalse(output.exists())

    def test_float_geometry_nonfinite_and_range_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.f32"
            proxy = np.zeros((8, 8, 3), dtype=np.uint8)
            np.zeros(10, dtype="<f4").tofile(path)
            with self.assertRaisesRegex(ValueError, "geometry"):
                float_source(path, proxy)
            np.zeros((3, 8, 8), dtype="<f4").tofile(path)
            with path.open("ab") as stream:
                stream.write(b"!")
            with self.assertRaisesRegex(ValueError, "geometry"):
                float_source(path, proxy)
            for invalid in (np.nan, np.inf, -0.01, 1.01):
                values = np.zeros((3, 8, 8), dtype="<f4")
                values[0, 0, 0] = invalid
                values.tofile(path)
                with self.assertRaisesRegex(ValueError, "invalid"):
                    float_source(path, proxy)

    def test_missing_boundary_or_step_evidence_refuses(self):
        with tempfile.TemporaryDirectory() as directory:
            barrier = VaeBoundaries(torch.zeros((1, 3, 8, 8)), Path(directory))
            with self.assertRaisesRegex(ValueError, "boundary evidence"):
                barrier.verify_complete([], 30)
            barrier.encoded.append({})
            barrier.decoded.append({})
            with self.assertRaisesRegex(ValueError, "diffusion steps"):
                barrier.verify_complete([{"index": 0}], 30)

    def test_decoder_evidence_preserves_out_of_range_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            barrier = VaeBoundaries(torch.zeros((1, 3, 8, 8)), root)
            decoded = torch.zeros((1, 3, 8, 8))
            decoded[0, 0, 0, 0] = -1.1
            decoded[0, 1, 0, 0] = 1.1
            barrier.decode(None, (), decoded)
            values = np.fromfile(root / "decoder-model-nchw.f32", dtype="<f4")
            self.assertLess(values.min(), 0)
            self.assertGreater(values.max(), 1)
            self.assertEqual(barrier.decoded[0]["out_of_model_range_samples"], 2)

    def test_raw_candidate_keeps_source_bits_and_rejectable_selected_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = np.full((8, 8, 3), 0.50004, dtype=np.float32)
            decoder = np.zeros((3, 8, 8), dtype="<f4")
            decoder[0, 3, 3] = -0.01
            decoder.tofile(root / "decoder-model-nchw.f32")
            hole = np.zeros((8, 8), dtype=bool)
            hole[3, 3] = True
            report = raw_candidate(root, source, hole)
            values = np.fromfile(root / "raw-candidate-nchw.f32", dtype="<f4")
            candidate = values.reshape(3, 8, 8).transpose(1, 2, 0).copy()
            self.assertEqual(report["outside_float_bits_changed"], 0)
            self.assertEqual(report["generation_out_of_model_range_samples"], 1)
            self.assertTrue(np.array_equal(candidate[~hole], source[~hole]))
            self.assertLess(candidate[3, 3, 0], 0)


if __name__ == "__main__":
    unittest.main()
