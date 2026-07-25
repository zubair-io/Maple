// XMPSerialization.swift — pure-Swift XMP parser + serializer for
// `(AdjustmentModel, CullingState)`. Split out of `AdjustmentModel.swift`
// in #632 once the additional `dc:subject` handling pushed the file past
// the 600-line hard budget (see `CONTRIBUTING.md` / `tools/budget-allowlist.txt`).
//
// This file is the single owner of the XMP wire format. The parallel split
// from #643 (`AdjustmentModel+XMP.swift`) was a duplicate created by a
// concurrent branch and was folded back in here — it now owns the S5
// effects keys (vignette / grain / split-tone) alongside the `dc:subject`
// keyword bag.
//
// Read the file header on `AdjustmentModel.swift` first — that's the
// type contract. This file owns the on-disk byte format:
//   • `XMPParser.parse(xml: String)` → `(AdjustmentModel, CullingState)`
//   • `XMPSerializer.serialize(model:culling:)` → `String`
//
// Both sides round-trip semantically with the Rust `raw_core::xmp`
// module and the TypeScript `XmpParserService` / `XmpSerializerService`
// — same fields, same value semantics, same legacy-alias precedence.
// The output is *not* byte-canonical: attribute ordering, the `papp:`
// namespace URI, and whitespace around the `rdf:Description` differ
// across the three serializers (TS calls this out in its own header,
// Rust ships only a fragment serializer). The canonical-form ticket is
// still open. When you add a new `crs:` or `papp:` attribute, mirror
// it in all three.

import Foundation

// MARK: - XMPParser

/// Pure-Swift XMP parser for `crs:` attributes. Reads the same attribute names as the Rust
/// `raw_core::xmp::parse()` function. Unknown attributes are silently ignored.
public struct XMPParser {
    private init() {}

    public static func parse(_ xml: String) throws -> (AdjustmentModel, CullingState) {
        var m = AdjustmentModel()
        var c = CullingState()
        let parser = XMLParser(data: Data(xml.utf8))
        let delegate = _XMPParserDelegate(model: m, culling: c)
        parser.delegate = delegate
        guard parser.parse() else {
            let err = parser.parserError?.localizedDescription ?? "unknown XML error"
            throw XMPError.parseError(err)
        }
        m = delegate.model
        c = delegate.culling
        // WB scale versioning (#1780/#1875/#1893/#1894), resolved at
        // document level: an explicit `papp:WbScaleVersion` stamp wins;
        // otherwise a document carrying the Maple `papp:` namespace AND an
        // explicit authored `crs:Temperature`/`crs:Tint` predates the
        // versioning (pre-#1756 scale, 1). Everything else — no `papp:`
        // namespace (ACR/Lightroom-authored, expressed in ACR's own
        // Robertson convention, which V5 matches exactly) or no authored WB
        // (nothing to convert) — is 5. Mirrors raw-core's `xmp::parse`.
        let unstampedIsV1 = delegate.sawPappNamespace && delegate.sawExplicitWb
        let version = delegate.wbScaleStamp ?? (unstampedIsV1 ? 1 : 5)
        // V2/V3/V4 → V5 load-normalization (#1894 Robertson mapping): the
        // legacy scales (Hernández-Andrés daylight locus, at either the
        // legacy 1e-4 uv-per-unit magnitude for V1/V2/V3 or ACR's kTintScale
        // magnitude for V4) evaluate a different locus than V5's Robertson
        // isotherms — so re-expressing an authored pair means converting
        // the PAIR jointly through physical chromaticity
        // (`WbDngTemperature.authoredPairToV5`), not a tint-only magnitude
        // rescale. Even a temperature-only authored value moves slightly in
        // both components (the two loci diverge), so this is gated on
        // `sawExplicitWb` (temperature OR tint authored), not tint alone.
        // Converting at load keeps the in-memory model (slider display, FFI
        // live params, autosave) uniformly V5 while preserving the
        // authored look. V1 deliberately does NOT load-normalize: its
        // conversion needs the image's calibration frame, so raw-core
        // converts it at develop and the sidecar round-trips as V1.
        if version == 2 || version == 3 || version == 4 {
            if delegate.sawExplicitWb {
                let (t, ti) = WbDngTemperature.authoredPairToV5(
                    temperature: m.temperature, tint: m.tint, version: version)
                m.temperature = t
                m.tint = ti
            }
            m.wbScaleVersion = 5
        } else {
            m.wbScaleVersion = version
        }
        return (m, c)
    }

    public static func parse(data: Data) throws -> (AdjustmentModel, CullingState) {
        guard let xml = String(data: data, encoding: .utf8) else {
            throw XMPError.notUTF8
        }
        return try parse(xml)
    }
}

