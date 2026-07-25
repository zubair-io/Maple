// PresetAdjustmentBridge.swift — preset ↔ AdjustmentModel mapping (#1115).
//
// Capture (save-preset) walks every canonical `FieldName` and records the
// NON-DEFAULT values as a sparse map; apply merges a sparse map back into
// a model. Both directions are defensive by design — storage is validated
// at save time, but presets written by NEWER schema versions (or by the
// web, whose generated model carries fields the Swift struct doesn't have
// yet) flow through here too:
//
//   - unknown keys → skipped on apply (they stay preserved in the document)
//   - numeric fields → must be finite; clamped to the canonical generated
//     range
//   - enum fields → applied only when the value is a known variant
//
// Fields in `FieldName` that the Swift `AdjustmentModel` does NOT carry
// (`wb_method`, `tone_curve_mode`, and the deprecated
// `capture_sharpening_radius` alias) map to nil below: never captured,
// skipped on apply, preserved in storage — the passthrough rule keeps a
// web-written preset intact even though Apple can't apply those fields
// until the Swift model gains them. `auto_exposure` (#1387) is now a Swift
// enum field like `highlightRecovery` / `profile` — captured and applied
// below, not routed through this passthrough list.
//
// The four `tone_curve_*` point curves (#366) map to nil for a different
// reason: the Swift model DOES carry them, but a preset `fields` map is a
// flat scalar map on every client, so a structured curve has nowhere to go.
// Curve presets land with the curve editor (#367).

import Foundation

