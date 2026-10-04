"""#3941: actual native2048 grade-image mutation controls; no fake fixtures.

Run with CONTEXT BAKE RESULT. All mutations are isolated temporary copies.
"""

import argparse
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
from probe_lama_large_scene import SIDE, mask_values
from verify_large_photo_bake import verify


class ActualLargeBakeVerifierTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bake = self.root / "bake"
        self.bake.mkdir()
        for path in INPUTS.bake.iterdir():
            (self.bake / path.name).symlink_to(path.resolve())
        self.output = self.root / "verification.json"

    def report_change(self, change):
        path = self.bake / "report.json"
        data = json.loads(path.read_text())
        path.unlink()
        change(data)
        path.write_text(json.dumps(data))

    def image_change(self, path, x, y):
        with Image.open(path) as image:
            data = np.array(image)
        path.unlink()
        if data.ndim == 2:
            data[y, x] ^= 255
        else:
            data[y, x, 0] ^= 1
        Image.fromarray(data).save(path)

    def assert_refused(self, message, result=None):
        with self.assertRaisesRegex(ValueError, message):
            verify(INPUTS.context, self.bake, result or INPUTS.result, self.output)
        self.assertFalse(self.output.exists())

    def test_actual_eighteen_native_grades_pass(self):
        verify(INPUTS.context, self.bake, INPUTS.result, self.output)
        data = json.loads(self.output.read_text())
        self.assertEqual(len(data["grades"]), 18)
        self.assertGreater(data["protectedNativePixels"], 0)
        self.assertFalse(data["releaseQualified"])

    def test_wrong_source_report_refuses(self):
        self.report_change(lambda value: value.update(original="blake3:" + "0" * 64))
        self.assert_refused("bound native source")

    def test_changed_actual_result_refuses(self):
        result = self.root / "changed-result.f32"
        shutil.copyfile(INPUTS.result, result)
        with result.open("r+b") as file:
            byte = file.read(1)[0]
            file.seek(0)
            file.write(bytes([byte ^ 1]))
        self.assert_refused("model result", result)

    def test_missing_grade_refuses(self):
        self.report_change(lambda value: value["grades"].pop())
        self.assert_refused("native grade cases")

    def test_wrong_native_window_refuses(self):
        self.report_change(lambda value: value["native_context"].update(x=0))
        self.assert_refused("bound native source")

    def test_changed_coverage_refuses(self):
        self.image_change(self.bake / "coverage.png", 0, 0)
        self.assert_refused("actual shared native mask")

    def test_changed_known_identity_sample_refuses(self):
        planes = np.fromfile(INPUTS.context / "masks.f32", "<f4").reshape(2, SIDE, SIDE)
        y, x = np.argwhere(planes[1] == 0)[0]
        self.image_change(
            self.bake / "neutral_ev-3_wb-1000-identity.png", int(x), int(y)
        )
        self.assert_refused("Known/protected grade sample")

    def test_changed_protected_removal_sample_refuses(self):
        pins = json.loads((INPUTS.context / "inputs.json").read_text())
        window = json.loads((INPUTS.context / "context.json").read_text())["window"]
        (x, y, _w, _h), protected = mask_values(
            (INPUTS.context / "protected.mimf").read_bytes(), pins["source"]
        )
        ys, xs = np.nonzero(protected)
        tx, ty = xs + x - window["x"], ys + y - window["y"]
        inside = (tx >= 0) & (ty >= 0) & (tx < SIDE) & (ty < SIDE)
        sx, sy = int(tx[inside][0]), int(ty[inside][0])
        self.image_change(self.bake / "auto_ev+0_wb+0-removal.png", sx, sy)
        self.assert_refused("Known/protected grade sample")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["context", "bake", "result"]:
        parser.add_argument(name, type=Path)
    parsed = parser.parse_args()
    INPUTS = argparse.Namespace(
        **{name: path.resolve() for name, path in vars(parsed).items()}
    )
    unittest.main(argv=[sys.argv[0]], verbosity=2)