public enum XMPError: Error, LocalizedError {
    case parseError(String)
    case notUTF8

    public var errorDescription: String? {
        switch self {
        case .parseError(let msg): return "XMP parse error: \(msg)"
        case .notUTF8: return "XMP sidecar is not valid UTF-8"
        }
    }
}

// MARK: - XMLParser delegate (module-internal)

/// Module-internal rather than file-private so the `rdf:Description`
/// attribute switch can live in `XMPSerialization+ParseAttrs.swift` — a
/// file-budget split, not a widening of the API. The leading underscore
/// marks it as an implementation detail of the XMP layer.
final class _XMPParserDelegate: NSObject, XMLParserDelegate {
    var model: AdjustmentModel
    var culling: CullingState
    /// Tracks whether the canonical `papp:CaptureSharpeningSigma` attribute
    /// has been applied during this element so the legacy
    /// `papp:CaptureSharpeningRadius` alias never overrides it. Swift
    /// dictionary iteration order is undefined; matches the Rust parser's
    /// `sigma_seen` precedence (PR #463).
    var captureSharpeningSigmaSeen: Bool = false
    /// Tracks whether the canonical `papp:Profile` attribute has been
    /// applied during this element so the legacy `papp:Look` migration
    /// never clobbers it. Mirrors raw-core's `profile_seen` precedence
    /// (ticket #536).
    var profileSeen: Bool = false
    /// Tracks whether the canonical `papp:Flag` attribute has been applied
    /// so the legacy `xmp:Label` cull-flag alias never overrides it (#2221).
    /// Same precedence shape as the two flags above.
    var cullFlagSeen: Bool = false
    /// Document-level WB-scale authorship state (#1780): whether ANY
    /// element carried the Maple `papp:` namespace (declaration or
    /// attribute), and the explicit `papp:WbScaleVersion` stamp when one
    /// is present. Resolved into `model.wbScaleVersion` by
    /// `XMPParser.parse` after the walk; mirrors raw-core's `xmp::parse`.
    var sawPappNamespace: Bool = false
    var sawExplicitWb: Bool = false
    var wbScaleStamp: Int? = nil

    /// `dc:subject` is the only XMP element that isn't an attribute on
    /// `rdf:Description` — it's a nested bag of `rdf:li` children:
    ///
    ///   <dc:subject><rdf:Bag><rdf:li>kw</rdf:li>…</rdf:Bag></dc:subject>
    ///
    /// `inDCSubject` flips on while the parser is inside that subtree;
    /// `currentLi` accumulates the running text content of the active
    /// `rdf:li` element (XMLParser may deliver characters in multiple
    /// chunks for long text, so we concatenate until `didEndElement`).
    /// Duplicates are dropped during accumulation so the parse output
    /// matches `EditSession.setKeywords`'s "unique, first-occurrence wins"
    /// invariant — necessary because callers (e.g. `KeywordChipsRow`)
    /// iterate `culling.keywords` with `ForEach(id: \.self)`.
    var inDCSubject: Bool = false
    var currentLi: String?
    var parsedKeywords: [String] = []

    /// Point tone curves (#365) — the other nested construct in the schema.
    /// Four `papp:SceneLinearToneCurve*` parents, each wrapping an `rdf:Seq`
    /// of `"x, y"` `rdf:li` leaves. The walk lives in
    /// `XMPSerialization+ToneCurves.swift`; this delegate just feeds it the
    /// element / character events.
    var toneCurves = ToneCurveWalker()

    init(model: AdjustmentModel, culling: CullingState) {
        self.model = model
        self.culling = culling
    }