extension AdjustmentModel.FieldName {
    /// Key path into the Swift model for numeric schema fields; nil for
    /// enum-valued fields and for fields the Swift model doesn't carry.
    var numericKeyPath: WritableKeyPath<AdjustmentModel, Double>? {
        switch self {
        case .temperature:                  return \.temperature
        case .tint:                         return \.tint
        case .exposure:                     return \.exposure
        case .contrast:                     return \.contrast
        case .brightness:                   return \.brightness
        case .highlights:                   return \.highlights
        case .shadows:                      return \.shadows
        case .whites:                       return \.whites
        case .blacks:                       return \.blacks
        case .parametricHighlights:         return \.parametricHighlights
        case .parametricLights:             return \.parametricLights
        case .parametricDarks:              return \.parametricDarks
        case .parametricShadows:            return \.parametricShadows
        case .vibrance:                     return \.vibrance
        case .saturation:                   return \.saturation
        case .clarity:                      return \.clarity
        case .texture:                      return \.texture
        case .sharpenAmount:                return \.sharpenAmount
        case .sharpenRadius:                return \.sharpenRadius
        case .sharpenDetail:                return \.sharpenDetail
        case .sharpenMasking:               return \.sharpenMasking
        case .captureSharpeningAmount:      return \.captureSharpeningAmount
        case .captureSharpeningSigma:       return \.captureSharpeningSigma
        case .nrLuminance:                  return \.nrLuminance
        case .nrColor:                      return \.nrColor
        case .dehaze:                       return \.dehaze
        case .vignetteAmount:               return \.vignetteAmount
        case .vignetteFeather:              return \.vignetteFeather
        case .grainAmount:                  return \.grainAmount
        case .grainSize:                    return \.grainSize
        case .grainRoughness:               return \.grainRoughness
        case .splitToneShadowHue:           return \.splitToneShadowHue
        case .splitToneShadowSaturation:    return \.splitToneShadowSaturation
        case .splitToneHighlightHue:        return \.splitToneHighlightHue
        case .splitToneHighlightSaturation: return \.splitToneHighlightSaturation
        case .splitToneBalance:             return \.splitToneBalance
        // HSL 8-band per-channel adjustments (#1112).
        case .hueAdjustmentRed:             return \.hueAdjustmentRed
        case .hueAdjustmentOrange:          return \.hueAdjustmentOrange
        case .hueAdjustmentYellow:          return \.hueAdjustmentYellow
        case .hueAdjustmentGreen:           return \.hueAdjustmentGreen
        case .hueAdjustmentAqua:            return \.hueAdjustmentAqua
        case .hueAdjustmentBlue:            return \.hueAdjustmentBlue
        case .hueAdjustmentPurple:          return \.hueAdjustmentPurple
        case .hueAdjustmentMagenta:         return \.hueAdjustmentMagenta
        case .saturationAdjustmentRed:      return \.saturationAdjustmentRed
        case .saturationAdjustmentOrange:   return \.saturationAdjustmentOrange
        case .saturationAdjustmentYellow:   return \.saturationAdjustmentYellow
        case .saturationAdjustmentGreen:    return \.saturationAdjustmentGreen
        case .saturationAdjustmentAqua:     return \.saturationAdjustmentAqua
        case .saturationAdjustmentBlue:     return \.saturationAdjustmentBlue
        case .saturationAdjustmentPurple:   return \.saturationAdjustmentPurple
        case .saturationAdjustmentMagenta:  return \.saturationAdjustmentMagenta
        case .luminanceAdjustmentRed:       return \.luminanceAdjustmentRed
        case .luminanceAdjustmentOrange:    return \.luminanceAdjustmentOrange
        case .luminanceAdjustmentYellow:    return \.luminanceAdjustmentYellow
        case .luminanceAdjustmentGreen:     return \.luminanceAdjustmentGreen
        case .luminanceAdjustmentAqua:      return \.luminanceAdjustmentAqua
        case .luminanceAdjustmentBlue:      return \.luminanceAdjustmentBlue
        case .luminanceAdjustmentPurple:    return \.luminanceAdjustmentPurple
        case .luminanceAdjustmentMagenta:   return \.luminanceAdjustmentMagenta
        // Decode-time chroma pre-filter (#1104) — numeric decode-product
        // field; capture/apply like any slider.
        case .chromaPrefilter:              return \.chromaPrefilter
        // BM3D deep denoise (#1105) — numeric decode-product field.
        case .deepDenoise:                  return \.deepDenoise
        // Deprecated alias — no Swift property (see AdjustmentModel docs).
        case .captureSharpeningRadius:      return nil
        // Enum-valued / not in the Swift model. `.autoExposure` (#1387) has
        // no *numeric* key path — like `.highlightRecovery`, it's captured
        // and applied as a string enum below instead.
        case .wbMethod, .highlightRecovery, .autoExposure, .look, .profile,
             .toneCurveMode, .hotPixelSuppression:
            return nil
        // Point curves (#366) — structured `ToneCurve` values, not scalars.
        // A preset `fields` map is flat (number | string | bool) on every
        // client, so curves are neither captured nor applied here; the web
        // preset layer skips them for the same reason. Point-curve presets
        // land with the curve editor (#367).
        case .toneCurveLuma, .toneCurveRed, .toneCurveGreen, .toneCurveBlue:
            return nil
        }
    }

