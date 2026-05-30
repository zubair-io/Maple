// XMPSerialization.swift — pure-Swift XMP parser + serializer for
// `(AdjustmentModel, CullingState)`. Split out of `AdjustmentModel.swift`
// in #632 once the additional `dc:subject` handling pushed the file past
// the 600-line hard budget (see `CONTRIBUTING.md` / `tools/budget-allowlist.txt`).
//
// Read the file header on `AdjustmentModel.swift` first — that's the
// type contract. This file owns the on-disk byte format:
//   • `XMPParser.parse(xml: String)` → `(AdjustmentModel, CullingState)`
//   • `XMPSerializer.serialize(model:culling:)` → `String`
//
// Both sides match the Rust `raw_core::xmp` module and the TypeScript
// `XmpParserService` / `XmpSerializerService` byte-for-byte (modulo the
// canonical-order ticket that's still open). When you add a new
// `crs:` or `papp:` attribute, mirror it in all three.

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

// MARK: - XMLParser delegate (private)

private final class _XMPParserDelegate: NSObject, XMLParserDelegate {
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

    /// `dc:subject` is the only XMP element that isn't an attribute on
    /// `rdf:Description` — it's a nested bag of `rdf:li` children:
    ///
    ///   <dc:subject><rdf:Bag><rdf:li>kw</rdf:li>…</rdf:Bag></dc:subject>
    ///
    /// `inDCSubject` flips on while the parser is inside that subtree;
    /// `currentLi` accumulates the running text content of the active
    /// `rdf:li` element (XMLParser may deliver characters in multiple
    /// chunks for long text, so we concatenate until `didEndElement`).
    var inDCSubject: Bool = false
    var currentLi: String?
    var parsedKeywords: [String] = []

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
        // `<dc:subject>` tag; track `<rdf:li>` children inside it. Matching
        // is done on the qualified name so the XML namespace prefix the
        // sidecar uses (`dc:`, conventionally) is respected without forcing
        // a specific namespace URI binding.
        let qual = qName ?? elementName
        if qual == "dc:subject" {
            inDCSubject = true
            parsedKeywords.removeAll(keepingCapacity: true)
            return
        }
        if inDCSubject {
            if qual == "rdf:li" {
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
        for (rawKey, value) in attributeDict
            where rawKey != "crs:WhiteBalance"
                && rawKey != "papp:CaptureSharpeningSigma"
                && rawKey != "papp:Profile" {
            applyAttribute(key: rawKey, value: value)
        }
        // Reset for the next rdf:Description (defensive — XMP normally
        // carries a single description element, but the parser must remain
        // idempotent across calls).
        captureSharpeningSigmaSeen = false
        profileSeen = false
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        guard inDCSubject, currentLi != nil else { return }
        currentLi! += string
    }

    func parser(_ parser: XMLParser,
                didEndElement elementName: String,
                namespaceURI: String?,
                qualifiedName qName: String?) {
        let qual = qName ?? elementName
        if inDCSubject {
            if qual == "rdf:li", let text = currentLi {
                // Per IPTC convention keywords are non-empty; drop blanks.
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { parsedKeywords.append(trimmed) }
                currentLi = nil
            } else if qual == "dc:subject" {
                culling.keywords = parsedKeywords
                parsedKeywords = []
                inDCSubject = false
            }
        }
    }

    private func applyAttribute(key: String, value: String) {
        // Strip namespace prefix for matching
        switch key {
        case "crs:Temperature":         model.temperature = d(value) ?? model.temperature
        case "crs:Tint":                model.tint        = d(value) ?? model.tint
        case "crs:Exposure2012":        model.exposure    = d(value) ?? model.exposure
        case "crs:Contrast2012":        model.contrast    = d(value) ?? model.contrast
        case "crs:Highlights2012":      model.highlights  = d(value) ?? model.highlights
        case "crs:Shadows2012":         model.shadows     = d(value) ?? model.shadows
        case "crs:Whites2012":          model.whites      = d(value) ?? model.whites
        case "crs:Blacks2012":          model.blacks      = d(value) ?? model.blacks
        case "crs:Vibrance":            model.vibrance    = d(value) ?? model.vibrance
        case "crs:Saturation":          model.saturation  = d(value) ?? model.saturation
        case "crs:Clarity2012":         model.clarity     = d(value) ?? model.clarity
        case "crs:Texture":             model.texture     = d(value) ?? model.texture
        case "crs:Dehaze":              model.dehaze      = d(value) ?? model.dehaze
        case "crs:Sharpness":           model.sharpenAmount  = d(value) ?? model.sharpenAmount
        case "crs:SharpenRadius":       model.sharpenRadius  = d(value) ?? model.sharpenRadius
        case "crs:SharpenDetail":       model.sharpenDetail  = d(value) ?? model.sharpenDetail
        case "crs:SharpenEdgeMasking":  model.sharpenMasking = d(value) ?? model.sharpenMasking
        case "papp:CaptureSharpeningAmount": model.captureSharpeningAmount = d(value) ?? model.captureSharpeningAmount
        case "papp:CaptureSharpeningSigma":
            if let v = d(value) {
                model.captureSharpeningSigma = v
                captureSharpeningSigmaSeen = true
            }
        case "papp:CaptureSharpeningRadius":
            // Legacy alias kept on the read path only (#456). Routed into
            // `captureSharpeningSigma` unchanged — no rescale, since no
            // shipping sidecar carries a non-zero amount and a rescale
            // would be a guess. Sigma wins when both keys are present.
            if !captureSharpeningSigmaSeen, let v = d(value) {
                model.captureSharpeningSigma = v
            }
        case "crs:LuminanceSmoothing":  model.nrLuminance    = d(value) ?? model.nrLuminance
        case "crs:ColorNoiseReduction": model.nrColor        = d(value) ?? model.nrColor
        case "crs:WhiteBalance":
            if let (t, ti) = wbPreset(value) {
                model.temperature = t
                model.tint = ti
            }
        case "papp:HighlightRecoveryMode":
            // Case-insensitive match against the four canonical PascalCase
            // rawValues. Rust's parser accepts both lowercase and PascalCase
            // forms (and #335's review flagged a parity gap where lowercase
            // `chromaticadaptation` parsed on Rust/Web but silently fell
            // through to the default on Apple). Unknown values keep the
            // current value (default) rather than silently flipping
            // reconstruction off.
            let lowered = value.lowercased()
            let parsed: HighlightRecoveryMode?
            switch lowered {
            case "off":                  parsed = .off
            case "blend":                parsed = .blend
            case "luminance":            parsed = .luminance
            case "chromaticadaptation":  parsed = .chromaticAdaptation
            case "oklabchromareduction": parsed = .oklabChromaReduction
            default:                     parsed = nil
            }
            if let parsed { model.highlightRecovery = parsed }
        case "papp:Look":
            // DisplayLookCurve (#371). Case-insensitive parse mirrors
            // `papp:HighlightRecoveryMode`. Unknown values keep the current
            // value (default = `.default`) — absence of the attribute means
            // existing sidecars pick up the empirical Look automatically.
            let lowered = value.lowercased()
            switch lowered {
            case "neutral": model.look = .neutral
            case "default": model.look = .default
            default:        break
            }
            // Auto Profile (#536) legacy migration. When `papp:Profile` is
            // absent on the same element, `papp:Look` also seeds the new
            // Profile field — Default/Auto → .auto, Neutral → .neutral.
            // Gated on `!profileSeen` so an explicit `papp:Profile`
            // attribute always wins, regardless of document order.
            if !profileSeen {
                switch lowered {
                case "neutral":         model.profile = .neutral
                case "default", "auto": model.profile = .auto
                default:                break
                }
            }
        case "papp:Profile":
            // Auto Profile Phase 1 (#536) — canonical render-shaping
            // profile attribute. Case-insensitive parse. Unknown values
            // keep the current value (default = `.auto`). Setting
            // `profileSeen` blocks the `papp:Look` legacy migration above
            // from clobbering this explicit choice.
            profileSeen = true
            switch value.lowercased() {
            case "auto":    model.profile = .auto
            case "neutral": model.profile = .neutral
            default:        break
            }
        // Lightroom culling
        case "xmp:Rating":
            if let n = Int(value) { culling.stars = max(0, min(5, n)) }
        case "xmp:Label":
            switch value.lowercased() {
            case "red", "pick": culling.flag = .pick
            case "reject":      culling.flag = .reject
            default:            break
            }
        default: break
        }
    }

    private func d(_ s: String) -> Double? { Double(s) }

    private func wbPreset(_ name: String) -> (Double, Double)? {
        switch name {
        case "Daylight":    return (5500, 10)
        case "Cloudy":      return (6500, 10)
        case "Shade":       return (7500, 10)
        case "Tungsten":    return (2850, 0)
        case "Fluorescent": return (3800, 21)
        case "Flash":       return (5500, 0)
        default:            return nil
        }
    }
}

// MARK: - XMP Serializer

/// Emit an XMP sidecar string compatible with the `crs:` schema from a model + culling state.
/// Output is byte-for-byte interchangeable with Lightroom / Maple Hosted.
public struct XMPSerializer {
    private init() {}

