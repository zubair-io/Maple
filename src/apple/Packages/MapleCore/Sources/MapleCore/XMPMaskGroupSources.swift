import Foundation

/// Byte-preserving slots for imported groups containing unsupported entries.
public struct XMPMaskGroupTemplate: Sendable, Equatable {
  public enum Part: Sendable, Equatable {
    case text(String)
    case layer(Int)
    case append
  }
  public var parts: [Part]
}

enum XMPMaskGroupSources {
  struct Collection {
    var layers: [LocalAdjustment] = []
    var templates: [XMPMaskGroupTemplate] = []
    var groupSources: Set<String> = []
    var unownedGroupSources: [String: String] = [:]
  }
  private typealias Child = XMPChildElementScanner.Child
  private static func children(_ xml: String, _ root: String) -> [Child] {
    XMPChildElementScanner.elementChildren(in: xml, rootLocalName: root)
  }
  private static func local(_ name: String, _ expected: String) -> Bool {
    LocalAdjustmentXMP.isLocalName(name, expected)
  }
  static func isGroup(_ mask: LocalMask) -> Bool {
    switch mask {
    case .group, .bitmap, .everywhere: return true
    case .linear, .radial, .brush: return false
    }
  }

  static func collect(_ xml: String) -> Collection {
    let namespaces = SourceNamespaces.atFirstDescription(xml)
    let candidates = XMPChildElementScanner.descriptionChildren(in: xml)
      .filter { local($0.qName, "MaskGroupBasedCorrections") }
    let groups =
      candidates
      .filter {
        XMPMaskGroupNamespaces.matches(
          $0.qName, LocalAdjustmentXMP.groupContainer,
          namespaces: scope(namespaces, attributes: rootAttributes($0.source)))
      }
    var collection = Collection()
    collection.groupSources = Set(groups.map(\.source))
    for candidate in candidates where !collection.groupSources.contains(candidate.source) {
      collection.unownedGroupSources[candidate.source] = explicitNamespaces(
        candidate.source,
        namespaces: scope(namespaces, attributes: rootAttributes(candidate.source)))
    }
    var opaque = false
    for group in groups {
      let rootChildren = children(group.source, "MaskGroupBasedCorrections")
      let groupNamespaces = scope(namespaces, attributes: rootAttributes(group.source))
      guard rootChildren.count == 1,
        matches(rootChildren[0], "rdf:Seq", inherited: groupNamespaces)
      else {
        opaque = true
        collection.templates.append(XMPMaskGroupTemplate(parts: [.text(group.source)]))
        continue
      }
      let sequence = rootChildren[0]
      let items = children(sequence.source, "Seq")
      let bytes = Array(group.source.utf8)
      var parts: [XMPMaskGroupTemplate.Part] = []
      var cursor = 0
      let sequenceNamespaces = scope(groupNamespaces, attributes: rootAttributes(sequence.source))
      // Container/sequence metadata stays in the original wrapper.
      if !rootAttributes(group.source).isEmpty || !rootAttributes(sequence.source).isEmpty {
        opaque = true
      }
      for item in items {
        let lower = sequence.byteRange.lowerBound + item.byteRange.lowerBound
        let upper = sequence.byteRange.lowerBound + item.byteRange.upperBound
        let range = lower..<upper
        guard matches(item, "rdf:li", inherited: sequenceNamespaces),
          let layer = layer(item.source, namespaces: sequenceNamespaces)
        else {
          opaque = true
          continue
        }
        parts.append(.text(String(decoding: bytes[cursor..<range.lowerBound], as: UTF8.self)))
        parts.append(.layer(collection.layers.count))
        collection.layers.append(layer)
        cursor = range.upperBound
      }
      // The append slot sits before the sequence's closing tag. A
      // self-closing sequence has no append slot and remains opaque.
      if let closing = sequence.source.range(of: "</", options: .backwards) {
        let closeOffset = sequence.source.utf8.distance(
          from: sequence.source.utf8.startIndex,
          to: closing.lowerBound.samePosition(in: sequence.source.utf8)!)
        let appendAt = sequence.byteRange.lowerBound + closeOffset
        parts.append(.text(String(decoding: bytes[cursor..<appendAt], as: UTF8.self)))
        parts.append(.append)
        parts.append(.text(String(decoding: bytes[appendAt...], as: UTF8.self)))
      } else {
        parts.append(.text(String(decoding: bytes[cursor...], as: UTF8.self)))
        opaque = true
      }
      collection.templates.append(XMPMaskGroupTemplate(parts: parts))
    }
    if opaque {
      for index in collection.layers.indices { collection.layers[index].xmpGroupSlot = index }
    } else {
      collection.templates = []
    }
    return collection
  }

