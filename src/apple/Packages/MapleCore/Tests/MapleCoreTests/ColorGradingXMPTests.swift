// ColorGradingXMPTests.swift — XMP round-trip for the eight new
// `crs:ColorGrade*` keys (#275, Color Grading supersedes Split Toning).
//
// The five `crs:SplitToning*` keys (shadow/highlight hue+saturation,
// balance) are already covered by `XMPSerializationTests.testParseS5EffectsFields`
// / `testS5EffectsRoundTrip` — this file owns only the eight NEW fields
// added under ACR's `crs:ColorGrade*` namespace.

import XCTest
@testable import MapleCore

final class ColorGradingXMPTests: XCTestCase {

    /// Parses every `crs:ColorGrade*` key into its matching model field.
    func testParseColorGradeFields() throws {
        let attrs = #"""
        crs:ColorGradeShadowLum="-30"
        crs:ColorGradeMidtoneHue="180"
        crs:ColorGradeMidtoneSat="45"
        crs:ColorGradeMidtoneLum="10"
        crs:ColorGradeHighlightLum="25"
        crs:ColorGradeGlobalHue="300"
        crs:ColorGradeGlobalSat="60"
        crs:ColorGradeGlobalLum="-15"
        """#
        let (m, _) = try XMPParser.parse(xmp(attrs: attrs))
        XCTAssertEqual(m.colorGradeShadowLuminance, -30)
        XCTAssertEqual(m.colorGradeMidtoneHue, 180)
        XCTAssertEqual(m.colorGradeMidtoneSaturation, 45)
        XCTAssertEqual(m.colorGradeMidtoneLuminance, 10)
        XCTAssertEqual(m.colorGradeHighlightLuminance, 25)
        XCTAssertEqual(m.colorGradeGlobalHue, 300)
        XCTAssertEqual(m.colorGradeGlobalSaturation, 60)
        XCTAssertEqual(m.colorGradeGlobalLuminance, -15)
    }

    /// Non-default values round-trip through serialize → parse and emit
    /// their `crs:ColorGrade*` keys.
    func testColorGradeFieldsRoundTrip() throws {
        var m = AdjustmentModel()
        m.colorGradeShadowLuminance = -30
        m.colorGradeMidtoneHue = 180
        m.colorGradeMidtoneSaturation = 45
        m.colorGradeMidtoneLuminance = 10
        m.colorGradeHighlightLuminance = 25
        m.colorGradeGlobalHue = 300
        m.colorGradeGlobalSaturation = 60
        m.colorGradeGlobalLuminance = -15

        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"crs:ColorGradeShadowLum="-30""#))
        XCTAssertTrue(xml.contains(#"crs:ColorGradeMidtoneHue="180""#))
        XCTAssertTrue(xml.contains(#"crs:ColorGradeMidtoneSat="45""#))
        XCTAssertTrue(xml.contains(#"crs:ColorGradeMidtoneLum="10""#))
        XCTAssertTrue(xml.contains(#"crs:ColorGradeHighlightLum="25""#))
        XCTAssertTrue(xml.contains(#"crs:ColorGradeGlobalHue="300""#))
        XCTAssertTrue(xml.contains(#"crs:ColorGradeGlobalSat="60""#))
        XCTAssertTrue(xml.contains(#"crs:ColorGradeGlobalLum="-15""#))

        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.colorGradeShadowLuminance, -30)
        XCTAssertEqual(m2.colorGradeMidtoneHue, 180)
        XCTAssertEqual(m2.colorGradeMidtoneSaturation, 45)
        XCTAssertEqual(m2.colorGradeMidtoneLuminance, 10)
        XCTAssertEqual(m2.colorGradeHighlightLuminance, 25)
        XCTAssertEqual(m2.colorGradeGlobalHue, 300)
        XCTAssertEqual(m2.colorGradeGlobalSaturation, 60)
        XCTAssertEqual(m2.colorGradeGlobalLuminance, -15)
    }

    /// An all-default model omits every one of the eight `crs:ColorGrade*`
    /// keys, so a sidecar produced before #275 (or by a user who never
    /// opens the panel) stays byte-identical.
    func testAllDefaultModelOmitsEveryColorGradeKey() {
        let xml = XMPSerializer.serialize(model: .default, culling: CullingState())
        XCTAssertFalse(xml.contains("crs:ColorGradeShadowLum"))
        XCTAssertFalse(xml.contains("crs:ColorGradeMidtoneHue"))
        XCTAssertFalse(xml.contains("crs:ColorGradeMidtoneSat"))
        XCTAssertFalse(xml.contains("crs:ColorGradeMidtoneLum"))
        XCTAssertFalse(xml.contains("crs:ColorGradeHighlightLum"))
        XCTAssertFalse(xml.contains("crs:ColorGradeGlobalHue"))
        XCTAssertFalse(xml.contains("crs:ColorGradeGlobalSat"))
        XCTAssertFalse(xml.contains("crs:ColorGradeGlobalLum"))
    }

    /// A single non-default field emits ONLY its own key — verifies the
    /// omit-on-default gate is per-field, not all-or-nothing.
    func testSingleNonDefaultFieldEmitsOnlyItsOwnKey() {
        var m = AdjustmentModel()
        m.colorGradeGlobalHue = 90
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"crs:ColorGradeGlobalHue="90""#))
        XCTAssertFalse(xml.contains("crs:ColorGradeShadowLum"))
        XCTAssertFalse(xml.contains("crs:ColorGradeMidtoneHue"))
        XCTAssertFalse(xml.contains("crs:ColorGradeMidtoneSat"))
        XCTAssertFalse(xml.contains("crs:ColorGradeMidtoneLum"))
        XCTAssertFalse(xml.contains("crs:ColorGradeHighlightLum"))
        XCTAssertFalse(xml.contains("crs:ColorGradeGlobalSat"))
        XCTAssertFalse(xml.contains("crs:ColorGradeGlobalLum"))
    }

    // MARK: - Helpers

    private func xmp(attrs: String) -> String {
        """
        <?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description
              xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              xmlns:xmp="http://ns.adobe.com/xap/1.0/"
              xmlns:papp="http://ns.justmaple.app/1.0/"
              \(attrs)/>
          </rdf:RDF>
        </x:xmpmeta>
        """
    }
}
