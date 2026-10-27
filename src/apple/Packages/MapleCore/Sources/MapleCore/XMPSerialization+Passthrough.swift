// XMPSerialization+Passthrough.swift — the parse half of the Apple
// passthrough contract (#2233).
//
// `XMPParser.parsePassthrough` reads a sidecar and returns everything on
// `rdf:Description` that Maple does not model: unknown attributes (through
// `XMLParser`, so entity references are already decoded) and unknown child
// elements (through `XMPChildElementScanner`, so their bytes survive intact —
// see that file's header for why the two halves use different machinery).
//
// This is a second pass over the document rather than an extra return value on
// `XMPParser.parse`. That keeps the widely-called `(AdjustmentModel,
// CullingState)` signature untouched, and passthrough is only needed on the
// write path — once per debounced save, not once per slider tick.

import Foundation

extension XMPParser {
  /// Collect the unknown attributes and unknown nested elements of `xml`.
  ///
  /// Returns `.empty` for a document that will not parse: a malformed
  /// sidecar has no trustworthy bytes to carry forward, and the caller
  /// (`XMPSidecarStore`) is about to replace it either way. One whose only
  /// defect is a repeated attribute is read from its first copies (#5475).
  public static func parsePassthrough(_ xml: String) -> XMPPassthrough {
    let parser = XMLParser(data: Data(xml.utf8))
    let delegate = _XMPPassthroughDelegate(
      primaryDescription: XMPChildElementScanner.primaryDescription(in: xml))
    parser.delegate = delegate
    guard parser.parse() else {
      return XMPDuplicateAttributes.removingRepeats(in: xml).map(parsePassthrough) ?? .empty
    }

    let groups = XMPMaskGroupSources.collect(xml)
    let isPassthroughChild: (XMPChildElementScanner.Child) -> Bool = {
      if LocalAdjustmentXMP.isLocalName($0.qName, "MaskGroupBasedCorrections") {
        return !groups.groupSources.contains($0.source)
      }
      if $0.qName == LocalAdjustmentXMP.brushContainer {
        return !LocalAdjustmentXMP.isModeledBrushContainer($0.source)
      }
      return !XMPKnownFields.isManagedChild($0.qName)
    }
    let nodes = XMPChildElementScanner.firstDescriptionChildren(in: xml)
      .filter(isPassthroughChild)
      .map { groups.unownedGroupSources[$0.source] ?? $0.source }
    let preserved = XMPChildElementScanner.preservedDocumentNodes(
      in: xml, groups: groups, isPassthroughChild: isPassthroughChild)
    return XMPPassthrough(
      unknownAttributes: delegate.unknownAttributes, unknownNodes: nodes,
      maskGroups: groups.templates,
      unknownRdfNodes: preserved.rdfNodes,
      unknownXmpmetaNodes: preserved.xmpmetaNodes,
      authoredRating: delegate.authoredRating, authoredLabel: delegate.authoredLabel,
      authoredColorLabel: (try? parse(xml))?.1.colorLabel)
  }

  /// `xmp:Rating` as stars: `3.0` reads as 3, and a Lightroom reject (`-1`),
  /// anything outside 0...5, or anything unparseable reads as unrated — the
  /// same reading as the web, Windows and API parsers.
  static func ratingValue(_ value: String) -> Int {
    guard let rating = Double(value.trimmingCharacters(in: .whitespaces)), (0...5).contains(rating)
    else { return 0 }
    return Int(rating.rounded())
  }

  /// Convenience overload for the on-disk read path.
  public static func parsePassthrough(data: Data) -> XMPPassthrough {
    guard let xml = String(data: data, encoding: .utf8) else { return .empty }
    return parsePassthrough(xml)
  }
}

// MARK: - Re-emission

extension XMPSerializer {
  /// Unknown attributes as canonical `(name, value)` pairs. Values are
  /// re-escaped because the bucket holds decoded text, exactly as the
  /// TypeScript serializer re-escapes `passthrough.unknownAttributes`.
  ///
  /// The pairs join the ordinary attribute list and go through
  /// `XMPCanonical.sorted`, whose unknown-namespace rank (500) drops them
  /// after every known attribute — `docs/xmp-canonical-format.md`
  /// § "Attribute ordering on `rdf:Description`".
  static func _passthroughAttrs(_ passthrough: XMPPassthrough) -> [(String, String)] {
    passthrough.unknownAttributes.map { ($0.name, escapeXMLAttr($0.value)) }
  }

