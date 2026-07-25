// XMPSerializationBlackWhiteTests.swift — #276 companion to
// XMPSerializationTests.swift (split out to stay under the 600-line hard
// budget, CONTRIBUTING.md § "File-size budget" — same rationale as
// XMPSerializationAutoExposureTests.swift).
//
// Covers `crs:ConvertToGrayscale` + the eight `crs:GrayMixer*` weights —
// the Black & White mix fields mirrored into the Swift `AdjustmentModel`
// by this ticket. See `AdjustmentModel.BlackWhiteMode` and
// `XMPSerialization+BlackWhite.swift` for both the parse and write side.

import XCTest
@testable import MapleCore

final class XMPSerializationBlackWhiteTests: XCTestCase {

    /// `crs:ConvertToGrayscale` accepts the ACR/Lightroom boolean
    /// spellings the ticket calls out — `"True"/"true"/"1"` → `.on`,
    /// `"False"/"false"/"0"` → `.off` — and keeps the current value
    /// (default `.off`) on an unrecognized spelling, matching every other
    /// papp:/crs: enum parse in this file (unlike raw-core's own strict
    /// parser, which errors).
    func testParseConvertToGrayscale() throws {
        for truthy in ["True", "true", "1"] {
            let (m, _) = try XMPParser.parse(xmp(attrs: #"crs:ConvertToGrayscale="\#(truthy)""#))
            XCTAssertEqual(m.blackWhite, .on, "\(truthy) should parse to .on")
        }
        for falsy in ["False", "false", "0"] {
            let (m, _) = try XMPParser.parse(xmp(attrs: #"crs:ConvertToGrayscale="\#(falsy)""#))
            XCTAssertEqual(m.blackWhite, .off, "\(falsy) should parse to .off")
        }
        let (unknown, _) = try XMPParser.parse(xmp(attrs: #"crs:ConvertToGrayscale="Maybe""#))
        XCTAssertEqual(unknown.blackWhite, .off, "unknown value keeps the default")
    }

    /// A sidecar predating #276 (no `crs:ConvertToGrayscale` / `crs:GrayMixer*`
    /// attributes at all) must parse to the default `.off` / all-zero
    /// weights — matches raw-core's own parse default.
    func testParseAbsentDefaultsToOffAndZero() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"crs:Exposure2012="1.0""#))
        XCTAssertEqual(m.blackWhite, .off)
        XCTAssertEqual(m.grayMixerRed, 0, accuracy: 1e-9)
        XCTAssertEqual(m.grayMixerMagenta, 0, accuracy: 1e-9)
    }

    /// The eight `crs:GrayMixer*` weights parse independent of the
    /// `crs:ConvertToGrayscale` toggle — a mixer edit made before B&W is
    /// switched on still lands on the model.
    func testParseGrayMixerWeights() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"""
            crs:GrayMixerRed="10" crs:GrayMixerOrange="-11" crs:GrayMixerYellow="12"
            crs:GrayMixerGreen="-13" crs:GrayMixerAqua="14" crs:GrayMixerBlue="-15"
            crs:GrayMixerPurple="16" crs:GrayMixerMagenta="-17"
            """#))
        XCTAssertEqual(m.blackWhite, .off, "weights alone must not flip the toggle")
        XCTAssertEqual(m.grayMixerRed, 10, accuracy: 1e-9)
        XCTAssertEqual(m.grayMixerOrange, -11, accuracy: 1e-9)
        XCTAssertEqual(m.grayMixerYellow, 12, accuracy: 1e-9)
        XCTAssertEqual(m.grayMixerGreen, -13, accuracy: 1e-9)
        XCTAssertEqual(m.grayMixerAqua, 14, accuracy: 1e-9)
        XCTAssertEqual(m.grayMixerBlue, -15, accuracy: 1e-9)
        XCTAssertEqual(m.grayMixerPurple, 16, accuracy: 1e-9)
        XCTAssertEqual(m.grayMixerMagenta, -17, accuracy: 1e-9)
    }

    /// All nine fields round-trip through serialize → parse, and a default
    /// model emits neither the toggle nor any weight attribute.
    func testRoundTripAndDefaultOmission() throws {
        var m = AdjustmentModel()
        m.blackWhite = .on
        m.grayMixerRed = 21
        m.grayMixerOrange = -22
        m.grayMixerYellow = 23
        m.grayMixerGreen = -24
        m.grayMixerAqua = 25
        m.grayMixerBlue = -26
        m.grayMixerPurple = 27
        m.grayMixerMagenta = -28

        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"crs:ConvertToGrayscale="True""#))
        XCTAssertTrue(xml.contains(#"crs:GrayMixerRed="21""#))
        XCTAssertTrue(xml.contains(#"crs:GrayMixerMagenta="-28""#))

        let (parsed, _) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.blackWhite, .on)
        XCTAssertEqual(parsed.grayMixerRed, 21, accuracy: 1e-9)
        XCTAssertEqual(parsed.grayMixerOrange, -22, accuracy: 1e-9)
        XCTAssertEqual(parsed.grayMixerYellow, 23, accuracy: 1e-9)
        XCTAssertEqual(parsed.grayMixerGreen, -24, accuracy: 1e-9)
        XCTAssertEqual(parsed.grayMixerAqua, 25, accuracy: 1e-9)
        XCTAssertEqual(parsed.grayMixerBlue, -26, accuracy: 1e-9)
        XCTAssertEqual(parsed.grayMixerPurple, 27, accuracy: 1e-9)
        XCTAssertEqual(parsed.grayMixerMagenta, -28, accuracy: 1e-9)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("crs:ConvertToGrayscale"),
                       "default .off must not be serialized")
        XCTAssertFalse(defaultXml.contains("crs:GrayMixer"),
                       "default zero weights must not be serialized")
    }

    /// The weights are written independent of the toggle (mirrors
    /// raw-core's `xmp::black_white::serialize`) — a non-default weight
    /// with B&W still off must still round-trip.
    func testWeightsSerializeIndependentlyOfToggle() throws {
        var m = AdjustmentModel()
        m.grayMixerRed = 15
        XCTAssertEqual(m.blackWhite, .off)

        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertFalse(xml.contains("crs:ConvertToGrayscale"))
        XCTAssertTrue(xml.contains(#"crs:GrayMixerRed="15""#))

        let (parsed, _) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.blackWhite, .off)
        XCTAssertEqual(parsed.grayMixerRed, 15, accuracy: 1e-9)
    }

    /// `XMPSidecarStore` write → read carries `blackWhite` + the mixer
    /// weights across the REAL on-disk `.xmp` boundary (no mocks — see
    /// CLAUDE.md § "No mocks for the sidecar layer").
    func testSidecarStoreRoundTripBlackWhite() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        defer {
            let xmpURL = tmp.deletingPathExtension().appendingPathExtension("xmp")
            try? FileManager.default.removeItem(at: xmpURL)
        }

        var m = AdjustmentModel()
        m.blackWhite = .on
        m.grayMixerBlue = -40

        let store = XMPSidecarStore(rawURL: tmp)
        await store.update(model: m, culling: CullingState())
        await store.flush()

        let fresh = XMPSidecarStore(rawURL: tmp)
        let (m2, _) = try await fresh.load()
        XCTAssertEqual(m2.blackWhite, .on)
        XCTAssertEqual(m2.grayMixerBlue, -40, accuracy: 1e-9)
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
