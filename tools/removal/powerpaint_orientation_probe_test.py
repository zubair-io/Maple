"""Actual shared orientation and source-binding guards, without model mocks."""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from native_orientation import orient
from probe_powerpaint_oriented import prepare, restore

PROBE = (
    Path(__file__).resolve().parents[2]
    / "src/raw-pipeline/target/release/examples/removal-orientation-probe"
)


class PowerPaintOrientationProbeTests(unittest.TestCase):
    def test_all_tags_restore_non_square_unclamped_decoder_and_source_bits(self):
        source = np.arange(16 * 32 * 3, dtype=np.float32).reshape(16, 32, 3) / 4096
        hole = np.zeros((16, 32), dtype=bool)
        hole[3:8, 10:19] = True
        decoder = source + np.float32(0.50001)
        decoder[4, 11, 0] = -0.1234
        decoder[4, 12, 1] = 1.1234
        candidate = source.copy()
        candidate[hole] = decoder[hole]
        with tempfile.TemporaryDirectory() as temporary:
            for tag in range(1, 9):
                output = Path(temporary) / str(tag)
                output.mkdir()
                generated = output / "generated"
                generated.mkdir()
                for name, pixels in [
                    ("decoder-model", decoder),
                    ("raw-candidate", candidate),
                ]:
                    upright, _ = orient(PROBE, pixels, tag, output, name + "-fixture")
                    upright.transpose(2, 0, 1).copy().astype("<f4").tofile(
                        generated / f"{name}-nchw.f32"
                    )
                rows = restore(generated, source, hole, tag, PROBE, output)
                for name, wanted in [
                    ("decoder-model", decoder),
                    ("raw-candidate", candidate),
                ]:
                    actual = np.fromfile(output / f"{name}-nchw.f32", dtype="<f4")
                    actual = actual.reshape(3, 16, 32).transpose(1, 2, 0).copy()
                    np.testing.assert_array_equal(
                        actual.view(np.uint32), wanted.view(np.uint32)
                    )
                    self.assertTrue(rows[name]["replay_bits_exact"])
                    self.assertFalse(rows[name]["clamped"])
                    self.assertEqual(rows[name]["out_of_model_range_samples"], 2)

    def test_candidate_changed_known_pixel_refuses(self):
        source = np.full((16, 32, 3), 0.50004, dtype=np.float32)
        hole = np.zeros((16, 32), dtype=bool)
        hole[3, 3] = True
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            generated = output / "generated"
            generated.mkdir()
            for name in ("decoder-model", "raw-candidate"):
                values = source.copy()
                values[0, 0, 0] = np.nextafter(values[0, 0, 0], np.float32(1))
                values.transpose(2, 0, 1).copy().astype("<f4").tofile(
                    generated / f"{name}-nchw.f32"
                )
            with self.assertRaisesRegex(ValueError, "known source"):
                restore(generated, source, hole, 1, PROBE, output)

    def test_partial_file_and_nonfinite_decoder_refuse(self):
        source = np.zeros((16, 32, 3), dtype=np.float32)
        hole = np.zeros((16, 32), dtype=bool)
        hole[3, 3] = True
        for invalid in ("partial", "nan"):
            with tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary)
                generated = output / "generated"
                generated.mkdir()
                path = generated / "decoder-model-nchw.f32"
                values = source.copy()
                if invalid == "nan":
                    values[0, 0, 0] = np.nan
                values.transpose(2, 0, 1).copy().astype("<f4").tofile(path)
                if invalid == "partial":
                    with path.open("ab") as stream:
                        stream.write(b"!")
                with self.assertRaisesRegex(ValueError, "geometry|Nonfinite"):
                    restore(generated, source, hole, 1, PROBE, output)

    def test_missing_changed_or_wrong_source_orientation_refuses_before_model_io(self):
        context = {
            "plate": "LinearCalibrationV1",
            "original": "blake3:source",
            "release_qualified": False,
        }
        metadata = {
            "orientation": 8,
            "raw_identity": {"decoder_verified": True, "original_blake3": "source"},
        }
        for kind in ("missing", "tag", "original", "context", "unverified"):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                prepared = {
                    "context": context.copy(),
                    "orientation": json.loads(json.dumps(metadata)),
                }
                if kind == "missing":
                    prepared["orientation"] = None
                elif kind == "tag":
                    prepared["orientation"]["orientation"] = 1
                elif kind == "original":
                    prepared["orientation"]["raw_identity"]["original_blake3"] = (
                        "different"
                    )
                elif kind == "context":
                    prepared["context"]["original"] = "different"
                else:
                    prepared["orientation"]["raw_identity"]["decoder_verified"] = False
                (root / "context.json").write_text(json.dumps(context))
                (root / "preparation.json").write_text(json.dumps(prepared))
                output = root / "output"
                with self.assertRaisesRegex(ValueError, "source-bound"):
                    prepare(root, 8, PROBE, output)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
