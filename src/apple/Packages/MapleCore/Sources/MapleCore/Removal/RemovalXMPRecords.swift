// Strict removal-attribute discovery for relocation (#3944). Interpret XML
// namespace bindings; a renamed papp prefix must not lose companion assets.
// JSON versions, source identities and asset names are still owned by Rust.
import Foundation

enum RemovalXMPRecords {
  static func read(_ data: Data) throws -> String? {
    try attribute(data)?.records
  }

  /// Namespace-owned attribute identity for atomic local writes. Its original
  /// name lets the writer replace an alias exactly once with canonical papp.
  static func attribute(_ data: Data) throws -> (name: String, records: String)? {
    let parser = XMLParser(data: data)
    let delegate = RemovalAttributeReader()
    parser.delegate = delegate
    parser.shouldResolveExternalEntities = false
    guard parser.parse(), !delegate.ambiguous else {
      // Existing file operations can carry opaque, unrelated malformed XMP.
      // A damaged removal attribute cannot silently become an empty edit.
      if delegate.records != nil || delegate.ambiguous
        || String(data: data, encoding: .utf8)?.contains("InpaintRemovals") != false
      {
        throw RemovalError.invalid("Cannot resolve removal companions from this XMP sidecar")
      }
      return nil
    }
    guard let records = delegate.records, let name = delegate.name else { return nil }
    _ = try RemovalBridge.assetNames(records: records)
    return (name, records)
  }
}

private final class RemovalAttributeReader: NSObject, XMLParserDelegate {
  private var scopes: [[String: String]] = []
  var records: String?
  var name: String?
  var ambiguous = false

  func parser(
    _ parser: XMLParser, didStartElement elementName: String,
    namespaceURI: String?, qualifiedName qName: String?, attributes attrs: [String: String]
  ) {
    var bindings = scopes.last ?? [:]
    for (name, value) in attrs where name.hasPrefix("xmlns:") {
      bindings[String(name.dropFirst(6))] = value
    }
    if let defaultNamespace = attrs["xmlns"] { bindings[""] = defaultNamespace }
    scopes.append(bindings)
    let element = (qName ?? elementName).split(separator: ":", omittingEmptySubsequences: false)
    let prefix = element.count == 2 ? String(element[0]) : ""
    guard element.last == "Description",
      bindings[prefix] == "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    else { return }
    for (name, value) in attrs {
      let attribute = name.split(separator: ":", omittingEmptySubsequences: false)
      guard attribute.count == 2, attribute[1] == "InpaintRemovals",
        let uri = bindings[String(attribute[0])],
        uri == XMPCanonical.pappNamespaceURI || uri == "http://ns.justmaple.app/1.0/"
      else { continue }
      if records != nil { ambiguous = true }
      records = value
      self.name = name
    }
  }

  func parser(
    _ parser: XMLParser, didEndElement elementName: String,
    namespaceURI: String?, qualifiedName qName: String?
  ) {
    _ = scopes.popLast()
  }
}
