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

        let nodes = XMPChildElementScanner.descriptionChildren(in: xml)
            .filter { !XMPKnownFields.isManagedChild($0.qName) }
            .map(\.source)
        return XMPPassthrough(unknownAttributes: delegate.unknownAttributes, unknownNodes: nodes)
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

    func parser(_ parser: XMLParser,
                didStartElement elementName: String,
                namespaceURI: String?,
                qualifiedName qName: String?,
                attributes attributeDict: [String: String]) {
        let qual = qName ?? elementName
        guard !captured, qual == "Description" || qual.hasSuffix(":Description") else { return }
        captured = true
        // `attributeDict` is unordered, so source order is unrecoverable here.
        // That is fine — the canonical attribute sort reorders every attribute
        // on write anyway — but the list is sorted so the bucket itself is
        // deterministic run to run, which keeps tests and diffs stable.
        unknownAttributes = attributeDict
            .filter { !XMPKnownFields.isKnownAttribute($0.key) }
            .map { XMPPassthrough.Attribute(name: $0.key, value: $0.value) }
            .sorted { $0.name < $1.name }
    }
}
