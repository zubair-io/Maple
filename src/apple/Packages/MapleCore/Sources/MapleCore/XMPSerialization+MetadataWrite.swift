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
    public static func serialize(
        model: AdjustmentModel,
        culling: CullingState,
        metadata: XmpMetadata
    ) -> String {
        // Reuse the full adjustment+culling attr list by delegating to the
        // internal builder.  We must rebuild rather than string-patch because
        // (a) the base serializer's namespace block is fixed and (b) we need to
        // add conditional namespace declarations cleanly.
        //
        // Call the private internal builder that returns the attrs array so we can
        // append metadata attrs without re-serializing.  Since `serialize` is a
        // large private function, we reproduce the structure here, delegating attr
        // list construction to `_buildAdjustmentAttrs`.
        //
        // Because reproducing the entire attr list is costly to maintain, we take
        // the simpler approach of calling the no-metadata overload to get the base
        // XML and then re-emitting from a known, stable template.  The stable
        // template approach requires knowing the exact structure the base emits —
        // which is stable across invocations.  We use string replacement at well-
        // defined injection points:
        //
        //  · Namespace block: inject after `xmlns:papp="..."` in either form.
        //  · Attrs: inject before the closing `/>` (self-closing) or before `>`
        //    followed by the keyword/nested content block.
        //  · Nested blocks: inject after the attrs `>` and before `</rdf:Description>`.
        //
        // This is a narrow, deterministic patch because the base serializer's
        // output format is tested and stable.

        let metaAttrs = metadataAttrParts(metadata)
        let metaBlocks = metadataNestedBlocks(metadata)
        let prefixes = metadataNamespacePrefixes(metadata)

        // If nothing to add, return the base sidecar unchanged.
        guard !metaAttrs.isEmpty || !metaBlocks.isEmpty else {
            return serialize(model: model, culling: culling)
        }

        // Build namespace declaration snippet for the metadata prefixes.
        // Fixed order mirrors the TS NS_ORDER: dc, exif, photoshop, Iptc4xmpCore, xmpRights.
        let nsOrder = ["dc", "exif", "photoshop", "Iptc4xmpCore", "xmpRights"]
        // Filter out "dc" if the base will already declare it for keywords.
        let hasDcKeywords = !culling.keywords.isEmpty
        let extraNsLines = nsOrder
            .filter { prefixes.contains($0) && !($0 == "dc" && hasDcKeywords) }
            .compactMap { p -> String? in
                guard let uri = xmpMetadataNamespaces[p] else { return nil }
                return "\n      xmlns:\(p)=\"\(uri)\""
            }
            .joined()

        // Build the metadata attribute string (each pair as `key="escaped-value"`).
        let metaAttrLines = metaAttrs
            .map { "\($0.0)=\"\(escapeXMLAttr($0.1))\"" }
            .joined(separator: "\n        ")

        // Build the metadata nested blocks string.
        let metaNestedStr = metaBlocks.joined(separator: "\n")

        // Get the base XML (adjustment + culling, no metadata).
        var xml = serialize(model: model, culling: culling)

        // --- Step 1: inject namespace declarations ---
        // The papp: declaration always appears in the base output.
        let pappMarker = "xmlns:papp=\"http://ns.justmaple.app/1.0/\""
        if !extraNsLines.isEmpty, let r = xml.range(of: pappMarker) {
            xml.insert(contentsOf: extraNsLines, at: r.upperBound)
        }

        // --- Step 2 + 3: inject attrs and nested blocks ---
        //
        // Self-closing form (`/>` with no keywords): `...attrs/>`
        // Keyword-bearing form: `...attrs>\n    <dc:subject>...`
        //
        // Self-closing: replace `/>` with `\n        metaAttrLines\n        />` (or
        // with open form if we have nested blocks).
        if let scRange = xml.range(of: "/>") {
            if metaNestedStr.isEmpty {
                let replacement = "\n        \(metaAttrLines)/>"
                xml.replaceSubrange(scRange, with: replacement)
            } else {
                // Convert self-closing → open/close, inserting attrs + nested.
                let replacement = "\n        \(metaAttrLines)>\n\(metaNestedStr)\n          </rdf:Description>"
                xml.replaceSubrange(scRange, with: replacement)
            }
        } else {
            // Keyword-bearing form: the rdf:Description open-tag ends with `>`
            // immediately followed by the keywordsBlock which starts with `\n  <dc:subject>`.
            // Find that exact `>\n  <dc:subject>` boundary to locate the `>`
            // that closes the rdf:Description opening tag.
            let kwPattern = ">\n  <dc:subject>"
            if let r = xml.range(of: kwPattern) {
                // Insert metadata attrs before the `>` of the opening tag.
                let attrInsertion = "\n        \(metaAttrLines)"
                xml.insert(contentsOf: attrInsertion, at: r.lowerBound)
                // After insertion, find `</rdf:Description>` and insert nested
                // blocks before it.
                if !metaNestedStr.isEmpty {
                    let closer = "\n    </rdf:Description>"
                    if let closerRange = xml.range(of: closer, options: .backwards) {
                        xml.insert(contentsOf: "\n\(metaNestedStr)", at: closerRange.lowerBound)
                    }
                }
            }
        }

        return xml
    }

    /// Attribute value escaping (mirrors `_escapeAttr` in the TS serializer).
    static func escapeXMLAttr(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
