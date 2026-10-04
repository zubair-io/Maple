"""#3941: actual-input preflight mutation controls, requiring retained fixtures.

Run with REPORT RAW POINTS MODELS INITIAL REFINED. No inference or downloads.
"""

import argparse
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from probe_smart_mask_conditioning import preflight


class ConditioningPreflightTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.args = argparse.Namespace(**vars(INPUTS))
        for name in ["report", "raw", "points", "initial", "refined"]:
            target = root / (name + Path(getattr(INPUTS, name)).suffix)
            shutil.copyfile(getattr(INPUTS, name), target)
            setattr(self.args, name, target)
        for name in ["selection-encoder.f32", "selection-proxy.rgb8"]:
            (root / name).symlink_to(INPUTS.report.parent / name)
        self.args.models = root / "models"
        self.args.models.mkdir()
        for name in ["mobile-sam-encoder.onnx", "mobile-sam-decoder.onnx"]:
            (self.args.models / name).symlink_to(INPUTS.models / name)

    def change_json(self, name, change):
        path = getattr(self.args, name)
        data = json.loads(path.read_text())
        change(data)
        path.write_text(json.dumps(data))

    def test_actual_inputs_pass(self):
        preflight(self.args)

    def test_changed_raw_rejected(self):
        with self.args.raw.open("r+b") as file:
            byte = file.read(1)[0]
            file.seek(0)
            file.write(bytes([byte ^ 1]))
        with self.assertRaisesRegex(ValueError, "Retained RAW"):
            preflight(self.args)

    def test_changed_encoder_rejected(self):
        target = self.args.report.parent / "selection-encoder.f32"
        target.unlink()
        shutil.copyfile(INPUTS.report.parent / target.name, target)
        with target.open("r+b") as file:
            byte = file.read(1)[0]
            file.seek(0)
            file.write(bytes([byte ^ 1]))
        with self.assertRaisesRegex(ValueError, "photographic encoder"):
            preflight(self.args)

    def test_changed_model_rejected(self):
        target = self.args.models / "mobile-sam-decoder.onnx"
        target.unlink()
        shutil.copyfile(INPUTS.models / target.name, target)
        with target.open("r+b") as file:
            byte = file.read(1)[0]
            file.seek(0)
            file.write(bytes([byte ^ 1]))
        with self.assertRaisesRegex(ValueError, "model checksum"):
            preflight(self.args)

    def test_wrong_neighbor_rejected(self):
        self.change_json(
            "refined", lambda value: value["prompts"][-1].update(position=[0.1, 0.1])
        )
        with self.assertRaisesRegex(ValueError, "recorded neighbor"):
            preflight(self.args)

    def test_dropped_positive_rejected(self):
        self.change_json("refined", lambda value: value["prompts"].pop(0))
        with self.assertRaisesRegex(ValueError, "unchanged intent"):
            preflight(self.args)

    def test_wrong_geometry_rejected(self):
        self.change_json("refined", lambda value: value.update(input_height=682))
        with self.assertRaisesRegex(ValueError, "exact full-frame"):
            preflight(self.args)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["report", "raw", "points", "models", "initial", "refined"]:
        parser.add_argument(name, type=Path)
    INPUTS = parser.parse_args()
    INPUTS = argparse.Namespace(
        **{name: path.resolve() for name, path in vars(INPUTS).items()}
    )
    unittest.main(argv=[sys.argv[0]], verbosity=2)
