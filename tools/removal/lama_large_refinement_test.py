"""#3941: actual retained RAW-context refusals before feature optimization."""

import argparse
import json
import tempfile
import unittest
from pathlib import Path

import blake3
import numpy as np
from probe_lama_large_refinement import preflight
from probe_lama_large_scene import SIDE, mask_values


class ActualRawRefinementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.context = self.root / "context"
        self.context.mkdir()
        for path in CONTEXT.iterdir():
            (self.context / path.name).symlink_to(path.resolve())
        self.output = self.root / "output"

    def change(self, name, data):
        target = self.context / name
        target.unlink()
        target.write_bytes(data)

    def edit(self, name, transform):
        value = json.loads((self.context / name).read_text())
        transform(value)
        self.change(name, json.dumps(value).encode())

    def refused(self, reason):
        with self.assertRaisesRegex(ValueError, reason):
            preflight(self.context, SOURCE, self.output)
        self.assertFalse(self.output.exists())

    def test_actual_native_float_plate_and_hole_are_unmodified(self):
        original, hole, _helpers = preflight(self.context, SOURCE, self.output)
        expected = np.fromfile(CONTEXT / "input.f32", "<f4").reshape(1, 3, SIDE, SIDE)
        planes = np.fromfile(CONTEXT / "masks.f32", "<f4").reshape(2, SIDE, SIDE)
        np.testing.assert_array_equal(
            original.view(np.uint32), expected.view(np.uint32)
        )
        np.testing.assert_array_equal(hole[0, 0], planes[0])
        self.assertFalse(self.output.exists())

    def test_display_or_unknown_recipe_refuses(self):
        self.edit(
            "context.json", lambda v: v["encoding"].update(method="fixed-agx-srgb")
        )
        self.refused("bound reversible photographic")

    def test_changed_source_anchor_refuses(self):
        self.edit(
            "inputs.json", lambda v: v["source"].update(decode="blake3:" + "0" * 64)
        )
        self.refused("exact native RAW")

    def test_changed_actual_model_input_refuses(self):
        data = bytearray((self.context / "input.f32").read_bytes())
        data[0] ^= 1
        self.change("input.f32", data)
        self.refused("Changed source-bound bytes")

    def test_nonfinite_model_pixels_refuse_even_with_matching_digest(self):
        data = bytearray((self.context / "input.f32").read_bytes())
        data[:4] = np.float32(np.nan).tobytes()
        self.change("input.f32", data)
        digest = "blake3:" + blake3.blake3(data).hexdigest()
        self.edit("context.json", lambda v: v.update(model_input=digest))
        self.refused("recipe domain")

    def test_changed_kept_person_mask_refuses(self):
        data = bytearray((self.context / "protected.mimf").read_bytes())
        data[-1] ^= 1
        self.change("protected.mimf", data)
        self.refused("Changed source-bound bytes")

    def test_generation_plane_cannot_consume_a_kept_pixel(self):
        recipe = json.loads((self.context / "context.json").read_text())
        pins = json.loads((self.context / "inputs.json").read_text())
        (x, y, _w, _h), values = mask_values(
            (self.context / "protected.mimf").read_bytes(), pins["source"]
        )
        ys, xs = np.nonzero(values)
        tx, ty = xs + x - recipe["window"]["x"], ys + y - recipe["window"]["y"]
        inside = (tx >= 0) & (ty >= 0) & (tx < SIDE) & (ty < SIDE)
        px, py = tx[inside][0], ty[inside][0]
        planes = np.fromfile(self.context / "masks.f32", "<f4").reshape(2, SIDE, SIDE)
        planes[:, py, px] = 1
        self.change("masks.f32", planes.tobytes())
        self.edit(
            "preparation.json", lambda v: v.update(hole_pixels=int(planes[0].sum()))
        )
        self.refused("explicitly kept pixels")

    def test_existing_output_refuses_without_mutating_it(self):
        self.output.mkdir()
        sentinel = self.output / "prior-result"
        sentinel.write_bytes(b"retain")
        with self.assertRaisesRegex(ValueError, "fresh native RAW refinement"):
            preflight(self.context, SOURCE, self.output)
        self.assertEqual(sentinel.read_bytes(), b"retain")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("context", type=Path)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    CONTEXT, SOURCE = args.context.resolve(), args.source.resolve()
    unittest.main(argv=["lama_large_refinement_test"], verbosity=2)
