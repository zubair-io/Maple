// XMPSerialization+HSL.swift — HSL 8-band parse + serialize helpers.
// Extracted from XMPSerialization.swift to keep that file under the 600-LOC
// hard budget (#772). Called from _XMPParserDelegate.applyAttribute (via its
// default: fallthrough) and from XMPSerializer.serialize.

import Foundation

// MARK: - HSL parser helper (internal — called from the private delegate)

/// Apply an HSL 8-band attribute key/value to `model`. Silently ignores
/// unrecognized keys so the `default:` case in `applyAttribute` can
/// delegate here unconditionally.
func _xmpApplyHSLAttribute(key: String, value: String, model: inout AdjustmentModel) {
    // HSL 8-band adjustments (#1112) — crs: keys for interchange with Lightroom.
    switch key {
    case "crs:HueAdjustmentRed":         model.hueAdjustmentRed       = Double(value) ?? model.hueAdjustmentRed
    case "crs:HueAdjustmentOrange":      model.hueAdjustmentOrange    = Double(value) ?? model.hueAdjustmentOrange
    case "crs:HueAdjustmentYellow":      model.hueAdjustmentYellow    = Double(value) ?? model.hueAdjustmentYellow
    case "crs:HueAdjustmentGreen":       model.hueAdjustmentGreen     = Double(value) ?? model.hueAdjustmentGreen
    case "crs:HueAdjustmentAqua":        model.hueAdjustmentAqua      = Double(value) ?? model.hueAdjustmentAqua
    case "crs:HueAdjustmentBlue":        model.hueAdjustmentBlue      = Double(value) ?? model.hueAdjustmentBlue
    case "crs:HueAdjustmentPurple":      model.hueAdjustmentPurple    = Double(value) ?? model.hueAdjustmentPurple
    case "crs:HueAdjustmentMagenta":     model.hueAdjustmentMagenta   = Double(value) ?? model.hueAdjustmentMagenta
    case "crs:SaturationAdjustmentRed":      model.saturationAdjustmentRed       = Double(value) ?? model.saturationAdjustmentRed
    case "crs:SaturationAdjustmentOrange":   model.saturationAdjustmentOrange    = Double(value) ?? model.saturationAdjustmentOrange
    case "crs:SaturationAdjustmentYellow":   model.saturationAdjustmentYellow    = Double(value) ?? model.saturationAdjustmentYellow
    case "crs:SaturationAdjustmentGreen":    model.saturationAdjustmentGreen     = Double(value) ?? model.saturationAdjustmentGreen
    case "crs:SaturationAdjustmentAqua":     model.saturationAdjustmentAqua      = Double(value) ?? model.saturationAdjustmentAqua
    case "crs:SaturationAdjustmentBlue":     model.saturationAdjustmentBlue      = Double(value) ?? model.saturationAdjustmentBlue
    case "crs:SaturationAdjustmentPurple":   model.saturationAdjustmentPurple    = Double(value) ?? model.saturationAdjustmentPurple
    case "crs:SaturationAdjustmentMagenta":  model.saturationAdjustmentMagenta   = Double(value) ?? model.saturationAdjustmentMagenta
    case "crs:LuminanceAdjustmentRed":       model.luminanceAdjustmentRed        = Double(value) ?? model.luminanceAdjustmentRed
    case "crs:LuminanceAdjustmentOrange":    model.luminanceAdjustmentOrange     = Double(value) ?? model.luminanceAdjustmentOrange
    case "crs:LuminanceAdjustmentYellow":    model.luminanceAdjustmentYellow     = Double(value) ?? model.luminanceAdjustmentYellow
    case "crs:LuminanceAdjustmentGreen":     model.luminanceAdjustmentGreen      = Double(value) ?? model.luminanceAdjustmentGreen
    case "crs:LuminanceAdjustmentAqua":      model.luminanceAdjustmentAqua       = Double(value) ?? model.luminanceAdjustmentAqua
    case "crs:LuminanceAdjustmentBlue":      model.luminanceAdjustmentBlue       = Double(value) ?? model.luminanceAdjustmentBlue
    case "crs:LuminanceAdjustmentPurple":    model.luminanceAdjustmentPurple     = Double(value) ?? model.luminanceAdjustmentPurple
    case "crs:LuminanceAdjustmentMagenta":   model.luminanceAdjustmentMagenta    = Double(value) ?? model.luminanceAdjustmentMagenta
    default: break
    }
}

// MARK: - HSL serializer helper

