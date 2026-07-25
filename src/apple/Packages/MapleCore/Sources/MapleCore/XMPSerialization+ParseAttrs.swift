// XMPSerialization+ParseAttrs.swift — the `rdf:Description` attribute switch
// for `_XMPParserDelegate`.
//
// Split out of `XMPSerialization.swift` for the 600-line hard budget: the
// point tone-curve parse/emit hooks (#365) landed alongside the
// `papp:ColorLabel` culling attribute (#2228), and together they pushed the
// host file past the limit — neither change alone crossed it. This is a
// verbatim move of `applyAttribute` and its two value helpers, with no
// behaviour change, mirroring the split raw-core took for `xmp::set_field`
// into `xmp/fields.rs`.
//
// `_XMPParserDelegate` widens from file-private to module-internal so the
// extension can live here. The leading underscore stays the marker that it
// is an implementation detail of the XMP layer; nothing outside MapleCore
// can see it.

import Foundation

extension _XMPParserDelegate {
    func applyAttribute(key: String, value: String, hasCrop: Bool = false) {
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
        // Parametric tone-curve region sliders (#365) — PV2012 keys,
        // Lightroom-compatible; authored by the tone-curve widget.
        case "crs:ParametricHighlights": model.parametricHighlights = d(value) ?? model.parametricHighlights
        case "crs:ParametricLights":    model.parametricLights = d(value) ?? model.parametricLights
        case "crs:ParametricDarks":     model.parametricDarks  = d(value) ?? model.parametricDarks
        case "crs:ParametricShadows":   model.parametricShadows = d(value) ?? model.parametricShadows
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
        // Auto-exposure (#1387) — Maple-proprietary enum, baked into the
        // Rust decode product. Case-insensitive like the other papp: enum
        // parsers (mirrors raw-core's `"on" | "On"` / `"off" | "Off"`
        // match); an unrecognized value keeps the current model value
        // (default `.on`) rather than throwing, matching every other
        // papp: enum parse in this file.
        case "papp:AutoExposure":
            switch value.lowercased() {
            case "on":  model.autoExposure = .on
            case "off": model.autoExposure = .off
            default: break
            }
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
        // Consumed at document level in `didStartElement` (#1780).
        case "papp:WbScaleVersion": break
        // Lightroom culling
        case "xmp:Rating":
            if let n = Int(value) { culling.stars = max(0, min(5, n)) }
        // `xmp:Label` is read as the pick/reject FLAG on Apple, matching what
        // this module's serializer writes ("Red" / "Rejected"). Interop note
        // (#1656): the web parser instead reads Adobe's `xmp:Label` colour
        // words ("Red", "Purple", …) as a COLOUR label, and prefers
        // `papp:ColorLabel` over them when both are present. Apple must not
        // copy that mapping — because the flag shares this attribute here,
        // doing so would turn every Apple-authored pick into a red colour
        // label. Colour labels are therefore read from `papp:ColorLabel`
        // only, exactly like the API parser (`metadata-parser.ts`).
        case "xmp:Label":
            switch value.lowercased() {
            case "red", "pick": culling.flag = .pick
            case "reject":      culling.flag = .reject
            default:            break
            }
        // Colour label (#1656/#1657). Unknown values leave the label unset
        // rather than storing an out-of-vocabulary string, mirroring the
        // API parser's `VALID_COLOR_LABELS` membership gate. The match is
        // case-sensitive on purpose: the wire vocabulary is lowercase on
        // all three platforms, and case-folding here would accept a value
        // the API would then reject.
        case "papp:ColorLabel":
            if let label = ColorLabel(rawValue: value) { culling.colorLabel = label }
        case "papp:Hidden": culling.hidden = XMPParser.parseHiddenAttribute(value)
        default: _xmpApplyHSLAttribute(key: key, value: value, model: &model)
        }
    }

    func d(_ s: String) -> Double? { Double(s) }

    func wbPreset(_ name: String) -> (Double, Double)? {
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
