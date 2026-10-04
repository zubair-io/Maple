"""#3941: mandatory actual RAW-context validation and pre-inference refusals."""

import argparse
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import blake3
import numpy as np
from probe_lama_large_scene import SIDE, load_inputs


class ActualLargeContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for path in CONTEXT.iterdir():
            (self.root / path.name).symlink_to(path.resolve())

    def change(self, name, data):
        target = self.root / name
        target.unlink()
        target.write_bytes(data)

    def edit(self, name, transform):
        value = json.loads((self.root / name).read_text())
        transform(value)
        self.change(name, json.dumps(value).encode())

    def test_actual_full_intent_and_canonical_float_context(self):
        inputs = load_inputs(self.root)
        self.assertEqual(inputs.shape, (1, 4, SIDE, SIDE))
        self.assertGreater(inputs[0, 3].sum(), 1000000)
        self.assertTrue(np.all(inputs[0, :3, inputs[0, 3] == 1] == 0))

    def test_proxy_geometry_refuses(self):
        self.edit("context.json", lambda v: v["window"].update(width=1024))
        with self.assertRaisesRegex(ValueError, "exact native RAW"):
            load_inputs(self.root)

    def test_changed_source_anchor_refuses(self):
        self.edit(
            "inputs.json", lambda v: v["source"].update(decode="blake3:" + "0" * 64)
        )
        with self.assertRaisesRegex(ValueError, "exact native RAW"):
            load_inputs(self.root)

    def test_changed_actual_scene_refuses(self):
        data = bytearray((self.root / "scene.f32").read_bytes())
        data[0] ^= 1
        self.change("scene.f32", data)
        with self.assertRaisesRegex(ValueError, "Changed source-bound bytes"):
            load_inputs(self.root)

    def test_model_domain_refuses_even_with_matching_digest(self):
        data = bytearray((self.root / "input.f32").read_bytes())
        data[:4] = np.float32(2).tobytes()
        self.change("input.f32", data)
        digest = "blake3:" + blake3.blake3(data).hexdigest()
        self.edit("context.json", lambda v: v.update(model_input=digest))
        with self.assertRaisesRegex(ValueError, "recipe domain"):
            load_inputs(self.root)

    def test_corrupt_actual_mimf_refuses(self):
        data = bytearray((self.root / "intent.mimf").read_bytes())
        data[-1] ^= 1
        self.change("intent.mimf", data)
        with self.assertRaisesRegex(ValueError, "Changed source-bound bytes"):
            load_inputs(self.root)

    def test_empty_generation_hole_refuses(self):
        planes = np.zeros((2, SIDE, SIDE), dtype="<f4")
        self.change("masks.f32", planes.tobytes())
        with self.assertRaisesRegex(ValueError, "generation masks"):
            load_inputs(self.root)

    def test_no_synthetic_rectangle_fallback(self):
        (self.root / "masks.f32").unlink()
        with self.assertRaises(FileNotFoundError):
            load_inputs(self.root)

    def refused_bake(self, reason):
        output = self.root / "no-patch-publication"
        result = subprocess.run(
            [
                str(PROBE.resolve()),
                "large-bake",
                str(RAW.resolve()),
                str(self.root),
                str(RESULT.resolve()),
                str(output),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(reason, result.stderr)
        self.assertFalse(output.exists())

    def test_native_bake_rejects_source_dimensions_before_publication(self):
        self.edit("context.json", lambda v: v.update(source_width=6001))
        self.refused_bake("source, geometry or plate differs")

    def test_native_bake_rejects_changed_encoding_before_publication(self):
        self.edit("context.json", lambda v: v["encoding"].update(span=7))
        self.refused_bake(
            "model input differs from recorded source and encoding recipe"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("context", type=Path)
    for name in ["raw", "probe", "result"]:
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    CONTEXT, RAW, PROBE, RESULT = args.context, args.raw, args.probe, args.result
    if not CONTEXT.is_dir():
        raise ValueError("Actual native RAW context is required")
    unittest.main(argv=["lama_large_scene_test"], verbosity=2)