extension XMPSerializer {
    /// HSL 8-band attribute pairs. Emits only non-default (0) values so
    /// sidecars from older builds stay byte-identical. Called from
    /// `serialize(model:culling:)` to keep `XMPSerialization.swift` under
    /// the 600-LOC hard budget (#772).
    static func hslAttrs(model: AdjustmentModel) -> [(String, String)] {
        var a: [(String, String)] = []
        if model.hueAdjustmentRed      != 0 { a.append(("crs:HueAdjustmentRed",      fmtNum(model.hueAdjustmentRed))) }
        if model.hueAdjustmentOrange   != 0 { a.append(("crs:HueAdjustmentOrange",   fmtNum(model.hueAdjustmentOrange))) }
        if model.hueAdjustmentYellow   != 0 { a.append(("crs:HueAdjustmentYellow",   fmtNum(model.hueAdjustmentYellow))) }
        if model.hueAdjustmentGreen    != 0 { a.append(("crs:HueAdjustmentGreen",    fmtNum(model.hueAdjustmentGreen))) }
        if model.hueAdjustmentAqua     != 0 { a.append(("crs:HueAdjustmentAqua",     fmtNum(model.hueAdjustmentAqua))) }
        if model.hueAdjustmentBlue     != 0 { a.append(("crs:HueAdjustmentBlue",     fmtNum(model.hueAdjustmentBlue))) }
        if model.hueAdjustmentPurple   != 0 { a.append(("crs:HueAdjustmentPurple",   fmtNum(model.hueAdjustmentPurple))) }
        if model.hueAdjustmentMagenta  != 0 { a.append(("crs:HueAdjustmentMagenta",  fmtNum(model.hueAdjustmentMagenta))) }
        if model.saturationAdjustmentRed      != 0 { a.append(("crs:SaturationAdjustmentRed",      fmtNum(model.saturationAdjustmentRed))) }
        if model.saturationAdjustmentOrange   != 0 { a.append(("crs:SaturationAdjustmentOrange",   fmtNum(model.saturationAdjustmentOrange))) }
        if model.saturationAdjustmentYellow   != 0 { a.append(("crs:SaturationAdjustmentYellow",   fmtNum(model.saturationAdjustmentYellow))) }
        if model.saturationAdjustmentGreen    != 0 { a.append(("crs:SaturationAdjustmentGreen",    fmtNum(model.saturationAdjustmentGreen))) }
        if model.saturationAdjustmentAqua     != 0 { a.append(("crs:SaturationAdjustmentAqua",     fmtNum(model.saturationAdjustmentAqua))) }
        if model.saturationAdjustmentBlue     != 0 { a.append(("crs:SaturationAdjustmentBlue",     fmtNum(model.saturationAdjustmentBlue))) }
        if model.saturationAdjustmentPurple   != 0 { a.append(("crs:SaturationAdjustmentPurple",   fmtNum(model.saturationAdjustmentPurple))) }
        if model.saturationAdjustmentMagenta  != 0 { a.append(("crs:SaturationAdjustmentMagenta",  fmtNum(model.saturationAdjustmentMagenta))) }
        if model.luminanceAdjustmentRed      != 0 { a.append(("crs:LuminanceAdjustmentRed",      fmtNum(model.luminanceAdjustmentRed))) }
        if model.luminanceAdjustmentOrange   != 0 { a.append(("crs:LuminanceAdjustmentOrange",   fmtNum(model.luminanceAdjustmentOrange))) }
        if model.luminanceAdjustmentYellow   != 0 { a.append(("crs:LuminanceAdjustmentYellow",   fmtNum(model.luminanceAdjustmentYellow))) }
        if model.luminanceAdjustmentGreen    != 0 { a.append(("crs:LuminanceAdjustmentGreen",    fmtNum(model.luminanceAdjustmentGreen))) }
        if model.luminanceAdjustmentAqua     != 0 { a.append(("crs:LuminanceAdjustmentAqua",     fmtNum(model.luminanceAdjustmentAqua))) }
        if model.luminanceAdjustmentBlue     != 0 { a.append(("crs:LuminanceAdjustmentBlue",     fmtNum(model.luminanceAdjustmentBlue))) }
        if model.luminanceAdjustmentPurple   != 0 { a.append(("crs:LuminanceAdjustmentPurple",   fmtNum(model.luminanceAdjustmentPurple))) }
        if model.luminanceAdjustmentMagenta  != 0 { a.append(("crs:LuminanceAdjustmentMagenta",  fmtNum(model.luminanceAdjustmentMagenta))) }
        return a
    }
}
