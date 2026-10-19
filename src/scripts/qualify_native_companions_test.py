"""Native companion qualification must not silently change reference pixels."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, PngImagePlugin
from qualify_native_companions import main, qualify

sys.path.insert(0, str(Path(__file__).resolve().parent / "acr-reference"))
from write_xmp import explicit_reference_defaults


class NativeCompanionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.raw = self.root / "original.dng"
        self.raw.write_bytes(b"immutable raw bytes")
        self.clone = self.root / "capture.dng"
        self.clone.write_bytes(self.raw.read_bytes())
        self.xmp = self.root / "canonical.xmp"
        self.xmp.write_text(
            '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
            'xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">'
            '<rdf:Description crs:Contrast2012="-100"/></rdf:RDF>'
        )
        self.adobe = self.root / "adobe.xmp"
        self.packet = explicit_reference_defaults(
            self.xmp.read_bytes(), "Adobe Standard"
        )
        self.adobe.write_bytes(self.packet)
        for name, size in [
            ("old.png", (4, 3)),
            ("down.png", (4, 3)),
            ("full.png", (8, 6)),
        ]:
            self.save(name, size)
        self.base = self.root / "base.json"
        self.capture = self.root / "capture.json"
        original = {
            "name": "fixture/contrast_min",
            "raw": "original.dng",
            "xmp": "canonical.xmp",
            "outputs": [{"resolution": "down", "long_edge": 4, "png": "old.png"}],
        }
        capture = {
            **original,
            "raw": "capture.dng",
            "acr_xmp": "adobe.xmp",
            "outputs": [
                {"resolution": "full", "long_edge": 0, "png": "full.png"},
                {"resolution": "down", "long_edge": 4, "png": "down.png"},
            ],
        }
        self.base.write_text(json.dumps({"cases": [original]}))
        self.capture.write_text(json.dumps({"cases": [capture]}))

    def save(self, name, size, packet=None, color=(80, 90, 100)):
        info = PngImagePlugin.PngInfo()
        info.add_text("XML:com.adobe.xmp", (packet or self.packet).decode())
        Image.new("RGB", size, color).save(self.root / name, pnginfo=info)

    def test_adds_qualified_pair_in_new_manifest_without_writing_inputs(self):
        before = {p: p.read_bytes() for p in self.root.iterdir()}
        result, report = qualify(self.base, self.capture)
        case = result["cases"][0]
        self.assertEqual(case["reference_protocol"], "native-pair-lanczos-v1")
        self.assertEqual(Path(case["outputs"][0]["png"]), self.root / "down.png")
        self.assertEqual(Path(case["xmp"]), self.xmp)
        self.assertEqual(report["qualified"], 1)
        self.assertTrue(report["cases"][0]["down_rgb_pixels_identical"])
        self.assertEqual({p: p.read_bytes() for p in self.root.iterdir()}, before)

    def test_any_rgb_difference_rejects_companion_without_tolerance(self):
        self.save("down.png", (4, 3), color=(80, 90, 101))
        with self.assertRaisesRegex(ValueError, "RGB pixels differ"):
            qualify(self.base, self.capture)

    def test_raw_identity_must_match(self):
        self.clone.write_bytes(b"different raw")
        with self.assertRaisesRegex(ValueError, "raw identity differs"):
            qualify(self.base, self.capture)

    def test_canonical_xmp_identity_must_match(self):
        other = self.root / "different.xmp"
        other.write_bytes(self.xmp.read_bytes() + b"\n")
        data = json.loads(self.capture.read_text())
        data["cases"][0]["xmp"] = str(other)
        self.capture.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "xmp identity differs"):
            qualify(self.base, self.capture)

    def test_effective_native_down_settings_must_match(self):
        packet = self.packet.replace(
            b'crs:Contrast2012="-100"', b'crs:Contrast2012="0"'
        )
        self.save("full.png", (8, 6), packet=packet)
        with self.assertRaisesRegex(ValueError, "effective Contrast2012"):
            qualify(self.base, self.capture)

    def test_unknown_active_setting_is_not_ignored(self):
        packet = self.packet.replace(
            b"<rdf:Description ", b'<rdf:Description crs:UnknownActive="1" '
        )
        self.save("old.png", (4, 3), packet=packet)
        with self.assertRaisesRegex(ValueError, "UnknownActive"):
            qualify(self.base, self.capture)

    def test_capture_metadata_may_add_known_inactive_controls(self):
        packet = self.packet.replace(
            b"<rdf:Description ", b'<rdf:Description crs:Version="18.7" crs:Glow="0" '
        )
        self.save("down.png", (4, 3), packet=packet)
        self.save("full.png", (8, 6), packet=packet)
        _, report = qualify(self.base, self.capture)
        self.assertEqual(report["qualified"], 1)

    def test_cli_rejects_original_input_as_output(self):
        before = self.xmp.read_bytes()
        with (
            self.assertRaisesRegex(ValueError, "must not overwrite"),
            patch.object(
                sys,
                "argv",
                [
                    "qualify",
                    str(self.base),
                    str(self.capture),
                    "--output",
                    str(self.xmp),
                    "--report",
                    str(self.root / "report.json"),
                ],
            ),
        ):
            main()
        self.assertEqual(self.xmp.read_bytes(), before)

    def test_bad_batch_writes_no_partial_output(self):
        self.save("down.png", (4, 3), color=(0, 0, 0))
        output = self.root / "qualified.json"
        report = self.root / "report.json"
        with (
            self.assertRaisesRegex(ValueError, "RGB pixels differ"),
            patch.object(
                sys,
                "argv",
                [
                    "qualify",
                    str(self.base),
                    str(self.capture),
                    "--output",
                    str(output),
                    "--report",
                    str(report),
                ],
            ),
        ):
            main()
        self.assertFalse(output.exists())
        self.assertFalse(report.exists())

    def test_geometry_must_match(self):
        self.save("full.png", (8, 16))
        with self.assertRaisesRegex(ValueError, "geometry differs"):
            qualify(self.base, self.capture)

    def test_native_down_export_metadata_must_match(self):
        packet = self.packet.replace(
            b"<rdf:Description ", b'<rdf:Description crs:Version="18.7" '
        )
        self.save("full.png", (8, 6), packet=packet)
        with self.assertRaisesRegex(
            ValueError, "native/down Camera Raw settings differ"
        ):
            qualify(self.base, self.capture)

    def test_cli_writes_new_manifest_and_report(self):
        output = self.root / "qualified.json"
        report = self.root / "report.json"
        before = self.base.read_bytes()
        with patch.object(
            sys,
            "argv",
            [
                "qualify",
                str(self.base),
                str(self.capture),
                "--output",
                str(output),
                "--report",
                str(report),
            ],
        ):
            self.assertEqual(main(), 0)
        self.assertEqual(json.loads(report.read_text())["qualified"], 1)
        self.assertEqual(len(json.loads(output.read_text())["cases"]), 1)
        self.assertEqual(self.base.read_bytes(), before)
        with (
            self.assertRaisesRegex(FileExistsError, "new output path"),
            patch.object(
                sys,
                "argv",
                [
                    "qualify",
                    str(self.base),
                    str(self.capture),
                    "--output",
                    str(output),
                    "--report",
                    str(report),
                ],
            ),
        ):
            main()


if __name__ == "__main__":
    unittest.main()
