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
    /// Duplicates are dropped during accumulation so the parse output
    /// matches `EditSession.setKeywords`'s "unique, first-occurrence wins"
    /// invariant — necessary because callers (e.g. `KeywordChipsRow`)
    /// iterate `culling.keywords` with `ForEach(id: \.self)`.
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
        // `<dc:subject>` tag; track `<rdf:li>` children inside it. The XML
        // namespace *prefix* the sidecar binds to Dublin Core / RDF isn't
        // stable (any sidecar may rebind `dc` / `rdf` to a different prefix
        // and still be valid), so match on the qName's local-name suffix
        // — `:subject` / `:li` or the bare local name. Namespace processing
        // stays OFF on `XMLParser` because the rest of this delegate keys
        // every attribute lookup on prefixed names (`crs:Temperature` etc.).
        let qual = qName ?? elementName
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
                && rawKey != "papp:Profile" {
            applyAttribute(key: rawKey, value: value, hasCrop: hasCrop)
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

    private func applyAttribute(key: String, value: String, hasCrop: Bool = false) {
        // Strip namespace prefix for matching
        switch key {
        case "crs:Temperature":         model.temperature = d(value) ?? model.temperature
        case "crs:Tint":                model.tint        = d(value) ?? model.tint
        case "crs:Exposure2012":        model.exposure    = d(value) ?? model.exposure
        // Brightness (#1102) — Maple-proprietary midtone-band gain. Lives
        // under `papp:` because the ACR `crs:Brightness` key is PV2010 with
        // different semantics (default +50, removed in PV2012); that legacy
        // key is deliberately NOT parsed.
        case "papp:Brightness":         model.brightness  = d(value) ?? model.brightness
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
        // Decode-time chroma pre-filter (#1104) — Maple-proprietary; baked
        // into the Rust decode product, not re-applied by the Apple chain.
        case "papp:ChromaPrefilter":    model.chromaPrefilter = d(value) ?? model.chromaPrefilter
        // BM3D deep denoise (#1105) — Maple-proprietary; baked into the
        // Rust decode product, not re-applied by the Apple chain.
        case "papp:DeepDenoise":        model.deepDenoise = d(value) ?? model.deepDenoise
        // Hot/dead-pixel suppression (#1106) — Maple-proprietary enum,
        // baked into the Rust decode product. Case-insensitive like the
        // other papp: enum parsers; unknown values keep the default.
        case "papp:HotPixelSuppression":
            switch value.lowercased() {
            case "on":  model.hotPixelSuppression = .on
            case "off": model.hotPixelSuppression = .off
            default: break
            }
        // S5 effects (#643) — Lightroom-compatible `crs:` keys.
        case "crs:PostCropVignetteAmount":   model.vignetteAmount  = d(value) ?? model.vignetteAmount
        case "crs:PostCropVignetteFeather":  model.vignetteFeather = d(value) ?? model.vignetteFeather
        case "crs:GrainAmount":              model.grainAmount     = d(value) ?? model.grainAmount
        case "crs:GrainSize":                model.grainSize       = d(value) ?? model.grainSize
        // Lightroom: "GrainFrequency"; Maple: `grainRoughness` (S5 § 3.13).
        case "crs:GrainFrequency":           model.grainRoughness  = d(value) ?? model.grainRoughness
        case "crs:SplitToningShadowHue":         model.splitToneShadowHue          = d(value) ?? model.splitToneShadowHue
        case "crs:SplitToningShadowSaturation":  model.splitToneShadowSaturation   = d(value) ?? model.splitToneShadowSaturation
        case "crs:SplitToningHighlightHue":      model.splitToneHighlightHue       = d(value) ?? model.splitToneHighlightHue
        case "crs:SplitToningHighlightSaturation": model.splitToneHighlightSaturation = d(value) ?? model.splitToneHighlightSaturation
        case "crs:SplitToningBalance":           model.splitToneBalance            = d(value) ?? model.splitToneBalance
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
            case "auto":     model.profile = .auto
            case "neutral":  model.profile = .neutral
            case "acrmatch": model.profile = .acrMatch
            default:         break
            }
        // Crop / straighten (#277, spec § 3.12). Rect fields gated by
        // `hasCrop` (above). `crs:CropAngle` is always parsed — it can
        // appear without a rect for a pure straighten.
        case "crs:CropTop":    if hasCrop, let n = d(value) { model.crop.top    = n }
        case "crs:CropLeft":   if hasCrop, let n = d(value) { model.crop.left   = n }
        case "crs:CropBottom": if hasCrop, let n = d(value) { model.crop.bottom = n }
        case "crs:CropRight":  if hasCrop, let n = d(value) { model.crop.right  = n }
        case "crs:CropAngle":  if let n = d(value) { model.crop.angle = n }
        // `crs:HasCrop` is consumed in the pre-pass; silently accept here too.
        case "crs:HasCrop", "crs:CropConstrainToWarp": break
        // Lightroom culling
        case "xmp:Rating":
            if let n = Int(value) { culling.stars = max(0, min(5, n)) }
        case "xmp:Label":
            switch value.lowercased() {
            case "red", "pick": culling.flag = .pick
            case "reject":      culling.flag = .reject
            default:            break
            }
        case "papp:Hidden": culling.hidden = XMPParser.parseHiddenAttribute(value)
        default: _xmpApplyHSLAttribute(key: key, value: value, model: &model)
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
/// Output is semantically round-trippable with Lightroom / Maple Hosted (same fields,
/// same value semantics) but is not byte-canonical — attribute ordering and the
/// `papp:` namespace URI differ across the Apple / Web / Rust serializers today.
public struct XMPSerializer {
    private init() {}

    // MARK: - Internal builders (used by both serialize overloads)

    /// Build the ordered adjustment + culling attribute list.
    /// Values are already formatted for direct emission (numbers, rawValues,
    /// "Red"/"Rejected" — all XML-safe without escaping).
    /// Called from both `serialize(model:culling:)` and the metadata overload
    /// so metadata attrs can be appended natively.
    static func _buildAttrs(model: AdjustmentModel, culling: CullingState) -> [(String, String)] {
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
        if let hidden = culling.hidden {  // tri-state: only emit when explicitly touched, never a default
            attrs.append(("papp:Hidden", hidden ? "true" : "false"))
        }
        // Brightness (#1102) — emit only when non-default (0) so sidecars
        // produced before the slider existed remain byte-identical for
        // users who never touch it. Key is `papp:Brightness`, NOT the ACR
        // PV2010 `crs:Brightness` (different semantics — see the parser).
        if model.brightness != 0 {
            attrs.append(("papp:Brightness", String(format: "%.0f", model.brightness)))
        }
        // S5 effects fields (#643) — emit only when non-default so sidecars
        // produced before this PR remain byte-identical for users who never
        // touch the vignette / grain / split-tone tools. Defaults are:
        // vignetteAmount=0, vignetteFeather=50, grainAmount=0, grainSize=25,
        // grainRoughness=50, all split-tone scalars=0.
        if model.vignetteAmount != 0 {
            attrs.append(("crs:PostCropVignetteAmount", String(format: "%.0f", model.vignetteAmount)))
        }
        if model.vignetteFeather != 50 {
            attrs.append(("crs:PostCropVignetteFeather", String(format: "%.0f", model.vignetteFeather)))
        }
        if model.grainAmount != 0 {
            attrs.append(("crs:GrainAmount", String(format: "%.0f", model.grainAmount)))
        }
        if model.grainSize != 25 {
            attrs.append(("crs:GrainSize", String(format: "%.0f", model.grainSize)))
        }
        if model.grainRoughness != 50 {
            attrs.append(("crs:GrainFrequency", String(format: "%.0f", model.grainRoughness)))
        }
        if model.splitToneShadowHue != 0 {
            attrs.append(("crs:SplitToningShadowHue", String(format: "%.0f", model.splitToneShadowHue)))
        }
        if model.splitToneShadowSaturation != 0 {
            attrs.append(("crs:SplitToningShadowSaturation", String(format: "%.0f", model.splitToneShadowSaturation)))
        }
        if model.splitToneHighlightHue != 0 {
            attrs.append(("crs:SplitToningHighlightHue", String(format: "%.0f", model.splitToneHighlightHue)))
        }
        if model.splitToneHighlightSaturation != 0 {
            attrs.append(("crs:SplitToningHighlightSaturation", String(format: "%.0f", model.splitToneHighlightSaturation)))
        }
        if model.splitToneBalance != 0 {
            attrs.append(("crs:SplitToningBalance", String(format: "%.0f", model.splitToneBalance)))
        }
        attrs += XMPSerializer.hslAttrs(model: model)
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
        // Decode-time chroma pre-filter (#1104) — emit only when
        // non-default (0) so sidecars produced before the field existed
        // remain byte-identical for users who never touch it.
        if model.chromaPrefilter != 0 {
            attrs.append(("papp:ChromaPrefilter", String(format: "%.0f", model.chromaPrefilter)))
        }
        // Hot/dead-pixel suppression (#1106) — emit only when non-default
        // (`.off`), same convention.
        if model.hotPixelSuppression != .off {
            attrs.append(("papp:HotPixelSuppression", model.hotPixelSuppression.rawValue))
        }
        // BM3D deep denoise (#1105) — emit only when non-default (0).
        if model.deepDenoise != 0 {
            attrs.append(("papp:DeepDenoise", String(format: "%.0f", model.deepDenoise)))
        }
        // Crop / straighten (#277, spec § 01 invariant 3) — emit only when
        // non-identity. CropAngle is independent so a pure straighten emits
        // only the angle without the HasCrop/rect group.
        if !model.crop.isIdentity {
            let c = model.crop
            let rectIsIdentity = c.top == 0 && c.left == 0 && c.bottom == 1 && c.right == 1
            if !rectIsIdentity {
                attrs.append(("crs:HasCrop", "True"))
                attrs.append(("crs:CropTop",    fmtCrop(c.top)))
                attrs.append(("crs:CropLeft",   fmtCrop(c.left)))
                attrs.append(("crs:CropBottom", fmtCrop(c.bottom)))
                attrs.append(("crs:CropRight",  fmtCrop(c.right)))
                attrs.append(("crs:CropConstrainToWarp", "0"))
            }
            if c.angle != 0 {
                attrs.append(("crs:CropAngle", fmtCrop(c.angle)))
            }
        }
        return attrs
    }

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

    public static func serialize(model: AdjustmentModel, culling: CullingState) -> String {
        let attrs = _buildAttrs(model: model, culling: culling)
        let attrsStr = attrs.map { "\($0.0)=\"\($0.1)\"" }.joined(separator: "\n        ")
        let (dcNamespace, keywordsBlock) = _buildKeywordsBlock(culling: culling)

        // Switch between self-closing and open/close `rdf:Description`
        // forms based on whether there's nested content (keywords block).
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
