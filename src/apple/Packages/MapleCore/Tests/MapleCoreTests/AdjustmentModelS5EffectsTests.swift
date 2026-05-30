import XCTest
@testable import MapleCore

// S5 effects (Vignette / Grain / Split-tone, #643) XMP parse/serialize tests.
// Split out of AdjustmentModelTests.swift to keep that file under the 600-line
// file-size budget (CONTRIBUTING.md § "File-size budget"). Declared as an
// extension on the same XCTestCase so it shares the `xmp(attrs:)` helper and
// is discovered as part of AdjustmentModelTests.
extension AdjustmentModelTests {
    // MARK: - S5 effects fields (#643)

    /// Parses Lightroom-compatible `crs:` keys for vignette / grain /
    /// split-tone into the new model fields.
    func testParseS5EffectsFields() throws {
        let attrs = #"""
        crs:PostCropVignetteAmount="-40"
        crs:PostCropVignetteFeather="70"
        crs:GrainAmount="35"
        crs:GrainSize="40"
        crs:GrainFrequency="55"
        crs:SplitToningShadowHue="220"
        crs:SplitToningShadowSaturation="30"
        crs:SplitToningHighlightHue="40"
        crs:SplitToningHighlightSaturation="25"
        crs:SplitToningBalance="-15"
        """#
        let (m, _) = try XMPParser.parse(xmp(attrs: attrs))
        XCTAssertEqual(m.vignetteAmount, -40)
        XCTAssertEqual(m.vignetteFeather, 70)
        XCTAssertEqual(m.grainAmount, 35)
        XCTAssertEqual(m.grainSize, 40)
        XCTAssertEqual(m.grainRoughness, 55)
        XCTAssertEqual(m.splitToneShadowHue, 220)
        XCTAssertEqual(m.splitToneShadowSaturation, 30)
        XCTAssertEqual(m.splitToneHighlightHue, 40)
        XCTAssertEqual(m.splitToneHighlightSaturation, 25)
        XCTAssertEqual(m.splitToneBalance, -15)
    }

    /// S5 effects fields round-trip through serialize → parse, and
    /// non-default values emit `crs:` keys. Pre-existing default-shaped
    /// sidecars stay byte-identical because the serializer only emits
    /// non-default values (guarded by `testS5EffectsDefaultsNotSerialized`
    /// below).
    func testS5EffectsRoundTrip() throws {
        var m = AdjustmentModel()
        m.vignetteAmount = -35
        m.vignetteFeather = 80
        m.grainAmount = 25
        m.grainSize = 40
        m.grainRoughness = 60
        m.splitToneShadowHue = 200
        m.splitToneShadowSaturation = 20
        m.splitToneHighlightHue = 45
        m.splitToneHighlightSaturation = 15
        m.splitToneBalance = -10
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"crs:PostCropVignetteAmount="-35""#))
        XCTAssertTrue(xml.contains(#"crs:GrainFrequency="60""#))
        XCTAssertTrue(xml.contains(#"crs:SplitToningBalance="-10""#))
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.vignetteAmount, -35)
        XCTAssertEqual(m2.vignetteFeather, 80)
        XCTAssertEqual(m2.grainAmount, 25)
        XCTAssertEqual(m2.grainSize, 40)
        XCTAssertEqual(m2.grainRoughness, 60)
        XCTAssertEqual(m2.splitToneShadowHue, 200)
        XCTAssertEqual(m2.splitToneShadowSaturation, 20)
        XCTAssertEqual(m2.splitToneHighlightHue, 45)
        XCTAssertEqual(m2.splitToneHighlightSaturation, 15)
        XCTAssertEqual(m2.splitToneBalance, -10)
    }

    /// Default-valued S5 effects fields MUST NOT emit any `crs:` keys, so
    /// sidecars produced before #643 remain byte-identical for users who
    /// never touch the new tools.
    func testS5EffectsDefaultsNotSerialized() {
        let xml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(xml.contains("crs:PostCropVignetteAmount"))
        XCTAssertFalse(xml.contains("crs:PostCropVignetteFeather"))
        XCTAssertFalse(xml.contains("crs:GrainAmount"))
        XCTAssertFalse(xml.contains("crs:GrainSize"))
        XCTAssertFalse(xml.contains("crs:GrainFrequency"))
        XCTAssertFalse(xml.contains("crs:SplitToningShadowHue"))
        XCTAssertFalse(xml.contains("crs:SplitToningShadowSaturation"))
        XCTAssertFalse(xml.contains("crs:SplitToningHighlightHue"))
        XCTAssertFalse(xml.contains("crs:SplitToningHighlightSaturation"))
        XCTAssertFalse(xml.contains("crs:SplitToningBalance"))
    }

    // MARK: - S5 effects + keywords interaction (#632 / #643 merge)

    /// The reconciliation of the two XMP file-splits introduces one case
    /// neither `testS5EffectsRoundTrip` (empty culling) nor
    /// `testKeywordsRoundTrip` (default model) exercises: S5 effect
    /// attributes living inside the open/close `rdf:Description` form
    /// *alongside* the `dc:subject` keyword bag. Setting both in one
    /// sidecar proves the S5 attrs were appended to the shared `attrs`
    /// list (so they survive the keyword-bearing output branch) and that
    /// the keyword sub-parser still recovers the bag when S5 attributes
    /// precede it.
    func testS5EffectsAndKeywordsRoundTripTogether() throws {
        var m = AdjustmentModel()
        m.vignetteAmount = -35
        m.grainAmount = 25
        m.splitToneShadowHue = 200
        m.splitToneBalance = -10
        let c = CullingState(stars: 3, flag: .pick, keywords: ["travel", "paris", "2026"])

        let xml = XMPSerializer.serialize(model: m, culling: c)
        // S5 attrs must appear in the keyword-bearing (open/close) form.
        XCTAssertTrue(xml.contains(#"crs:PostCropVignetteAmount="-35""#))
        XCTAssertTrue(xml.contains(#"crs:SplitToningBalance="-10""#))
        XCTAssertTrue(xml.contains("<dc:subject>"))

        let (m2, c2) = try XMPParser.parse(xml)
        // S5 fields survive.
        XCTAssertEqual(m2.vignetteAmount, -35)
        XCTAssertEqual(m2.grainAmount, 25)
        XCTAssertEqual(m2.splitToneShadowHue, 200)
        XCTAssertEqual(m2.splitToneBalance, -10)
        // Keywords + culling survive.
        XCTAssertEqual(c2.keywords, ["travel", "paris", "2026"])
        XCTAssertEqual(c2.stars, 3)
        XCTAssertEqual(c2.flag, .pick)
    }

}
