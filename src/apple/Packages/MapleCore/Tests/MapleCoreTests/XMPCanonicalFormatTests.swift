// XMPCanonicalFormatTests.swift — the Swift half of the cross-engine
// byte-canonical contract (#1577).
//
// `xmpCanonicalGoldenDocument` below is the same literal as
// `CANONICAL_GOLDEN_DOCUMENT` in
// `src/web/projects/maple-common/src/lib/xmp/xmp-canonical.spec.ts`, and
// `canonicalFixtureModel` builds the same model as that spec's
// `canonicalFixtureModel`. Both suites assert their own serializer reproduces
// the literal, so a divergence on either platform fails that platform's tests
// — the zero-byte-diff check without a build that runs Swift and TypeScript in
// one process.
//
// What the parity claim covers, precisely: the canonical document for a model
// both writers emit the same field set for. It is not whole-document equality
// for arbitrary round-tripped sidecars — the web writer preserves unknown
// attributes and nested nodes and Apple's has no passthrough at all (#2233),
// so a document carrying foreign fields cannot be byte-equal across the two.
// It also excludes `papp:Hidden` (no web writer) and default-valued sliders
// (Apple authors them unconditionally, the web writer omits them); the fixture
// therefore sets every unconditionally-emitted field to a non-default value.

import XCTest
@testable import MapleCore

final class XMPCanonicalFormatTests: XCTestCase {

    // MARK: - Shared cross-engine fixture

    /// Every field the Swift writer emits unconditionally is non-default here,
    /// so the web writer's omit-on-default rule yields the same attribute set.
    static func canonicalFixtureModel() -> AdjustmentModel {
        var m = AdjustmentModel()
        m.temperature = 5200
        m.tint = -14.5
        m.wbScaleVersion = 5
        m.exposure = 0.5
        m.brightness = 6
        m.contrast = 12
        m.highlights = -30
        m.shadows = 25
        m.whites = 8
        m.blacks = -6
        m.parametricHighlights = 4
        m.parametricLights = -3
        m.parametricDarks = 2.5
        m.parametricShadows = -1
        m.vibrance = 15
        m.saturation = -10
        m.clarity = 20
        m.texture = 7
        m.dehaze = 5
        m.sharpenAmount = 55
        m.sharpenRadius = 1.4
        m.sharpenDetail = 30
        m.sharpenMasking = 12
        m.captureSharpeningAmount = 35
        m.captureSharpeningSigma = 0.8
        m.nrLuminance = 18
        m.nrColor = 30
        m.chromaPrefilter = 3
        m.deepDenoise = 9
        m.vignetteAmount = -20
        m.vignetteFeather = 40
        m.grainAmount = 10
        m.grainSize = 30
        m.grainRoughness = 45
        m.splitToneShadowHue = 210
        m.splitToneShadowSaturation = 12
        m.splitToneHighlightHue = 45
        m.splitToneHighlightSaturation = 8
        m.splitToneBalance = -5
        m.colorGradeShadowLuminance = 3
        m.colorGradeMidtoneHue = 120
        m.colorGradeMidtoneSaturation = 14
        m.colorGradeMidtoneLuminance = -2
        m.colorGradeHighlightLuminance = 6
        m.colorGradeGlobalHue = 300
        m.colorGradeGlobalSaturation = 9
        m.colorGradeGlobalLuminance = 1
        m.hueAdjustmentRed = 5
        m.hueAdjustmentAqua = -7
        m.saturationAdjustmentGreen = 11
        m.luminanceAdjustmentBlue = -13
        m.blackWhite = .on
        m.grayMixerRed = 22
        m.grayMixerMagenta = -18
        m.highlightRecovery = .blend
        m.autoExposure = .off
        // `papp:WbMethod` / `papp:ToneCurveMode` are deliberately left at
        // their defaults: Apple's `AdjustmentModel` has no field for either
        // (#2216), so only the web writer can emit them and a non-default
        // value would put an attribute in the golden one engine cannot
        // produce.
        m.hotPixelSuppression = .on
        m.profile = .neutral
        m.crop = Crop(top: 0.1, left: 0.05, bottom: 0.9, right: 0.95, angle: 2.5)
        m.toneCurveLuma = ToneCurve(points: [(x: 0, y: 0), (x: 0.5, y: 0.55), (x: 1, y: 1)])
        m.toneCurveBlue = ToneCurve(points: [(x: 0, y: 0), (x: 1, y: 0.8)])
        return m
    }

    /// `hidden` stays nil: `papp:Hidden` has no web writer, so including it
    /// would put an attribute in the golden that only one engine can produce.
    static func canonicalFixtureCulling() -> CullingState {
        CullingState(
            stars: 4,
            flag: .pick,
            keywords: ["alpha", "bravo & co"],
            colorLabel: .green)
    }

    // MARK: - Zero-byte-diff golden

    func testSerializeMatchesCrossEngineGolden() {
        let produced = XMPSerializer.serialize(
            model: Self.canonicalFixtureModel(),
            culling: Self.canonicalFixtureCulling())
        XCTAssertEqual(produced, xmpCanonicalGoldenDocument)
    }

