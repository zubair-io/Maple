// AdjustmentModel.swift — Swift mirror of raw_core::xmp::AdjustmentModel.
//
// Fields, defaults, and ranges match spec § 01 and the Rust source in
// src/raw-pipeline/raw-core/src/xmp.rs exactly.
//
// XMP parsing is handled by the pure-Swift `XMPParser` below, which reads the
// same ACR attributes as the Rust `parse()` function so that sidecar files
// produced by either Lightroom or Maple are interchangeable.

import Foundation

// MARK: - HighlightRecoveryMode

public enum HighlightRecoveryMode: String, Codable, Sendable, Hashable {
    case off                  = "Off"
    case blend                = "Blend"
    case luminance            = "Luminance"
    /// Path C — `AsShotNeutral`-aware chromatic-adaptation highlight
    /// reconstruction (ticket #325). `blend` and `luminance` are legacy
    /// variants kept for back-compat: raw-core silently upgrades them at
    /// apply time.
    case chromaticAdaptation  = "ChromaticAdaptation"
}

// MARK: - AdjustmentModel

/// Per-image editing knobs. Mirrors `raw_core::xmp::AdjustmentModel`.
/// All values are stored at full float64 precision (Lightroom uses float32
/// on-wire; we widen to Double here for Swift arithmetic convenience and
/// narrow before the FFI call path).
public struct AdjustmentModel: Codable, Sendable, Equatable, Hashable {
    // White balance
    public var temperature: Double      // 2000..12000, default 6500
    public var tint: Double             // -100..100, default 0

    // Basic tone
    public var exposure: Double         // -4..+4 EV, default 0
    public var contrast: Double         // -100..100, default 0
    public var highlights: Double       // -100..100, default 0
    public var shadows: Double          // -100..100, default 0
    public var whites: Double           // -100..100, default 0
    public var blacks: Double           // -100..100, default 0

    // Presence
    public var vibrance: Double         // -100..100, default 0
    public var saturation: Double       // -100..100, default 0
    public var clarity: Double          // -100..100, default 0
    public var texture: Double          // -100..100, default 0
    public var dehaze: Double           // -100..100, default 0

    // Detail — sharpening
    //
    // Defaults mirror ACR / Lightroom raw-file profile sharpening — a small
    // amount of capture-sharpening at the lens-blur radius — rather than the
    // "no edits applied" identity (0 / 0.5) the Rust `AdjustmentModel::default()`
    // uses. First-open of a sidecar-less RAW should look as sharp as ACR's
    // default-import, not soft. See Ticket 12 Bug 3 for context.
    //
    // sharpenRadius default revised from 5 to 1.0 (this commit). The earlier
    // value of 5 was outside the documented field range 0.5..3.0; both the
    // Rust `sharpen::apply` and Apple Metal kernel clamp internally to 3.0
    // and round to integer-px box width, so radius=5 silently rendered as
    // radius=3 — pegged at the upper bound. Combined with amount=45 (3 RL
    // iterations at full strength) on high-contrast-edge inputs (e.g. a
    // ColorChecker chart) the 3-px stencil produced visible chroma halos.
    // 1.0 is ACR's actual raw-file default and the value the docstring
    // range implies as typical capture-sharpening.
    public var sharpenAmount: Double    // 0..150, default 45 (was 0)
    public var sharpenRadius: Double    // 0.5..3.0, default 1.0 (was 0.5, briefly 5)
    public var sharpenDetail: Double    // 0..100, default 25
    public var sharpenMasking: Double   // 0..100, default 0

    // Detail — capture sharpening (Maple-proprietary Richardson-Lucy
    // deconvolution; distinct from ACR's unsharp-mask sliders above).
    // Defaults to 0 (stage skipped) so first-open matches pre-#271 behaviour
    // bit-identically. Per-camera defaults are a follow-up calibration ticket.
    public var captureSharpeningAmount: Double  // 0..100, default 0
    public var captureSharpeningRadius: Double  // 0.5..2.0, default 1.0

    // Detail — noise reduction
    public var nrLuminance: Double      // 0..100, default 0
    public var nrColor: Double          // 0..100, default 25

    // Highlight recovery (Maple-proprietary)
    public var highlightRecovery: HighlightRecoveryMode