  /// `xmp:Rating` and `xmp:Label` (#4403). An unchanged rating keeps its
  /// authored bytes, so a Lightroom reject (`-1`) or a `3.0` is not deleted
  /// or rewritten by an unrelated edit; a changed one is written canonically
  /// (omitted at zero). `xmp:Label` is never Maple's to author: it survives
  /// unless the user changed the colour label and the authored word is one
  /// of the six colours it would now contradict.
  static func _ratingAndLabelAttrs(
    culling: CullingState, passthrough: XMPPassthrough
  ) -> [(String, String)] {
    let authoredRating = passthrough.authoredRating.flatMap { authored in
      XMPParser.ratingValue(authored) == culling.stars ? authored : nil
    }
    let rating =
      authoredRating.map { [("xmp:Rating", escapeXMLAttr($0))] }
      ?? (culling.stars > 0 ? [("xmp:Rating", String(culling.stars))] : [])
    let labelUnchanged = culling.colorLabel == passthrough.authoredColorLabel
    let label = passthrough.authoredLabel.flatMap { authored in
      labelUnchanged || ColorLabel(adobeLabel: authored) == nil
        ? [("xmp:Label", escapeXMLAttr(authored))] : nil
    }
    return rating + (label ?? [])
  }

  /// Unknown nested elements, in original document order — masks, history
  /// and snapshots are ordered stacks, so sorting them would corrupt them.
  ///
  /// Only the first line of each node is indented. The rest keeps the
  /// interior whitespace its author wrote, which is what makes the preserved
  /// region byte-identical across a read-modify-write; the web serializer
  /// re-emits its nodes the same way.
  static func _passthroughNodesBlock(_ passthrough: XMPPassthrough, indent: String) -> String {
    passthrough.unknownNodes.map { "\(indent)\($0)" }.joined(separator: "\n")
  }
  /// The conditional namespace declarations a document needs (#4688): the
  /// prefixes its own payload uses (`needed`) plus any of them a preserved
  /// attribute or node uses. The passthrough bucket drops a source
  /// declaration for these prefixes because the envelope owns them, so the
  /// envelope must emit it whenever preserved content still refers to it.
  /// Declaring one that turns out unused is harmless; omitting one leaves an
  /// unbound prefix that namespace-aware readers reject.
  static func _conditionalNamespaces(
    needed: Set<String>, passthrough: XMPPassthrough
  ) -> [(prefix: String, uri: String)] {
    let order = ["dc", "exif", "photoshop", "Iptc4xmpCore", "xmpRights"]
    let attributePrefixes = Set(
      passthrough.unknownAttributes.compactMap {
        $0.name.split(separator: ":").first.map(String.init)
      })
    let preserved = order.filter { prefix in
      attributePrefixes.contains(prefix)
        || passthrough.unknownNodes.contains {
          $0.range(of: "[<\\s/]\(prefix):[A-Za-z_]", options: .regularExpression) != nil
        }
    }
    return
      order
      .filter { needed.contains($0) || preserved.contains($0) }
      .compactMap { prefix in xmpMetadataNamespaces[prefix].map { (prefix: prefix, uri: $0) } }
  }
}

// MARK: - Attribute capture

/// Captures the unknown attributes of the primary `rdf:Description`.
///
/// Only that element matters: every Maple field is an attribute on it, and an
/// unknown attribute deeper in the tree already rides along inside its
/// enclosing passthrough node's source text. The authored `xmp:Rating` /
/// `xmp:Label` are captured from any same-subject top-level description.
final class _XMPPassthroughDelegate: NSObject, XMLParserDelegate {
  private(set) var unknownAttributes: [XMPPassthrough.Attribute] = []
  private(set) var authoredRating: String?
  private(set) var authoredLabel: String?
  private var captured = false
  /// Foreign declarations on `x:xmpmeta` / `rdf:RDF` (#4688). The canonical
  /// envelope rebuilds those elements, so a prefix a preserved node relies on
  /// rides along on `rdf:Description` instead.
  private var ancestorDeclarations: [String: String] = [:]
  private var namespaceScopes: [[String: String]] = []
  private let primaryDescription: XMPChildElementScanner.PrimaryDescription?
  private var topLevelDescriptionIndex = 0
  private var primaryDescriptionContext: XMPChildElementScanner.DescriptionContext?
  private var sawRdfEnvelope = false
  private var rdfEnvelopeDepth: Int?