  private static func layer(_ source: String, namespaces: [String: String]) -> LocalAdjustment? {
    let itemNamespaces = scope(namespaces, attributes: rootAttributes(source))
    let descriptions = children(source, "li")
    guard descriptions.count == 1,
      matches(descriptions[0], "rdf:Description", inherited: itemNamespaces),
      hasOnlyNamespaces(rootAttributes(source))
    else { return nil }
    let description = descriptions[0].source
    let descriptionNamespaces = scope(
      itemNamespaces,
      attributes: rootAttributes(description))
    let nodes = children(description, "Description")
    let masks = nodes.filter {
      matches($0, LocalAdjustmentXMP.masksElement, inherited: descriptionNamespaces)
    }
    guard masks.count == 1 else { return nil }
    let maskNamespaces = scope(descriptionNamespaces, attributes: rootAttributes(masks[0].source))
    let sequences = children(masks[0].source, "CorrectionMasks")
    guard sequences.count == 1, matches(sequences[0], "rdf:Seq", inherited: maskNamespaces) else {
      return nil
    }
    // Unexpected metadata on structural mask wrappers cannot be moved
    // safely by the model; preserve that complete correction opaquely.
    guard hasOnlyNamespaces(rootAttributes(masks[0].source)),
      hasOnlyNamespaces(rootAttributes(sequences[0].source))
    else { return nil }
    let leaves = children(sequences[0].source, "Seq")
    let leafNamespaces = scope(maskNamespaces, attributes: rootAttributes(sequences[0].source))
    guard !leaves.isEmpty, leaves.allSatisfy({ matches($0, "rdf:li", inherited: leafNamespaces) })
    else { return nil }
    let components = leaves.compactMap { leaf -> MaskComponent? in
      let attributes = rootAttributes(leaf.source)
      let namespaces = scope(leafNamespaces, attributes: attributes)
      guard
        var component = LocalAdjustmentXMP.parseComponent(
          XMPMaskGroupNamespaces.attributes(attributes, namespaces: namespaces))
      else { return nil }
      let extras = children(leaf.source, "li").map(\.source)
      component.xmpMetadata = metadata(
        attributes, owned: LocalAdjustmentXMP.componentKeys, nodes: extras,
        namespaces: namespaces)
      return component
    }
    guard components.count == leaves.count else { return nil }
    let sourceAttributes = rootAttributes(description)
    let attributes = XMPMaskGroupNamespaces.attributes(
      sourceAttributes, namespaces: descriptionNamespaces)
    let range = LocalAdjustmentXMP.parseRange(attributes)
    guard attributes["papp:RangeKind"] == nil || range != nil else { return nil }
    guard LocalAdjustmentXMP.bool(attributes["crs:CorrectionActive"]) != false,
      let mask = LocalAdjustmentXMP.parseGroup(attributes, components: components)
    else { return nil }
    return LocalAdjustment(
      mask: mask, range: range,
      adjustments: LocalAdjustmentXMP.parseAdjustments(attributes),
      xmpMetadata: metadata(
        sourceAttributes, owned: LocalAdjustmentXMP.correctionKeys,
        nodes: nodes.filter {
          !matches($0, LocalAdjustmentXMP.masksElement, inherited: descriptionNamespaces)
        }.map(\.source),
        namespaces: descriptionNamespaces))
  }

  private static func metadata(
    _ attributes: [String: String], owned: Set<String>, nodes: [String],
    namespaces: [String: String]
  ) -> LocalXmpMetadata? {
    XMPMaskGroupNamespaces.metadata(
      attributes, owned: owned,
      nodes: nodes.map { explicitNamespaces($0, namespaces: namespaces) }, namespaces: namespaces)
  }

  private static func matches(_ child: Child, _ name: String, inherited: [String: String]) -> Bool {
    XMPMaskGroupNamespaces.matches(
      child.qName, name, namespaces: scope(inherited, attributes: rootAttributes(child.source)))
  }

