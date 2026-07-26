// XMPSerialization+VideoWrite.swift — metadata-only serializer for video assets.
//
// Split from XMPSerialization.swift to stay under the 600-LOC hard budget.
// Batch Metadata M6 (#1638).

import Foundation

// MARK: - serializeMetadataOnly

extension XMPSerializer {
    /// Produces a metadata-only XMP sidecar with no Camera Raw Settings (`crs:`) attributes.
    ///
    /// Use for video assets that have no `AdjustmentModel` — emitting a `crs:` block
    /// for a video is nonsensical and risks confusion. Mirrors the TypeScript
    /// `METADATA_ONLY_STUB_XMP` / `metadataOnly: true` path in
    /// `src/api/src/xmp/metadata-serializer.ts`.
    ///
    /// The envelope is the canonical one (#1577), so a video sidecar has the
    /// same shape as a photo sidecar minus the develop attributes. The three
    /// core namespace declarations ride along unused, as they do everywhere
    /// else — they are structural, not payload, and no parser resolves them.
    public static func serializeMetadataOnly(metadata: XmpMetadata) -> String {
        let metaAttrs = metadataAttrParts(metadata).map { ($0.0, escapeXMLAttr($0.1)) }
        let metaBlocks = metadataNestedBlocks(metadata)
        let prefixes = metadataNamespacePrefixes(metadata)

        let nsOrder = ["dc", "exif", "photoshop", "Iptc4xmpCore", "xmpRights"]
        let extraNamespaces = nsOrder
            .filter { prefixes.contains($0) }
            .compactMap { p -> (prefix: String, uri: String)? in
                guard let uri = xmpMetadataNamespaces[p] else { return nil }
                return (prefix: p, uri: uri)
            }

        return XMPCanonical.document(
            extraNamespaces: extraNamespaces,
            attributes: metaAttrs,
            children: metaBlocks.joined(separator: "\n"))
    }
}
