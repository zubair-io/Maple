// EditorState.swift — responsive-program S5 (#625).
//
// Thin coordinator over an existing `EditSession`. Owns transient UI state
// only: which tool/group is armed, whether fine-mode is active. The actual
// model state (slider values, undo/redo, debounced sidecar writes) stays
// on `EditSession` — `EditorState` reads through and delegates so the
// editor and existing surfaces never diverge.
//
// Why not a parallel store? Risk #4 in the S5 spec calls out the race:
// any duplicate `values` dict here would have to round-trip through
// `EditSession.model` to reach `XMPSidecarStore.update`'s 750ms debounce.
// Two source-of-truths invite drift. Keeping one (`EditSession.model`)
// makes the undo/save invariants trivially true.
//
// Spec: docs/design/responsive-program/s5-editor.md §4.

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

/// 22 tools grouped per spec §2 "Groups & tools".
public enum Tool: String, CaseIterable, Sendable, Hashable {
    // Light
    case exposure, contrast, highlights, shadows, whites, blacks
    // Color
    case temp, tint, vibrance, saturation, hsl
    // Effects
    case clarity, texture, dehaze, vignette, grain, splitTone
    // Detail
    case sharpen, noise, colorNR, crop, presets

    public var group: ToolGroup {
        switch self {
        case .exposure, .contrast, .highlights, .shadows, .whites, .blacks:
            return .light
        case .temp, .tint, .vibrance, .saturation, .hsl:
            return .color
        case .clarity, .texture, .dehaze, .vignette, .grain, .splitTone:
            return .effects
        case .sharpen, .noise, .colorNR, .crop, .presets:
            return .detail
        }
    }

    public var displayName: String {
        switch self {
        case .exposure:   return "Exposure"
        case .contrast:   return "Contrast"
        case .highlights: return "Highlights"
        case .shadows:    return "Shadows"
        case .whites:     return "Whites"
        case .blacks:     return "Blacks"
        case .temp:       return "Temp"
        case .tint:       return "Tint"
        case .vibrance:   return "Vibrance"
        case .saturation: return "Saturation"
        case .hsl:        return "HSL"
        case .clarity:    return "Clarity"
        case .texture:    return "Texture"
        case .dehaze:     return "Dehaze"
        case .vignette:   return "Vignette"
        case .grain:      return "Grain"
        case .splitTone:  return "Split Tone"
        case .sharpen:    return "Sharpen"
        case .noise:      return "Noise"
        case .colorNR:    return "Color NR"
        case .crop:       return "Crop"
        case .presets:    return "Presets"
        }
    }

    /// True when this tool is wired to an `AdjustmentModel` field. The
    /// remaining "v0.1 stub" tools render in the pill row but route to
    /// "Coming soon" — follow-up tickets track field additions.
    public var isWired: Bool {
        switch self {
        case .hsl, .vignette, .grain, .splitTone, .crop, .presets:
            return false
        default:
            return true
        }
    }

    public static func tools(in group: ToolGroup) -> [Tool] {
        Self.allCases.filter { $0.group == group }
    }
}

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
        case .tint:     return -100...100
        case .contrast, .highlights, .shadows, .whites, .blacks,
             .vibrance, .saturation,
             .clarity, .texture, .dehaze:
            return -100...100
        case .sharpen:  return 0...150
        case .noise, .colorNR: return 0...100
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
        case .noise, .colorNR:
            // 0..100, default 0 at v=-100 / 25 at v=0 for colorNR? We keep
            // the simple symmetric mapping: 0 at v=-100, 100 at v=+100.
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
        case .noise, .colorNR:
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
        // Stub tools — not wired.
        default:          return 0
        }
    }

    /// Mutate the wired `AdjustmentModel` field from a display-range value.
    public static func apply(_ value: Double, to model: inout AdjustmentModel, tool: Tool) {
        switch tool {
        case .exposure:   model.exposure = value
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
        // Stub tools — no-op.
        default: break
        }
    }
}

// MARK: - EditorState

/// Transient UI state for the editor. Reads model state through an
/// associated `EditSession`; never duplicates `AdjustmentModel` fields.
@MainActor
@Observable
public final class EditorState {
    public let session: EditSession

    /// The currently-armed (group, tool) — the next drag-bar gesture
    /// targets this tool. Persisted by callers via `cm.editor.armed`.
    public var armedGroup: ToolGroup
    public var armedTool: Tool

    /// `true` while a long-press on the drag-bar marker has activated
    /// fine-mode (next drag is 0.25:1 instead of the bar/canvas defaults).
    /// Released on touch-up by the gesture handler.
    public var fineMode: Bool = false

    public init(session: EditSession,
                armedGroup: ToolGroup = .light,
                armedTool: Tool = .exposure)
    {
        self.session = session
        self.armedGroup = armedGroup
        self.armedTool = armedTool
    }

    /// `true` when the session's model has diverged from its original
    /// (mirrors EditSession's intent — there's no `isDirty` field on
    /// EditSession today; compare against the snapshot at open).
    public var isDirty: Bool {
        session.model != session.originalModel
    }

    // MARK: Arm / select

    /// Arm a tool. If it belongs to a different group, switch group too.
    public func arm(tool: Tool) {
        self.armedTool = tool
        self.armedGroup = tool.group
    }

    /// Arm a group. Re-arms the first tool in that group if the currently-
    /// armed tool is not a member.
    public func arm(group: ToolGroup) {
        self.armedGroup = group
        if armedTool.group != group {
            armedTool = Tool.tools(in: group).first ?? armedTool
        }
    }

    // MARK: Value pipe (display-range)

    /// Live read of the currently-armed tool's display-range value (e.g.
    /// `+0.25` EV for exposure, `5800` K for temp).
    public var armedDisplayValue: Double {
        ToolValueMapping.currentDisplayValue(session.model, tool: armedTool)
    }

    /// Live write — applied immediately (no debounce here; EditSession's
    /// `model` setter already routes to `XMPSidecarStore.update`'s 750ms
    /// debounce). Caller is responsible for `commit()`-ing on gesture
    /// release so undo snapshot boundaries land at slider-up.
    public func setArmedDisplayValue(_ value: Double) {
        guard armedTool.isWired else { return }
        ToolValueMapping.apply(value, to: &session.model, tool: armedTool)
    }

    /// Convert the drag-bar's internal `[-100, +100]` value and apply.
    public func setArmedInternalValue(_ v: Double) {
        let display = ToolValueMapping.displayValue(for: armedTool, internalValue: v)
        setArmedDisplayValue(display)
    }

    /// Snapshot the current model for undo. Call on slider release /
    /// keyboard shortcut / preset apply (per spec §4 "Undo commit
    /// boundaries").
    public func commit() {
        session.beginEdit()
    }

    // MARK: Undo / redo / reset

    public var canUndo: Bool { session.canUndo }
    public var canRedo: Bool { session.canRedo }

    public func undo() { session.undo() }
    public func redo() { session.redo() }

    /// Reset only the armed tool to its default (typically 0).
    public func resetArmedTool() {
        guard armedTool.isWired else { return }
        commit()
        let defaultDisplay: Double
        switch armedTool {
        case .temp:    defaultDisplay = 6500
        case .sharpen: defaultDisplay = 40
        default:       defaultDisplay = 0
        }
        setArmedDisplayValue(defaultDisplay)
    }

    /// Reset to the snapshot at session open (clears all sliders).
    public func resetAll() {
        session.resetToOriginal()
    }
}