  private static func explicitNamespaces(_ source: String, namespaces: [String: String]) -> String {
    guard
      let nameEnd = source.firstIndex(where: { $0.isWhitespace || $0 == ">" || $0 == "/" })
    else { return source }
    let own = rootAttributes(source)
    let declarations = namespaces.sorted { $0.key < $1.key }.compactMap { prefix, uri -> String? in
      let name = prefix.isEmpty ? "xmlns" : "xmlns:\(prefix)"
      let used =
        prefix.isEmpty
        || source.range(
          of: "(?:</?|\\s)" + NSRegularExpression.escapedPattern(for: prefix) + ":",
          options: .regularExpression) != nil
      guard prefix != "xml", used, own[name] == nil else { return nil }
      return " \(name)=\"\(XMPSerializer.escapeXMLAttr(uri))\""
    }.joined()
    var out = source
    out.insert(contentsOf: declarations, at: nameEnd)
    return out
  }

  private static func hasOnlyNamespaces(_ attributes: [String: String]) -> Bool {
    attributes.keys.allSatisfy { $0 == "xmlns" || $0.hasPrefix("xmlns:") }
  }

  private static func scope(_ inherited: [String: String], attributes: [String: String]) -> [String:
    String]
  {
    inherited.merging(
      attributes.reduce(into: [:]) { result, entry in
        if entry.key == "xmlns" {
          result[""] = entry.value
        } else if entry.key.hasPrefix("xmlns:") {
          result[String(entry.key.dropFirst(6))] = entry.value
        }
      }, uniquingKeysWith: { _, local in local })
  }

  private static func rootAttributes(_ xml: String) -> [String: String] {
    let delegate = SourceRootAttributes()
    let parser = XMLParser(data: Data(xml.utf8))
    parser.delegate = delegate
    _ = parser.parse()
    return delegate.attributes
  }

  private final class SourceRootAttributes: NSObject, XMLParserDelegate {
    var attributes: [String: String] = [:]
    func parser(
      _ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
      qualifiedName qName: String?, attributes attributeDict: [String: String]
    ) {
      attributes = attributeDict
      parser.abortParsing()
    }
  }
  private final class SourceNamespaces: NSObject, XMLParserDelegate {
    var namespaces: [String: String] = [:]
    static func atFirstDescription(_ xml: String) -> [String: String] {
      let delegate = SourceNamespaces()
      let parser = XMLParser(data: Data(xml.utf8))
      parser.delegate = delegate
      _ = parser.parse()
      return delegate.namespaces
    }
    func parser(
      _ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
      qualifiedName qName: String?, attributes attributeDict: [String: String]
    ) {
      namespaces = scope(namespaces, attributes: attributeDict)
      if local(qName ?? elementName, "Description") { parser.abortParsing() }
    }
  }
}

extension XMPSerializer {
  static func _buildLocalAdjustmentsBlockWithPassthrough(
    model: AdjustmentModel, indent: String,
    templates: [XMPMaskGroupTemplate]
  ) -> String {
    guard !templates.isEmpty else {
      return _buildLocalAdjustmentsBlock(model: model, indent: indent)
    }
    let groups = model.localAdjustments.filter { XMPMaskGroupSources.isGroup($0.mask) }
    let owned = Dictionary(
      groups.compactMap { layer -> (Int, String)? in
        guard let slot = layer.xmpGroupSlot else { return nil }
        return (slot, _scopedLocalCorrection(layer))
      }, uniquingKeysWith: { first, _ in first })
    let appended = groups.filter { $0.xmpGroupSlot == nil }.map(_scopedLocalCorrection).joined()
    let lastAppend = templates.lastIndex { $0.parts.contains(.append) }
    let blocks = templates.enumerated().map { index, template in
      indent
        + template.parts.map { part -> String in
          switch part {
          case .text(let text): return text
          case .layer(let slot): return owned[slot] ?? ""
          case .append: return index == lastAppend ? appended : ""
          }
        }.joined()
    }
    var canonical = model
    canonical.localAdjustments =
      model.localAdjustments.filter { !XMPMaskGroupSources.isGroup($0.mask) }
      + (lastAppend == nil ? groups.filter { $0.xmpGroupSlot == nil } : [])
    return ([_buildLocalAdjustmentsBlock(model: canonical, indent: indent)] + blocks)
      .filter { !$0.isEmpty }.joined(separator: "\n")
  }
  private static func _scopedLocalCorrection(_ layer: LocalAdjustment) -> String {
    let source = _localAdjustmentCorrection(layer, indent: "").joined(separator: "\n")
    guard let opening = source.range(of: "<rdf:li>") else { return source }
    var scoped = source
    scoped.replaceSubrange(
      opening,
      with:
        "<rdf:li xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\""
        + " xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\""
        + " xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\">")
    return scoped
  }
}