    public static func serialize(model: AdjustmentModel, culling: CullingState) -> String {
        var attrs: [(String, String)] = [
            ("crs:Temperature",          String(format: "%.0f", model.temperature)),
            ("crs:Tint",                 String(format: "%.0f", model.tint)),
            ("crs:Exposure2012",         fmtF(model.exposure)),
            ("crs:Contrast2012",         String(format: "%.0f", model.contrast)),
            ("crs:Highlights2012",       String(format: "%.0f", model.highlights)),
            ("crs:Shadows2012",          String(format: "%.0f", model.shadows)),
            ("crs:Whites2012",           String(format: "%.0f", model.whites)),
            ("crs:Blacks2012",           String(format: "%.0f", model.blacks)),
            ("crs:Vibrance",             String(format: "%.0f", model.vibrance)),
            ("crs:Saturation",           String(format: "%.0f", model.saturation)),
            ("crs:Clarity2012",          String(format: "%.0f", model.clarity)),
            ("crs:Texture",              String(format: "%.0f", model.texture)),
            ("crs:Dehaze",               String(format: "%.0f", model.dehaze)),
            ("crs:Sharpness",            String(format: "%.0f", model.sharpenAmount)),
            ("crs:SharpenRadius",        String(format: "%.1f", model.sharpenRadius)),
            ("crs:SharpenDetail",        String(format: "%.0f", model.sharpenDetail)),
            ("crs:SharpenEdgeMasking",   String(format: "%.0f", model.sharpenMasking)),
            ("papp:CaptureSharpeningAmount", String(format: "%.0f", model.captureSharpeningAmount)),
            // Canonical capture-sharpening write key (#456). Legacy
            // `papp:CaptureSharpeningRadius` is read-only — older sidecars
            // still parse, but new sidecars emit Sigma exclusively.
            ("papp:CaptureSharpeningSigma", String(format: "%.1f", model.captureSharpeningSigma)),
            ("crs:LuminanceSmoothing",   String(format: "%.0f", model.nrLuminance)),
            ("crs:ColorNoiseReduction",  String(format: "%.0f", model.nrColor)),
            ("xmp:Rating",               String(culling.stars)),
        ]
        if culling.flag != .none {
            attrs.append(("xmp:Label", culling.flag == .pick ? "Red" : "Rejected"))
        }
        if model.highlightRecovery != .chromaticAdaptation {
            attrs.append(("papp:HighlightRecoveryMode", model.highlightRecovery.rawValue))
        }
        // DisplayLookCurve (#371; retired in #443) — the field is a no-op
        // post-#443 but the attribute is still emitted on non-default
        // values so it round-trips with pre-#443 sidecars. Default-valued
        // models omit the attribute, so newly-saved sidecars carry no
        // `papp:Look` at all.
        if model.look != .default {
            attrs.append(("papp:Look", model.look.rawValue))
        }
        // Auto Profile Phase 1 (#536) — canonical render-shaping profile.
        // Mirrors raw-core's `serialize`: emit only on non-default
        // (`.auto`). Newly-written sidecars carry `papp:Profile` only;
        // older sidecars without it pick up `.auto` automatically, and
        // legacy `papp:Look` migrates into Profile on read.
        if model.profile != .auto {
            attrs.append(("papp:Profile", model.profile.rawValue))
        }

        let attrsStr = attrs.map { "\($0.0)=\"\($0.1)\"" }.joined(separator: "\n        ")

        // dc:subject — IPTC keyword bag (#632). Emitted as a nested
        // `<dc:subject><rdf:Bag><rdf:li>…</rdf:Bag></dc:subject>` element
        // when at least one keyword is present. An empty list omits the
        // element entirely so the round-trip empty → no element → empty
        // matches the read path's "no element" default.
        let dcNamespace = culling.keywords.isEmpty
            ? ""
            : "\n      xmlns:dc=\"http://purl.org/dc/elements/1.1/\""
        let keywordsBlock: String
        if culling.keywords.isEmpty {
            keywordsBlock = ""
        } else {
            let liItems = culling.keywords
                .map { "          <rdf:li>\(escapeXMLText($0))</rdf:li>" }
                .joined(separator: "\n")
            keywordsBlock = """

              <dc:subject>
                <rdf:Bag>
            \(liItems)
                </rdf:Bag>
              </dc:subject>
            """
        }

        // Switch between self-closing and open/close `rdf:Description`
        // forms based on whether there's nested content. The attribute
        // list is identical in both branches; only the closer differs.
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

    private static func fmtF(_ v: Double) -> String {
        // Exposure uses two decimal places to match the reference renderer's wire format
        String(format: "%.2f", v)
    }

    /// Minimal XML 1.0 text-content escaping — only `&`, `<`, `>` are
    /// strictly required between tags. `"` and `'` are attribute-only.
    private static func escapeXMLText(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}
