// FilmLookXMPTests.swift — XMP round-trip for `papp:FilmLook` /
// `papp:FilmStrength` (epic #2683, Task 10).
//
// Mirrors `ColorGradingXMPTests.swift` (in-memory serialize/parse against
// the omit-on-default convention) plus a real-file round trip through
// `XMPSidecarStore` on disk in a temp directory — CLAUDE.md forbids mocking
// the sidecar layer, so the headline assertion below reads bytes that
// actually landed on disk (mirrors `ColorLabelSidecarTests.swift`).

import XCTest
@testable import MapleCore

final class FilmLookXMPTests: XCTestCase {

    // MARK: - Parse

    func testParseFilmLookFields() throws {
        let attrs = #"""
        papp:FilmLook="color_negative_kodak_portra_400"
        papp:FilmStrength="65"
        """#
        let (m, _) = try XMPParser.parse(xmp(attrs: attrs))
        XCTAssertEqual(m.filmLook, "color_negative_kodak_portra_400")
        XCTAssertEqual(m.filmStrength, 65)
    }

    /// An id with no matching `.mlut` catalog entry still parses verbatim —
    /// resolution (and the identity fallback) is `FilmLutStore`'s job at
    /// render time, not the XMP layer's.
    func testUnknownFilmLookIdPassesThroughToModel() throws {
        let attrs = #"papp:FilmLook="retired_look_no_longer_in_catalog""#
        let (m, _) = try XMPParser.parse(xmp(attrs: attrs))
        XCTAssertEqual(m.filmLook, "retired_look_no_longer_in_catalog")
    }

    // MARK: - Round trip (in-memory serialize → parse)

    func testFilmLookFieldsRoundTrip() throws {
        var m = AdjustmentModel()
        m.filmLook = "black_white_kodak_tri_x_400"
        m.filmStrength = 72

        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:FilmLook="black_white_kodak_tri_x_400""#))
        XCTAssertTrue(xml.contains(#"papp:FilmStrength="72""#))

        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.filmLook, "black_white_kodak_tri_x_400")
        XCTAssertEqual(m2.filmStrength, 72)
    }

    /// XML-special characters in the id are escaped on write and recovered
    /// on read — the brief calls this out explicitly since `filmLook` is a
    /// free-form string, not a closed rawValue enum like every sibling
    /// `papp:` field.
    func testFilmLookIdIsXMLEscaped() throws {
        var m = AdjustmentModel()
        m.filmLook = "a\"b&c<d>e"
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertFalse(xml.contains(#"papp:FilmLook="a"b&c<d>e""#))
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.filmLook, "a\"b&c<d>e")
    }

    // MARK: - Defaults-silent

    /// An all-default model omits both keys — a sidecar produced before
    /// #2683 (or by a user who never opens the film panel) stays
    /// byte-identical.
    func testDefaultModelOmitsFilmKeys() {
        let xml = XMPSerializer.serialize(model: .default, culling: CullingState())
        XCTAssertFalse(xml.contains("papp:FilmLook"))
        XCTAssertFalse(xml.contains("papp:FilmStrength"))
    }

    /// `filmStrength` at the default 100 stays silent even alongside a
    /// non-empty look — the omit-on-default gate is per-field.
    func testFilmStrengthAtDefaultOmitsEvenWithALookSet() {
        var m = AdjustmentModel()
        m.filmLook = "instant_polaroid_600"
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:FilmLook="instant_polaroid_600""#))
        XCTAssertFalse(xml.contains("papp:FilmStrength"))
    }

    // MARK: - Real-file round trip (no sidecar mocks)

    /// The headline round trip: a film look set in memory reaches a real
    /// `.xmp` on disk as `papp:FilmLook`/`papp:FilmStrength`, and parses
    /// back to the same values. No mocks — every assertion reads bytes that
    /// actually landed on disk (mirrors `ColorLabelSidecarTests.swift`).
    func testFilmLookRoundTripsThroughSidecarOnDisk() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        let store = XMPSidecarStore(rawURL: url)
        var model = AdjustmentModel()
        model.filmLook = "slide_kodak_ektachrome_100"
        model.filmStrength = 80
        await store.update(model: model, culling: CullingState())
        await store.flush()

        let sidecarURL = await store.url
        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        XCTAssertTrue(xml.contains(#"papp:FilmLook="slide_kodak_ektachrome_100""#))
        XCTAssertTrue(xml.contains(#"papp:FilmStrength="80""#))

        let (parsed, _) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.filmLook, "slide_kodak_ektachrome_100")
        XCTAssertEqual(parsed.filmStrength, 80)
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
