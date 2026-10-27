// #5475: builds before #4686 wrote `papp:FilmLook` twice. Real files, real store.

import XCTest

@testable import MapleCore

final class XMPDuplicateAttributeTests: XCTestCase {
  static let portra = "color_negative_kodak_portra_160"

  /// The layout an affected sidecar has on disk: the model's copy and the
  /// passthrough copy, adjacent after the canonical sort.
  static let corruptSidecar = """
    <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
    <x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description rdf:about=""
          xmlns:xmp="http://ns.adobe.com/xap/1.0/"
          xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
          xmlns:papp="http://ns.justmaple.app/photo/1.0/"
          crs:Exposure2012="-1.5"
          crs:HasSettings="True"
          crs:ProcessVersion="11.0"
          crs:Temperature="5600"
          crs:Tint="4"
          crs:Version="11.0"
          crs:WhiteBalance="Custom"
          papp:FilmLook="\(portra)"
          papp:FilmLook="\(portra)"
          papp:Profile="Auto"
          papp:WbScaleVersion="5"/>
      </rdf:RDF>
    </x:xmpmeta>
    <?xpacket end="w"?>
    """

  private func occurrences(of name: String, in xml: String) -> Int {
    xml.components(separatedBy: "\(name)=").count - 1
  }

  private func makeTempDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-xmp-5475-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    return dir
  }

  func testRemovesOnlyTheRepeatedAttribute() {
    XCTAssertFalse(
      XMLParser(data: Data(Self.corruptSidecar.utf8)).parse(),
      "the fixture must be one XMLParser rejects")
    let expected = Self.corruptSidecar.replacingOccurrences(
      of: "\n      papp:FilmLook=\"\(Self.portra)\"\n      papp:FilmLook=",
      with: "\n      papp:FilmLook=")
    XCTAssertEqual(XMPDuplicateAttributes.removingRepeats(in: Self.corruptSidecar), expected)
  }

  func testKeepsTheFirstValueAndScopesNamesToOneStartTag() {
    XCTAssertEqual(
      XMPDuplicateAttributes.removingRepeats(in: "<a x:k=\"first\" y=\"1\" x:k='second'/>"),
      "<a x:k=\"first\" y=\"1\"/>")
    let xml = """
      <?xml version="1.0"?>
      <!-- <b k="1" k="2"/> -->
      <a k="1" v="x > y"><b k="1"><![CDATA[<c k="1" k="2"/>]]></b>
      <b k="2" k="3">t &gt; u</b></a>
      """
    XCTAssertEqual(
      XMPDuplicateAttributes.removingRepeats(in: xml),
      xml.replacingOccurrences(of: " k=\"3\"", with: ""))
  }

  func testLeavesDocumentsWithoutRepeatsOrThatCannotBeTokenized() {
    XCTAssertNil(XMPDuplicateAttributes.removingRepeats(in: "<a k=\"1\"><b k=\"1\"/></a>"))
    XCTAssertNil(XMPDuplicateAttributes.removingRepeats(in: "<!DOCTYPE a><a k=\"1\" k=\"2\"/>"))
    XCTAssertNil(XMPDuplicateAttributes.removingRepeats(in: "<a k=\"1\" k=\"2\""))
    XCTAssertNil(XMPDuplicateAttributes.removingRepeats(in: "<!-- <a k=\"1\" k=\"2\"/>"))
  }

  func testAnyOtherMalformationStillFails() {
    let unclosed = Self.corruptSidecar.replacingOccurrences(of: "</x:xmpmeta>", with: "")
    XCTAssertThrowsError(try XMPParser.parse(unclosed))
    XCTAssertEqual(XMPParser.parsePassthrough(unclosed), .empty)
  }

  func testLoadsTheEditAndTheNextSaveWritesEachAttributeOnce() async throws {
    let dir = try makeTempDirectory()
    let rawURL = dir.appendingPathComponent("084A9983.CR2")
    let sidecarURL = SidecarPath.sidecarURL(for: rawURL)
    try Self.corruptSidecar.write(to: sidecarURL, atomically: true, encoding: .utf8)

    let store = XMPSidecarStore(rawURL: rawURL)
    let (model, culling) = try await store.load()
    XCTAssertEqual(model.filmLook, Self.portra)
    XCTAssertEqual(model.exposure, -1.5)
    XCTAssertEqual(model.profile, .auto)
    XCTAssertEqual(XMPParser.parsePassthrough(Self.corruptSidecar).unknownAttributes, [])

    await store.update(model: model, culling: culling)
    await store.flush()
    let saved = try String(contentsOf: sidecarURL, encoding: .utf8)
    XCTAssertEqual(occurrences(of: "papp:FilmLook", in: saved), 1)
    XCTAssertNil(XMPDuplicateAttributes.removingRepeats(in: saved))
    XCTAssertTrue(
      XMLParser(data: Data(saved.utf8)).parse(), "the saved sidecar must be well-formed")

    let reopened = XMPSidecarStore(rawURL: rawURL)
    let (reloaded, reloadedCulling) = try await reopened.load()
    XCTAssertEqual(reloaded.filmLook, Self.portra)
    await reopened.update(model: reloaded, culling: reloadedCulling)
    await reopened.flush()
    XCTAssertEqual(try String(contentsOf: sidecarURL, encoding: .utf8), saved)
  }

  func testWriterNeverEmitsANameTwice() {
    var model = AdjustmentModel()
    model.filmLook = "slide_fuji_velvia_50"
    let passthrough = XMPPassthrough(
      unknownAttributes: [.init(name: "papp:FilmLook", value: Self.portra)], unknownNodes: [])
    let xml = XMPSerializer.serialize(
      model: model, culling: CullingState(), passthrough: passthrough)
    XCTAssertEqual(occurrences(of: "papp:FilmLook", in: xml), 1)
    XCTAssertTrue(xml.contains("papp:FilmLook=\"slide_fuji_velvia_50\""))
    XCTAssertTrue(XMLParser(data: Data(xml.utf8)).parse())
  }
}
