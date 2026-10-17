// LookProfileXMPTests.swift — Lightroom's `crs:Look` profile block (#4685).
//
// The profile's own `crs:Parameters` recipe (PV2012 contrast curves,
// `crs:ConvertToGrayscale`) is never the photographer's edit. Both fixtures
// under `test-fixtures/look-profiles/` are opened through the real on-disk
// `XMPSidecarStore`, nudged by one slider and flushed, and the look must
// neither reach the model nor lose a byte on the way back out.

import XCTest

@testable import MapleCore

final class LookProfileXMPTests: XCTestCase {
  private static let fixtures = [
    "look-profiles/lightroom-adobe-color.xmp",
    "look-profiles/lightroom-adobe-monochrome.xmp",
  ]

  private func fixture(_ path: String) throws -> String {
    try String(
      contentsOf: WorkflowFixture.root().appendingPathComponent(path), encoding: .utf8)
  }

  private func lookSubtree(in xml: String) throws -> Substring {
    let start = try XCTUnwrap(xml.range(of: "<crs:Look>"))
    let end = try XCTUnwrap(xml.range(of: "</crs:Look>"))
    return xml[start.lowerBound..<end.upperBound]
  }

  private func makeTempDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-xmp-4685-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    return dir
  }

  func testProfileLookIsNotAUserEdit() throws {
    for path in Self.fixtures {
      let (model, culling) = try XMPParser.parse(try fixture(path))
      XCTAssertEqual(model, AdjustmentModel(), path)
      XCTAssertEqual(culling, CullingState(), path)
    }
  }

  func testLookSurvivesLoadEditSaveThroughTheStore() async throws {
    for path in Self.fixtures {
      let source = try fixture(path)
      let dir = try makeTempDirectory()
      let rawURL = dir.appendingPathComponent("DSC_0001.dng")
      let sidecarURL = SidecarPath.sidecarURL(for: rawURL)
      try source.write(to: sidecarURL, atomically: true, encoding: .utf8)

      let store = XMPSidecarStore(rawURL: rawURL)
      let (loaded, culling) = try await store.load()
      XCTAssertEqual(loaded, AdjustmentModel(), path)

      var edited = loaded
      edited.exposure = 1.25
      await store.update(model: edited, culling: culling)
      await store.flush()

      let written = try String(contentsOf: sidecarURL, encoding: .utf8)
      XCTAssertTrue(written.contains("crs:Exposure2012=\"1.25\""), path)
      XCTAssertTrue(
        written.contains(try lookSubtree(in: source)),
        "\(path): crs:Look must be re-emitted verbatim")
      let grayscaleMarker = "crs:ConvertToGrayscale=\"True\""
      XCTAssertEqual(
        written.components(separatedBy: grayscaleMarker).count,
        source.components(separatedBy: grayscaleMarker).count,
        "\(path): the look's grayscale flag must not be hoisted onto the primary description")

      let (reloaded, _) = try await XMPSidecarStore(rawURL: rawURL).load()
      XCTAssertEqual(reloaded.exposure, 1.25, accuracy: 1e-9, path)
      XCTAssertEqual(reloaded.blackWhite, .off, path)
      XCTAssertTrue(reloaded.displayToneCurveLuma.points.isEmpty, path)
    }
  }

  func testUserCurveBesideTheLookStillReads() throws {
    let userCurve = """
         <crs:ToneCurvePV2012>
          <rdf:Seq>
           <rdf:li>0, 0</rdf:li>
           <rdf:li>128, 150</rdf:li>
           <rdf:li>255, 255</rdf:li>
          </rdf:Seq>
         </crs:ToneCurvePV2012>

      """
    let xml = try fixture(Self.fixtures[1])
      .replacingOccurrences(of: "   <crs:Look>", with: userCurve + "   <crs:Look>")
    let (model, _) = try XMPParser.parse(xml)
    XCTAssertEqual(model.displayToneCurveLuma.points.count, 3)
    XCTAssertTrue(model.displayToneCurveRed.points.isEmpty)
    XCTAssertEqual(model.blackWhite, .off)
  }
}