    public init(
        temperature: Double = 6500,
        tint: Double = 0,
        exposure: Double = 0,
        contrast: Double = 0,
        highlights: Double = 0,
        shadows: Double = 0,
        whites: Double = 0,
        blacks: Double = 0,
        vibrance: Double = 0,
        saturation: Double = 0,
        clarity: Double = 0,
        texture: Double = 0,
        dehaze: Double = 0,
        sharpenAmount: Double = 45,
        sharpenRadius: Double = 1.0,
        sharpenDetail: Double = 25,
        sharpenMasking: Double = 0,
        captureSharpeningAmount: Double = 0,
        captureSharpeningRadius: Double = 1.0,
        nrLuminance: Double = 0,
        nrColor: Double = 25,
        highlightRecovery: HighlightRecoveryMode = .chromaticAdaptation
    ) {
        self.temperature = temperature
        self.tint = tint
        self.exposure = exposure
        self.contrast = contrast
        self.highlights = highlights
        self.shadows = shadows
        self.whites = whites
        self.blacks = blacks
        self.vibrance = vibrance
        self.saturation = saturation
        self.clarity = clarity
        self.texture = texture
        self.dehaze = dehaze
        self.sharpenAmount = sharpenAmount
        self.sharpenRadius = sharpenRadius
        self.sharpenDetail = sharpenDetail
        self.sharpenMasking = sharpenMasking
        self.captureSharpeningAmount = captureSharpeningAmount
        self.captureSharpeningRadius = captureSharpeningRadius
        self.nrLuminance = nrLuminance
        self.nrColor = nrColor
        self.highlightRecovery = highlightRecovery
    }

    public static let `default` = AdjustmentModel()
}

// MARK: - CullingState

/// Per-image culling metadata (stars, pick/reject). Matches spec § 01.
public struct CullingState: Codable, Sendable, Equatable, Hashable {
    public var stars: Int        // 0..5
    public var flag: CullFlag    // pick / reject / none

    public init(stars: Int = 0, flag: CullFlag = .none) {
        self.stars = stars
        self.flag = flag
    }
}

public enum CullFlag: String, Codable, Sendable, Hashable {
    case none    = "none"
    case pick    = "pick"
    case reject  = "reject"
}

// MARK: - XMPParser

/// Pure-Swift ACR XMP parser. Reads the same attribute names as the Rust
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

    init(model: AdjustmentModel, culling: CullingState) {
        self.model = model
        self.culling = culling
    }

    func parser(_ parser: XMLParser,
                didStartElement elementName: String,
                namespaceURI: String?,
                qualifiedName qName: String?,
                attributes attributeDict: [String: String]) {
        // Process WhiteBalance preset first so explicit Temperature/Tint can override it.
        if let wb = attributeDict["crs:WhiteBalance"] {
            applyAttribute(key: "crs:WhiteBalance", value: wb)
        }
        for (rawKey, value) in attributeDict where rawKey != "crs:WhiteBalance" {
            applyAttribute(key: rawKey, value: value)
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
        case "papp:CaptureSharpeningRadius": model.captureSharpeningRadius = d(value) ?? model.captureSharpeningRadius
        case "crs:LuminanceSmoothing":  model.nrLuminance    = d(value) ?? model.nrLuminance
        case "crs:ColorNoiseReduction": model.nrColor        = d(value) ?? model.nrColor
        case "crs:WhiteBalance":
            if let (t, ti) = wbPreset(value) {
                model.temperature = t
                model.tint = ti
            }
        case "papp:HighlightRecoveryMode":
            // Try exact rawValue first (so multi-word PascalCase like
            // "ChromaticAdaptation" round-trips), then fall back to the
            // capitalized form for single-word back-compat values ("off",
            // "blend", "luminance"). Unknown values keep the current value
            // (default) rather than silently flipping reconstruction off.
            if let parsed = HighlightRecoveryMode(rawValue: value)
                ?? HighlightRecoveryMode(rawValue: value.capitalized) {
                model.highlightRecovery = parsed
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

/// Emit an ACR-compatible XMP sidecar string from a model + culling state.
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
            ("papp:CaptureSharpeningRadius", String(format: "%.1f", model.captureSharpeningRadius)),
            ("crs:LuminanceSmoothing",   String(format: "%.0f", model.nrLuminance)),
            ("crs:ColorNoiseReduction",  String(format: "%.0f", model.nrColor)),
            ("xmp:Rating",               String(culling.stars)),
        ]
        if culling.flag != .none {
            attrs.append(("xmp:Label", culling.flag == .pick ? "Red" : "Rejected"))
        }
        if model.highlightRecovery != .off {
            attrs.append(("papp:HighlightRecoveryMode", model.highlightRecovery.rawValue))
        }

        let attrsStr = attrs.map { "\($0.0)=\"\($0.1)\"" }.joined(separator: "\n        ")
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
    }

    private static func fmtF(_ v: Double) -> String {
        // Exposure uses two decimal places like ACR
        String(format: "%.2f", v)
    }
}
