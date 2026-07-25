// ToolValueMapping.swift — drag-bar value mapping for the editor tools (#625).
//
// Split out of EditorState.swift to keep that file inside the file-size budget.
// Maps the drag-bar's internal [-100, +100] scale to each tool's AdjustmentModel
// field range (spec §3). Lives in MapleCore alongside `Tool` / `EditorState`.

import Foundation

// MARK: - Value mapping

/// Maps the drag-bar's internal `[-100, +100]` linear scale to each tool's
/// `AdjustmentModel` field range (spec §3 "Value ranges"). The inverse
/// `internalValue(for:displayValue:)` lets the value-chip pull a display
/// value back out for non-default initial states (e.g. hydrated WB).
public enum ToolValueMapping {
    /// Display range per tool. `nil` for tools that don't have a wired
    /// `AdjustmentModel` field yet.
    public static func displayRange(for tool: Tool) -> ClosedRange<Double>? {
        switch tool {
        case .exposure: return -4.0...4.0    // EV
        case .temp:     return 2000...12000  // K
        case .tint:     return AdjustmentModel.tintRange // ±150, ACR's crs:Tint span (#1870)
        case .brightness,
             .contrast, .highlights, .shadows, .whites, .blacks,
             .vibrance, .saturation,
             .clarity, .texture, .dehaze:
            return -100...100
        case .sharpen:  return 0...150
        case .noise, .colorNR: return 0...100
        // Capture sharpening (#271, relocated from the Develop tab in
        // #875). Amount is one-sided 0..100 (default 0); Sigma is a
        // narrow 0.5..2.0 px band centred on its 1.0 default.
        case .captureSharpen: return 0...100
        case .captureSigma:   return 0.5...2.0
        // S5 effects (#1109 / #1110 / #1111) — wired; drag bars drive
        // each tool's primary sub-param (vignetteAmount / grainAmount /
        // splitToneBalance).
        case .vignette: return -100...100
        case .grain:    return 0...100
        case .splitTone: return -100...100
        // B&W Mix (#276) — wired multi-param; the grid row's "unarmed"
        // representation reads/writes the first-declared sub-param
        // (grayMixerRed), same convention as vignette → amount,
        // grain → amount, splitTone → balance.
        case .bwMix:    return AdjustmentModel.grayMixerRedRange
        default:        return nil
        }
    }

    /// Convert internal `[-100, +100]` to the tool's display range.
    public static func displayValue(for tool: Tool, internalValue v: Double) -> Double {
        guard let r = displayRange(for: tool) else { return v }
        // Symmetric tools centred at 0; tools with one-sided range
        // (sharpen 0-150, noise 0-100) treat `+100` as the max and `-100`
        // as zero. Tools with a non-symmetric center (temp 2000-12000,
        // default 6500) map linearly with 0 at the default.
        switch tool {
        case .temp:
            // 6500 K default at v=0; +100 → 12000, -100 → 2000.
            return v >= 0 ? 6500 + (v / 100.0) * (12000 - 6500)
                          : 6500 + (v / 100.0) * (6500 - 2000)
        case .sharpen:
            // 0..150, default 40 at v=0.
            return v >= 0 ? 40 + (v / 100.0) * (150 - 40)
                          : 40 + (v / 100.0) * 40
        case .captureSigma:
            // 0.5..2.0 px, default 1.0 at v=0; +100 → 2.0, -100 → 0.5.
            return v >= 0 ? 1.0 + (v / 100.0) * (2.0 - 1.0)
                          : 1.0 + (v / 100.0) * (1.0 - 0.5)
        case .noise, .colorNR, .grain, .captureSharpen:
            // 0..100, default 0 at v=-100 / 25 at v=0 for colorNR? We keep
            // the simple symmetric mapping: 0 at v=-100, 100 at v=+100.
            // Grain shares the one-sided 0..100 layout per #643.
            let lo = r.lowerBound, hi = r.upperBound
            return lo + ((v + 100) / 200.0) * (hi - lo)
        default:
            // Symmetric ±100 → ±r.upperBound (or ±EV 4.0 for exposure).
            return (v / 100.0) * r.upperBound
        }
    }

