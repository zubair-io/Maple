"""Real XML/PNG tests for deterministic Adobe reference settings (#3633)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, PngImagePlugin
from verify_settings import verify_manifest, verify_png
from write_xmp import (
    REFERENCE_DEFAULTS,
    explicit_reference_defaults,
    reference_settings,
)

MINIMAL = b"""<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF
xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description
xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
crs:CameraProfile="Adobe Standard" crs:Unknown="preserve me"/></rdf:RDF></x:xmpmeta>"""


class ReferenceSettingsTests(unittest.TestCase):
    def test_pin_missing_controls_and_preserve_authored_bytes(self):
        authored = MINIMAL.replace(
            b"crs:Unknown=",
            b'crs:Whites2012="+100" crs:LensProfileEnable="1" crs:Unknown=',
        )
        result = explicit_reference_defaults(authored)
        settings = reference_settings(result)
        self.assertEqual(set(settings), set(REFERENCE_DEFAULTS))
        self.assertEqual(settings["Whites2012"], "+100")
        self.assertEqual(settings["LensProfileEnable"], "1")
        self.assertEqual(settings["AutoLateralCA"], "0")
        self.assertEqual(settings["WhiteBalance"], "As Shot")
        self.assertIn(b'crs:Unknown="preserve me"', result)
        self.assertEqual(explicit_reference_defaults(result), result)

    def test_nested_explicit_curve_and_controls_survive(self):
        authored = MINIMAL.replace(
            b"/></rdf:RDF>",
            b"><crs:Clarity2012>8</crs:Clarity2012><crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>128, 150</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012></rdf:Description></rdf:RDF>",
        )
        result = reference_settings(explicit_reference_defaults(authored))
        self.assertEqual(result["Clarity2012"], "8")
        self.assertEqual(result["ToneCurveName2012"], "Custom")
        self.assertEqual(result["ToneCurvePV2012"][1], "128, 150")

    def test_saved_png_effective_metadata_is_required_and_checked(self):
        authored = explicit_reference_defaults(MINIMAL)
        expected = reference_settings(authored)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "reference.png"

            def save(xmp):
                info = PngImagePlugin.PngInfo()
                if xmp is not None:
                    info.add_text("XML:com.adobe.xmp", xmp.decode())
                Image.new("RGB", (2, 2)).save(path, pnginfo=info)

            save(authored.replace(b'crs:Exposure2012="0"', b'crs:Exposure2012="+0.00"'))
            verify_png(path, expected)
            for bad in (
                None,
                authored.replace(
                    b'crs:LensProfileEnable="0"', b'crs:LensProfileEnable="1"'
                ),
                authored.replace(b'crs:Whites2012="0"', b'crs:Whites2012="15"'),
            ):
                save(bad)
                with self.assertRaises(ValueError):
                    verify_png(path, expected)
            with self.assertRaises(ValueError):
                verify_png(path, {})

    def test_missing_dormant_detail_only_allowed_with_zero_parent(self):
        authored = explicit_reference_defaults(MINIMAL)
        expected = reference_settings(authored)
        metadata = authored.replace(b' crs:SharpenRadius="1"', b"").replace(
            b'crs:Sharpness="40"', b'crs:Sharpness="0"'
        )
        expected["Sharpness"] = "0"
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "reference.png"
            info = PngImagePlugin.PngInfo()
            info.add_text("XML:com.adobe.xmp", metadata.decode())
            Image.new("RGB", (2, 2)).save(path, pnginfo=info)
            verify_png(path, expected)
            info = PngImagePlugin.PngInfo()
            info.add_text(
                "XML:com.adobe.xmp",
                metadata.replace(b'crs:Sharpness="0"', b'crs:Sharpness="40"').decode(),
            )
            Image.new("RGB", (2, 2)).save(path, pnginfo=info)
            with self.assertRaises(ValueError):
                verify_png(path, expected | {"Sharpness": "40"})

    def test_filtered_self_run_keeps_maple_sidecar_and_stages_adobe_defaults(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "test_0000" / "xmp"
            source.mkdir(parents=True)
            sidecar = source / "baseline.xmp"
            sidecar.write_bytes(MINIMAL)
            raw = root / "test_0000.dng"
            raw.write_bytes(b"not opened by manifest preparation")
            subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("run.py")),
                    "--raws",
                    str(raw),
                    "--out",
                    str(root),
                    "--cases-filter",
                    "baseline",
                ],
                check=True,
                capture_output=True,
            )
            self.assertEqual(sidecar.read_bytes(), MINIMAL)
            manifest_path = root / "manifest.json"
            entry = json.loads(manifest_path.read_text())["cases"][0]
            self.assertEqual(Path(entry["xmp"]), sidecar.resolve())
            self.assertNotEqual(entry["xmp"], entry["acr_xmp"])
            self.assertEqual(
                reference_settings(Path(entry["acr_xmp"]).read_bytes()),
                REFERENCE_DEFAULTS,
            )
            with self.assertRaises(FileNotFoundError):
                verify_manifest(manifest_path)


if __name__ == "__main__":
    unittest.main()