    /// The golden is not just "whatever we emit": these are the four
    /// divergences #1577 was filed for, asserted directly so a regression
    /// names itself rather than showing up as an opaque string diff.
    func testCanonicalInvariants() {
        let doc = XMPSerializer.serialize(
            model: Self.canonicalFixtureModel(),
            culling: Self.canonicalFixtureCulling())
        XCTAssertTrue(doc.contains("      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\""),
                      "papp: must bind the canonical URI")
        let nsOrder = ["xmlns:xmp=", "xmlns:crs=", "xmlns:papp=", "xmlns:dc="]
        let positions = nsOrder.map { doc.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(where: { $0 == nil }),
                       "every expected namespace declaration must be present")
        XCTAssertEqual(positions.compactMap { $0 }, positions.compactMap { $0 }.sorted(),
                       "namespace declarations must be in canonical order")
        XCTAssertFalse(doc.contains("x:xmptk"),
                       "the toolkit string is platform-identifying and is not canonical")
        // xmp: sorts before crs:, which sorts before papp:; alphabetical
        // within each namespace.
        guard let rating = doc.range(of: "xmp:Rating="),
              let blacks = doc.range(of: "crs:Blacks2012="),
              let whites = doc.range(of: "crs:Whites2012="),
              let brightness = doc.range(of: "papp:Brightness=") else {
            return XCTFail("expected attributes missing from the canonical document")
        }
        XCTAssertLessThan(rating.lowerBound, blacks.lowerBound)
        XCTAssertLessThan(blacks.lowerBound, whites.lowerBound)
        XCTAssertLessThan(whites.lowerBound, brightness.lowerBound)
    }

    /// Every nested child sits at the canonical six-space indent, stepping two
    /// per level — the `dc:subject` bag used 6/8/10 while the metadata
    /// lang-alt blocks used 2/3/4 before #1577.
    func testNestedChildrenShareOneIndentLadder() {
        let doc = XMPSerializer.serialize(
            model: Self.canonicalFixtureModel(),
            culling: Self.canonicalFixtureCulling())
        for line in ["      <dc:subject>", "        <rdf:Bag>",
                     "          <rdf:li>alpha</rdf:li>",
                     "      <papp:SceneLinearToneCurve>", "        <rdf:Seq>"] {
            XCTAssertTrue(doc.contains(line), "expected canonical indent line: \(line)")
        }
    }

    // MARK: - Existing sidecars must keep parsing

    /// A sidecar in the pre-#1577 Apple layout — the old `papp:` URI, the old
    /// `crs, xmp, papp` declaration order, no `rdf:about`, unsorted attributes
    /// — must still load. Written to a real file in a temp directory and read
    /// back through the on-disk store, per CLAUDE.md's no-mocks-for-sidecars
    /// rule.
    func testLegacyLayoutSidecarStillParses() throws {
        let legacy = """
        <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description
              xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              xmlns:xmp="http://ns.adobe.com/xap/1.0/"
              xmlns:papp="http://ns.justmaple.app/1.0/"
              xmlns:dc="http://purl.org/dc/elements/1.1/"
              crs:Temperature="5200"
              crs:Tint="-14.5"
              papp:WbScaleVersion="5"
              crs:Exposure2012="0.50"
              crs:Contrast2012="12"
              crs:Shadows2012="25"
              crs:SharpenRadius="1.4"
              papp:CaptureSharpeningSigma="0.8"
              papp:Profile="Neutral"
              papp:Flag="pick"
              papp:ColorLabel="green"
              xmp:Rating="4">
              <dc:subject>
                <rdf:Bag>
                  <rdf:li>alpha</rdf:li>
                </rdf:Bag>
              </dc:subject>
              <papp:SceneLinearToneCurve>
                <rdf:Seq>
                  <rdf:li>0, 0</rdf:li>
                  <rdf:li>127.5, 140.25</rdf:li>
                </rdf:Seq>
              </papp:SceneLinearToneCurve>
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>
        <?xpacket end="w"?>
        """
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-xmp-1577-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("legacy.xmp")
        try legacy.write(to: url, atomically: true, encoding: .utf8)

        let (model, culling) = try XMPParser.parse(data: Data(contentsOf: url))
        XCTAssertEqual(model.temperature, 5200, accuracy: 1e-9)
        XCTAssertEqual(model.tint, -14.5, accuracy: 1e-9)
        XCTAssertEqual(model.wbScaleVersion, 5)
        XCTAssertEqual(model.exposure, 0.5, accuracy: 1e-9)
        XCTAssertEqual(model.contrast, 12, accuracy: 1e-9)
        XCTAssertEqual(model.shadows, 25, accuracy: 1e-9)
        XCTAssertEqual(model.sharpenRadius, 1.4, accuracy: 1e-9)
        XCTAssertEqual(model.captureSharpeningSigma, 0.8, accuracy: 1e-9)
        XCTAssertEqual(model.profile, .neutral)
        XCTAssertEqual(culling.stars, 4)
        XCTAssertEqual(culling.flag, .pick)
        XCTAssertEqual(culling.colorLabel, .green)
        XCTAssertEqual(culling.keywords, ["alpha"])
        XCTAssertEqual(model.toneCurveLuma.points.count, 2)
        XCTAssertEqual(model.toneCurveLuma.points[1].x, 0.5, accuracy: 1e-6)
        XCTAssertEqual(model.toneCurveLuma.points[1].y, 0.55, accuracy: 1e-6)
    }

