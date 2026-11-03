// RetouchInfoPreservationTests.swift — a legacy `crs:RetouchInfo` list this
// build cannot decode must survive a save verbatim and unstamped; a list it
// can decode still converts to the stamped struct form. Real files, real store.

import XCTest

@testable import MapleCore

final class RetouchInfoPreservationTests: XCTestCase {
  private static let malformedList = """
         <crs:RetouchInfo>
          <rdf:Seq>
           <rdf:li>centerX = 0.5, centerY = 0.5, radius = 0.02, spotType = heal</rdf:li>
           <rdf:li>not a key value list at all</rdf:li>
          </rdf:Seq>
         </crs:RetouchInfo>
    """

  private static let wellFormedList = """
         <crs:RetouchInfo>
          <rdf:Seq>
           <rdf:li>centerX = 0.5, centerY = 0.5, radius = 0.02, sourceState = sourceSetExplicitly, sourceX = 0.6, sourceY = 0.5, spotType = heal</rdf:li>
          </rdf:Seq>
         </crs:RetouchInfo>
    """

  private static let mapleNamespace = """

        xmlns:papp="http://ns.justmaple.app/photo/1.0/"
        papp:Profile="Auto"
    """

  private func sidecar(list: String, mapleAuthored: Bool) -> String {
    """
    <x:xmpmeta xmlns:x="adobe:ns:meta/">
     <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about=""
        xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"\(mapleAuthored ? Self.mapleNamespace : "")
       crs:Version="15.0"
       crs:HasSettings="True">
    \(list)
      </rdf:Description>
     </rdf:RDF>
    </x:xmpmeta>
    """
  }

  private func saveSliderEdit(of source: String, times: Int = 1) async throws -> String {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-retouchinfo-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let rawURL = dir.appendingPathComponent("IMG_0001.dng")
    try Data("not a real raw".utf8).write(to: rawURL)
    let sidecarURL = SidecarPath.sidecarURL(for: rawURL)
    try source.write(to: sidecarURL, atomically: true, encoding: .utf8)

    for pass in 1...times {
      let store = XMPSidecarStore(rawURL: rawURL)
      var (model, culling) = try await store.load()
      model.exposure = Double(pass) * 0.25
      await store.update(model: model, culling: culling)
      await store.flush()
    }
    return try String(contentsOf: sidecarURL, encoding: .utf8)
  }

  func testUndecodableListSurvivesASliderSaveVerbatimAndUnstamped() async throws {
    for mapleAuthored in [false, true] {
      let written = try await saveSliderEdit(
        of: sidecar(list: Self.malformedList, mapleAuthored: mapleAuthored))
      XCTAssertTrue(written.contains(Self.malformedList), "mapleAuthored=\(mapleAuthored)")
      XCTAssertFalse(written.contains("RetouchFrameVersion"))
      XCTAssertFalse(written.contains("<crs:RetouchAreas>"))
      XCTAssertEqual(try XMPParser.parse(written).0.exposure, 0.25, accuracy: 1e-9)
    }
  }

  func testUndecodableListIsStableAcrossRepeatedSaves() async throws {
    let written = try await saveSliderEdit(
      of: sidecar(list: Self.malformedList, mapleAuthored: false), times: 3)
    XCTAssertEqual(written.components(separatedBy: "<crs:RetouchInfo>").count - 1, 1)
    XCTAssertTrue(written.contains(Self.malformedList))
    XCTAssertFalse(written.contains("RetouchFrameVersion"))
  }

  func testDecodableListStillConvertsToTheStampedStructForm() async throws {
    let written = try await saveSliderEdit(
      of: sidecar(list: Self.wellFormedList, mapleAuthored: false))
    XCTAssertFalse(written.contains("crs:RetouchInfo"))
    XCTAssertEqual(written.components(separatedBy: "<crs:RetouchAreas>").count - 1, 1)
    XCTAssertTrue(written.contains("papp:RetouchFrameVersion=\"2\""))
    XCTAssertEqual(try XMPParser.parse(written).0.retouchSpots.count, 1)
  }

  func testAListWithOneDecodableEntryConvertsAndDropsTheUndecodableOne() async throws {
    let mixed = Self.wellFormedList.replacingOccurrences(
      of: "     </rdf:Seq>", with: "      <rdf:li>garbage</rdf:li>\n     </rdf:Seq>")
    let written = try await saveSliderEdit(of: sidecar(list: mixed, mapleAuthored: false))
    XCTAssertFalse(written.contains("crs:RetouchInfo"))
    XCTAssertEqual(try XMPParser.parse(written).0.retouchSpots.count, 1)
  }
}
