// PappSchemaTests.swift — Round-trip tests for the papp:Panorama XMP schema (T5.6).
//
// Verifier: swift test --filter PappSchemaTests
//
// Every test that writes a PanoramaSidecar must parse it back and assert
// struct-equality, exercising the full serialize → parse round-trip without
// relying on fixtures or the filesystem.

import XCTest
@testable import MapleCore

final class PappSchemaTests: XCTestCase {

    // MARK: - Fixtures

    /// Minimal panorama with one source, identity homography.
    private static let minimalPano = PanoramaSidecar(
        sources: [
            PanoramaSidecar.SourceEntry(
                sourcePath: "/Volumes/Photos/img_001.dng",
                sourceBookmark: nil,
                sourceHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                focalLength: 24.0,
                exposureValue: 0.0
            )
        ],
        alignment: .identity,
        output: PanoramaSidecar.Output(width: 4096, height: 1024, projection: .cylindrical),
        preset: .quality
    )

    /// Full panorama with two sources, bookmark, non-identity homography,
    /// non-zero BA residual, and rectilinear projection.
    private static let fullPano = PanoramaSidecar(
        sources: [
            PanoramaSidecar.SourceEntry(
                sourcePath: "/Volumes/Photos/frame_001.dng",
                sourceBookmark: "YmFzZTY0Ym9va21hcms=",   // base64 placeholder
                sourceHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                focalLength: 50.0,
                exposureValue: 1.0
            ),
            PanoramaSidecar.SourceEntry(
                sourcePath: "/Volumes/Photos/frame_002.dng",
                sourceBookmark: nil,
                sourceHash: "cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe",
                focalLength: 50.0,
                exposureValue: 0.5
            )
        ],
        alignment: PanoramaSidecar.Alignment(
            homography: [
                0.99, -0.01, 120.5,
                0.01,  1.00,  -3.2,
                0.00,  0.00,   1.0
            ],
            baResidual: 0.42
        ),
        output: PanoramaSidecar.Output(width: 8192, height: 2048, projection: .rectilinear),
        preset: .quick
    )

    // MARK: - Basic round-trip tests