    /// Inverse of `displayValue(for:internalValue:)`.
    public static func internalValue(for tool: Tool, displayValue d: Double) -> Double {
        guard let r = displayRange(for: tool) else { return d }
        switch tool {
        case .temp:
            return d >= 6500 ? ((d - 6500) / (12000 - 6500)) * 100
                             : ((d - 6500) / (6500 - 2000)) * 100
        case .sharpen:
            return d >= 40 ? ((d - 40) / (150 - 40)) * 100
                           : ((d - 40) / 40) * 100
        case .captureSigma:
            return d >= 1.0 ? ((d - 1.0) / (2.0 - 1.0)) * 100
                            : ((d - 1.0) / (1.0 - 0.5)) * 100
        case .noise, .colorNR, .grain, .captureSharpen:
            let lo = r.lowerBound, hi = r.upperBound
            return ((d - lo) / (hi - lo)) * 200 - 100
        default:
            return (d / r.upperBound) * 100
        }
    }

    /// Read the wired `AdjustmentModel` field as a display-range value.
    public static func currentDisplayValue(_ model: AdjustmentModel, tool: Tool) -> Double {
        switch tool {
        case .exposure:   return model.exposure
        case .brightness: return model.brightness
        case .contrast:   return model.contrast
        case .highlights: return model.highlights
        case .shadows:    return model.shadows
        case .whites:     return model.whites
        case .blacks:     return model.blacks
        case .temp:       return model.temperature
        case .tint:       return model.tint
        case .vibrance:   return model.vibrance
        case .saturation: return model.saturation
        case .clarity:    return model.clarity
        case .texture:    return model.texture
        case .dehaze:     return model.dehaze
        case .sharpen:    return model.sharpenAmount
        case .noise:      return model.nrLuminance
        case .colorNR:    return model.nrColor
        // Capture sharpening (#271) — relocated from the Develop tab (#875).
        case .captureSharpen: return model.captureSharpeningAmount
        case .captureSigma:   return model.captureSharpeningSigma
        // S5 effects (#1109 / #1110 / #1111) — wired; the drag bars read
        // each tool's primary sub-param.
        case .vignette:   return model.vignetteAmount
        case .grain:      return model.grainAmount
        case .splitTone:  return model.splitToneBalance
        // B&W Mix (#276) — first-declared sub-param, see `displayRange`.
        case .bwMix:      return model.grayMixerRed
        // Stub tools — not wired.
        default:          return 0
        }
    }

    /// Canonical default display value per tool. Matches the
    /// `AdjustmentModel` field defaults — `colorNR` is 25, `sharpen` is
    /// 40, `temp` is 6500 K, everything else is 0. Used by reset
    /// semantics and by the modified-dot check, so a default asset never
    /// reads as "modified".
    ///
    /// The S5 effects tools (#1109 / #1110 / #1111) are wired and their
    /// primary-field defaults ARE 0 (vignetteAmount / grainAmount /
    /// splitToneBalance), so the fall-through is correct for all three.
    public static func defaultDisplayValue(for tool: Tool) -> Double {
        switch tool {
        case .temp:    return 6500
        case .sharpen: return 40
        case .colorNR: return 25
        // Capture-sharpening Sigma default is 1.0 px (Amount default 0
        // falls through). Keeps a fresh asset off the modified dot (#875).
        case .captureSigma: return 1.0
        default:       return 0
        }
    }

    /// Mutate the wired `AdjustmentModel` field from a display-range value.
    public static func apply(_ value: Double, to model: inout AdjustmentModel, tool: Tool) {
        switch tool {
        case .exposure:   model.exposure = value
        case .brightness: model.brightness = value
        case .contrast:   model.contrast = value
        case .highlights: model.highlights = value
        case .shadows:    model.shadows = value
        case .whites:     model.whites = value
        case .blacks:     model.blacks = value
        case .temp:       model.temperature = value
        case .tint:       model.tint = value
        case .vibrance:   model.vibrance = value
        case .saturation: model.saturation = value
        case .clarity:    model.clarity = value
        case .texture:    model.texture = value
        case .dehaze:     model.dehaze = value
        case .sharpen:    model.sharpenAmount = value
        case .noise:      model.nrLuminance = value
        case .colorNR:    model.nrColor = value
        // Capture sharpening (#271) — relocated from the Develop tab (#875).
        case .captureSharpen: model.captureSharpeningAmount = value
        case .captureSigma:   model.captureSharpeningSigma = value
        // S5 effects (#1109 / #1110 / #1111) — wired writes to each
        // tool's primary sub-param.
        case .vignette:   model.vignetteAmount = value
        case .grain:      model.grainAmount = value
        case .splitTone:  model.splitToneBalance = value
        // B&W Mix (#276) — first-declared sub-param, see `displayRange`.
        case .bwMix:      model.grayMixerRed = value
        // Stub tools — no-op.
        default: break
        }
    }
}
