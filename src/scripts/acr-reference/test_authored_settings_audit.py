"""Read-only audit coverage for historical, partially authored sidecars."""

import json
import tempfile
import unittest
from pathlib import Path
from xml.sax.saxutils import quoteattr

from audit_authored_settings import audit_manifest, audit_png
from PIL import Image, PngImagePlugin


def xmp(**values):
    attributes = " ".join(
        f"crs:{key}={quoteattr(value)}" for key, value in values.items()
    )
    return (
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
        'xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">'
        f"<rdf:Description {attributes}/></rdf:RDF>"
    )


class AuthoredSettingsAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.png = self.root / "reference.png"

    def save(self, metadata):
        info = PngImagePlugin.PngInfo()
        if metadata is not None:
            info.add_text("XML:com.adobe.xmp", metadata)
        Image.new("RGB", (2, 2)).save(self.png, pnginfo=info)

    def test_explicit_tint_mismatch_is_not_hidden_by_partial_custom_pair(self):
        self.save(xmp(WhiteBalance="Custom", Temperature="5500", Tint="+10"))
        before = self.png.read_bytes()
        self.assertEqual(
            audit_png(self.png, {"WhiteBalance": "Custom", "Tint": "150"}),
            [{"control": "Tint", "authored": "150", "effective": "+10"}],
        )
        self.assertEqual(self.png.read_bytes(), before)

    def test_omitted_axes_are_not_invented(self):
        self.save(xmp(WhiteBalance="Custom", Temperature="5500", Tint="+150"))
        self.assertEqual(audit_png(self.png, {"Tint": "150"}), [])

    def test_dormant_subcontrols_may_be_absent(self):
        self.save(xmp(Sharpness="0"))
        self.assertEqual(audit_png(self.png, {"SharpenRadius": "1"}), [])

    def test_active_missing_subcontrol_is_mismatch(self):
        self.save(xmp(Sharpness="40"))
        self.assertEqual(
            audit_png(self.png, {"SharpenRadius": "1"})[0]["effective"], None
        )

    def test_missing_metadata_is_error(self):
        self.save(None)
        with self.assertRaisesRegex(ValueError, "no effective Adobe XMP"):
            audit_png(self.png, {"Tint": "150"})

    def test_manifest_checks_each_tier_and_keeps_errors_visible(self):
        self.save(xmp(Tint="+10"))
        sidecar = self.root / "case.xmp"
        sidecar.write_text(xmp(Tint="150"))
        manifest = self.root / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "cases": [
                        {
                            "name": "fixture/tint_max",
                            "xmp": "case.xmp",
                            "outputs": [
                                {"resolution": "down", "png": "reference.png"},
                                {"resolution": "full", "png": "absent.png"},
                            ],
                        }
                    ]
                }
            )
        )
        before = sidecar.read_bytes()
        report = audit_manifest(manifest)
        self.assertEqual(
            (report["outputs"], report["mismatched"], report["errors"]), (2, 1, 1)
        )
        self.assertEqual(sidecar.read_bytes(), before)

    def test_malformed_metadata_is_reported_without_aborting_manifest(self):
        self.save("<broken")
        (self.root / "case.xmp").write_text(xmp(Tint="150"))
        manifest = self.root / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "cases": [
                        {
                            "name": "fixture/tint_max",
                            "xmp": "case.xmp",
                            "outputs": [
                                {"resolution": "down", "png": "reference.png"},
                            ],
                        }
                    ]
                }
            )
        )
        report = audit_manifest(manifest)
        self.assertEqual((report["outputs"], report["errors"]), (1, 1))

    def test_bad_sidecar_keeps_both_output_errors(self):
        (self.root / "case.xmp").write_text("<broken")
        manifest = self.root / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "cases": [
                        {
                            "name": "fixture/tint_max",
                            "xmp": "case.xmp",
                            "outputs": [
                                {"resolution": "down", "png": "down.png"},
                                {"resolution": "full", "png": "full.png"},
                            ],
                        }
                    ]
                }
            )
        )
        report = audit_manifest(manifest)
        self.assertEqual((report["outputs"], report["errors"]), (2, 2))
        self.assertEqual([r["resolution"] for r in report["records"]], ["down", "full"])


if __name__ == "__main__":
    unittest.main()