    func testMinimalPanoRoundTrip() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.minimalPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed, Self.minimalPano,
            "Minimal PanoramaSidecar must round-trip through serialize → parse unchanged")
    }

    func testFullPanoRoundTrip() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.fullPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed, Self.fullPano,
            "Full PanoramaSidecar (two sources, non-identity homography) must round-trip")
    }

    // MARK: - Idempotency: serialize → parse → serialize must produce identical XML

    func testSerializationIsIdempotent() throws {
        let xml1 = PanoramaXMPSerializer.serialize(Self.fullPano)
        let parsed = try PanoramaXMPParser.parse(xml1)
        let xml2 = PanoramaXMPSerializer.serialize(parsed)

        XCTAssertEqual(xml1, xml2,
            "Serializing a parsed PanoramaSidecar must produce the same XML as the original")
    }

    // MARK: - Source field round-trips

    func testSourceBookmarkIsOptional_presentWhenProvided() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.fullPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.sources[0].sourceBookmark, "YmFzZTY0Ym9va21hcms=")
        XCTAssertNil(parsed.sources[1].sourceBookmark,
            "nil sourceBookmark must remain nil after round-trip")
    }

    func testSourcePathIsPreserved() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.fullPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.sources[0].sourcePath, "/Volumes/Photos/frame_001.dng")
        XCTAssertEqual(parsed.sources[1].sourcePath, "/Volumes/Photos/frame_002.dng")
    }

    func testSourceHashIsPreserved() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.minimalPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(
            parsed.sources[0].sourceHash,
            "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
        )
    }

    func testFocalLengthAndEVArePreserved() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.fullPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.sources[0].focalLength, 50.0, accuracy: 0.001)
        XCTAssertEqual(parsed.sources[0].exposureValue, 1.0, accuracy: 0.001)
        XCTAssertEqual(parsed.sources[1].exposureValue, 0.5, accuracy: 0.001)
    }

    // MARK: - Alignment round-trips

    func testHomographyMatrixRoundTrip() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.fullPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.alignment.homography.count, 9,
            "Homography must have exactly 9 elements after round-trip")
        let expected = Self.fullPano.alignment.homography
        for (i, (got, want)) in zip(parsed.alignment.homography, expected).enumerated() {
            XCTAssertEqual(got, want, accuracy: 0.001,
                "Homography element \(i) must round-trip accurately")
        }
    }

    func testIdentityHomographyRoundTrip() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.minimalPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.alignment, PanoramaSidecar.Alignment.identity)
    }

    func testBAResidualRoundTrip() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.fullPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.alignment.baResidual, 0.42, accuracy: 0.001)
    }

    // MARK: - Output round-trips

    func testOutputDimensionsRoundTrip() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.fullPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.output.width, 8192)
        XCTAssertEqual(parsed.output.height, 2048)
    }

    func testProjectionRoundTrip_cylindrical() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.minimalPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.output.projection, .cylindrical)
    }

    func testProjectionRoundTrip_rectilinear() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.fullPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.output.projection, .rectilinear)
    }

    func testProjectionRoundTrip_spherical() throws {
        var pano = Self.minimalPano
        pano.output.projection = .spherical
        let xml = PanoramaXMPSerializer.serialize(pano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.output.projection, .spherical)
    }

    // MARK: - Preset round-trips

    func testPreset_quality() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.minimalPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.preset, .quality)
    }

    func testPreset_quick() throws {
        let xml = PanoramaXMPSerializer.serialize(Self.fullPano)
        let parsed = try PanoramaXMPParser.parse(xml)

        XCTAssertEqual(parsed.preset, .quick)
    }

    // MARK: - XML structural checks

    /// Verify the XMP envelope is present and uses the correct namespace URI.
    func testSerializedXMLHasCorrectEnvelope() {
        let xml = PanoramaXMPSerializer.serialize(Self.minimalPano)

        XCTAssertTrue(xml.contains("<?xpacket begin="), "Must have xpacket begin")
        XCTAssertTrue(xml.contains("<?xpacket end=\"w\"?>"), "Must have xpacket end")
        XCTAssertTrue(xml.contains("xmlns:papp=\"http://ns.justmaple.app/1.0/\""),
            "Must declare the papp: namespace URI")
        XCTAssertTrue(xml.contains("<papp:Panorama>"), "Must contain papp:Panorama element")
        XCTAssertTrue(xml.contains("</papp:Panorama>"), "Must close papp:Panorama element")
    }

    /// Verify that special XML characters in paths are escaped in the output.
    func testXMLSpecialCharsInPathAreEscaped() throws {
        var pano = Self.minimalPano
        pano.sources[0].sourcePath = "/Volumes/My&Photos <2024>"
        let xml = PanoramaXMPSerializer.serialize(pano)

        XCTAssertTrue(xml.contains("My&amp;Photos &lt;2024&gt;"),
            "& and < in path must be XML-escaped in the serialized output")

        let parsed = try PanoramaXMPParser.parse(xml)
        XCTAssertEqual(parsed.sources[0].sourcePath, "/Volumes/My&Photos <2024>",
            "Parser must unescape XML entities back to original path")
    }

    // MARK: - Number formatting

    func testNumberFormatter_integer() {
        XCTAssertEqual(PanoramaXMPSerializer.fmtNum(1.0), "1")
        XCTAssertEqual(PanoramaXMPSerializer.fmtNum(-3.0), "-3")
        XCTAssertEqual(PanoramaXMPSerializer.fmtNum(0.0), "0")
    }

    func testNumberFormatter_fractional() {
        XCTAssertEqual(PanoramaXMPSerializer.fmtNum(0.5), "0.5")
        XCTAssertEqual(PanoramaXMPSerializer.fmtNum(0.42), "0.42")
        // Values beyond 2 decimal places are truncated to 2 d.p.
        XCTAssertEqual(PanoramaXMPSerializer.fmtNum(0.123), "0.12")
    }

    // MARK: - Error cases

    /// Parsing XML without any papp:Panorama element must throw `.missingPanorama`.
    func testParseEmptyXML_throwsMissingPanorama() {
        let xml = """
        <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description/>
          </rdf:RDF>
        </x:xmpmeta>
        <?xpacket end="w"?>
        """
        XCTAssertThrowsError(try PanoramaXMPParser.parse(xml)) { error in
            if case PanoramaXMPParser.ParseError.missingPanorama = error {
                // expected
            } else {
                XCTFail("Expected .missingPanorama, got \(error)")
            }
        }
    }

    /// Parsing non-UTF8 data must throw `.notUTF8`.
    func testParseNonUTF8Data_throwsNotUTF8() {
        // 0xFF is not valid UTF-8.
        let badData = Data([0xFF, 0xFE, 0x00])
        XCTAssertThrowsError(try PanoramaXMPParser.parse(data: badData)) { error in
            if case PanoramaXMPParser.ParseError.notUTF8 = error {
                // expected
            } else {
                XCTFail("Expected .notUTF8, got \(error)")
            }
        }
    }
}