    func parser(_ parser: XMLParser,
                didStartElement elementName: String,
                namespaceURI: String?,
                qualifiedName qName: String?,
                attributes attributeDict: [String: String]) {
        // dc:subject — nested keyword bag. Enter the subtree on the opening
        // `<dc:subject>` tag; track `<rdf:li>` children inside it. The XML
        // namespace *prefix* the sidecar binds to Dublin Core / RDF isn't
        // stable (any sidecar may rebind `dc` / `rdf` to a different prefix
        // and still be valid), so match on the qName's local-name suffix
        // — `:subject` / `:li` or the bare local name. Namespace processing
        // stays OFF on `XMLParser` because the rest of this delegate keys
        // every attribute lookup on prefixed names (`crs:Temperature` etc.).
        // WB-scale authorship scan (#1780) — runs for EVERY element,
        // before any early return, so nested passthrough elements
        // carrying `papp:` attributes still mark the document as
        // Maple-authored. The stamp itself is also consumed here.
        for key in attributeDict.keys where key == "xmlns:papp" || key.hasPrefix("papp:") {
            sawPappNamespace = true
        }
        if attributeDict["crs:Temperature"] != nil || attributeDict["crs:Tint"] != nil {
            sawExplicitWb = true
        }
        if let stamp = attributeDict["papp:WbScaleVersion"], let v = Int(stamp),
           (1...5).contains(v) {
            wbScaleStamp = v
        }

        let qual = qName ?? elementName
        // Point tone curves (#365). Inside a curve subtree there are no Maple
        // attributes to read, so the whole attribute walk below is skipped.
        if toneCurves.start(qual) {
            return
        }
        if Self.isLocalName(qual, "subject") {
            inDCSubject = true
            parsedKeywords.removeAll(keepingCapacity: true)
            return
        }
        if inDCSubject {
            if Self.isLocalName(qual, "li") {
                currentLi = ""
            }
            // `rdf:Bag` / `rdf:Seq` / `rdf:Alt` wrappers carry no value of
            // their own — only their `rdf:li` children do.
            return
        }

        // Process WhiteBalance preset first so explicit Temperature/Tint can override it.
        if let wb = attributeDict["crs:WhiteBalance"] {
            applyAttribute(key: "crs:WhiteBalance", value: wb)
        }
        // Pre-pass: if the canonical capture-sharpening Sigma attribute is
        // present, apply it before the legacy Radius alias so attribute
        // iteration order can't flip precedence. Mirrors raw-core's
        // `sigma_seen` flag.
        if let sigma = attributeDict["papp:CaptureSharpeningSigma"] {
            applyAttribute(key: "papp:CaptureSharpeningSigma", value: sigma)
        }
        // Pre-pass: if the canonical `papp:Profile` attribute is present,
        // apply it before the `papp:Look` legacy-migration arm so Swift's
        // unordered attribute iteration can't let `Look` overwrite the
        // explicit Profile choice. Mirrors raw-core's `profile_seen` flag.
        if let profile = attributeDict["papp:Profile"] {
            applyAttribute(key: "papp:Profile", value: profile)
        }
        // Pre-pass: the canonical `papp:Flag` cull flag wins over the legacy
        // `xmp:Label` alias regardless of attribute iteration order, so a
        // sidecar carrying both resolves to the canonical value (#2221).
        if let flag = attributeDict["papp:Flag"] {
            applyAttribute(key: "papp:Flag", value: flag)
        }
        // Pre-pass: discover `crs:HasCrop` before applying the rect fields —
        // mirrors raw-core's two-pass crop gate. `crs:CropAngle` is always
        // applied regardless of HasCrop (pure straighten; spec § 01 inv 3).
        let hasCrop: Bool = {
            guard let v = attributeDict["crs:HasCrop"] else { return false }
            return v == "True" || v == "true"
        }()
        for (rawKey, value) in attributeDict
            where rawKey != "crs:WhiteBalance"
                && rawKey != "papp:CaptureSharpeningSigma"
                && rawKey != "papp:Profile"
                && rawKey != "papp:Flag" {
            applyAttribute(key: rawKey, value: value, hasCrop: hasCrop)
        }
        // Reset for the next rdf:Description (defensive — XMP normally
        // carries a single description element, but the parser must remain
        // idempotent across calls).
        captureSharpeningSigmaSeen = false
        profileSeen = false
        cullFlagSeen = false
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        toneCurves.characters(string)
        guard inDCSubject, currentLi != nil else { return }
        currentLi! += string
    }

    func parser(_ parser: XMLParser,
                didEndElement elementName: String,
                namespaceURI: String?,
                qualifiedName qName: String?) {
        let qual = qName ?? elementName
        toneCurves.end(qual, into: &model)
        if inDCSubject {
            if Self.isLocalName(qual, "li"), let text = currentLi {
                // Per IPTC convention keywords are non-empty; drop blanks.
                // Dedupe at parse time so the model/UI invariant of unique
                // keywords (also enforced on the write path by
                // `EditSession.setKeywords`) holds even for hand-edited or
                // foreign sidecars. First occurrence wins so source order
                // is preserved.
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty, !parsedKeywords.contains(trimmed) {
                    parsedKeywords.append(trimmed)
                }
                currentLi = nil
            } else if Self.isLocalName(qual, "subject") {
                culling.keywords = parsedKeywords
                parsedKeywords = []
                inDCSubject = false
            }
        }
    }

    /// True if `qual` matches the namespaced element `local` regardless of
    /// the bound prefix — i.e. either the bare local name or any `*:local`
    /// form. Used so the parser doesn't silently ignore `dc:subject` /
    /// `rdf:li` content when a sidecar binds the namespaces to non-default
    /// prefixes.
    private static func isLocalName(_ qual: String, _ local: String) -> Bool {
        qual == local || qual.hasSuffix(":" + local)
    }
}

// MARK: - XMP Serializer

