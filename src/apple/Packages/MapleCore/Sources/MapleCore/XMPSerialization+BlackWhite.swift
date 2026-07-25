// XMPSerialization+BlackWhite.swift — Black & white mix (#276) parse +
// serialize helpers. Same `+HSL` split pattern (#772) applied to keep
// `XMPSerialization.swift` / `XMPSerialization+Attrs.swift` under the
// 600-LOC hard budget. Mirrors raw-core's `xmp/black_white.rs`:
// ACR/Lightroom-compatible `crs:` keys, so a monochrome conversion
// interchanges with Lightroom — the boolean `crs:ConvertToGrayscale`
// toggle plus `crs:GrayMixerRed` … `crs:GrayMixerMagenta` in the same
// band order as the HSL block.

import Foundation

// MARK: - Black & white parser helper (internal — called from the private delegate)

/// Apply a B&W attribute key/value to `model`. Silently ignores
/// unrecognized keys (and unrecognized `crs:ConvertToGrayscale` spellings —
/// unlike raw-core's strict parser, every other papp:/crs: enum parse in
/// this file keeps the current value on an unknown spelling rather than
/// throwing) so the `default:` case in `applyAttribute` can delegate here
/// unconditionally.
func _xmpApplyBlackWhiteAttribute(key: String, value: String, model: inout AdjustmentModel) {
    switch key {
    case "crs:GrayMixerRed":     model.grayMixerRed     = Double(value) ?? model.grayMixerRed
    case "crs:GrayMixerOrange":  model.grayMixerOrange  = Double(value) ?? model.grayMixerOrange
    case "crs:GrayMixerYellow":  model.grayMixerYellow  = Double(value) ?? model.grayMixerYellow
    case "crs:GrayMixerGreen":   model.grayMixerGreen   = Double(value) ?? model.grayMixerGreen
    case "crs:GrayMixerAqua":    model.grayMixerAqua    = Double(value) ?? model.grayMixerAqua
    case "crs:GrayMixerBlue":    model.grayMixerBlue    = Double(value) ?? model.grayMixerBlue
    case "crs:GrayMixerPurple":  model.grayMixerPurple  = Double(value) ?? model.grayMixerPurple
    case "crs:GrayMixerMagenta": model.grayMixerMagenta = Double(value) ?? model.grayMixerMagenta
    case "crs:ConvertToGrayscale":
        switch value.lowercased() {
        case "true", "1":  model.blackWhite = .on
        case "false", "0": model.blackWhite = .off
        default: break
        }
    default: break
    }
}

// MARK: - Black & white serializer helper

extension XMPSerializer {
    /// B&W attribute pairs: the `crs:ConvertToGrayscale` toggle (emitted
    /// only for the non-default `.on`, matching the `autoExposure`
    /// omit-on-default gate) plus the eight `crs:GrayMixer*` weights
    /// (emitted only when non-default (0), matching `hslAttrs`). The
    /// weights are written independent of the toggle — mirrors raw-core's
    /// `xmp::black_white::serialize` — so a mixer edit made before
    /// switching B&W on still round-trips. Called from
    /// `_buildAttrs(model:culling:omitWhiteBalance:)` to keep
    /// `XMPSerialization+Attrs.swift` under the 600-LOC hard budget.
    static func blackWhiteAttrs(model: AdjustmentModel) -> [(String, String)] {
        var a: [(String, String)] = []
        if model.blackWhite != .off {
            a.append(("crs:ConvertToGrayscale", "True"))
        }
        if model.grayMixerRed      != 0 { a.append(("crs:GrayMixerRed",      String(format: "%.0f", model.grayMixerRed))) }
        if model.grayMixerOrange   != 0 { a.append(("crs:GrayMixerOrange",   String(format: "%.0f", model.grayMixerOrange))) }
        if model.grayMixerYellow   != 0 { a.append(("crs:GrayMixerYellow",   String(format: "%.0f", model.grayMixerYellow))) }
        if model.grayMixerGreen    != 0 { a.append(("crs:GrayMixerGreen",    String(format: "%.0f", model.grayMixerGreen))) }
        if model.grayMixerAqua     != 0 { a.append(("crs:GrayMixerAqua",     String(format: "%.0f", model.grayMixerAqua))) }
        if model.grayMixerBlue     != 0 { a.append(("crs:GrayMixerBlue",     String(format: "%.0f", model.grayMixerBlue))) }
        if model.grayMixerPurple   != 0 { a.append(("crs:GrayMixerPurple",   String(format: "%.0f", model.grayMixerPurple))) }
        if model.grayMixerMagenta  != 0 { a.append(("crs:GrayMixerMagenta",  String(format: "%.0f", model.grayMixerMagenta))) }
        return a
    }
}
