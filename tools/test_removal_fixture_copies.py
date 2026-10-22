"""The Apple removal fixture mirror must equal the committed test-fixtures bytes."""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# `python3 -I` leaves the script directory off sys.path; import the checker by
# location so the test runs the same way in isolated mode and under discover.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_removal_fixture_copies import APPLE, CANONICAL, PAIRS, verify

CALIBRATION = CANONICAL / "calibration"


class RemovalFixtureCopyTests(unittest.TestCase):
    def test_committed_copies_match(self):
        self.assertEqual([verify(*pair) for pair in PAIRS], [6, 13])

    def test_basic_copy_ignores_the_sibling_calibration_directory(self):
        self.assertTrue((APPLE / "calibration").is_dir())
        self.assertEqual(verify(CANONICAL / "basic", APPLE, recursive=False), 6)

    def test_actual_shared_calibration_files_match(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundled = Path(temporary) / "bundled"
            shutil.copytree(CALIBRATION, bundled)
            self.assertEqual(verify(CALIBRATION, bundled), 13)

    def test_changed_display_reference_or_real_sidecar_is_rejected(self):
        for name in ("preview-4.rgb", "saved.xmp"):
            with tempfile.TemporaryDirectory() as temporary:
                bundled = Path(temporary) / "bundled"
                shutil.copytree(CALIBRATION, bundled)
                path = bundled / name
                values = bytearray(path.read_bytes())
                values[0] ^= 1
                path.write_bytes(values)
                with self.assertRaisesRegex(ValueError, name):
                    verify(CALIBRATION, bundled)

    def test_missing_companion_or_extra_reference_is_rejected(self):
        for kind in ("missing", "extra"):
            with tempfile.TemporaryDirectory() as temporary:
                bundled = Path(temporary) / "bundled"
                shutil.copytree(CALIBRATION, bundled)
                if kind == "missing":
                    (bundled / "patch.f16").unlink()
                else:
                    (bundled / "stale-preview.rgb").write_bytes(b"stale")
                with self.assertRaisesRegex(ValueError, "copies differ"):
                    verify(CALIBRATION, bundled)


if __name__ == "__main__":
    unittest.main()