/// Emit an XMP sidecar string compatible with the `crs:` schema from a model + culling state.
/// Output is semantically round-trippable with Lightroom / Maple Hosted (same fields,
/// same value semantics) but is not byte-canonical — attribute ordering and the
/// `papp:` namespace URI differ across the Apple / Web / Rust serializers today.
public struct XMPSerializer {
    private init() {}

    // MARK: - Internal builders (used by both serialize overloads)


    /// Build the dc:subject keywords block pieces.
    /// Returns `(dcNs, block)` where `dcNs` is the namespace suffix string
    /// (empty or `\n      xmlns:dc=…`) and `block` is the multi-line
    /// `<dc:subject>…</dc:subject>` body (empty string when no keywords).
    static func _buildKeywordsBlock(culling: CullingState) -> (dcNs: String, block: String) {
        guard !culling.keywords.isEmpty else { return ("", "") }
        let dcNs = "\n      xmlns:dc=\"http://purl.org/dc/elements/1.1/\""
        let liItems = culling.keywords
            .map { "          <rdf:li>\(escapeXMLText($0))</rdf:li>" }
            .joined(separator: "\n")
        let block = """

              <dc:subject>
                <rdf:Bag>
            \(liItems)
                </rdf:Bag>
              </dc:subject>
            """
        return (dcNs, block)
    }

    // MARK: - Public serializer

    /// Serialize a full adjustment sidecar. This is the persisted-save entry
    /// point — it always authors white balance. The decode-XMP path that
    /// needs As-Shot omission uses the internal `omitWhiteBalance` overload
    /// below, kept off this public surface so a sidecar-save call site can
    /// never accidentally drop authored WB (#1883, Copilot).
    public static func serialize(model: AdjustmentModel, culling: CullingState) -> String {
        serialize(model: model, culling: culling, omitWhiteBalance: false)
    }

    /// `omitWhiteBalance` (#1883): decode-XMP-only mode — see `_buildAttrs`.
    /// `internal` (no default) so only in-module callers — `RawCoreBridge`'s
    /// decode temp-XMP and the parity test — can request WB omission
    /// intentionally; every persisted save routes through the public two-arg
    /// form above, which always authors WB.
    static func serialize(
        model: AdjustmentModel,
        culling: CullingState,
        omitWhiteBalance: Bool
    ) -> String {
        let attrs = _buildAttrs(model: model, culling: culling, omitWhiteBalance: omitWhiteBalance)
        let attrsStr = attrs.map { "\($0.0)=\"\($0.1)\"" }.joined(separator: "\n        ")
        let (dcNamespace, rawKeywordsBlock) = _buildKeywordsBlock(culling: culling)
        // Point tone curves (#365) — the second nested child block. Children
        // of `rdf:Description` sit at six spaces in this document shape (see
        // `docs/xmp-canonical-format.md` § "Indentation"). Identity curves
        // emit nothing, so a model with no authored curve keeps the
        // pre-#365 bytes exactly.
        let toneCurvesBlock = _buildToneCurvesBlock(
            model: model, indent: "      ")
        // Both blocks carry a leading newline when non-empty so they splice
        // straight after the `rdf:Description` open tag's `>`.
        let keywordsBlock = rawKeywordsBlock
            + (toneCurvesBlock.isEmpty ? "" : "\n" + toneCurvesBlock)

        // Switch between self-closing and open/close `rdf:Description`
        // forms based on whether there's any nested content.
        if keywordsBlock.isEmpty {
            return """
            <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
            <x:xmpmeta xmlns:x="adobe:ns:meta/">
              <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                <rdf:Description
                  xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                  xmlns:xmp="http://ns.adobe.com/xap/1.0/"
                  xmlns:papp="http://ns.justmaple.app/1.0/"
                  \(attrsStr)/>
              </rdf:RDF>
            </x:xmpmeta>
            <?xpacket end="w"?>
            """
        } else {
            return """
            <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
            <x:xmpmeta xmlns:x="adobe:ns:meta/">
              <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                <rdf:Description
                  xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                  xmlns:xmp="http://ns.adobe.com/xap/1.0/"
                  xmlns:papp="http://ns.justmaple.app/1.0/"\(dcNamespace)
                  \(attrsStr)>\(keywordsBlock)
                </rdf:Description>
              </rdf:RDF>
            </x:xmpmeta>
            <?xpacket end="w"?>
            """
        }
    }

    // serialize(model:culling:metadata:) + escapeXMLAttr live in
    // XMPSerialization+MetadataWrite.swift (split out for the 600-LOC budget).
    //
    // fmtF and escapeXMLText are defined in XMPSerialization+Helpers.swift
    // (split out to stay under the 600-LOC hard budget, #1181).
    //
    // serializeMetadataOnly lives in XMPSerialization+VideoWrite.swift (#1638).
}
