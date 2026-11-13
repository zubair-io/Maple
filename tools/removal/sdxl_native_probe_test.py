"""Actual artifact identity and native-selection refusal before model loading."""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
from probe_sdxl_native import run, verify_models

PINS = json.loads(Path(__file__).with_name("sdxl-research-models.json").read_text())
MODEL_FIXTURE = Path("/tmp/maple-removal-models/sdxl-inpaint-native")


class SDXLNativeProbeTests(unittest.TestCase):
    def test_corrupt_metadata_refuses_before_loading_remaining_weights(self):
        first = PINS["files"][0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / first["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"!" * first["bytes"])
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                verify_models(root)

    def test_real_pinned_weights_with_changed_license_refuse(self):
        if not MODEL_FIXTURE.exists():
            self.skipTest("Actual pinned research weights are not installed")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for item in PINS["files"]:
                destination = root / item["path"]
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.link(MODEL_FIXTURE / item["path"], destination)
            license_name = PINS["license"]["file"]
            shutil.copyfile(MODEL_FIXTURE / license_name, root / license_name)
            with (root / license_name).open("ab") as stream:
                stream.write(b"\nChanged license fixture\n")
            with self.assertRaisesRegex(ValueError, "model license"):
                verify_models(root)

    def test_partial_selection_refuses_before_model_io_and_output_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path, mask_path = root / "source.png", root / "mask.png"
            Image.new("RGB", (2048, 2048), (80, 100, 120)).save(image_path)
            mask = np.zeros((2048, 2048), dtype=np.uint8)
            mask[600:1800, 700:1000] = 255
            Image.fromarray(mask).save(mask_path)
            output = root / "output"
            with self.assertRaisesRegex(ValueError, "entire selection"):
                run(root / "absent", image_path, mask_path, (0, 0, 1024, 1024), output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
