"""Actual shared-core orientation on tagged non-square f32/mask fixtures."""

import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np
from native_orientation import exact_roundtrip, orient

PROBE = (
    Path(__file__).resolve().parents[2]
    / "src/raw-pipeline/target/release/examples/removal-orientation-probe"
)


class KleinOrientationProbeTests(unittest.TestCase):
    def test_all_tags_match_independent_non_square_pixel_order_and_inverse(self):
        expected = [
            [[1, 2], [3, 4], [5, 6]],
            [[2, 1], [4, 3], [6, 5]],
            [[6, 5], [4, 3], [2, 1]],
            [[5, 6], [3, 4], [1, 2]],
            [[1, 3, 5], [2, 4, 6]],
            [[5, 3, 1], [6, 4, 2]],
            [[6, 4, 2], [5, 3, 1]],
            [[2, 4, 6], [1, 3, 5]],
        ]
        # Include signed zero, infinities and NaN payloads: no f32 arithmetic is allowed.
        source = np.arange(1, 7, dtype=np.float32).reshape(3, 2, 1).repeat(3, axis=2)
        source.view(np.uint32)[:, :, 1] = np.array(
            [0, 0x80000000, 0x7FC00001, 0xFFC00002, 0x7F800000, 0xFF800000],
            dtype=np.uint32,
        ).reshape(3, 2)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for tag, wanted in enumerate(expected, 1):
                result, report = exact_roundtrip(
                    PROBE, source, tag, directory, str(tag)
                )
                np.testing.assert_array_equal(result[:, :, 0], wanted)
                self.assertTrue(report["roundtrip_bits_exact"])
                for y, row in enumerate(wanted):
                    for x, label in enumerate(row):
                        np.testing.assert_array_equal(
                            result[y, x].view(np.uint32),
                            source.reshape(-1, 3)[label - 1].view(np.uint32),
                        )

    def test_binary_selection_and_protection_permute_together(self):
        source = np.zeros((16, 32, 3), dtype=np.float32)
        source[3:8, 10:19, 0] = 1  # intent
        source[8:14, 20:28, 1] = 1  # protection
        with tempfile.TemporaryDirectory() as temporary:
            for tag in range(1, 9):
                result, _ = exact_roundtrip(
                    PROBE, source, tag, Path(temporary), str(tag)
                )
                self.assertEqual(np.count_nonzero(result[:, :, 0]), 45)
                self.assertEqual(np.count_nonzero(result[:, :, 1]), 48)
                self.assertFalse(np.any(result[:, :, 0] * result[:, :, 1]))

    def test_unknown_orientation_and_overwrite_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = np.zeros((16, 16, 3), dtype=np.float32)
            with self.assertRaises(subprocess.CalledProcessError):
                orient(PROBE, source, 9, directory, "bad")
            orient(PROBE, source, 8, directory, "once")
            with self.assertRaisesRegex(ValueError, "fresh"):
                orient(PROBE, source, 8, directory, "once")

    def test_actual_raw_decoder_rejects_wrong_orientation(self):
        raw = (
            Path(__file__).resolve().parents[2]
            / "test-fixtures/removal/basic/source.dng"
        )
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "source.f32"
            np.zeros((16, 16, 3), dtype="<f4").tofile(source)
            for tag, accepted in [(1, True), (8, False)]:
                output = directory / f"tag-{tag}.f32"
                completed = subprocess.run(
                    [
                        str(PROBE),
                        str(source),
                        "16",
                        "16",
                        str(tag),
                        str(output),
                        "--raw",
                        str(raw),
                    ],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.returncode == 0, accepted)
                self.assertEqual(output.exists(), accepted)
                if not accepted:
                    self.assertIn(
                        "differs from the shared RAW decoder", completed.stderr
                    )


if __name__ == "__main__":
    unittest.main()