    /// A legacy sidecar upgrades to the canonical layout on the next save,
    /// without touching the original until then. Round-trips through real
    /// files rather than in-memory strings.
    func testLegacySidecarUpgradesOnResave() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-xmp-1577-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("resave.xmp")

        let original = XMPSerializer.serialize(
            model: Self.canonicalFixtureModel(), culling: Self.canonicalFixtureCulling())
        try original.write(to: url, atomically: true, encoding: .utf8)

        let (model, culling) = try XMPParser.parse(data: Data(contentsOf: url))
        let resaved = XMPSerializer.serialize(model: model, culling: culling)
        try resaved.write(to: url, atomically: true, encoding: .utf8)

        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), original,
                       "a canonical sidecar must be a fixed point of write → parse → write")
    }
}

/// See the file header: this literal is duplicated verbatim in
/// `xmp-canonical.spec.ts`. Any canonical-format change updates both copies
/// and `docs/xmp-canonical-format.md` in the same commit.
let xmpCanonicalGoldenDocument = """
<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmp:Rating="4"
      crs:Blacks2012="-6"
      crs:Clarity2012="20"
      crs:ColorGradeGlobalHue="300"
      crs:ColorGradeGlobalLum="1"
      crs:ColorGradeGlobalSat="9"
      crs:ColorGradeHighlightLum="6"
      crs:ColorGradeMidtoneHue="120"
      crs:ColorGradeMidtoneLum="-2"
      crs:ColorGradeMidtoneSat="14"
      crs:ColorGradeShadowLum="3"
      crs:ColorNoiseReduction="30"
      crs:Contrast2012="12"
      crs:ConvertToGrayscale="True"
      crs:CropAngle="2.500000"
      crs:CropBottom="0.900000"
      crs:CropConstrainToWarp="0"
      crs:CropLeft="0.050000"
      crs:CropRight="0.950000"
      crs:CropTop="0.100000"
      crs:Dehaze="5"
      crs:Exposure2012="0.5"
      crs:GrainAmount="10"
      crs:GrainFrequency="45"
      crs:GrainSize="30"
      crs:GrayMixerMagenta="-18"
      crs:GrayMixerRed="22"
      crs:HasCrop="True"
      crs:HasSettings="True"
      crs:Highlights2012="-30"
      crs:HueAdjustmentAqua="-7"
      crs:HueAdjustmentRed="5"
      crs:LuminanceAdjustmentBlue="-13"
      crs:LuminanceSmoothing="18"
      crs:ParametricDarks="2.5"
      crs:ParametricHighlights="4"
      crs:ParametricLights="-3"
      crs:ParametricShadows="-1"
      crs:PostCropVignetteAmount="-20"
      crs:PostCropVignetteFeather="40"
      crs:ProcessVersion="11.0"
      crs:Saturation="-10"
      crs:SaturationAdjustmentGreen="11"
      crs:Shadows2012="25"
      crs:SharpenDetail="30"
      crs:SharpenEdgeMasking="12"
      crs:SharpenRadius="1.4"
      crs:Sharpness="55"
      crs:SplitToningBalance="-5"
      crs:SplitToningHighlightHue="45"
      crs:SplitToningHighlightSaturation="8"
      crs:SplitToningShadowHue="210"
      crs:SplitToningShadowSaturation="12"
      crs:Temperature="5200"
      crs:Texture="7"
      crs:Tint="-14.5"
      crs:Version="11.0"
      crs:Vibrance="15"
      crs:WhiteBalance="Custom"
      crs:Whites2012="8"
      papp:AutoExposure="Off"
      papp:Brightness="6"
      papp:CaptureSharpeningAmount="35"
      papp:CaptureSharpeningSigma="0.8"
      papp:ChromaPrefilter="3"
      papp:ColorLabel="green"
      papp:DeepDenoise="9"
      papp:Flag="pick"
      papp:HighlightRecoveryMode="Blend"
      papp:HotPixelSuppression="On"
      papp:Profile="Neutral"
      papp:WbScaleVersion="5">
      <dc:subject>
        <rdf:Bag>
          <rdf:li>alpha</rdf:li>
          <rdf:li>bravo &amp; co</rdf:li>
        </rdf:Bag>
      </dc:subject>
      <papp:SceneLinearToneCurve>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>127.5, 140.25</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </papp:SceneLinearToneCurve>
      <papp:SceneLinearToneCurveBlue>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>255, 204</rdf:li>
        </rdf:Seq>
      </papp:SceneLinearToneCurveBlue>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"""
