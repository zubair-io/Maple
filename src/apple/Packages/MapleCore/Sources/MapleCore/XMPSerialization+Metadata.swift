// XMPSerialization+Metadata.swift — XmpMetadata struct + GPS/altitude encoders +
// serialization and parsing helpers for the Batch Metadata field set.
// (Spec 2026-06-26-batch-metadata-editor-design.md, ticket #1581 / epic #1575.)
//
// Parity contract: semantic parity with the TypeScript `xmp-metadata.ts` reference
// implementation — same field set, same value semantics, same GPS/altitude encoding
// rules. Output is per-platform byte-stable (serialize → parse → serialize is
// idempotent on Apple), but cross-platform byte-identical output is out of scope
// (tracked as debt #1577).
//
// GPS encoding mirrors `gpsToXmp` / `gpsFromXmp` in the TS canonical source.
// Key edge cases reproduced here:
//  · Zero magnitude (±0) always maps to the positive hemisphere (N / E) so that
//    `+0` and `-0` can never flip N↔S or E↔W on round-trip.
//  · When `abs(value) * 60 * 1e4` rounds to an exact multiple of 60 (degree-boundary
//    carry), `deg` increments and `min` becomes 0 — the encoder never emits 60.0000
//    as a minutes value (which would be invalid XMP).

import Foundation

// MARK: - XmpMetadata

/// User-authored capture/IPTC metadata persisted to the XMP sidecar
/// (Batch Metadata, spec 2026-06-26). All fields optional; `nil` means
/// "not set" and emits nothing. Values are in native units (signed decimal
/// degrees, ISO-8601 datetime with offset, plain strings) — the standard-XMP
/// text encodings are handled by the serialization helpers below.
///
/// Mirrors the TypeScript `XmpMetadata` interface in `xmp.types.ts`.
public struct XmpMetadata: Equatable {
    public var gpsLatitude: Double?
    public var gpsLongitude: Double?
    public var gpsAltitude: Double?
    public var dateTimeOriginal: String?
    public var timeZone: String?
    public var sublocation: String?
    public var city: String?
    public var state: String?
    public var country: String?
    public var countryCode: String?
    public var title: String?
    public var caption: String?
    public var headline: String?
    public var instructions: String?
    public var creator: String?
    public var creatorJobTitle: String?
    public var copyrightNotice: String?
    public var copyrightStatus: CopyrightStatus?
    public var usageTerms: String?
    public var credit: String?
    public var source: String?

    public init() {}
}

/// Copyright status (`xmpRights:Marked`): tri-state.
/// `.unknown` omits the attribute entirely.
/// Mirrors the TypeScript `CopyrightStatus` type in `xmp.types.ts`.
public enum CopyrightStatus: String, Equatable {
    case unknown
    case copyrighted
    case publicDomain = "public-domain"
}

// MARK: - GPS encoding

/// Axis selector for GPS encoding (picks the N/S vs E/W hemisphere suffix).
public enum GpsAxis { case lat, lon }

/// Encode a signed decimal degree to the Adobe XMP `exif:GPSLatitude/Longitude`
/// form: `DDD,MM.mmmm{N|S|E|W}` (degrees, decimal-minutes, hemisphere). Minutes
/// are formatted to 4 decimal places — Lightroom's precision (~2 cm).
///
/// Round-trip-stable by construction: minutes are rounded to 4dp *first* so a
/// value within rounding distance of a degree boundary carries into the degrees
/// (never emits the invalid `89,60.0000`), and a magnitude that rounds to zero
/// always takes the positive hemisphere so `+0`/`-0` can't flip N/S↔E/W.
///
/// Mirrors `gpsToXmp` in `xmp-metadata.ts`.
public func gpsToXmp(_ value: Double, axis: GpsAxis) -> String {
    let absValue = value < 0 ? -value : value
    let roundedMinutes = (absValue * 60 * 1e4).rounded() / 1e4
    let deg = Int(floor(roundedMinutes / 60))
    let rawMin = roundedMinutes - Double(deg) * 60
    // Normalize -0.0 to 0.0 so String(format:) never emits "-0.0000".
    let min = rawMin == 0 ? 0.0 : rawMin
    let positive = roundedMinutes == 0 ? true : (value >= 0)
    let hemi: String
    switch axis {
    case .lat: hemi = positive ? "N" : "S"
    case .lon: hemi = positive ? "E" : "W"
    }
    return "\(deg),\(String(format: "%.4f", min))\(hemi)"
}

