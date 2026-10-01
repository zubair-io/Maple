import Foundation
import XCTest

@testable import MapleCore

final class RemovalSidecarNamespaceTests: XCTestCase {
  private func fixture(_ name: String, _ ext: String) throws -> Data {
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: name, withExtension: ext, subdirectory: "removal"))
    return try Data(contentsOf: url)
  }

  private func stage() async throws -> (URL, String) {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
    let raw = folder.appendingPathComponent("photo.dng")
    try fixture("source", "dng").write(to: raw)
    let records = try await LocalRemovalAssetStore(rawURL: raw).publish(
      request: String(decoding: fixture("request", "txt"), as: UTF8.self), prior: "[]",
      mask: fixture("mask", "mimf"), patch: fixture("patch", "f16"))
    return (raw, records)
  }

  private func document(records: String, uri: String = XMPCanonical.pappNamespaceURI) -> Data {
    let escaped = records.replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "\"", with: "&quot;")
    return Data(
      """
      <r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description xmlns:m="\(uri)" xmlns:foreign="urn:fixture" m:InpaintRemovals="\(escaped)" foreign:Keep="untouched"><foreign:History original="preserved"/></r:Description></r:RDF>
      """.utf8)
  }

  func testAliasOwnedRecordsSurviveOrdinarySaveAndConfirmedCASForBothMapleNamespaces() async throws
  {
    let (raw, records) = try await stage()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let original = try Data(contentsOf: raw)
    for uri in [XMPCanonical.pappNamespaceURI, "http://ns.justmaple.app/1.0/"] {
      let input = document(records: records, uri: uri)
      try input.write(to: sidecar)
      let store = XMPSidecarStore(rawURL: raw)
      do {
        try await store.writeRemovalConfirmed(
          records: "[]", expectedRecords: "[]", model: .default, culling: CullingState())
        XCTFail("An aliased accepted stack must not look empty to compare-and-swap")
      } catch {
        guard case RemovalError.saveConflict = error else { return XCTFail("\(error)") }
      }
      XCTAssertEqual(try Data(contentsOf: sidecar), input)
      var model = AdjustmentModel.default
      model.exposure = 1
      try await store.writeConfirmed(model: model, culling: CullingState())
      let saved = try Data(contentsOf: sidecar)
      XCTAssertEqual(try RemovalXMPRecords.read(saved), records)
      XCTAssertEqual(try XMPParser.parse(data: saved).0.exposure, 1)
      let xml = String(decoding: saved, as: UTF8.self)
      XCTAssertFalse(xml.contains("m:InpaintRemovals="))
      XCTAssertTrue(xml.contains("papp:InpaintRemovals="))
      XCTAssertTrue(xml.contains("foreign:Keep=\"untouched\""))
      XCTAssertTrue(xml.contains("<foreign:History original=\"preserved\"/>"))
      try await store.writeRemovalConfirmed(
        records: records, expectedRecords: records, model: model, culling: CullingState())
      XCTAssertEqual(try RemovalXMPRecords.read(Data(contentsOf: sidecar)), records)
    }
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testMalformedOwnedRecordsAndForeignCanonicalCollisionsCannotBeOverwritten() async throws {
    let (raw, _) = try await stage()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let malformed = document(records: "not JSON")
    let foreign = Data(
      String(decoding: document(records: "foreign opaque", uri: "urn:foreign"), as: UTF8.self)
        .replacingOccurrences(of: "xmlns:m=", with: "xmlns:papp=")
        .replacingOccurrences(of: "m:InpaintRemovals=", with: "papp:InpaintRemovals=").utf8)
    for input in [malformed, foreign] {
      try input.write(to: sidecar)
      do {
        try await XMPSidecarStore(rawURL: raw).writeConfirmed(
          model: .default, culling: CullingState())
        XCTFail("Invalid ownership must preserve the existing sidecar and report failure")
      } catch { XCTAssertTrue(error is RemovalError) }
      XCTAssertEqual(try Data(contentsOf: sidecar), input)
    }
  }
  func testScalarPropertiesCanonicalizeOnceAndPreserveForeignChildBytes() async throws {
    let (raw, records) = try await stage()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let foreign =
      "<m:InpaintRemovals xmlns:m=\"urn:foreign\" marker=\"keep\">opaque</m:InpaintRemovals>"
    for uri in [XMPCanonical.pappNamespaceURI, "http://ns.justmaple.app/1.0/"] {
      for payload in [XMPSerializer.escapeXMLAttr(records), "<![CDATA[\(records)]]>"] {
        let input = Data(
          """
          <r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description xmlns:m="\(uri)"><m:InpaintRemovals>\(payload)</m:InpaintRemovals>\(foreign)</r:Description></r:RDF>
          """.utf8)
        try input.write(to: sidecar)
        XCTAssertEqual(try RemovalXMPRecords.read(input), records)
        let store = XMPSidecarStore(rawURL: raw)
        try await store.writeConfirmed(model: .default, culling: CullingState())
        let saved = try Data(contentsOf: sidecar)
        XCTAssertEqual(try RemovalXMPRecords.read(saved), records)
        let xml = String(decoding: saved, as: UTF8.self)
        XCTAssertTrue(xml.contains(foreign))
        XCTAssertFalse(xml.contains("<m:InpaintRemovals>"))
        XCTAssertEqual(xml.components(separatedBy: "papp:InpaintRemovals=").count, 2)
        try input.write(to: sidecar)
        try await store.writeRemovalConfirmed(
          records: "[]", expectedRecords: records, model: .default, culling: CullingState())
        XCTAssertEqual(try RemovalXMPRecords.read(Data(contentsOf: sidecar)), "[]")
        XCTAssertTrue(
          String(decoding: try Data(contentsOf: sidecar), as: UTF8.self).contains(foreign))
      }
    }
  }

  func testNestedAndSecondaryDescriptionPropertiesRefuseWithoutChangingSidecar() async throws {
    let (raw, records) = try await stage()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let property = "<m:InpaintRemovals><![CDATA[\(records)]]></m:InpaintRemovals>"
    for content in [
      "<r:Description/><r:Description>\(property)</r:Description>",
      "<foreign:Description/><r:Description>\(property)</r:Description>",
      "<r:Description><m:InpaintRemovals><foreign:Value>[]</foreign:Value></m:InpaintRemovals></r:Description>",
      "<r:Description>\(property)\(property)</r:Description>",
    ] {
      let input = Data(
        """
        <r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:m="\(XMPCanonical.pappNamespaceURI)" xmlns:foreign="urn:foreign">\(content)</r:RDF>
        """.utf8)
      try input.write(to: sidecar)
      do {
        try await XMPSidecarStore(rawURL: raw).writeConfirmed(
          model: .default, culling: CullingState())
        XCTFail("Unrepresentable removal ownership must refuse the save")
      } catch { XCTAssertTrue(error is RemovalError) }
      XCTAssertEqual(try Data(contentsOf: sidecar), input)
    }
  }

}
