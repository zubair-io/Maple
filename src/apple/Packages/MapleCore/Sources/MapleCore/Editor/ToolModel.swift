// ToolModel.swift — the editor's tool taxonomy (#625).
//
// `ToolGroup` and `Tool` split out of `EditorState.swift` to stay under the
// 600-line hard budget (#482). Pure code move: every case, doc comment and
// switch is verbatim from that file. `EditorState.swift` keeps the
// coordinator itself — arming, the value pipe, undo/redo and presets.

import Foundation

// MARK: - Tool model

public enum ToolGroup: String, CaseIterable, Sendable, Hashable {
    case light
    case color
    case effects
    case detail

    public var displayName: String {
        switch self {
        case .light:   return "Light"
        case .color:   return "Color"
        case .effects: return "Effects"
        case .detail:  return "Detail"
        }
    }
}

/// 26 tools grouped per spec §2 "Groups & tools". Capture-sharpening
/// Amount / Sigma (`captureSharpen` / `captureSigma`) joined the Detail
/// group in #875 when the Develop tab — their only prior surface — was
/// removed; they map directly to the `captureSharpening*` fields.
/// Brightness (#1102 midtone-band gain) joined Light per tone-zoom spec
/// §10.0 (#1108), placed directly after Exposure to match the
/// scene_tone_controls pipeline order (exposure → brightness).
/// Tone Curve (#367) joined Light last, after the scene-tone scalars it
/// composes with.
/// Declaration order is presentation order (`tools(in:)` filters
/// `allCases`).
///
/// One deliberate divergence from the web `ToolId` union, recorded here so
/// it isn't folklore: there is no `'toneCurve'` on the web. Its
/// `EditorShellComponent` already owns a first-class curve panel with its
/// own dock toggle (`curvePanelToggle` / `curveOpen`), so the tone curve is
/// not a tool its drag bar can arm. Apple has no standalone panel — every
/// control variant swaps surfaces off `armedTool` — so an armed tool is the
/// only route to the curve here. See `tool-model.ts`'s header for the
/// mirror of this note.
public enum Tool: String, CaseIterable, Sendable, Hashable {
    // Light
    case exposure, brightness, contrast, highlights, shadows, whites, blacks, toneCurve
    // Color
    case temp, tint, vibrance, saturation, hsl, bwMix
    // Effects
    case clarity, texture, dehaze, vignette, grain, colorGrade
    // Detail
    case sharpen, noise, colorNR, captureSharpen, captureSigma, crop, presets

    public var group: ToolGroup {
        switch self {
        case .exposure, .brightness, .contrast, .highlights, .shadows, .whites, .blacks,
             .toneCurve:
            return .light
        case .temp, .tint, .vibrance, .saturation, .hsl, .bwMix:
            return .color
        case .clarity, .texture, .dehaze, .vignette, .grain, .colorGrade:
            return .effects
        case .sharpen, .noise, .colorNR, .captureSharpen, .captureSigma, .crop, .presets:
            return .detail
        }
    }

    public var displayName: String {
        switch self {
        case .exposure:   return "Exposure"
        case .brightness: return "Brightness"
        case .contrast:   return "Contrast"
        case .highlights: return "Highlights"
        case .shadows:    return "Shadows"
        case .whites:     return "Whites"
        case .blacks:     return "Blacks"
        case .toneCurve:  return "Tone Curve"
        case .temp:       return "Temp"
        case .tint:       return "Tint"
        case .vibrance:   return "Vibrance"
        case .saturation: return "Saturation"
        case .hsl:        return "HSL"
        case .bwMix:      return "B&W"
        case .clarity:    return "Clarity"
        case .texture:    return "Texture"
        case .dehaze:     return "Dehaze"
        case .vignette:   return "Vignette"
        case .grain:      return "Grain"
        case .colorGrade: return "Color Grading"
        case .sharpen:        return "Sharpen"
        case .noise:          return "Noise"
        case .colorNR:        return "Color NR"
        case .captureSharpen: return "Deconv"
        case .captureSigma:   return "Deconv σ"
        case .crop:           return "Crop"
        case .presets:        return "Presets"
        }
    }

    /// True when this tool is wired to a *pipeline-applied*
    /// `AdjustmentModel` field. Stub tools render in the pill row but
    /// reject writes (the scrub guards in `setArmedDisplayValue` /
    /// `resetArmedTool` short-circuit on `!isWired`) — follow-up tickets
    /// track the missing work.
    ///
    /// The S5 effects pills are all real pipeline stages now — vignette
    /// (#1109), grain (#1110), colour grading (#1111, extended to four
    /// wheels at #275) left the #952 stub list as their stages landed.
    /// HSL left it at #274: the 8-band Oklab
    /// stage is live in raw-core and the pill drives its 24 sub-params
    /// through `HSLSection` (it has no single primary drag-bar field, so
    /// `displayRange` stays nil and the sub-param path carries every
    /// edit). B&W Mix left it at #276, the same shape: no primary, eight
    /// sub-params driving the `grayMixer*` fields through the same 8-band
    /// stage in its monochrome mode. Crop (#638) remains a stub — its
    /// model field and pipeline math exist, but it is edited through the
    /// canvas overlay rather than the drag bar.
    ///
    /// Presets left the stub list at #1115: the pill opens the presets
    /// sheet/popover (see EditorView) instead of carrying a drag-bar
    /// value — `displayRange` stays nil, so the value pipe is inert for
    /// it (the scrub/reset guards also check `displayRange`).
    ///
    /// Tone Curve (#367) is wired and takes the HSL shape: four
    /// parametric region sub-params plus four per-channel point curves
    /// and no single primary field, so `displayRange` stays nil and
    /// `ToneCurveSection` is its whole control surface.
    public var isWired: Bool {
        switch self {
        case .crop:
            return false
        default:
            return true
        }
    }

    public static func tools(in group: ToolGroup) -> [Tool] {
        Self.allCases.filter { $0.group == group }
    }
}
