import Foundation
import XCTest

@testable import MapleCore

final class RemovalXMPRecordsTests: XCTestCase {
  private func document(_ attributes: String) -> Data {
    Data(
      """
      <x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description xmlns:m="http://ns.justmaple.app/photo/1.0/" \(attributes)/></r:RDF></x:xmpmeta>
      """.utf8)
  }

  func testAliasPrefixAndEntityDecodingPreserveRealAcceptedRecords() throws {
    let recordsURL = try XCTUnwrap(
      Bundle.module.url(forResource: "records", withExtension: "txt", subdirectory: "removal"))
    let records = try String(contentsOf: recordsURL, encoding: .utf8)
    let escaped = records.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(
      of: "\"", with: "&quot;")
    let xml = document("m:InpaintRemovals=\"\(escaped)\"")
    XCTAssertEqual(try RemovalXMPRecords.read(xml), records)
    let text = String(decoding: xml, as: UTF8.self)
    XCTAssertEqual(try RemovalXMPRecords.read(try XCTUnwrap(text.data(using: .utf16))), records)
  }

  func testNestedNamespaceRebindingCannotClaimAnotherNamespacesRemovalAttribute() throws {
    let xml = Data(
      """
      <r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:m="http://ns.justmaple.app/photo/1.0/">
      <r:Description xmlns:m="urn:foreign" m:InpaintRemovals="invalid foreign JSON"/>
      <r:Description m:InpaintRemovals="[]"/>
      </r:RDF>
      """.utf8)
    XCTAssertEqual(try RemovalXMPRecords.read(xml), "[]")
    let foreign = String(decoding: document("m:InpaintRemovals=\"ignored\""), as: UTF8.self)
      .replacingOccurrences(of: XMPCanonical.pappNamespaceURI, with: "urn:foreign")
    XCTAssertNil(try RemovalXMPRecords.read(Data(foreign.utf8)))
  }

  func testAmbiguousMalformedAndUnsupportedRemovalRecordsCannotSilentlyDisappear() throws {
    let duplicate = Data(
      """
      <r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:m="http://ns.justmaple.app/photo/1.0/">
      <r:Description m:InpaintRemovals="[]"/><r:Description m:InpaintRemovals="[]"/></r:RDF>
      """.utf8)
    XCTAssertThrowsError(try RemovalXMPRecords.read(duplicate))
    XCTAssertThrowsError(try RemovalXMPRecords.read(document("missing:InpaintRemovals=\"[]\"")))
    XCTAssertThrowsError(try RemovalXMPRecords.read(Data("<broken m:InpaintRemovals=\"[]\"".utf8)))
    XCTAssertThrowsError(try RemovalXMPRecords.read(document("m:InpaintRemovals=\"invalid JSON\"")))
    XCTAssertThrowsError(
      try RemovalXMPRecords.read(
        document(
          "m:InpaintRemovals=\"[{&quot;kind&quot;:&quot;removal&quot;,&quot;schema&quot;:999}]\"")))
    XCTAssertNil(try RemovalXMPRecords.read(Data("opaque unrelated legacy sidecar".utf8)))
  }
}
