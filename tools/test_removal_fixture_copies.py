"""Real RAW/XMP/companion/reference file-copy integrity, without sidecar mocks."""

import shutil
import tempfile
import unittest
from pathlib import Path

from check_removal_fixture_copies import CANONICAL, verify


class RemovalFixtureCopyTests(unittest.TestCase):
    def test_actual_shared_calibration_files_match(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundled = Path(temporary) / "bundled"
            shutil.copytree(CANONICAL, bundled)
            self.assertEqual(verify(CANONICAL, bundled), 13)

    def test_changed_display_reference_or_real_sidecar_is_rejected(self):
        for name in ("preview-4.rgb", "saved.xmp"):
            with tempfile.TemporaryDirectory() as temporary:
                bundled = Path(temporary) / "bundled"
                shutil.copytree(CANONICAL, bundled)
                path = bundled / name
                values = bytearray(path.read_bytes())
                values[0] ^= 1
                path.write_bytes(values)
                with self.assertRaisesRegex(ValueError, name):
                    verify(CANONICAL, bundled)

    def test_missing_companion_or_extra_reference_is_rejected(self):
        for kind in ("missing", "extra"):
            with tempfile.TemporaryDirectory() as temporary:
                bundled = Path(temporary) / "bundled"
                shutil.copytree(CANONICAL, bundled)
                if kind == "missing":
                    (bundled / "patch.f16").unlink()
                else:
                    (bundled / "stale-preview.rgb").write_bytes(b"stale")
                with self.assertRaisesRegex(ValueError, "copies differ"):
                    verify(CANONICAL, bundled)


if __name__ == "__main__":
    unittest.main()
