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
    public static func serializeMetadataOnly(metadata: XmpMetadata) -> String {
        let metaAttrs = metadataAttrParts(metadata)
        let metaBlocks = metadataNestedBlocks(metadata)
        let prefixes = metadataNamespacePrefixes(metadata)

        // Build namespace declarations (metadata namespaces only; no crs:).
        // papp: is included when timeZone is set (papp:TimeZone) since
        // metadataNamespacePrefixes does not track the papp prefix.
        let needsPapp = metadata.timeZone.map { !$0.isEmpty } ?? false
        let nsOrder = ["dc", "exif", "photoshop", "Iptc4xmpCore", "xmpRights"]
        var nsLines = nsOrder
            .filter { prefixes.contains($0) }
            .compactMap { p -> String? in
                guard let uri = xmpMetadataNamespaces[p] else { return nil }
                return "      xmlns:\(p)=\"\(uri)\""
            }
        if needsPapp {
            nsLines.insert("      xmlns:papp=\"http://ns.justmaple.app/1.0/\"", at: 0)
        }
        let nsBlock = nsLines.isEmpty ? "" : "\n" + nsLines.joined(separator: "\n")

        let attrsBlock: String
        if metaAttrs.isEmpty {
            attrsBlock = ""
        } else {
            let lines = metaAttrs.map { "\($0.0)=\"\(escapeXMLAttr($0.1))\"" }
            attrsBlock = "\n        " + lines.joined(separator: "\n        ")
        }

        let metaNestedStr = metaBlocks.joined(separator: "\n")

        if metaNestedStr.isEmpty {
            return """
<?xpacket begin='\u{FEFF}' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
  <rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
    <rdf:Description rdf:about=''\(nsBlock)\(attrsBlock)/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>
"""
        } else {
            return """
<?xpacket begin='\u{FEFF}' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
  <rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
    <rdf:Description rdf:about=''\(nsBlock)\(attrsBlock)>
\(metaNestedStr)
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>
"""
        }
    }
}
