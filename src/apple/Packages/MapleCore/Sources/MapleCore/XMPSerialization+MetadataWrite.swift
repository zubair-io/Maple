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
    /// Byte-canonical (#1577): the envelope, namespace prelude, attribute
    /// ordering and child indentation all come from `XMPCanonical`, which the
    /// TypeScript `canonicalDocument` mirrors.
    ///
    /// Implementation note: builds the full XML through the shared
    /// `_buildAttrs` / `_buildKeywordsBlock` internal helpers rather than
    /// string-patching the base serializer's output. This makes the overload
    /// robust to any future base-format change.
    public static func serialize(
        model: AdjustmentModel,
        culling: CullingState,
        metadata: XmpMetadata,
        passthrough: XMPPassthrough = .empty
    ) -> String {
        let metaAttrs = metadataAttrParts(metadata)
        let metaBlocks = metadataNestedBlocks(metadata)
        let prefixes = metadataNamespacePrefixes(metadata)

        // If nothing to add, return the base sidecar unchanged — still
        // carrying the passthrough bucket, since an empty metadata block is no
        // reason to drop the source document's foreign fields (#2233).
        guard !metaAttrs.isEmpty || !metaBlocks.isEmpty else {
            return serialize(model: model, culling: culling, passthrough: passthrough)
        }

        // Build the full attr list: adjustment+culling attrs first, then
        // metadata attrs (values escaped for XML attribute context), then the
        // passthrough attributes. The canonical sort reorders all of them.
        let attrs = _buildAttrs(model: model, culling: culling)
            + metaAttrs.map { ($0.0, escapeXMLAttr($0.1)) }
            + _passthroughAttrs(passthrough)

        // Keywords block (dc:subject), shared with the base serializer.
        let keywordsBlock = _buildKeywordsBlock(culling: culling)

        // Namespace declarations for metadata prefixes, in the same fixed
        // order the TS serializer uses: dc, exif, photoshop, Iptc4xmpCore,
        // xmpRights. `dc` is also required by the keyword bag, so the union of
        // the two needs is taken before the lookup.
        let nsOrder = ["dc", "exif", "photoshop", "Iptc4xmpCore", "xmpRights"]
        let neededPrefixes = culling.keywords.isEmpty ? prefixes : prefixes.union(["dc"])
        let extraNamespaces = nsOrder
            .filter { neededPrefixes.contains($0) }
            .compactMap { p -> (prefix: String, uri: String)? in
                guard let uri = xmpMetadataNamespaces[p] else { return nil }
                return (prefix: p, uri: uri)
            }

        // Nested content, in the canonical child order the TS serializer also
        // uses: dc:title / dc:creator / dc:description, then the keyword bag,
        // then dc:rights / xmpRights:UsageTerms, then the point tone curves.
        // A metadata-carrying save must not drop an authored curve — that is
        // exactly the silent-data-loss shape #2191 fixed for the parametric
        // scalars.
        let toneCurvesBlock = _buildToneCurvesBlock(
            model: model, indent: XMPCanonical.childIndent)
        let isRightsBlock: (String) -> Bool = { block in
            block.contains("<dc:rights>") || block.contains("<xmpRights:UsageTerms>")
        }
        let children = [
            metaBlocks.filter { !isRightsBlock($0) }.joined(separator: "\n"),
            keywordsBlock,
            metaBlocks.filter(isRightsBlock).joined(separator: "\n"),
            toneCurvesBlock,
            _passthroughNodesBlock(passthrough, indent: XMPCanonical.childIndent),
        ]
        .filter { !$0.isEmpty }
        .joined(separator: "\n")

        return XMPCanonical.document(
            extraNamespaces: extraNamespaces,
            attributes: attrs,
            children: children)
    }

    /// Attribute value escaping (mirrors `_escapeAttr` in the TS serializer).
    static func escapeXMLAttr(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
