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

/// 25 tools grouped per spec §2 "Groups & tools". Capture-sharpening
/// Amount / Sigma (`captureSharpen` / `captureSigma`) joined the Detail
/// group in #875 when the Develop tab — their only prior surface — was
/// removed; they map directly to the `captureSharpening*` fields.
/// Brightness (#1102 midtone-band gain) joined Light per tone-zoom spec
/// §10.0 (#1108), placed directly after Exposure to match the
/// scene_tone_controls pipeline order (exposure → brightness).
/// Declaration order is presentation order (`tools(in:)` filters
/// `allCases`).
public enum Tool: String, CaseIterable, Sendable, Hashable {
    // Light
    case exposure, brightness, contrast, highlights, shadows, whites, blacks
    // Color
    case temp, tint, vibrance, saturation, hsl
    // Effects
    case clarity, texture, dehaze, vignette, grain, splitTone
    // Detail
    case sharpen, noise, colorNR, captureSharpen, captureSigma, crop, presets

    public var group: ToolGroup {
        switch self {
        case .exposure, .brightness, .contrast, .highlights, .shadows, .whites, .blacks:
            return .light
        case .temp, .tint, .vibrance, .saturation, .hsl:
            return .color
        case .clarity, .texture, .dehaze, .vignette, .grain, .splitTone:
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
    /// (#1109), grain (#1110), splitTone (#1111) left the #952 stub list
    /// as their stages landed. HSL (#636) and Crop (#638) remain stubs
    /// pending their own specs.
    ///
    /// Presets left the stub list at #1115: the pill opens the presets
    /// sheet/popover (see EditorView) instead of carrying a drag-bar
    /// value — `displayRange` stays nil, so the value pipe is inert for
    /// it (the scrub/reset guards also check `displayRange`).
    public var isWired: Bool {
        switch self {
        case .hsl, .crop:
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

    /// Armed sub-param id for multi-param tools (#1108, spec §10.0);
    /// `nil` while a single-param tool is armed. Resolved on every
    /// `arm(tool:)` from the session memory (last selection per tool,
    /// falling back to the first declared). Mutate via
    /// `arm(subParamId:)`.
    public private(set) var armedSubParamId: String?

    /// Session-scoped per-tool sub-param memory — shared across
    /// `EditorState` instances because both editor hosts rebuild the
    /// state per asset (NOT in XMP, not in `cm.*`).
    private let subParamMemory: ToolSubParamMemory

    /// `true` while a long-press on the drag-bar marker has activated
    /// fine-mode (next drag is 0.25:1 instead of the bar/canvas defaults).
    /// Released on touch-up by the gesture handler.
    public var fineMode: Bool = false

    /// Canvas zoom/pan state for the editor's image canvas (#1099,
    /// spec §5.0). Owned here so its lifetime matches the (session,
    /// editor) pairing exactly — both hosts (`EditorSessionHost`,
    /// `EditorDestination`) rebuild `EditorState` per asset, which
    /// resets zoom to fit on every open, same as the legacy surface.
    public let zoom: CanvasZoomController

    /// `subParamMemory` defaults to the app-session `.shared` store;
    /// tests inject fresh instances for isolation. (`nil` sentinel
    /// instead of a `.shared` default argument — a MainActor-isolated
    /// default value is a Swift 6 error in nonisolated default-arg
    /// position.)
    public init(session: EditSession,
                armedGroup: ToolGroup = .light,
                armedTool: Tool = .exposure,
                subParamMemory: ToolSubParamMemory? = nil)
    {
        let memory = subParamMemory ?? .shared
        self.session = session
        self.armedGroup = armedGroup
        self.armedTool = armedTool
        self.subParamMemory = memory
        self.zoom = CanvasZoomController(session: session)
        self.armedSubParamId = Self.resolveSubParamId(
            for: armedTool, memory: memory
        )
    }

    /// `true` when the session's model has diverged from its original
    /// (mirrors EditSession's intent — there's no `isDirty` field on
    /// EditSession today; compare against the snapshot at open).
    public var isDirty: Bool {
        session.model != session.originalModel
    }

    // MARK: Arm / select

    /// Arm a tool. If it belongs to a different group, switch group too.
    /// The armed sub-param re-resolves from the session memory (#1108).
    public func arm(tool: Tool) {
        self.armedTool = tool
        self.armedGroup = tool.group
        self.armedSubParamId = Self.resolveSubParamId(
            for: tool, memory: subParamMemory
        )
    }

    /// Arm a group. Re-arms the first tool in that group if the currently-
    /// armed tool is not a member.
    public func arm(group: ToolGroup) {
        self.armedGroup = group
        if armedTool.group != group {
            arm(tool: Tool.tools(in: group).first ?? armedTool)
        }
    }

    /// Arm a sub-param of the armed tool (#1108, spec §10.0). No-op for
    /// ids the tool doesn't declare (and therefore for single-param
    /// tools). Remembered per tool for the session.
    public func arm(subParamId: String) {
        guard let sub = armedTool.subParams.first(where: { $0.id == subParamId })
        else { return }
        armedSubParamId = sub.id
        subParamMemory.remember(sub.id, for: armedTool)
    }

    /// Ordered sub-params of the armed tool (empty for single-param tools).
    public var armedSubParams: [ToolSubParam] { armedTool.subParams }

    /// The armed (tool, subParam) pair's sub-param — `nil` while a
    /// single-param tool is armed, in which case the `ToolValueMapping`
    /// tool-level path applies unchanged.
    public var armedSubParam: ToolSubParam? {
        guard let id = armedSubParamId else { return nil }
        return armedTool.subParams.first { $0.id == id }
    }

    /// Remembered (session) sub-param for `tool`, falling back to the
    /// first-declared; `nil` for single-param tools.
    private static func resolveSubParamId(
        for tool: Tool, memory: ToolSubParamMemory
    ) -> String? {
        let subs = tool.subParams
        guard !subs.isEmpty else { return nil }
        if let remembered = memory.recall(for: tool),
           subs.contains(where: { $0.id == remembered })
        {
            return remembered
        }
        return subs.first?.id
    }

    // MARK: Value pipe (display-range)

    /// Live read of the armed (tool, subParam) pair's display-range value
    /// (e.g. `+0.25` EV for exposure, `5800` K for temp, `1.0` px for
    /// Sharpen · Radius).
    public var armedDisplayValue: Double {
        if let sub = armedSubParam {
            return session.model[keyPath: sub.keyPath]
        }
        return ToolValueMapping.currentDisplayValue(session.model, tool: armedTool)
    }

    /// The armed pair's value on the drag-bar's internal `[-100, +100]`
    /// scale — the single place display↔internal resolution happens, so
    /// `DragBar` and `wheelNudge` can't disagree about the armed
    /// sub-param's mapping (#1108).
    public var armedInternalValue: Double {
        if let sub = armedSubParam {
            return sub.internalValue(displayValue: armedDisplayValue)
        }
        return ToolValueMapping.internalValue(for: armedTool, displayValue: armedDisplayValue)
    }

    /// `true` when the armed (tool, subParam) pair can accept drag-bar
    /// value edits. Sub-params always carry a generated range + field
    /// (#1108); single-param tools must be wired AND carry a display
    /// range. Presets (#1115, wired but value-less) and the gated stubs
    /// (#952) fail this. The scrub paths below guard on it, and `DragBar`
    /// disables hit-testing on it so a gesture's touch-down `commit()`
    /// can't push a junk undo snapshot for a value write that would be
    /// ignored anyway.
    public var armedToolAcceptsValueEdits: Bool {
        guard armedTool.isWired else { return false }
        if armedSubParam != nil { return true }
        return ToolValueMapping.displayRange(for: armedTool) != nil
    }

    /// Live write — applied immediately (no debounce here; EditSession's
    /// `model` setter already routes to `XMPSidecarStore.update`'s 750ms
    /// debounce). Caller is responsible for `commit()`-ing on gesture
    /// release so undo snapshot boundaries land at slider-up.
    ///
    /// The guard skips wired-but-value-less tools (presets, #1115):
    /// without it the inout write-back through `ToolValueMapping.apply`
    /// would fire `session.model`'s setter (and its sidecar debounce) for
    /// a no-op.
    public func setArmedDisplayValue(_ value: Double) {
        guard armedToolAcceptsValueEdits else { return }
        if let sub = armedSubParam {
            session.model[keyPath: sub.keyPath] = value
        } else {
            ToolValueMapping.apply(value, to: &session.model, tool: armedTool)
        }
    }

    /// Convert the drag-bar's internal `[-100, +100]` value and apply
    /// through the armed pair's mapping.
    public func setArmedInternalValue(_ v: Double) {
        if let sub = armedSubParam {
            setArmedDisplayValue(sub.displayValue(internalValue: v))
        } else {
            setArmedDisplayValue(ToolValueMapping.displayValue(for: armedTool, internalValue: v))
        }
    }

    // MARK: Wheel nudge (desktop)

    /// Wheel-nudge undo coalescing (#1099): detents within a burst share
    /// one snapshot; a pause or an armed-tool change starts a new one.
    /// `@ObservationIgnored` — bookkeeping only, never drives a view.
    @ObservationIgnored private var wheelNudgeBurst = WheelNudgeBurst()

    /// Plain scroll wheel over the canvas at fit zoom nudges the armed
    /// (tool, subParam) pair by `steps × unit` internal units (±1 per
    /// detent; the host resolves the modifier-scaled unit — ±10 shift,
    /// ±0.1 option; S5 desktop contract, routed via
    /// `CanvasZoomHost.onWheelEditing`). Detents within a burst share one
    /// undo snapshot, mirroring `DragBar`'s commit-at-gesture-start
    /// boundary; a > 0.5 s pause OR a change of the armed pair (tool OR
    /// sub-param, #1108) starts a new burst (#1125 review — see
    /// `WheelNudgeBurst`). `now` is injectable for tests.
    public func wheelNudge(steps: Int, unit: Double, at now: Date = Date()) {
        guard steps != 0, armedToolAcceptsValueEdits else { return }
        if wheelNudgeBurst.beginsNewBurst(
            tool: armedTool, subParamId: armedSubParamId, at: now
        ) {
            commit()
        }
        setArmedInternalValue(DragBarMath.clamp(armedInternalValue + Double(steps) * unit))
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

    /// Reset only the armed (tool, subParam) pair to its canonical
    /// default. Defaults mirror the generated `AdjustmentModel` field
    /// defaults (Color NR = 25, Sharpen = 40, Temp = 6500) so a fresh
    /// asset never reads as "modified" and reset returns to the same
    /// value the model was born with. On a multi-param tool only the
    /// ARMED sub-param resets — the others keep their values (#1108).
    public func resetArmedTool() {
        // The guard skips wired-but-value-less tools (presets, #1115) so
        // they can't push junk undo entries.
        guard armedToolAcceptsValueEdits else { return }
        commit()
        if let sub = armedSubParam {
            setArmedDisplayValue(sub.defaultDisplayValue)
        } else {
            setArmedDisplayValue(ToolValueMapping.defaultDisplayValue(for: armedTool))
        }
    }

    /// Reset to the snapshot at session open (clears all sliders).
    public func resetAll() {
        session.resetToOriginal()
    }

    // MARK: AUTO (#1379) — resetToFactoryDefaults() + applyAuto() → EditorState+AutoReset.swift

    /// True while an AUTO analysis is running — drives the AUTO button's
    /// disabled + progress state. Observed (`@Observable`).
    public internal(set) var autoInProgress = false

    /// Monotonic guard so a slow AUTO result can't clobber a newer edit or a
    /// filmstrip image switch.
    @ObservationIgnored var autoGeneration: UInt64 = 0

    /// Test seam: the analyzer `applyAuto` calls. Defaults to the real FFI;
    /// tests inject a deterministic result so they need no RAW fixture.
    @ObservationIgnored
    var autoProvider: @Sendable (URL) async throws -> AutoAdjustmentsResult = { url in
        try await AutoAdjustments.compute(forRawAt: url)
    }

    // MARK: Presets (#1115, spec §10.7)

    /// Apply a preset: sparse merge of its recognized fields into the
    /// current model as ONE undo-ring entry (`commit()` then a single
    /// `session.model` write). Persistence rides the existing debounced
    /// XMP sidecar save inside `EditSession.model`'s setter — presets
    /// never touch original files. Returns false when the preset carries
    /// nothing this client can apply (unknown-only fields), in which case
    /// no undo entry is pushed.
    @discardableResult
    public func applyPreset(_ preset: Preset) -> Bool {
        let (merged, applied) = PresetAdjustments.merged(
            session.model, applying: preset.fields
        )
        guard applied > 0 else { return false }
        commit()
        session.model = merged
        return true
    }

    /// Sparse capture of the current model's non-default schema fields —
    /// what "Save preset" stores.
    public func capturePresetFields() -> [String: PresetFieldValue] {
        PresetAdjustments.captureFields(from: session.model)
    }
}
