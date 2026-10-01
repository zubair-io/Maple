// Strict removal-attribute discovery for relocation (#3944). Interpret XML
// namespace bindings; a renamed papp prefix must not lose companion assets.
// JSON versions, source identities and asset names are still owned by Rust.
import Foundation

enum RemovalXMPRecords {
  static func read(_ data: Data) throws -> String? {
    try field(data)?.records
  }

  /// Namespace-owned attribute identity for atomic local writes. Its original
  /// name lets the writer replace an alias exactly once with canonical papp.
  static func field(_ data: Data) throws
    -> (name: String, records: String, propertyNamespaces: [String: String]?, primary: Bool)?
  {
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
    return (name, records, delegate.propertyNamespaces, delegate.primary)
  }

  /// Classify an opaque direct child under its actual inherited namespace
  /// scope. Child-local rebinding still wins; same-named foreign XML survives.
  static func isOwnedProperty(_ node: String, namespaces: [String: String]) throws -> Bool {
    let prefix = (0...).lazy.map { "_maple_removal_\($0)" }.first { namespaces[$0] == nil }!
    let declarations: String = namespaces.sorted { $0.key < $1.key }.map { prefix, uri -> String in
      let name = prefix.isEmpty ? "xmlns" : "xmlns:\(prefix)"
      return "\(name)=\"\(XMPSerializer.escapeXMLAttr(uri))\""
    }.joined(separator: " ")
    let xml = """
      <\(prefix):Description xmlns:\(prefix)="http://www.w3.org/1999/02/22-rdf-syntax-ns#" \(declarations)>\(node)</\(prefix):Description>
      """
    return try field(Data(xml.utf8))?.propertyNamespaces != nil
  }
}

private final class RemovalAttributeReader: NSObject, XMLParserDelegate {
  private var scopes: [[String: String]] = []
  private var descriptions: [Bool] = []
  private var primaryDepth: Int?
  private var sawDescription = false
  var primary = false
  private var propertyText: String?
  private var propertyDepth: Int?
  var propertyNamespaces: [String: String]?
  var records: String?
  var name: String?
  var ambiguous = false

  func parser(
    _ parser: XMLParser, didStartElement elementName: String,
    namespaceURI: String?, qualifiedName qName: String?, attributes attrs: [String: String]
  ) {
    let parentBindings = scopes.last ?? [:]
    let parentIsDescription = descriptions.last == true
    var bindings = parentBindings
    for (name, value) in attrs where name.hasPrefix("xmlns:") {
      bindings[String(name.dropFirst(6))] = value
    }
    if let defaultNamespace = attrs["xmlns"] { bindings[""] = defaultNamespace }
    scopes.append(bindings)
    let element = (qName ?? elementName).split(separator: ":", omittingEmptySubsequences: false)
    let prefix = element.count == 2 ? String(element[0]) : ""
    let isDescription =
      element.last == "Description"
      && bindings[prefix] == "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    descriptions.append(isDescription)
    if element.last == "Description", !sawDescription {
      sawDescription = true
      if isDescription { primaryDepth = scopes.count }
    }
    if propertyText != nil {
      ambiguous = true
      return
    }
    if parentIsDescription, element.last == "InpaintRemovals", !prefix.isEmpty,
      bindings[prefix] == nil
    {
      ambiguous = true
    }
    if parentIsDescription, element.last == "InpaintRemovals",
      bindings[prefix] == XMPCanonical.pappNamespaceURI
        || bindings[prefix] == "http://ns.justmaple.app/1.0/"
    {
      if records != nil { ambiguous = true }
      propertyText = ""
      propertyDepth = scopes.count
      propertyNamespaces = parentBindings
      primary = primaryDepth == scopes.count - 1
      name = qName ?? elementName
      return
    }
    guard isDescription else { return }
    for (name, value) in attrs {
      let attribute = name.split(separator: ":", omittingEmptySubsequences: false)
      guard attribute.count == 2, attribute[1] == "InpaintRemovals" else { continue }
      guard let uri = bindings[String(attribute[0])] else {
        ambiguous = true
        continue
      }
      guard uri == XMPCanonical.pappNamespaceURI || uri == "http://ns.justmaple.app/1.0/"
      else { continue }
      if records != nil { ambiguous = true }
      records = value
      primary = primaryDepth == scopes.count
      self.name = name
    }
  }

  func parser(
    _ parser: XMLParser, didEndElement elementName: String,
    namespaceURI: String?, qualifiedName qName: String?
  ) {
    if propertyDepth == scopes.count {
      records = propertyText
      propertyText = nil
      propertyDepth = nil
    }
    if primaryDepth == scopes.count { primaryDepth = nil }
    _ = scopes.popLast()
    _ = descriptions.popLast()
  }

  func parser(_ parser: XMLParser, foundCharacters string: String) {
    propertyText?.append(string)
  }

  func parser(_ parser: XMLParser, foundCDATA cdataBlock: Data) {
    guard propertyText != nil else { return }
    guard let text = String(data: cdataBlock, encoding: .utf8) else {
      ambiguous = true
      return
    }
    propertyText?.append(text)
  }
}