  init(primaryDescription: XMPChildElementScanner.PrimaryDescription? = nil) {
    self.primaryDescription = primaryDescription
  }

  func parser(
    _ parser: XMLParser,
    didStartElement elementName: String,
    namespaceURI: String?,
    qualifiedName qName: String?,
    attributes attributeDict: [String: String]
  ) {
    let declarations = Dictionary(
      uniqueKeysWithValues: attributeDict.compactMap { key, value in
        key == "xmlns"
          ? ("", value) : (key.hasPrefix("xmlns:") ? (String(key.dropFirst(6)), value) : nil)
      })
    let namespaces =
      (namespaceScopes.last ?? ["rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#"])
      .merging(declarations) { _, current in current }
    let depth = namespaceScopes.count
    namespaceScopes.append(namespaces)
    let qual = qName ?? elementName
    let canonicalName = XMPChildElementScanner.canonicalQualifiedName(
      qual, namespaces: namespaces)
    if !sawRdfEnvelope, depth <= 1, canonicalName == "rdf:RDF" {
      sawRdfEnvelope = true
      rdfEnvelopeDepth = depth + 1
      if !captured {
        ancestorDeclarations.merge(
          attributeDict.filter { $0.key.hasPrefix("xmlns:") }
        ) { _, nearer in nearer }
      }
      return
    }
    guard rdfEnvelopeDepth == depth || (depth == 0 && primaryDescription == nil),
      canonicalName == "rdf:Description"
    else {
      if !captured, depth == 0 {
        ancestorDeclarations.merge(
          attributeDict.filter { $0.key.hasPrefix("xmlns:") }
        ) { _, nearer in nearer }
      }
      return
    }
    let currentIndex = topLevelDescriptionIndex
    topLevelDescriptionIndex += 1
    let context = XMPChildElementScanner.descriptionContext(
      attributes: attributeDict, namespaces: namespaces)
    let matchesPrimary: Bool
    let isPrimaryElement: Bool
    if let primary = primaryDescription {
      matchesPrimary = primary.matches(index: currentIndex, context: context)
      isPrimaryElement = currentIndex == primary.index
    } else if let primary = primaryDescriptionContext {
      matchesPrimary = primary.hasExplicitSubject && context == primary
      isPrimaryElement = false
    } else {
      primaryDescriptionContext = context
      matchesPrimary = true
      isPrimaryElement = true
    }
    guard matchesPrimary else { return }
    let xmpAttr: (String) -> String? = { local in
      attributeDict.first {
        XMPChildElementScanner.canonicalQualifiedName($0.key, namespaces: namespaces)
          == "xmp:" + local
      }?.value ?? (namespaces["xmp"] == nil ? attributeDict["xmp:" + local] : nil)
    }
    authoredRating = authoredRating ?? xmpAttr("Rating")
    authoredLabel = authoredLabel ?? xmpAttr("Label")
    guard isPrimaryElement, !captured else { return }
    captured = true
    // `attributeDict` is unordered, so source order is unrecoverable here.
    // That is fine — the canonical attribute sort reorders every attribute
    // on write anyway — but the list is sorted so the bucket itself is
    // deterministic run to run, which keeps tests and diffs stable.
    unknownAttributes =
      ancestorDeclarations.merging(attributeDict) { _, own in own }
      .filter { !XMPKnownFields.isKnownAttribute($0.key) }
      .map { XMPPassthrough.Attribute(name: $0.key, value: $0.value) }
      .sorted { $0.name < $1.name }
  }

  func parser(
    _ parser: XMLParser,
    didEndElement elementName: String,
    namespaceURI: String?,
    qualifiedName qName: String?
  ) {
    _ = namespaceScopes.popLast()
    if let envDepth = rdfEnvelopeDepth, namespaceScopes.count < envDepth {
      rdfEnvelopeDepth = nil
    }
  }
}