/// Decode an `exif:GPSLatitude/Longitude` string back to signed decimal degrees.
/// Accepts `DDD,MM.mmmm{N|S|E|W}`. Returns `nil` if the string does not match.
/// Normalizes `-0` to `0` so a zero-magnitude coordinate can't flip hemisphere
/// on the next encode.
///
/// Mirrors `gpsFromXmp` in `xmp-metadata.ts`.
public func gpsFromXmp(_ s: String) -> Double? {
    // Match: digits, comma, digits with optional decimal, hemisphere letter.
    let pattern = try? NSRegularExpression(pattern: #"^(\d+),(\d+(?:\.\d+)?)([NSEW])$"#)
    let trimmed = s.trimmingCharacters(in: .whitespaces)
    guard let m = pattern?.firstMatch(
        in: trimmed,
        range: NSRange(trimmed.startIndex..., in: trimmed)
    ) else { return nil }
    guard
        let degRange = Range(m.range(at: 1), in: trimmed),
        let minRange = Range(m.range(at: 2), in: trimmed),
        let hemiRange = Range(m.range(at: 3), in: trimmed),
        let deg = Double(trimmed[degRange]),
        let min = Double(trimmed[minRange])
    else { return nil }
    let hemi = String(trimmed[hemiRange])
    let sign: Double = (hemi == "S" || hemi == "W") ? -1 : 1
    let result = sign * (deg + min / 60)
    return result == 0 ? 0 : result  // normalize -0
}

// MARK: - Altitude encoding

/// Encode signed meters as a `/1000` rational + altitude-ref flag.
/// Returns `(value: String, ref: String)` where ref is "0" (above sea level)
/// or "1" (below sea level). Mirrors `altitudeToXmp` in `xmp-metadata.ts`.
public func altitudeToXmp(_ meters: Double) -> (value: String, ref: String) {
    let ref = meters < 0 ? "1" : "0"
    let absMeters = meters < 0 ? -meters : meters
    let thousandths = Int((absMeters * 1000).rounded())
    return ("\(thousandths)/1000", ref)
}

/// Decode an altitude rational + ref back to signed meters; `nil` if malformed.
/// Accepts only the canonical `\d+/\d+` form (non-negative integers on both
/// sides, no decimal point, no sign) — matching the TS `altitudeFromXmp`
/// regex `^(\d+)\/(\d+)$`. The sign is encoded in `ref`: "0" = above sea
/// level, "1" = below. `altitudeToXmp` always emits this canonical form.
/// Mirrors `altitudeFromXmp` in `xmp-metadata.ts`.
public func altitudeFromXmp(value: String, ref: String) -> Double? {
    let pattern = try? NSRegularExpression(pattern: #"^(\d+)\/(\d+)$"#)
    let trimmed = value.trimmingCharacters(in: .whitespaces)
    guard let m = pattern?.firstMatch(
        in: trimmed,
        range: NSRange(trimmed.startIndex..., in: trimmed)
    ) else { return nil }
    guard
        let numRange = Range(m.range(at: 1), in: trimmed),
        let denRange = Range(m.range(at: 2), in: trimmed),
        let numerator = Double(trimmed[numRange]),
        let denominator = Double(trimmed[denRange]),
        denominator != 0
    else { return nil }
    let meters = numerator / denominator
    return ref == "1" ? -meters : meters
}

// MARK: - Namespace declarations

/// Namespace URI keyed by prefix — only declared when used.
/// Mirrors `METADATA_NAMESPACES` in `xmp-metadata.ts`.
public let xmpMetadataNamespaces: [String: String] = [
    "dc":           "http://purl.org/dc/elements/1.1/",
    "exif":         "http://ns.adobe.com/exif/1.0/",
    "photoshop":    "http://ns.adobe.com/photoshop/1.0/",
    "Iptc4xmpCore": "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/",
    "xmpRights":    "http://ns.adobe.com/xap/1.0/rights/",
]

// MARK: - Metadata serialization helpers (extension on XMPSerializer)

extension XMPSerializer {

    /// Build the ordered list of simple-attribute `key="value"` pairs for the
    /// metadata block. Order is fixed for per-platform byte-stability.
    /// Mirrors `metadataAttrParts` in `xmp-metadata.ts`.
    static func metadataAttrParts(_ m: XmpMetadata) -> [(String, String)] {
        var parts: [(String, String)] = []
        let push = { (key: String, value: String) in parts.append((key, value)) }

        if let lat = m.gpsLatitude { push("exif:GPSLatitude", gpsToXmp(lat, axis: .lat)) }
        if let lon = m.gpsLongitude { push("exif:GPSLongitude", gpsToXmp(lon, axis: .lon)) }
        if let alt = m.gpsAltitude {
            let (v, r) = altitudeToXmp(alt)
            push("exif:GPSAltitude", v)
            push("exif:GPSAltitudeRef", r)
        }
        if let v = m.dateTimeOriginal, !v.isEmpty { push("exif:DateTimeOriginal", v) }
        if let v = m.timeZone, !v.isEmpty { push("papp:TimeZone", v) }
        if let v = m.sublocation, !v.isEmpty { push("Iptc4xmpCore:Location", v) }
        if let v = m.city, !v.isEmpty { push("photoshop:City", v) }
        if let v = m.state, !v.isEmpty { push("photoshop:State", v) }
        if let v = m.country, !v.isEmpty { push("photoshop:Country", v) }
        if let v = m.countryCode, !v.isEmpty { push("Iptc4xmpCore:CountryCode", v) }
        if let v = m.headline, !v.isEmpty { push("photoshop:Headline", v) }
        if let v = m.instructions, !v.isEmpty { push("photoshop:Instructions", v) }
        if let v = m.creatorJobTitle, !v.isEmpty { push("photoshop:AuthorsPosition", v) }
        if let v = m.credit, !v.isEmpty { push("photoshop:Credit", v) }
        if let v = m.source, !v.isEmpty { push("photoshop:Source", v) }
        if let status = m.copyrightStatus {
            switch status {
            case .copyrighted:  push("xmpRights:Marked", "True")
            case .publicDomain: push("xmpRights:Marked", "False")
            case .unknown:      break  // omit
            }
        }
        return parts
    }

    /// Build the nested lang-alt/seq element blocks for the metadata, in fixed order:
    /// dc:title, dc:creator, dc:description, dc:rights, xmpRights:UsageTerms.
    /// Mirrors `metadataNestedBlocks` in `xmp-metadata.ts`.
    static func metadataNestedBlocks(_ m: XmpMetadata) -> [String] {
        var blocks: [String] = []
        if let v = m.title, !v.isEmpty { blocks.append(langAltBlock("dc:title", text: v)) }
        if let v = m.creator, !v.isEmpty { blocks.append(seqBlock("dc:creator", text: v)) }
        if let v = m.caption, !v.isEmpty { blocks.append(langAltBlock("dc:description", text: v)) }
        if let v = m.copyrightNotice, !v.isEmpty { blocks.append(langAltBlock("dc:rights", text: v)) }
        if let v = m.usageTerms, !v.isEmpty { blocks.append(langAltBlock("xmpRights:UsageTerms", text: v)) }
        return blocks
    }

    /// Which namespace prefixes the metadata requires declared on `rdf:Description`.
    /// Mirrors `metadataNamespacePrefixes` in `xmp-metadata.ts`.
    static func metadataNamespacePrefixes(_ m: XmpMetadata) -> Set<String> {
        var used = Set<String>()
        if m.gpsLatitude != nil || m.gpsLongitude != nil || m.gpsAltitude != nil
            || (m.dateTimeOriginal.map { !$0.isEmpty } ?? false) {
            used.insert("exif")
        }
        if [m.city, m.state, m.country, m.headline, m.instructions, m.creatorJobTitle,
            m.credit, m.source].contains(where: { $0.map { !$0.isEmpty } ?? false }) {
            used.insert("photoshop")
        }
        if [m.sublocation, m.countryCode].contains(where: { $0.map { !$0.isEmpty } ?? false }) {
            used.insert("Iptc4xmpCore")
        }
        if [m.title, m.creator, m.caption, m.copyrightNotice].contains(where: { $0.map { !$0.isEmpty } ?? false }) {
            used.insert("dc")
        }
        if m.usageTerms.map({ !$0.isEmpty }) ?? false {
            used.insert("xmpRights")
        }
        if let status = m.copyrightStatus, status != .unknown {
            used.insert("xmpRights")
        }
        return used
    }

    // MARK: - Private block builders

    /// Build a lang-alt nested element:
    ///   `<prefix:Name><rdf:Alt><rdf:li xml:lang="x-default">text</rdf:li></rdf:Alt></prefix:Name>`
    /// Mirrors `langAltBlock` in `xmp-metadata.ts`.
    private static func langAltBlock(_ qname: String, text: String) -> String {
        let escaped = escapeXMLText(text)
        return """
          <\(qname)>
           <rdf:Alt>
            <rdf:li xml:lang="x-default">\(escaped)</rdf:li>
           </rdf:Alt>
          </\(qname)>
        """
    }

    /// Build an `rdf:Seq` nested element holding a single entry (v1 single-creator).
    /// Mirrors `seqBlock` in `xmp-metadata.ts`.
    private static func seqBlock(_ qname: String, text: String) -> String {
        let escaped = escapeXMLText(text)
        return """
          <\(qname)>
           <rdf:Seq>
            <rdf:li>\(escaped)</rdf:li>
           </rdf:Seq>
          </\(qname)>
        """
    }
}

// MARK: - XMPParser metadata extension

extension XMPParser {

    /// Parse the IPTC/EXIF metadata block from an XMP sidecar string.
    /// Returns only the fields that are present and non-empty; absent or
    /// whitespace-only fields are left nil in the returned struct.
    ///
    /// Mirrors `XmpParserService.parseMetadata()` in `xmp-parser.service.ts`.
    public static func parseMetadata(_ xml: String) -> XmpMetadata {
        var result = XmpMetadata()
        let delegate = _XMPMetadataDelegate()
        let parser = XMLParser(data: Data(xml.utf8))
        parser.delegate = delegate
        _ = parser.parse()
        result = delegate.metadata
        return result
    }
}

// MARK: - Private metadata parser delegate

/// Private delegate that collects XmpMetadata fields from an XMP sidecar.
/// Handles both simple attributes (on `rdf:Description`) and nested
/// lang-alt/seq elements (dc:title, dc:creator, dc:description, dc:rights,
/// xmpRights:UsageTerms).
final class _XMPMetadataDelegate: NSObject, XMLParserDelegate {
    var metadata = XmpMetadata()

    // --- Nested element tracking ---
    /// The qualified name of the lang-alt/seq element we're currently inside,
    /// or nil when outside all managed nested elements.
    private var inNestedElement: String? = nil
    /// Are we inside an rdf:li child of the active nested element?
    private var inLi: Bool = false
    /// Accumulated text for the current rdf:li.
    private var liText: String = ""
    /// Have we already captured the first rdf:li for this element?
    private var liCaptured: Bool = false

    /// Managed nested element qualified names that are tracked as lang-alt/seq
    /// containers. Uses a prefix-aware match: "dc:title", "dc:creator", etc.
    /// NOT `rdf:Description` even though its local name is "Description".
    private static let managedNestedQNames: Set<String> = [
        "dc:title", "dc:creator", "dc:description", "dc:rights",
        "xmpRights:UsageTerms",
    ]

    func parser(_ parser: XMLParser,
                didStartElement elementName: String,
                namespaceURI: String?,
                qualifiedName qName: String?,
                attributes attributeDict: [String: String]) {
        let qual = qName ?? elementName

        // If we're inside a managed nested element, look for rdf:li.
        if inNestedElement != nil {
            if _XMPMetadataDelegate.isLocalName(qual, "li") {
                inLi = true
                liText = ""
            }
            return
        }

        // Check if this element is one of the managed nested elements.
        // We match on the full qualified name to avoid confusing rdf:Description
        // (local name = "Description") with dc:description.
        if _XMPMetadataDelegate.managedNestedQNames.contains(qual) {
            inNestedElement = qual
            liCaptured = false
            return
        }

        // Otherwise it's rdf:Description (or rdf:RDF, x:xmpmeta, etc.) — read
        // simple attributes. Only rdf:Description carries the metadata attrs.
        for (rawKey, value) in attributeDict {
            applyAttr(key: rawKey, value: value)
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        guard inLi else { return }
        liText += string
    }

    func parser(_ parser: XMLParser,
                didEndElement elementName: String,
                namespaceURI: String?,
                qualifiedName qName: String?) {
        let qual = qName ?? elementName

        guard let active = inNestedElement else { return }

        if _XMPMetadataDelegate.isLocalName(qual, "li") {
            // Capture only the first rdf:li (x-default) per element.
            if !liCaptured {
                let trimmed = liText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    applyNestedText(element: active, text: trimmed)
                    liCaptured = true
                }
            }
            inLi = false
            liText = ""
        } else if qual == active {
            // Closing tag for the managed nested element.
            inNestedElement = nil
        }
    }

    // MARK: - Private helpers

    private func applyAttr(key: String, value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        switch key {
        case "exif:GPSLatitude":
            metadata.gpsLatitude = gpsFromXmp(trimmed)
        case "exif:GPSLongitude":
            metadata.gpsLongitude = gpsFromXmp(trimmed)
        case "exif:GPSAltitude":
            // Defer: ref may come before or after; we'll resolve in didEndElement.
            // We read ref below too, and altitudeFromXmp needs both.
            // Store the raw value string temporarily.
            pendingAltitudeValue = trimmed
            resolveAltitudeIfReady()
        case "exif:GPSAltitudeRef":
            pendingAltitudeRef = trimmed
            resolveAltitudeIfReady()
        case "exif:DateTimeOriginal":
            metadata.dateTimeOriginal = trimmed
        case "papp:TimeZone":
            metadata.timeZone = trimmed
        case "Iptc4xmpCore:Location":
            metadata.sublocation = trimmed
        case "photoshop:City":
            metadata.city = trimmed
        case "photoshop:State":
            metadata.state = trimmed
        case "photoshop:Country":
            metadata.country = trimmed
        case "Iptc4xmpCore:CountryCode":
            metadata.countryCode = trimmed
        case "photoshop:Headline":
            metadata.headline = trimmed
        case "photoshop:Instructions":
            metadata.instructions = trimmed
        case "photoshop:AuthorsPosition":
            metadata.creatorJobTitle = trimmed
        case "photoshop:Credit":
            metadata.credit = trimmed
        case "photoshop:Source":
            metadata.source = trimmed
        case "xmpRights:Marked":
            switch trimmed {
            case "True":  metadata.copyrightStatus = .copyrighted
            case "False": metadata.copyrightStatus = .publicDomain
            default:      break  // unknown string → leave nil, matching TS copyrightStatusFromMarked null
            }
        default:
            break
        }
    }

    // Altitude deferred resolution: both GPSAltitude and GPSAltitudeRef may
    // arrive in either order as XML attributes on the same element.
    private var pendingAltitudeValue: String? = nil
    private var pendingAltitudeRef: String = "0"

    private func resolveAltitudeIfReady() {
        guard let v = pendingAltitudeValue else { return }
        if let meters = altitudeFromXmp(value: v, ref: pendingAltitudeRef) {
            metadata.gpsAltitude = meters
        }
    }

    private func applyNestedText(element: String, text: String) {
        switch element {
        case "dc:title":           metadata.title = text
        case "dc:creator":         metadata.creator = text
        case "dc:description":     metadata.caption = text
        case "dc:rights":          metadata.copyrightNotice = text
        case "xmpRights:UsageTerms": metadata.usageTerms = text
        default: break
        }
    }

    /// Extract the local name from a qualified name (after the colon).
    private func localName(of qual: String) -> String {
        if let colonIdx = qual.firstIndex(of: ":") {
            return String(qual[qual.index(after: colonIdx)...])
        }
        return qual
    }

    /// True if `qual` ends with `:<local>` or equals `local` (prefix-agnostic).
    private static func isLocalName(_ qual: String, _ local: String) -> Bool {
        qual == local || qual.hasSuffix(":" + local)
    }
}
