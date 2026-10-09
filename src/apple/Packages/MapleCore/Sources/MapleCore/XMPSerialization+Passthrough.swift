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
      .map { groups.unownedGroupSources[$0.source] ?? $0.source }
    return XMPPassthrough(
      unknownAttributes: delegate.unknownAttributes, unknownNodes: nodes,
      maskGroups: groups.templates)
  }

  /// Convenience overload for the on-disk read path.
  public static func parsePassthrough(data: Data) -> XMPPassthrough {
    guard let xml = String(data: data, encoding: .utf8) else { return .empty }
    return parsePassthrough(xml)
  }

  /// The star count an `xmp:Rating` raw parses to, exactly matching the
  /// `applyAttribute` arm in `XMPSerialization+ParseAttrs.swift`: integers
  /// clamp to 0...5, anything else leaves the incoming value untouched.
  /// Shared with the keep-or-rewrite rule below (#4403) so parse and
  /// preserve can never disagree.
  static func parseRatingValue(_ raw: String, current: Int) -> Int {
    guard let n = Int(raw) else { return current }
    return max(0, min(5, n))
  }

  /// The flag an `xmp:Label` raw parses to under the legacy alias read
  /// (#2221), or nil when the word means no flag. Shared with the
  /// keep-or-rewrite rule below (#4403).
  static func parseLabelFlag(_ raw: String) -> CullFlag? {
    switch raw.lowercased() {
    case "red", "pick": return .pick
    case "reject", "rejected": return .reject
    default: return nil
    }
  }
}

// MARK: - Re-emission

extension XMPSerializer {
  /// Whether a captured raw survives this save. Ordinary passthrough
  /// always does; a conditionally owned raw (#4403) only when the model
  /// still matches what it parses to — an edited or cleared field
  /// rewrites canonically instead, and a label word that means no flag
  /// (`"Blue"`) can never be "edited" through the flag, so it always stays.
  static func _keepsRawCullingAttribute(
    name: String, value: String, culling: CullingState
  ) -> Bool {
    switch name {
    case "xmp:Rating":
      return XMPParser.parseRatingValue(value, current: 0) == culling.stars
    case "xmp:Label":
      guard let flag = XMPParser.parseLabelFlag(value) else { return true }
      return flag == culling.flag
    default:
      return true
    }
  }

  /// Unknown attributes as canonical `(name, value)` pairs. Values are
  /// re-escaped because the bucket holds decoded text, exactly as the
  /// TypeScript serializer re-escapes `passthrough.unknownAttributes`.
  ///
  /// The pairs join the ordinary attribute list and go through
  /// `XMPCanonical.sorted`, whose unknown-namespace rank (500) drops them
  /// after every known attribute — `docs/xmp-canonical-format.md`
  /// § "Attribute ordering on `rdf:Description`".
  static func _passthroughAttrs(
    _ passthrough: XMPPassthrough, culling: CullingState
  ) -> [(String, String)] {
    passthrough.unknownAttributes
      .filter {
        _keepsRawCullingAttribute(name: $0.name, value: $0.value, culling: culling)
      }
      .map { ($0.name, escapeXMLAttr($0.value)) }
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
/// enclosing passthrough node's source text.
final class _XMPPassthroughDelegate: NSObject, XMLParserDelegate {
  private(set) var unknownAttributes: [XMPPassthrough.Attribute] = []
  private var captured = false

  func parser(
    _ parser: XMLParser,
    didStartElement elementName: String,
    namespaceURI: String?,
    qualifiedName qName: String?,
    attributes attributeDict: [String: String]
  ) {
    let qual = qName ?? elementName
    guard !captured, qual == "Description" || qual.hasSuffix(":Description") else { return }
    captured = true
    // `attributeDict` is unordered, so source order is unrecoverable here.
    // That is fine — the canonical attribute sort reorders every attribute
    // on write anyway — but the list is sorted so the bucket itself is
    // deterministic run to run, which keeps tests and diffs stable.
    unknownAttributes =
      attributeDict
      .filter { XMPKnownFields.isCapturedAttribute($0.key) }
      .map { XMPPassthrough.Attribute(name: $0.key, value: $0.value) }
      .sorted { $0.name < $1.name }
  }
}