    /// Canonical generated range for numeric schema fields.
    var numericRange: ClosedRange<Double>? {
        switch self {
        case .temperature:                  return AdjustmentModel.temperatureRange
        case .tint:                         return AdjustmentModel.tintRange
        case .exposure:                     return AdjustmentModel.exposureRange
        case .contrast:                     return AdjustmentModel.contrastRange
        case .brightness:                   return AdjustmentModel.brightnessRange
        case .highlights:                   return AdjustmentModel.highlightsRange
        case .shadows:                      return AdjustmentModel.shadowsRange
        case .whites:                       return AdjustmentModel.whitesRange
        case .blacks:                       return AdjustmentModel.blacksRange
        case .parametricHighlights:         return AdjustmentModel.parametricHighlightsRange
        case .parametricLights:             return AdjustmentModel.parametricLightsRange
        case .parametricDarks:              return AdjustmentModel.parametricDarksRange
        case .parametricShadows:            return AdjustmentModel.parametricShadowsRange
        case .vibrance:                     return AdjustmentModel.vibranceRange
        case .saturation:                   return AdjustmentModel.saturationRange
        case .clarity:                      return AdjustmentModel.clarityRange
        case .texture:                      return AdjustmentModel.textureRange
        case .sharpenAmount:                return AdjustmentModel.sharpenAmountRange
        case .sharpenRadius:                return AdjustmentModel.sharpenRadiusRange
        case .sharpenDetail:                return AdjustmentModel.sharpenDetailRange
        case .sharpenMasking:               return AdjustmentModel.sharpenMaskingRange
        case .captureSharpeningAmount:      return AdjustmentModel.captureSharpeningAmountRange
        case .captureSharpeningSigma:       return AdjustmentModel.captureSharpeningSigmaRange
        case .nrLuminance:                  return AdjustmentModel.nrLuminanceRange
        case .nrColor:                      return AdjustmentModel.nrColorRange
        case .dehaze:                       return AdjustmentModel.dehazeRange
        case .vignetteAmount:               return AdjustmentModel.vignetteAmountRange
        case .vignetteFeather:              return AdjustmentModel.vignetteFeatherRange
        case .grainAmount:                  return AdjustmentModel.grainAmountRange
        case .grainSize:                    return AdjustmentModel.grainSizeRange
        case .grainRoughness:               return AdjustmentModel.grainRoughnessRange
        case .splitToneShadowHue:           return AdjustmentModel.splitToneShadowHueRange
        case .splitToneShadowSaturation:    return AdjustmentModel.splitToneShadowSaturationRange
        case .splitToneHighlightHue:        return AdjustmentModel.splitToneHighlightHueRange
        case .splitToneHighlightSaturation:
            return AdjustmentModel.splitToneHighlightSaturationRange
        case .splitToneBalance:             return AdjustmentModel.splitToneBalanceRange
        // HSL 8-band per-channel adjustments (#1112).
        case .hueAdjustmentRed:             return AdjustmentModel.hueAdjustmentRedRange
        case .hueAdjustmentOrange:          return AdjustmentModel.hueAdjustmentOrangeRange
        case .hueAdjustmentYellow:          return AdjustmentModel.hueAdjustmentYellowRange
        case .hueAdjustmentGreen:           return AdjustmentModel.hueAdjustmentGreenRange
        case .hueAdjustmentAqua:            return AdjustmentModel.hueAdjustmentAquaRange
        case .hueAdjustmentBlue:            return AdjustmentModel.hueAdjustmentBlueRange
        case .hueAdjustmentPurple:          return AdjustmentModel.hueAdjustmentPurpleRange
        case .hueAdjustmentMagenta:         return AdjustmentModel.hueAdjustmentMagentaRange
        case .saturationAdjustmentRed:      return AdjustmentModel.saturationAdjustmentRedRange
        case .saturationAdjustmentOrange:   return AdjustmentModel.saturationAdjustmentOrangeRange
        case .saturationAdjustmentYellow:   return AdjustmentModel.saturationAdjustmentYellowRange
        case .saturationAdjustmentGreen:    return AdjustmentModel.saturationAdjustmentGreenRange
        case .saturationAdjustmentAqua:     return AdjustmentModel.saturationAdjustmentAquaRange
        case .saturationAdjustmentBlue:     return AdjustmentModel.saturationAdjustmentBlueRange
        case .saturationAdjustmentPurple:   return AdjustmentModel.saturationAdjustmentPurpleRange
        case .saturationAdjustmentMagenta:  return AdjustmentModel.saturationAdjustmentMagentaRange
        case .luminanceAdjustmentRed:       return AdjustmentModel.luminanceAdjustmentRedRange
        case .luminanceAdjustmentOrange:    return AdjustmentModel.luminanceAdjustmentOrangeRange
        case .luminanceAdjustmentYellow:    return AdjustmentModel.luminanceAdjustmentYellowRange
        case .luminanceAdjustmentGreen:     return AdjustmentModel.luminanceAdjustmentGreenRange
        case .luminanceAdjustmentAqua:      return AdjustmentModel.luminanceAdjustmentAquaRange
        case .luminanceAdjustmentBlue:      return AdjustmentModel.luminanceAdjustmentBlueRange
        case .luminanceAdjustmentPurple:    return AdjustmentModel.luminanceAdjustmentPurpleRange
        case .luminanceAdjustmentMagenta:   return AdjustmentModel.luminanceAdjustmentMagentaRange
        case .chromaPrefilter:              return AdjustmentModel.chromaPrefilterRange
        case .deepDenoise:                  return AdjustmentModel.deepDenoiseRange
        default:                            return nil
        }
    }
}

