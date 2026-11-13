"""Pinned actual source/model rejection and native packed-latent guards."""

import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

import mlx.core as mx
import numpy as np
from probe_klein_native import (
    NativeSteps,
    float_source,
    native_dimensions,
    source_tree_digest,
    verify_model,
    verify_source,
)

PINS = json.loads(Path(__file__).with_name("klein-research-models.json").read_text())
MODEL = Path("/tmp/maple-removal-models/klein4b-mlx8bit")
SOURCE = Path("/tmp/maple-removal-mlx-gen-source")


class KleinNativeProbeTests(unittest.TestCase):
    def test_float_native_input_keeps_subcode_values_and_refuses_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.f32"
            values = np.full((3, 16, 16), 0.1234567, dtype="<f4")
            values.tofile(path)
            proxy = np.rint(values.transpose(1, 2, 0) * 255).astype(np.uint8)
            actual = float_source(path, proxy)
            self.assertTrue(np.array_equal(actual, values.transpose(1, 2, 0)))
            self.assertFalse(np.array_equal(actual, proxy.astype(np.float32) / 255))
            changed = proxy.copy()
            changed[0, 0, 0] += 1
            with self.assertRaisesRegex(ValueError, "differs from its native proxy"):
                float_source(path, changed)
            np.full((3, 16, 16), np.nan, dtype="<f4").tofile(path)
            with self.assertRaisesRegex(ValueError, "Float input is invalid"):
                float_source(path, proxy)
            ties = np.full((3, 16, 16), np.float32(10.5) / 255, dtype="<f4")
            ties.tofile(path)
            self.assertTrue(
                np.array_equal(
                    float_source(path, np.full((16, 16, 3), 11, dtype=np.uint8)),
                    ties.transpose(1, 2, 0),
                )
            )

    def test_actual_source_pin_matches_and_changed_tree_is_rejected(self):
        if not SOURCE.exists():
            self.skipTest("Pinned upstream research source is not installed")
        verify_source(SOURCE, PINS["runtimeSource"])
        changed = {**PINS["runtimeSource"], "python_tree_sha256": "0" * 64}
        with self.assertRaisesRegex(ValueError, "changed upstream"):
            verify_source(SOURCE, changed)

    def test_tree_identity_covers_extra_python_not_just_tracked_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src").mkdir()
            (root / "src" / "a.py").write_text("value = 1\n")
            before = source_tree_digest(root)
            (root / "src" / "extra.py").write_text("value = 2\n")
            self.assertNotEqual(before, source_tree_digest(root))

    def test_actual_model_with_changed_official_license_refuses(self):
        if not MODEL.exists():
            self.skipTest("Pinned local research weights are not installed")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = [*PINS["files"], *PINS["baseModel"]["records"]]
            license_name = "LICENSE-KLEIN-OFFICIAL.md"
            for item in records:
                target = root / item["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                if item["path"] == license_name:
                    shutil.copyfile(MODEL / item["path"], target)
                else:
                    os.link(MODEL / item["path"], target)
            with (root / license_name).open("ab") as stream:
                stream.write(b"\nChanged license fixture\n")
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                verify_model(root, PINS)

    def test_floor16_or_nonfinite_latents_cannot_be_reported_as_native(self):
        native_dimensions((384, 384, 1024, 1536))
        with self.assertRaisesRegex(ValueError, "divisible by 16"):
            native_dimensions((384, 384, 1032, 1536))
        config = SimpleNamespace(height=1536, width=1024)
        steps = NativeSteps(1536, 1024, time.perf_counter())
        for values in [
            mx.zeros((1, 6143, 128)),
            mx.full((1, 6144, 128), float("nan")),
        ]:
            with self.assertRaisesRegex(ValueError, "Invalid native"):
                steps.call_in_loop(t=0, latents=values, config=config)
        self.assertEqual(steps.rows, [])


if __name__ == "__main__":
    unittest.main()
