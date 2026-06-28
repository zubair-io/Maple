// XMPSerialization+MetadataWrite.swift — the metadata-carrying serialize
// overload + escapeXMLAttr, split out of XMPSerialization.swift to stay
// under the 600-LOC hard budget (the overload pushed that file to 711).
// Batch Metadata M0b (#1581).

import Foundation

extension XMPSerializer {
    /// Produces a sidecar carrying the full adjustment / culling AND the 21-field
    /// IPTC/EXIF metadata set. Namespace declarations are emitted conditionally —
    /// only prefixes that appear in the payload are declared.
    ///
    /// Per-platform byte-stable: `serialize(model:culling:metadata:)` →
    /// `parseMetadata` → `serialize(model:culling:metadata:)` yields the same
    /// string on Apple. Not cross-platform byte-identical with the TS serializer
    /// (tracked as debt #1577).
    ///
    /// Implementation note: builds the full XML through the shared
    /// `_buildAttrs` / `_buildKeywordsBlock` internal helpers rather than
    /// string-patching the base serializer's output. This makes the overload
    /// robust to any future base-format change.
    public static func serialize(
        model: AdjustmentModel,
        culling: CullingState,
        metadata: XmpMetadata
    ) -> String {
        let metaAttrs = metadataAttrParts(metadata)
        let metaBlocks = metadataNestedBlocks(metadata)
        let prefixes = metadataNamespacePrefixes(metadata)

        // If nothing to add, return the base sidecar unchanged.
        guard !metaAttrs.isEmpty || !metaBlocks.isEmpty else {
            return serialize(model: model, culling: culling)
        }

        // Build the full attr list: adjustment+culling attrs first, then
        // metadata attrs (values escaped for XML attribute context).
        var attrs = _buildAttrs(model: model, culling: culling)
        for (key, value) in metaAttrs {
            attrs.append((key, escapeXMLAttr(value)))
        }
        let attrsStr = attrs.map { "\($0.0)=\"\($0.1)\"" }.joined(separator: "\n        ")

        // Keywords block (dc:subject), shared with the base serializer.
        let (kwDcNs, keywordsBlock) = _buildKeywordsBlock(culling: culling)

        // Namespace declarations for metadata prefixes, in fixed TS order:
        // dc, exif, photoshop, Iptc4xmpCore, xmpRights.
        // Skip dc when the keywords block already declares it.
        let nsOrder = ["dc", "exif", "photoshop", "Iptc4xmpCore", "xmpRights"]
        let hasDcKeywords = !culling.keywords.isEmpty
        let extraNsLines = nsOrder
            .filter { prefixes.contains($0) && !($0 == "dc" && hasDcKeywords) }
            .compactMap { p -> String? in
                guard let uri = xmpMetadataNamespaces[p] else { return nil }
                return "\n      xmlns:\(p)=\"\(uri)\""
            }
            .joined()

        // Nested content: keywords block (dc:subject) followed by metadata
        // lang-alt/seq blocks (dc:title, dc:creator, dc:description, dc:rights,
        // xmpRights:UsageTerms).
        let metaNestedStr = metaBlocks.joined(separator: "\n")
        let allNested: String = {
            if keywordsBlock.isEmpty { return metaNestedStr }
            if metaNestedStr.isEmpty { return keywordsBlock }
            return keywordsBlock + "\n" + metaNestedStr
        }()

        if allNested.isEmpty {
            // Self-closing form: no nested elements.
            return """
            <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
            <x:xmpmeta xmlns:x="adobe:ns:meta/">
              <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                <rdf:Description
                  xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                  xmlns:xmp="http://ns.adobe.com/xap/1.0/"
                  xmlns:papp="http://ns.justmaple.app/1.0/"\(extraNsLines)
                  \(attrsStr)/>
              </rdf:RDF>
            </x:xmpmeta>
            <?xpacket end="w"?>
            """
        } else {
            // Open/close form: nested elements present.
            return """
            <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
            <x:xmpmeta xmlns:x="adobe:ns:meta/">
              <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                <rdf:Description
                  xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                  xmlns:xmp="http://ns.adobe.com/xap/1.0/"
                  xmlns:papp="http://ns.justmaple.app/1.0/"\(kwDcNs)\(extraNsLines)
                  \(attrsStr)>\(allNested)
                </rdf:Description>
              </rdf:RDF>
            </x:xmpmeta>
            <?xpacket end="w"?>
            """
        }
    }

    /// Attribute value escaping (mirrors `_escapeAttr` in the TS serializer).
    static func escapeXMLAttr(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