// MARK: - PresetAdjustments

public enum PresetAdjustments {
    /// Capture the model's NON-DEFAULT schema fields as a sparse preset
    /// `fields` map (canonical snake_case keys). Enum fields record their
    /// raw string value; only fields the Swift model carries can ever be
    /// captured (matching the S5 sliders, which write the same fields).
    public static func captureFields(from model: AdjustmentModel) -> [String: PresetFieldValue] {
        let defaults = AdjustmentModel.default
        var fields: [String: PresetFieldValue] = [:]
        for field in AdjustmentModel.FieldName.allCases {
            if let keyPath = field.numericKeyPath {
                let value = model[keyPath: keyPath]
                if value != defaults[keyPath: keyPath] {
                    fields[field.rawValue] = .number(value)
                }
                continue
            }
            switch field {
            case .highlightRecovery where model.highlightRecovery != defaults.highlightRecovery:
                fields[field.rawValue] = .string(model.highlightRecovery.rawValue)
            case .look where model.look != defaults.look:
                fields[field.rawValue] = .string(model.look.rawValue)
            case .profile where model.profile != defaults.profile:
                fields[field.rawValue] = .string(model.profile.rawValue)
            // Hot/dead-pixel suppression (#1106) — enum decode-product field.
            case .hotPixelSuppression
                where model.hotPixelSuppression != defaults.hotPixelSuppression:
                fields[field.rawValue] = .string(model.hotPixelSuppression.rawValue)
            // Auto-exposure (#1387) — enum decode-product field.
            case .autoExposure where model.autoExposure != defaults.autoExposure:
                fields[field.rawValue] = .string(model.autoExposure.rawValue)
            default:
                break
            }
        }
        return fields
    }

    /// Merge a sparse `fields` map into `model`. Returns the merged model
    /// plus how many fields were recognized and applied — zero means the
    /// preset had nothing this client understands (apply should no-op
    /// rather than push an empty undo entry).
    public static func merged(
        _ model: AdjustmentModel,
        applying fields: [String: PresetFieldValue]
    ) -> (model: AdjustmentModel, appliedFieldCount: Int) {
        var merged = model
        var applied = 0
        for (key, value) in fields {
            guard let field = AdjustmentModel.FieldName(rawValue: key) else {
                continue // Unknown field (newer schema) — preserved, never applied.
            }
            if let keyPath = field.numericKeyPath {
                guard case .number(let raw) = value, raw.isFinite else { continue }
                let clamped = field.numericRange.map { min($0.upperBound, max($0.lowerBound, raw)) }
                merged[keyPath: keyPath] = clamped ?? raw
                applied += 1
                continue
            }
            // Enum-valued fields: apply only known variants. Fields the
            // Swift model doesn't carry (wb_method, tone_curve_mode,
            // capture_sharpening_radius) fall through.
            guard case .string(let rawValue) = value else { continue }
            switch field {
            case .highlightRecovery:
                guard let mode = HighlightRecoveryMode(rawValue: rawValue) else { continue }
                merged.highlightRecovery = mode
                applied += 1
            case .look:
                guard let look = Look(rawValue: rawValue) else { continue }
                merged.look = look
                applied += 1
            case .profile:
                guard let profile = Profile(rawValue: rawValue) else { continue }
                merged.profile = profile
                applied += 1
            case .hotPixelSuppression:
                guard let mode = HotPixelSuppressionMode(rawValue: rawValue) else { continue }
                merged.hotPixelSuppression = mode
                applied += 1
            case .autoExposure:
                guard let mode = AutoExposureMode(rawValue: rawValue) else { continue }
                merged.autoExposure = mode
                applied += 1
            default:
                continue
            }
        }
        return (merged, applied)
    }
}
