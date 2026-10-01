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
  /// (`XMPSidecarStore`) is about to replace it either way.
  public static func parsePassthrough(_ xml: String) -> XMPPassthrough {
    let parser = XMLParser(data: Data(xml.utf8))
    let delegate = _XMPPassthroughDelegate()
    parser.delegate = delegate
    guard parser.parse() else { return .empty }

    // Only namespace-owned primary records are modeled. Foreign attributes
    // and locally rebound child bytes must remain opaque (#3955).
    let removal = try? RemovalXMPRecords.field(Data(xml.utf8))
    let modeledRemoval = removal?.primary == true ? removal : nil
    let attributes = delegate.unknownAttributes.filter {
      modeledRemoval?.propertyNamespaces != nil || $0.name != modeledRemoval?.name
    }

    let groups = XMPMaskGroupSources.collect(xml)
    let nodes = XMPChildElementScanner.descriptionChildren(in: xml)
      .filter {
        if LocalAdjustmentXMP.isLocalName($0.qName, "MaskGroupBasedCorrections") {
          return !groups.groupSources.contains($0.source)
        }
        if $0.qName == LocalAdjustmentXMP.brushContainer {
          return !LocalAdjustmentXMP.isModeledBrushContainer($0.source)
        }
        return !XMPKnownFields.isManagedChild($0.qName)
      }
      .filter { child in
        guard let namespaces = modeledRemoval?.propertyNamespaces else { return true }
        return (try? RemovalXMPRecords.isOwnedProperty(child.source, namespaces: namespaces))
          != true
      }
      .map { groups.unownedGroupSources[$0.source] ?? $0.source }
    return XMPPassthrough(
      unknownAttributes: attributes, unknownNodes: nodes,
      maskGroups: groups.templates,
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
}

// MARK: - Attribute capture

/// Captures the unknown attributes of the first `rdf:Description`.
///
/// Only that element matters: every Maple field is an attribute on it, and an
/// unknown attribute deeper in the tree already rides along inside its
/// enclosing passthrough node's source text. The authored `xmp:Rating` /
/// `xmp:Label` are the exception: the parser reads them from any description,
/// so they are captured from the first description that carries them.
final class _XMPPassthroughDelegate: NSObject, XMLParserDelegate {
  private(set) var unknownAttributes: [XMPPassthrough.Attribute] = []
  private(set) var authoredRating: String?
  private(set) var authoredLabel: String?
  private var captured = false

  func parser(
    _ parser: XMLParser,
    didStartElement elementName: String,
    namespaceURI: String?,
    qualifiedName qName: String?,
    attributes attributeDict: [String: String]
  ) {
    let qual = qName ?? elementName
    guard qual == "Description" || qual.hasSuffix(":Description") else { return }
    authoredRating = authoredRating ?? attributeDict["xmp:Rating"]
    authoredLabel = authoredLabel ?? attributeDict["xmp:Label"]
    guard !captured else { return }
    captured = true
    // `attributeDict` is unordered, so source order is unrecoverable here.
    // That is fine — the canonical attribute sort reorders every attribute
    // on write anyway — but the list is sorted so the bucket itself is
    // deterministic run to run, which keeps tests and diffs stable.
    unknownAttributes =
      attributeDict
      .filter {
        // Ownership is resolved separately at document scope. A
        // foreign papp binding must not disappear from this bucket.
        $0.key.hasSuffix(":InpaintRemovals") || !XMPKnownFields.isKnownAttribute($0.key)
      }
      .map { XMPPassthrough.Attribute(name: $0.key, value: $0.value) }
      .sorted { $0.name < $1.name }
  }
}
