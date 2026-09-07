import XCTest

@testable import MapleCore

@MainActor
final class ForeignWhiteBalanceSourceTests: XCTestCase {
  func testForeignCustomPairShowsCustomAndSurvivesRoundTrip() throws {
    for preset in ["", #"crs:WhiteBalance="Custom""#] {
      let model = try readSidecar(
        #"\#(preset) crs:Temperature="5100" crs:Tint="-7""#)
      XCTAssertEqual(model.temperature, 5100)
      XCTAssertEqual(model.tint, -7)
      XCTAssertEqual(model.whiteBalancePreset, .custom)
      XCTAssertEqual(model.wbSource, .manual)
      let session = EditSession.preview()
      session.model = model
      XCTAssertEqual(WhiteBalancePicker(session: session).selectedPreset, .custom)
      let serialized = XMPSerializer.serialize(model: model, culling: CullingState())
      XCTAssertEqual(try XMPParser.parse(serialized).0, model)
    }
  }

  func testMapleLegacyDefaultAndExplicitSourceArePreserved() throws {
    let attrs = #"crs:WhiteBalance="Custom" crs:Temperature="5100" crs:Tint="-7""#
    let namespace = #"xmlns:papp="\#(XMPCanonical.pappNamespaceURI)""#
    XCTAssertEqual(try readSidecar("\(attrs) \(namespace)").wbSource, .asShot)
    XCTAssertEqual(
      try readSidecar(attrs, children: "<papp:Private \(namespace)>note</papp:Private>").wbSource,
      .asShot)
    for source in WbSource.allCases {
      let sourceAttribute = #"papp:WbSource="\#(source.rawValue)""#
      XCTAssertEqual(try readSidecar("\(attrs) \(namespace) \(sourceAttribute)").wbSource, source)
    }
  }

  func testAsShotAndUnauthoredCustomDoNotInventManualSource() throws {
    for attrs in [
      #"crs:WhiteBalance="As Shot" crs:Temperature="5100" crs:Tint="-7""#,
      #"crs:WhiteBalance="Custom""#,
      "",
    ] {
      XCTAssertEqual(try readSidecar(attrs).wbSource, .asShot)
    }
  }

  private func readSidecar(_ attrs: String, children: String = "") throws -> AdjustmentModel {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let sidecar = directory.appendingPathComponent("foreign.xmp")
    let xml = """
      <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" \(attrs)>\(children)</rdf:Description></rdf:RDF></x:xmpmeta>
      """
    try xml.write(to: sidecar, atomically: true, encoding: .utf8)
    return try XMPParser.parse(data: Data(contentsOf: sidecar)).0
  }
}
