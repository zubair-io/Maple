// XMPSerialization+Canonical.swift — the canonical sidecar document shape
// (#1577).
//
// `docs/xmp-canonical-format.md` is the prose contract; this file is its
// Swift implementation and `xmp-canonical.ts` is the TypeScript one. The two
// are written to emit the same bytes for the same attribute list, which is
// what the cross-engine zero-diff test (`XMPCanonicalFormatTests` here,
// `xmp-canonical.spec.ts` on the web) pins.
//
// Namespace URI note (#1577): the `papp:` prefix — not the URI it is bound
// to — is the discriminator every Maple parser keys on. raw-core's
// `xmp::parse` matches attribute names byte-wise (`papp:Profile`), this
// module's `XMLParser` runs with namespace processing OFF so `attributeDict`
// is keyed on qualified names, and the TypeScript parser compares
// `attr.name`, which is also a qualified name. None of the three ever
// resolves a namespace URI, so moving Swift onto the TypeScript/API URI
// leaves every sidecar already on disk parsing exactly as before.

import Foundation

// MARK: - Canonical document

/// Envelope, indentation, namespace prelude and attribute ordering for a
/// Maple sidecar. Deliberately a plain namespace of statics rather than a
/// configurable writer: there is exactly one canonical form.
enum XMPCanonical {
    /// Canonical `papp:` namespace URI — see the file header.
    static let pappNamespaceURI = "http://ns.justmaple.app/photo/1.0/"

    /// Namespace declarations emitted on every `rdf:Description`, in this
    /// exact order, whether or not the payload uses them. They are
    /// structural: a fixed prelude keeps the head of every sidecar
    /// byte-stable.
    static let coreNamespaces: [(prefix: String, uri: String)] = [
        ("xmp", "http://ns.adobe.com/xap/1.0/"),
        ("crs", "http://ns.adobe.com/camera-raw-settings/1.0/"),
        ("papp", pappNamespaceURI),
    ]

    /// Indent of `rdf:Description`'s attributes, namespace declarations and
    /// children. Nested element children step two further spaces per level.
    static let childIndent = "      "

    /// Sort rank per namespace prefix. Ranks the three core namespaces first
    /// (the develop settings a reader cares about), then the metadata
    /// namespaces in the order they are declared, then everything else —
    /// unknown passthrough attributes, which sort last so an imported
    /// sidecar's foreign attributes stay out of the middle of Maple's block.
    private static let namespacePriority: [String: Int] = [
        "xmp": 0,
        "crs": 1,
        "papp": 2,
        "dc": 3,
        "exif": 4,
        "photoshop": 5,
        "Iptc4xmpCore": 6,
        "xmpRights": 7,
    ]

    private static let unknownNamespacePriority = 500

    private static func priority(of name: String) -> Int {
        guard let colon = name.firstIndex(of: ":") else { return unknownNamespacePriority }
        return namespacePriority[String(name[name.startIndex..<colon])] ?? unknownNamespacePriority
    }

    /// Order attributes canonically: namespace priority first, then
    /// alphabetically by fully-qualified name within each namespace.
    ///
    /// Attribute names are XML NCNames drawn from the schema plus whatever a
    /// foreign sidecar carried, so the alphabetical tiebreak is a plain string
    /// comparison; every name Maple or Adobe writes is ASCII, where Swift's
    /// ordering and JavaScript's code-unit ordering agree.
    static func sorted(_ attrs: [(String, String)]) -> [(String, String)] {
        attrs.sorted { lhs, rhs in
            let lp = priority(of: lhs.0)
            let rp = priority(of: rhs.0)
            return lp == rp ? lhs.0 < rhs.0 : lp < rp
        }
    }

    /// Assemble the canonical sidecar document.
    ///
    /// `extraNamespaces` are the conditional declarations (metadata prefixes,
    /// `dc` for the keyword bag) appended after the three core ones in the
    /// caller's fixed order. `attributes` are sorted here so no caller can
    /// forget. `children` is the already-indented nested-element body, or the
    /// empty string for the self-closing form.
    static func document(
        extraNamespaces: [(prefix: String, uri: String)],
        attributes: [(String, String)],
        children: String
    ) -> String {
        let nsLines = (coreNamespaces + extraNamespaces).map {
            "\(childIndent)xmlns:\($0.prefix)=\"\($0.uri)\""
        }
        let attrLines = sorted(attributes).map { "\(childIndent)\($0.0)=\"\($0.1)\"" }
        let head = (nsLines + attrLines).joined(separator: "\n")
        let body = children.isEmpty ? "/>" : ">\n\(children)\n    </rdf:Description>"

        return """
        <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description rdf:about=""
        \(head)\(body)
          </rdf:RDF>
        </x:xmpmeta>
        <?xpacket end="w"?>
        """
    }
}
