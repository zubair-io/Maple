"""#3941: actual RAW/model-scale inputs, preservation and refusal controls."""

import argparse
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from probe_lama_large_scene import SIDE, load_inputs, mask_values
from probe_lama_whole_scale import MODEL_SIDE, interpolate, prepare, run


class ActualWholeScaleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.context = self.root / "context"
        self.context.mkdir()
        for p in CONTEXT.iterdir():
            (self.context / p.name).symlink_to(p.resolve())

    def change(self, name, data):
        p = self.context / name
        p.unlink()
        p.write_bytes(data)

    def test_entire_actual_native_intent_remains_selected_at_model_scale(self):
        inputs, _rgb, _hole, report = prepare(RAW, self.context)
        pins = json.loads((self.context / "inputs.json").read_text())
        recipe = json.loads((self.context / "context.json").read_text())
        (x, y, _w, _h), mask = mask_values(
            (self.context / "intent.mimf").read_bytes(), pins["source"]
        )
        ys, xs = np.nonzero(mask)
        tx = (xs + x - recipe["window"]["x"]) // 2
        ty = (ys + y - recipe["window"]["y"]) // 2
        self.assertGreater(len(xs), 1000000)
        self.assertTrue(np.all(inputs[0, 3, ty, tx] == 1))
        self.assertEqual(inputs.shape, (1, 4, MODEL_SIDE, MODEL_SIDE))
        self.assertEqual(report["nativeHolePixelsLost"], 0)
        self.assertTrue(np.all(inputs[0, :3, inputs[0, 3] == 1] == 0))

    def test_changed_actual_raw_refuses_before_inference(self):
        raw = self.root / "owned-changed.nef"
        shutil.copyfile(RAW, raw)
        with raw.open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "Original differs"):
            prepare(raw, self.context)

    def test_changed_actual_scene_refuses(self):
        data = bytearray((self.context / "scene.f32").read_bytes())
        data[0] ^= 1
        self.change("scene.f32", data)
        with self.assertRaisesRegex(ValueError, "Changed source-bound bytes"):
            prepare(RAW, self.context)

    def test_changed_actual_protection_refuses(self):
        data = bytearray((self.context / "protected.mimf").read_bytes())
        data[-1] ^= 1
        self.change("protected.mimf", data)
        with self.assertRaisesRegex(ValueError, "Changed source-bound bytes"):
            prepare(RAW, self.context)

    def test_stale_source_anchor_refuses(self):
        pins = json.loads((self.context / "inputs.json").read_text())
        pins["source"]["decode"] = "blake3:" + "0" * 64
        self.change("inputs.json", json.dumps(pins).encode())
        with self.assertRaisesRegex(ValueError, "exact native RAW"):
            prepare(RAW, self.context)

    def test_actual_generated_result_restores_every_known_input_bit(self):
        native = load_inputs(self.context)
        rgb = np.fromfile(self.context / "input.f32", "<f4").reshape(1, 3, SIDE, SIDE)
        result = np.fromfile(RESULT / "model-result.f32", "<f4").reshape(
            1, 3, MODEL_SIDE, MODEL_SIDE
        )
        output = interpolate(result, rgb, native[:, 3:4])
        known = np.broadcast_to(native[:, 3:4] == 0, rgb.shape)
        self.assertTrue(
            np.array_equal(output.view("<u4")[known], rgb.view("<u4")[known])
        )
        retained = np.fromfile(RESULT / "result.f32", "<f4").reshape(rgb.shape)
        self.assertTrue(np.array_equal(retained.view("<u4"), output.view("<u4")))

    def test_wrong_result_geometry_is_not_treated_as_native_inference(self):
        native = load_inputs(self.context)
        with self.assertRaisesRegex(ValueError, "Invalid model-scale"):
            interpolate(native[:, :3], native[:, :3], native[:, 3:4])

    def test_modified_actual_artifact_refuses_without_output_publication(self):
        artifact = self.root / "owned-changed.onnx"
        shutil.copyfile(ARTIFACT, artifact)
        with artifact.open("r+b") as stream:
            value = stream.read(1)
            stream.seek(0)
            stream.write(bytes([value[0] ^ 1]))
        output = self.root / "refused"
        with self.assertRaisesRegex(ValueError, "Unpinned LaMa"):
            run(SimpleNamespace(output=output, artifact=artifact))
        self.assertFalse(output.exists())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["raw", "context", "result", "artifact"]:
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    RAW, CONTEXT, RESULT, ARTIFACT = args.raw, args.context, args.result, args.artifact
    unittest.main(argv=["lama_whole_scale_test"], verbosity=2)
