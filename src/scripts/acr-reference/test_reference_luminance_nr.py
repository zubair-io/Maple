"""Reproducible active luminance-NR authoring and capture checks (#4851)."""

import tempfile
import unittest
from pathlib import Path

from PIL import Image, PngImagePlugin
from verify_settings import verify_png
from write_xmp import explicit_reference_defaults, reference_settings

MINIMAL = b"""<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF
xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description
xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
crs:CameraProfile="Adobe Standard" crs:LuminanceSmoothing="100"
crs:Unknown="keep"/></rdf:RDF></x:xmpmeta>"""


class LuminanceNrTests(unittest.TestCase):
    def verify(self, packet, expected):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "reference.png"
            info = PngImagePlugin.PngInfo()
            info.add_itxt("XML:com.adobe.xmp", packet.decode())
            Image.new("RGB", (2, 2)).save(path, pnginfo=info)
            verify_png(path, expected)

    def test_active_subcontrols_are_pinned_without_changing_original(self):
        authored = explicit_reference_defaults(MINIMAL)
        expected = reference_settings(authored)
        self.assertEqual(expected.get("LuminanceNoiseReductionDetail"), "50")
        self.assertEqual(expected.get("LuminanceNoiseReductionContrast"), "0")
        self.assertIn(b'crs:Unknown="keep"', authored)
        self.assertNotIn(b"LuminanceNoiseReductionDetail", MINIMAL)
        self.assertEqual(explicit_reference_defaults(authored), authored)
        self.verify(authored, expected)

    def test_explicit_attribute_and_element_overrides_are_preserved(self):
        original = MINIMAL.replace(
            b"/></rdf:RDF>",
            b' crs:LuminanceNoiseReductionContrast="23"><crs:LuminanceNoiseReductionDetail>71</crs:LuminanceNoiseReductionDetail></rdf:Description></rdf:RDF>',
        )
        authored = explicit_reference_defaults(original)
        expected = reference_settings(authored)
        self.assertEqual(expected.get("LuminanceNoiseReductionDetail"), "71")
        self.assertEqual(expected.get("LuminanceNoiseReductionContrast"), "23")
        self.assertIn(b">71</crs:LuminanceNoiseReductionDetail>", authored)
        self.verify(authored, expected)

    def test_active_captures_reject_mismatched_or_missing_subcontrols(self):
        original = MINIMAL.replace(
            b"crs:Unknown=",
            b'crs:LuminanceNoiseReductionDetail="50" crs:LuminanceNoiseReductionContrast="0" crs:Unknown=',
        )
        authored = explicit_reference_defaults(original)
        expected = reference_settings(authored)
        for key, value in [
            ("LuminanceNoiseReductionDetail", "50"),
            ("LuminanceNoiseReductionContrast", "0"),
        ]:
            attribute = f'crs:{key}="{value}"'.encode()
            for replacement in [b"", f'crs:{key}="99"'.encode()]:
                with (
                    self.subTest(key=key, replacement=replacement),
                    self.assertRaises(ValueError),
                ):
                    self.verify(authored.replace(attribute, replacement), expected)

    def test_active_authoring_requires_both_subcontrols(self):
        authored = explicit_reference_defaults(MINIMAL)
        expected = reference_settings(authored)
        for key in ["LuminanceNoiseReductionDetail", "LuminanceNoiseReductionContrast"]:
            partial = {k: v for k, v in expected.items() if k != key}
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.verify(authored, partial)

    def test_dormant_historical_authoring_and_capture_omissions_remain_valid(self):
        authored = explicit_reference_defaults(
            MINIMAL.replace(b'LuminanceSmoothing="100"', b'LuminanceSmoothing="0"')
        )
        expected = reference_settings(authored)
        old = authored.replace(b' crs:LuminanceNoiseReductionDetail="50"', b"").replace(
            b' crs:LuminanceNoiseReductionContrast="0"', b""
        )
        self.verify(old, expected)
        self.verify(authored, reference_settings(old))
        self.verify(old, reference_settings(old))

    def test_dormant_explicit_values_must_still_match_when_captured(self):
        original = MINIMAL.replace(
            b'LuminanceSmoothing="100"', b'LuminanceSmoothing="0"'
        ).replace(
            b"crs:Unknown=", b'crs:LuminanceNoiseReductionDetail="50" crs:Unknown='
        )
        authored = explicit_reference_defaults(original)
        with self.assertRaises(ValueError):
            self.verify(
                authored.replace(
                    b'LuminanceNoiseReductionDetail="50"',
                    b'LuminanceNoiseReductionDetail="77"',
                ),
                reference_settings(authored),
            )
