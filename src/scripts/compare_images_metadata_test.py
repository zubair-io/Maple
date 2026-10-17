"""Authoring-sidecar checks for the native reference-pair protocol (#4788)."""

import sys
import tempfile
import unittest
from pathlib import Path

import compare_images as ci
from PIL import Image, PngImagePlugin

sys.path.insert(0, str(Path(__file__).parent / "acr-reference"))
from write_xmp import explicit_reference_defaults

LOCAL = (
    "<crs:GradientBasedCorrections><rdf:Seq><rdf:li>"
    '<rdf:Description crs:LocalExposure2012="-0.6" '
    'crs:CorrectionActive="True"/>'
    "</rdf:li></rdf:Seq></crs:GradientBasedCorrections>"
)


class AuthoringMetadataTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.full, self.down, self.sidecar = [
            root / name for name in ("full.png", "down.png", "author.xmp")
        ]
        self.authored = explicit_reference_defaults(
            b'<x xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" '
            b'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            b'<rdf:Description crs:CameraProfile="Adobe Standard"/></x>'
        ).decode()
        self.outputs = [
            {"resolution": "full", "png": str(self.full)},
            {"resolution": "down", "png": str(self.down)},
        ]

    def with_property(self, payload):
        return self.authored.replace(
            "</rdf:Description>", payload + "</rdf:Description>"
        )

    def compare(self, authored, captured):
        self.sidecar.write_text(authored)
        metadata = PngImagePlugin.PngInfo()
        metadata.add_itxt("XML:com.adobe.xmp", captured)
        for path, size in ((self.full, (8, 6)), (self.down, (4, 3))):
            Image.new("RGB", size, (130, 120, 110)).save(path, pnginfo=metadata)
        return ci.diff_manifest_case(
            str(self.full),
            self.outputs,
            "down",
            case_label="local_gradient",
            reference_xmp=str(self.sidecar),
            reference_protocol="native-pair-lanczos-v1",
        )

    def test_capture_cannot_add_local_adjustment(self):
        with self.assertRaisesRegex(ValueError, "GradientBasedCorrections"):
            self.compare(self.authored, self.with_property(LOCAL))

    def test_capture_cannot_omit_authored_local_adjustment(self):
        with self.assertRaisesRegex(ValueError, "GradientBasedCorrections"):
            self.compare(self.with_property(LOCAL), self.authored)

    def test_capture_cannot_change_nested_local_value(self):
        with self.assertRaisesRegex(ValueError, "GradientBasedCorrections"):
            self.compare(
                self.with_property(LOCAL),
                self.with_property(LOCAL.replace('="-0.6"', '="0.6"')),
            )

    def test_unknown_scalar_fields_are_not_filtered(self):
        unknown = self.with_property("<crs:FutureAdjustment>7</crs:FutureAdjustment>")
        for authored, captured in ((unknown, self.authored), (self.authored, unknown)):
            with (
                self.subTest(authored=authored),
                self.assertRaisesRegex(ValueError, "FutureAdjustment"),
            ):
                self.compare(authored, captured)

    def test_unknown_fields_match_when_authored(self):
        both = self.with_property("<crs:FutureAdjustment>7</crs:FutureAdjustment>")
        self.assertEqual(self.compare(both, both)["max_deltaE"], 0)

    def test_nested_order_is_significant(self):
        second = (
            LOCAL.replace("-0.6", "0.2").split("<rdf:Seq>")[1].split("</rdf:Seq>")[0]
        )
        first = LOCAL.split("<rdf:Seq>")[1].split("</rdf:Seq>")[0]
        authored = self.with_property(LOCAL.replace(first, first + second))
        captured = self.with_property(LOCAL.replace(first, second + first))
        with self.assertRaisesRegex(ValueError, "GradientBasedCorrections"):
            self.compare(authored, captured)

    def test_nested_numeric_boolean_and_attribute_spelling(self):
        captured = LOCAL.replace(
            'crs:LocalExposure2012="-0.6" crs:CorrectionActive="True"',
            'crs:CorrectionActive="true" crs:LocalExposure2012="-0.6000"',
        )
        self.assertEqual(
            self.compare(self.with_property(LOCAL), self.with_property(captured))[
                "max_deltaE"
            ],
            0,
        )

    def test_conflicting_duplicate_properties_fail(self):
        duplicate = self.with_property("<crs:Exposure2012>1</crs:Exposure2012>")
        with self.assertRaisesRegex(ValueError, "conflicting.*Exposure2012"):
            self.compare(duplicate, duplicate)

    def test_as_shot_capture_can_report_resolved_white_balance(self):
        captured = self.with_property(
            "<crs:Temperature>5550</crs:Temperature><crs:Tint>-4</crs:Tint>"
            "<crs:Version>18.7</crs:Version><crs:AlreadyApplied>True</crs:AlreadyApplied>"
            "<crs:HasSettings>True</crs:HasSettings>"
            "<crs:CameraProfileDigest>ABCD</crs:CameraProfileDigest>"
        )
        self.assertEqual(self.compare(self.authored, captured)["max_deltaE"], 0)

    def test_named_white_balance_reports_its_derived_pair(self):
        for mode in (
            "Auto",
            "Daylight",
            "Cloudy",
            "Shade",
            "Tungsten",
            "Fluorescent",
            "Flash",
        ):
            with self.subTest(mode=mode):
                authored = self.authored.replace('"As Shot"', f'"{mode}"')
                captured = authored.replace(
                    "</rdf:Description>",
                    "<crs:Temperature>5550</crs:Temperature><crs:Tint>-4</crs:Tint>"
                    + (
                        "<crs:AutoWhiteVersion>134348800</crs:AutoWhiteVersion>"
                        if mode == "Auto"
                        else ""
                    )
                    + "</rdf:Description>",
                )
                self.assertEqual(self.compare(authored, captured)["max_deltaE"], 0)

    def test_capture_metadata_does_not_override_authored_values(self):
        for key in ("AutoWhiteVersion", "Temperature", "Tint"):
            authored = self.with_property(f"<crs:{key}>20</crs:{key}>")
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                self.compare(
                    authored,
                    authored.replace(f"<{'crs:' + key}>20", f"<{'crs:' + key}>21"),
                )

    def test_inactive_export_defaults_have_exact_values(self):
        points = ", ".join(["-1.000000"] * 19)
        payload = (
            "<crs:Glow>0</crs:Glow><crs:ReshapeAmount>0</crs:ReshapeAmount>"
            "<crs:OverrideLookVignette>False</crs:OverrideLookVignette>"
            f"<crs:PointColors><rdf:Seq><rdf:li>{points}</rdf:li></rdf:Seq></crs:PointColors>"
            "<crs:ColorVariance><rdf:Seq><rdf:li>-50</rdf:li></rdf:Seq></crs:ColorVariance>"
        )
        captured = self.with_property(payload)
        self.assertEqual(self.compare(self.authored, captured)["max_deltaE"], 0)
        for changed in (
            payload.replace(points, points.replace("-1.000000", "0", 1)),
            payload.replace(">-50<", ">-49<"),
        ):
            with (
                self.subTest(changed=changed),
                self.assertRaisesRegex(ValueError, "PointColors|ColorVariance"),
            ):
                self.compare(self.authored, self.with_property(changed))

    def test_active_noise_controls_must_be_authored(self):
        authored = self.authored.replace(
            'crs:LuminanceSmoothing="0"', 'crs:LuminanceSmoothing="100"'
        )
        captured = authored.replace(
            "</rdf:Description>",
            "<crs:LuminanceNoiseReductionDetail>50</crs:LuminanceNoiseReductionDetail></rdf:Description>",
        )
        with self.assertRaisesRegex(ValueError, "LuminanceNoiseReductionDetail"):
            self.compare(authored, captured)

    def test_unknown_conflicting_duplicates_and_nonfinite_values_fail(self):
        for payload in (
            "<crs:FutureAdjustment>1</crs:FutureAdjustment><crs:FutureAdjustment>2</crs:FutureAdjustment>",
            "<crs:FutureAdjustment>NaN</crs:FutureAdjustment>",
        ):
            with (
                self.subTest(payload=payload),
                self.assertRaisesRegex(ValueError, "FutureAdjustment"),
            ):
                both = self.with_property(payload)
                self.compare(both, both)

    def test_authored_profile_digest_must_match(self):
        authored = self.with_property(
            "<crs:CameraProfileDigest>ABCD</crs:CameraProfileDigest>"
        )
        with self.assertRaisesRegex(ValueError, "CameraProfileDigest"):
            self.compare(authored, authored.replace("ABCD", "EFGH"))

    def test_zero_sharpening_allows_omitted_dormant_subcontrols(self):
        authored = self.authored.replace('crs:Sharpness="40"', 'crs:Sharpness="0"')
        captured = authored.replace(' crs:SharpenDetail="25"', "")
        self.assertEqual(self.compare(authored, captured)["max_deltaE"], 0)

    def test_active_extra_control_is_rejected(self):
        for key in ("Glow", "ReshapeAmount", "OverrideLookVignette"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                self.compare(
                    self.authored, self.with_property(f"<crs:{key}>1</crs:{key}>")
                )


if __name__ == "__main__":
    unittest.main()
