// XMPSerializationStageKnobTests.swift — XMP round-trip coverage for the
// per-stage strength knobs: the three decode-product stages Maple namespaces
// under `papp:` (chroma pre-filter #1104, hot/dead-pixel suppression #1106,
// BM3D deep denoise #1105) and the DNG lens corrections ACR namespaces under
// `crs:LensProfile*` (#376).
//
// Split out of `XMPSerializationTests.swift` in #376 to keep both files under
// the 600-line hard budget (CONTRIBUTING.md), the same rationale as the
// existing `XMPSerializationAutoExposureTests` and
// `XMPSerializationBlackWhiteTests` siblings. Pure move — every test body is
// unchanged.
//
// These four sections share one shape, which is why they share a file: parse
// the attribute, round-trip it, prove the default is omitted so pre-feature
// sidecars stay byte-identical, and prove `stripAppleGPUStages` preserves it
// (each is baked into the Rust decode product, so it must survive into the
// #950 baked-model cache key rather than being re-applied on the Metal side).

import XCTest
@testable import MapleCore

final class XMPSerializationStageKnobTests: XCTestCase {

    // MARK: - Chroma pre-filter (#1104)

    /// `papp:ChromaPrefilter` parses onto `model.chromaPrefilter`, and it
    /// is distinct from ACR's `crs:ColorNoiseReduction` (which maps onto
    /// the late-chain `nrColor` NLM slider).
    func testParseChromaPrefilter() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"papp:ChromaPrefilter="35""#))
        XCTAssertEqual(m.chromaPrefilter, 35)
        XCTAssertEqual(m.nrColor, 25, "nrColor must stay at its default")
    }

    /// ChromaPrefilter round-trips through serialize → parse, and the
    /// default (0) emits no attribute so pre-#1104 sidecars stay
    /// byte-identical.
    func testChromaPrefilterRoundTripAndDefaultOmission() throws {
        var m = AdjustmentModel()
        m.chromaPrefilter = 35
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:ChromaPrefilter="35""#))
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.chromaPrefilter, 35)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("papp:ChromaPrefilter"),
                       "default chromaPrefilter must not be serialized")
    }

    /// The decode-baked field must survive `stripAppleGPUStages` — the
    /// strip removes only the stages the per-tick Apple chain re-applies,
    /// and the chroma pre-filter has no chain equivalent. This is also
    /// what keys the decoded-image cache (#950 baked model): if the strip
    /// dropped it, edits to the field would silently never re-decode.
    func testStripKeepsChromaPrefilter() {
        var m = AdjustmentModel()
        m.chromaPrefilter = 60
        let stripped = RawCoreBridge.stripAppleGPUStages(m)
        XCTAssertEqual(stripped.chromaPrefilter, 60,
                       "stripAppleGPUStages must keep the decode-baked chromaPrefilter")
    }

    // MARK: - Hot/dead-pixel suppression (#1106)

    /// `papp:HotPixelSuppression` parses case-insensitively onto the
    /// model; unknown values keep the default rather than erroring the
    /// whole sidecar (Apple parser convention).
    func testParseHotPixelSuppression() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"papp:HotPixelSuppression="On""#))
        XCTAssertEqual(m.hotPixelSuppression, .on)
        let (m2, _) = try XMPParser.parse(xmp(attrs: #"papp:HotPixelSuppression="off""#))
        XCTAssertEqual(m2.hotPixelSuppression, .off)
        let (m3, _) = try XMPParser.parse(xmp(attrs: #"papp:HotPixelSuppression="Maybe""#))
        XCTAssertEqual(m3.hotPixelSuppression, .off, "unknown value keeps the default")
    }

    /// HotPixelSuppression round-trips through serialize → parse, and the
    /// default (.off) emits no attribute so pre-#1106 sidecars stay
    /// byte-identical.
    func testHotPixelSuppressionRoundTripAndDefaultOmission() throws {
        var m = AdjustmentModel()
        m.hotPixelSuppression = .on
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:HotPixelSuppression="On""#))
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.hotPixelSuppression, .on)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("papp:HotPixelSuppression"),
                       "default .off must not be serialized")
    }

    /// The decode-baked field must survive `stripAppleGPUStages` — same
    /// cache-key contract as `chromaPrefilter` (#950 baked model).
    func testStripKeepsHotPixelSuppression() {
        var m = AdjustmentModel()
        m.hotPixelSuppression = .on
        let stripped = RawCoreBridge.stripAppleGPUStages(m)
        XCTAssertEqual(stripped.hotPixelSuppression, .on,
                       "stripAppleGPUStages must keep the decode-baked hotPixelSuppression")
    }

    // MARK: - DNG lens corrections (#376)

    /// A fresh model applies the DNG's embedded corrections in full,
    /// matching ACR when the file carries a profile.
    func testLensCorrectionDefaultsAreFullStrength() {
        let m = AdjustmentModel()
        XCTAssertEqual(m.lensProfileEnable, .on)
        XCTAssertEqual(m.lensCorrectionDistortion, 100)
        XCTAssertEqual(m.lensCorrectionCa, 100)
        XCTAssertEqual(m.lensCorrectionVignetting, 100)
    }

    /// `crs:LensProfileEnable` parses ACR's "1"/"0" spelling as well as
    /// the True/False form other XMP writers use for boolean markers;
    /// unknown values keep the default rather than failing the sidecar.
    func testParseLensProfileEnable() throws {
        for on in ["1", "true", "True", "On"] {
            let (m, _) = try XMPParser.parse(xmp(attrs: "crs:LensProfileEnable=\"\(on)\""))
            XCTAssertEqual(m.lensProfileEnable, .on, "\(on) must parse as on")
        }
        for off in ["0", "false", "False", "Off"] {
            let (m, _) = try XMPParser.parse(xmp(attrs: "crs:LensProfileEnable=\"\(off)\""))
            XCTAssertEqual(m.lensProfileEnable, .off, "\(off) must parse as off")
        }
        let (m, _) = try XMPParser.parse(xmp(attrs: #"crs:LensProfileEnable="Maybe""#))
        XCTAssertEqual(m.lensProfileEnable, .on, "unknown value keeps the default")
    }

    func testParseLensCorrectionScales() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: """
            crs:LensProfileDistortionScale="80" \
            crs:LensProfileChromaticAberrationScale="0" \
            crs:LensProfileVignettingScale="55"
            """))
        XCTAssertEqual(m.lensCorrectionDistortion, 80)
        XCTAssertEqual(m.lensCorrectionCa, 0)
        XCTAssertEqual(m.lensCorrectionVignetting, 55)
    }

    /// The whole group round-trips, and an untouched lens panel writes
    /// nothing so existing sidecars stay byte-identical.
    func testLensCorrectionRoundTripAndDefaultOmission() throws {
        var m = AdjustmentModel()
        m.lensProfileEnable = .off
        m.lensCorrectionDistortion = 80
        m.lensCorrectionCa = 0
        m.lensCorrectionVignetting = 55
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"crs:LensProfileEnable="0""#))
        XCTAssertTrue(xml.contains(#"crs:LensProfileDistortionScale="80""#))
        XCTAssertTrue(xml.contains(#"crs:LensProfileChromaticAberrationScale="0""#))
        XCTAssertTrue(xml.contains(#"crs:LensProfileVignettingScale="55""#))

        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.lensProfileEnable, .off)
        XCTAssertEqual(m2.lensCorrectionDistortion, 80)
        XCTAssertEqual(m2.lensCorrectionCa, 0)
        XCTAssertEqual(m2.lensCorrectionVignetting, 55)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("crs:LensProfile"),
                       "an untouched lens panel must not write any attribute")
    }

    /// The lens scales are decode-product parameters like
    /// `chromaPrefilter`: `stripAppleGPUStages` must keep them so the
    /// #950 baked-model decode-cache key re-decodes when one changes.
    func testStripKeepsLensCorrections() {
        var m = AdjustmentModel()
        m.lensProfileEnable = .off
        m.lensCorrectionDistortion = 20
        m.lensCorrectionCa = 30
        m.lensCorrectionVignetting = 40
        let stripped = RawCoreBridge.stripAppleGPUStages(m)
        XCTAssertEqual(stripped.lensProfileEnable, .off)
        XCTAssertEqual(stripped.lensCorrectionDistortion, 20)
        XCTAssertEqual(stripped.lensCorrectionCa, 30)
        XCTAssertEqual(stripped.lensCorrectionVignetting, 40)
    }

    // MARK: - BM3D deep denoise (#1105)

    /// `papp:DeepDenoise` parses, round-trips, and is omitted at the
    /// default (0) so pre-#1105 sidecars stay byte-identical; the
    /// decode-baked field survives `stripAppleGPUStages` (the #950
    /// baked-model cache-key contract — this is what makes the BM3D run
    /// a one-time cost per setting).
    func testDeepDenoiseRoundTripDefaultOmissionAndStrip() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"papp:DeepDenoise="70""#))
        XCTAssertEqual(m.deepDenoise, 70)

        var m2 = AdjustmentModel()
        m2.deepDenoise = 70
        let xml = XMPSerializer.serialize(model: m2, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:DeepDenoise="70""#))
        let (m3, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m3.deepDenoise, 70)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("papp:DeepDenoise"),
                       "default deepDenoise must not be serialized")

        let stripped = RawCoreBridge.stripAppleGPUStages(m2)
        XCTAssertEqual(stripped.deepDenoise, 70,
                       "stripAppleGPUStages must keep the decode-baked deepDenoise")
    }

    // MARK: - Helpers

    /// Same sidecar skeleton the sibling XMP suites build (see
    /// `XMPSerializationTests`, `ColorGradingXMPTests`); each test class
    /// carries its own private copy.
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
