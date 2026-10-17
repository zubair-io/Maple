// XMPPassthroughNamespaceTests — every prefix a saved sidecar uses is bound
// by a namespace declaration in scope (#4688). A real Lightroom sidecar is
// round-tripped through `XMPSidecarStore` in a temp directory and the output
// is re-read by a namespace-aware parser. The resaved bytes are also the
// committed golden the web suite parses (`xmp-namespaces.spec.ts`).

import XCTest

@testable import MapleCore

final class XMPPassthroughNamespaceTests: XCTestCase {
  private static let fixtureName = "lightroom-foreign-attributes.xmp"
  private static let goldenName = "apple-resaved.xmp"

  private func resave(metadata: XmpMetadata? = nil) async throws -> String {
    let dir = try SidecarContractIO.makeTempDirectory(prefix: "xmp-namespaces")
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let raw = dir.appendingPathComponent("IMG_0001.CR3")
    try FileManager.default.copyItem(
      at: try XMPNamespaceFixture.root().appendingPathComponent(Self.fixtureName),
      to: SidecarPath.sidecarURL(for: raw))
    let store = XMPSidecarStore(rawURL: raw)
    var (model, culling) = try await store.load()
    model.exposure = 1.25
    culling.stars = 4
    if let metadata {
      await store.update(model: model, culling: culling, metadata: metadata)
    } else {
      await store.update(model: model, culling: culling)
    }
    await store.flush()
    return try String(contentsOf: SidecarPath.sidecarURL(for: raw), encoding: .utf8)
  }

  func testEveryPreservedPrefixIsBoundAfterADevelopSave() async throws {
    let xml = try await resave()
    let report = NamespaceScopeReport(xml)
    XCTAssertTrue(report.parsed, report.parseError ?? "")
    XCTAssertEqual(report.unboundNames, [])
    XCTAssertEqual(report.boundURI["photoshop"], "http://ns.adobe.com/photoshop/1.0/")
    XCTAssertEqual(report.boundURI["exif"], "http://ns.adobe.com/exif/1.0/")
    XCTAssertEqual(report.boundURI["dc"], "http://purl.org/dc/elements/1.1/")
    XCTAssertEqual(report.boundURI["xmpMM"], "http://ns.adobe.com/xap/1.0/mm/")
    XCTAssertEqual(
      report.boundURI["stEvt"], "http://ns.adobe.com/xap/1.0/sType/ResourceEvent#")
    XCTAssertTrue(xml.contains("photoshop:DateCreated=\"2026-09-12T17:41:03.21\""))
    XCTAssertTrue(xml.contains("dc:format=\"image/x-canon-cr3\""))
    XCTAssertTrue(xml.contains("<xmpMM:History>"))
  }

  func testEveryPreservedPrefixIsBoundAfterAMetadataSave() async throws {
    var metadata = XmpMetadata()
    metadata.title = "Harbour"
    let xml = try await resave(metadata: metadata)
    let report = NamespaceScopeReport(xml)
    XCTAssertTrue(report.parsed, report.parseError ?? "")
    XCTAssertEqual(report.unboundNames, [])
    XCTAssertTrue(xml.contains("exif:ExposureTime=\"1/250\""))
  }

  func testResavedOutputMatchesTheGoldenTheWebSuiteReads() async throws {
    let xml = try await resave()
    let golden = try XMPNamespaceFixture.root().appendingPathComponent(Self.goldenName)
    guard let committed = try? String(contentsOf: golden, encoding: .utf8) else {
      try xml.write(to: golden, atomically: true, encoding: .utf8)
      return XCTFail("golden written to \(golden.path) — inspect it, commit it, re-run")
    }
    XCTAssertEqual(xml, committed, "regenerate by deleting \(golden.path) and re-running")
  }
}

enum XMPNamespaceFixture {
  /// Swift CI compiles Packages/MapleCore outside the checkout and stages
  /// `test-fixtures/xmp-namespaces` beside it (apple.yml); absence fails.
  static func root(from file: URL = URL(fileURLWithPath: #filePath)) throws -> URL {
    let parents = sequence(first: file.standardizedFileURL.deletingLastPathComponent()) {
      directory -> URL? in
      let parent = directory.deletingLastPathComponent().standardizedFileURL
      return parent.path == directory.path ? nil : parent
    }
    let root = parents.lazy.map { $0.appendingPathComponent("test-fixtures/xmp-namespaces") }
      .first { candidate in
        FileManager.default.fileExists(
          atPath: candidate.appendingPathComponent("lightroom-foreign-attributes.xmp").path)
      }
    guard let root else {
      throw NSError(
        domain: "XMPNamespaceFixture", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Missing committed xmp-namespaces fixtures"])
    }
    return root
  }
}

/// Walks a document tracking which prefixes are declared in scope, and lists
/// every element or attribute name whose prefix is not.
private final class NamespaceScopeReport: NSObject, XMLParserDelegate {
  private(set) var parsed = false
  private(set) var parseError: String?
  private(set) var unboundNames: [String] = []
  private(set) var boundURI: [String: String] = [:]
  private var scopes: [[String: String]] = [["xml": "http://www.w3.org/XML/1998/namespace"]]

  init(_ xml: String) {
    super.init()
    let parser = XMLParser(data: Data(xml.utf8))
    parser.delegate = self
    parsed = parser.parse()
    parseError = parser.parserError.map { String(describing: $0) }
  }

  private func isBound(_ name: String) -> Bool {
    guard let colon = name.firstIndex(of: ":") else { return true }
    let prefix = String(name[..<colon])
    return prefix == "xmlns" || scopes.contains { $0[prefix] != nil }
  }

  func parser(
    _ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
    qualifiedName qName: String?, attributes attributeDict: [String: String]
  ) {
    let declared = attributeDict.reduce(into: [String: String]()) { scope, attribute in
      guard attribute.key.hasPrefix("xmlns:") else { return }
      scope[String(attribute.key.dropFirst("xmlns:".count))] = attribute.value
    }
    scopes.append(declared)
    boundURI.merge(declared) { first, _ in first }
    let names = [qName ?? elementName] + attributeDict.keys.sorted()
    unboundNames += names.filter { !isBound($0) }
  }

  func parser(
    _ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?,
    qualifiedName qName: String?
  ) {
    scopes.removeLast()
  }
}
