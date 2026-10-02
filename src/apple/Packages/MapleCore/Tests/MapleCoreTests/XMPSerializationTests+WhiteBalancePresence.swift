import Foundation
import XCTest

@testable import MapleCore

extension XMPSerializationTests {
  func testAbsentPartialAndExplicitWBKeepTheirMeaningThroughRealSidecars() async throws {
    let cases: [(String, Bool, Bool)] = [
      ("", false, false),
      (#"crs:WhiteBalance="As Shot""#, false, false),
      (#"crs:Temperature="6500""#, true, false),
      (#"crs:Tint="0""#, false, true),
      (#"crs:Temperature="6500" crs:Tint="0""#, true, true),
      (#"crs:WhiteBalance="Daylight""#, false, false),
      (#"crs:WhiteBalance="Daylight" crs:Tint="7""#, false, true),
    ]
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "wb-presence")
    defer { try? FileManager.default.removeItem(at: directory) }
    for (index, row) in cases.enumerated() {
      let raw = directory.appendingPathComponent("\(index).dng")
      let xmp = SidecarPath.sidecarURL(for: raw)
      try Data(wbPresenceXML(row.0).utf8).write(to: xmp)
      let store = XMPSidecarStore(rawURL: raw)
      var model = try await store.load().0
      XCTAssertEqual(model.temperatureSeen, row.1)
      XCTAssertEqual(model.tintSeen, row.2)
      model.exposure = 1
      await store.update(model: model, culling: CullingState(stars: 3))
      await store.flush()
      let bytes = try Data(contentsOf: xmp)
      let xml = String(decoding: bytes, as: UTF8.self)
      XCTAssertEqual(xml.contains("crs:Temperature="), row.1)
      XCTAssertEqual(xml.contains("crs:Tint="), row.2)
      XCTAssertEqual(xml.contains("papp:WbScaleVersion="), row.1 || row.2)
      let reopened = XMPSidecarStore(rawURL: raw)
      let (restored, culling) = try await reopened.load()
      XCTAssertEqual(restored, model)
      XCTAssertEqual(culling.stars, 3)
      XCTAssertFalse(FileManager.default.fileExists(atPath: raw.path))
    }
  }

  func testWBPresenceSurvivesJSONAndLegacySnapshotsKeepExplicitPairs() throws {
    for attrs in ["", #"crs:Temperature="6500""#, #"crs:Tint="0""#] {
      let model = try XMPParser.parse(wbPresenceXML(attrs)).0
      let data = try JSONEncoder().encode(model)
      XCTAssertEqual(try JSONDecoder().decode(AdjustmentModel.self, from: data), model)
    }
    var legacy = try XCTUnwrap(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(AdjustmentModel.default))
        as? [String: Any])
    legacy.removeValue(forKey: "temperatureSeen")
    legacy.removeValue(forKey: "tintSeen")
    let model = try JSONDecoder().decode(
      AdjustmentModel.self, from: JSONSerialization.data(withJSONObject: legacy))
    XCTAssertEqual(model, .default)
    let xml = XMPSerializer.serialize(model: model, culling: CullingState())
    XCTAssertTrue(xml.contains(#"crs:Temperature="6500""#))
    XCTAssertTrue(xml.contains(#"crs:Tint="0""#))
  }

  func testNumericWBEditAuthorsOnlyThatComponentAndGroupPasteKeepsOmissions() throws {
    let absent = try XMPParser.parse(wbPresenceXML("")).0
    var temperature = absent
    temperature.temperature = 6500
    XCTAssertTrue(temperature.temperatureSeen)
    XCTAssertFalse(temperature.tintSeen)
    var tint = absent
    tint.tint = 0
    XCTAssertFalse(tint.temperatureSeen)
    XCTAssertTrue(tint.tintSeen)
    for source in [absent, temperature, tint] {
      let merged = AdjustmentGroupMerge.merged(.default, applying: source, groups: [.whiteBalance])
      XCTAssertEqual(merged.temperatureSeen, source.temperatureSeen)
      XCTAssertEqual(merged.tintSeen, source.tintSeen)
      XCTAssertEqual(
        RawCoreBridge.stripAppleGPUStages(source),
        RawCoreBridge.stripAppleGPUStages(.default), "Presence must not invalidate decoded pixels")
    }
    XCTAssertFalse(absent.isVisuallyEditedBeyondWhiteBalance)
  }

  private func wbPresenceXML(_ attrs: String) -> String {
    """
    <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" \(attrs)/></rdf:RDF></x:xmpmeta>
    """
  }
}
