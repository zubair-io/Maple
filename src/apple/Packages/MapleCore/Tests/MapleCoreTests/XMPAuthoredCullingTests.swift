// XMPAuthoredCullingTests.swift — `xmp:Rating` and `xmp:Label` survive an
// unrelated save byte-for-byte (#4403). Round trips go through a real `.xmp`
// in a temp directory (CLAUDE.md § "No mocks for the sidecar layer").

import XCTest
@testable import MapleCore

final class XMPAuthoredCullingTests: XCTestCase {

    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("XMPAuthoredCullingTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func lightroomSidecar(_ culling: String) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000">
         <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description rdf:about=""
            xmlns:xmp="http://ns.adobe.com/xap/1.0/"
            xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
            \(culling)
            crs:Version="15.0"
            crs:Exposure2012="+0.50">
          </rdf:Description>
         </rdf:RDF>
        </x:xmpmeta>
        """
    }

    private func saved(
        from source: String, edit: (inout AdjustmentModel, inout CullingState) -> Void
    ) async throws -> String {
        let rawURL = directory.appendingPathComponent("IMG_0001.dng")
        let sidecarURL = SidecarPath.sidecarURL(for: rawURL)
        try source.write(to: sidecarURL, atomically: true, encoding: .utf8)
        let store = XMPSidecarStore(rawURL: rawURL)
        let (loadedModel, loadedCulling) = try await store.load()
        var model = loadedModel
        var culling = loadedCulling
        edit(&model, &culling)
        await store.update(model: model, culling: culling)
        await store.flush()
        return try String(contentsOf: sidecarURL, encoding: .utf8)
    }

    func testLightroomRejectAndRedLabelSurviveAnExposureEdit() async throws {
        let source = lightroomSidecar(#"xmp:Rating="-1" xmp:Label="Red""#)
        let (_, loaded) = try XMPParser.parse(source)
        XCTAssertEqual(loaded.stars, 0)
        XCTAssertEqual(loaded.flag, .none)
        XCTAssertEqual(loaded.colorLabel, .red)

        let xml = try await saved(from: source) { model, _ in model.exposure = 1.25 }

        XCTAssertTrue(xml.contains(#"xmp:Rating="-1""#), xml)
        XCTAssertTrue(xml.contains(#"xmp:Label="Red""#), xml)
        XCTAssertEqual(try XMPParser.parse(xml).0.exposure, 1.25)
        XCTAssertFalse(xml.contains("papp:Flag="), xml)
        XCTAssertEqual(xml.components(separatedBy: "xmp:Rating=").count, 2)
        XCTAssertEqual(xml.components(separatedBy: "xmp:Label=").count, 2)
    }

    func testCullingInASecondDescriptionSurvivesAnExposureEdit() async throws {
        let split = lightroomSidecar("").replacingOccurrences(
            of: "</rdf:Description>",
            with: """
            </rdf:Description>
              <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
                xmp:Rating="-1" xmp:Label="Red"/>
            """)
        let xml = try await saved(from: split) { model, _ in model.exposure = 1.25 }
        XCTAssertEqual(xml.components(separatedBy: #"xmp:Rating="-1""#).count, 2, xml)
        XCTAssertEqual(xml.components(separatedBy: #"xmp:Label="Red""#).count, 2, xml)
    }

    func testUnchangedFractionalRatingKeepsItsBytes() async throws {
        let xml = try await saved(from: lightroomSidecar(#"xmp:Rating="3.0""#)) { model, culling in
            XCTAssertEqual(culling.stars, 3)
            model.exposure = 0.75
        }
        XCTAssertTrue(xml.contains(#"xmp:Rating="3.0""#), xml)
    }

    func testRatingEditRewritesTheRatingCanonically() async throws {
        let xml = try await saved(from: lightroomSidecar(#"xmp:Rating="-1""#)) { _, culling in
            culling.stars = 4
        }
        XCTAssertTrue(xml.contains(#"xmp:Rating="4""#), xml)
        XCTAssertFalse(xml.contains(#"xmp:Rating="-1""#), xml)
    }

    func testClearingAnEditedRatingOmitsIt() async throws {
        let xml = try await saved(from: lightroomSidecar(#"xmp:Rating="3""#)) { _, culling in
            culling.stars = 0
        }
        XCTAssertFalse(xml.contains("xmp:Rating="), xml)
    }

    func testColourLabelEditReplacesTheContradictedAdobeWord() async throws {
        let xml = try await saved(from: lightroomSidecar(#"xmp:Label="Red""#)) { _, culling in
            culling.colorLabel = .blue
        }
        XCTAssertFalse(xml.contains("xmp:Label="), xml)
        XCTAssertTrue(xml.contains(#"papp:ColorLabel="blue""#), xml)
        XCTAssertEqual(try XMPParser.parse(xml).1.colorLabel, .blue)
    }

    func testClearingTheColourLabelDropsTheAdobeWord() async throws {
        let xml = try await saved(from: lightroomSidecar(#"xmp:Label="Red""#)) { _, culling in
            culling.colorLabel = nil
        }
        XCTAssertFalse(xml.contains("xmp:Label="), xml)
        XCTAssertNil(try XMPParser.parse(xml).1.colorLabel)
    }

    func testCustomLabelWordSurvivesAColourLabelEdit() async throws {
        let xml = try await saved(from: lightroomSidecar(#"xmp:Label="To Do""#)) { _, culling in
            culling.colorLabel = .green
        }
        XCTAssertTrue(xml.contains(#"xmp:Label="To Do""#), xml)
        XCTAssertTrue(xml.contains(#"papp:ColorLabel="green""#), xml)
    }

    func testRatingValueParsing() {
        XCTAssertEqual(XMPParser.ratingValue("3.0"), 3)
        XCTAssertEqual(XMPParser.ratingValue("-1"), 0)
        XCTAssertEqual(XMPParser.ratingValue("5"), 5)
        XCTAssertEqual(XMPParser.ratingValue("nope"), 0)
        XCTAssertEqual(XMPParser.ratingValue("6"), 0)
    }
}
