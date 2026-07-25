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

    /// Backing store for `armedTool`.
    private var armedToolStorage: Tool

    /// The currently-armed tool, normalised on read: `.hsl` is not a
    /// reachable armed state while Black & White is on (#276 × #274).
    ///
    /// `setBlackWhite` re-arms `.bwMix` when the user flips the switch,
    /// but the mode can also land straight on the model — a preset apply,
    /// an undo, a sidecar load — and every one of those paths would
    /// otherwise leave `.hsl` armed on a tool that no surface shows and
    /// no gesture should edit: `HSLSection` renders on `armedTool == .hsl`
    /// in four of the five control surfaces, and `DragBar` would happily
    /// scrub a band field through `armedSubParamId`. Normalising here
    /// makes the invariant total instead of chasing every writer.
    public var armedTool: Tool {
        get {
            armedToolStorage == .hsl && session.model.blackWhite == .on
                ? .bwMix
                : armedToolStorage
        }
        set { armedToolStorage = newValue }
    }

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
        self.armedToolStorage = armedTool
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

    // MARK: Crop session (#638)

    /// Selected crop aspect-ratio lock. Transient UI state — never persisted
    /// to XMP. Reset to `.free` on every crop entry (matches the web
    /// `CropSessionService`). Read by the crop toolbar + overlay.
    public var cropAspectId: CropAspectId = .free

    /// Resolved aspect preset for `cropAspectId`.
    public var cropAspectPreset: CropAspectPreset {
        CropAspect.preset(for: cropAspectId)
    }

    /// Select a crop aspect-ratio lock.
    public func setCropAspect(_ id: CropAspectId) {
        cropAspectId = id
    }

    // MARK: Arm / select

    /// Arm a tool. If it belongs to a different group, switch group too.
    /// The armed sub-param re-resolves from the session memory (#1108).
    ///
    /// Crop (#638): arming `.crop` puts the session into crop-editing mode
    /// (`session.cropEditingActive`) so the canvas renders UNCROPPED under
    /// the overlay, resets the aspect lock to Free (so a ratio chosen on one
    /// image doesn't carry into the next crop session), and snaps the canvas
    /// to fit + zero pan (the overlay footprint maps 1:1 onto the painted
    /// image only at fit). Arming any other tool clears crop-editing mode, so
    /// the next render publishes the cropped+straightened result.
    public func arm(tool: Tool) {
        // A parked commit-on-release value belongs to the OLD armed pair —
        // committing it now would land on the wrong field (#1153).
        cancelGesture()
        let wasCropEditing = session.cropEditingActive
        self.armedTool = tool
        self.armedGroup = tool.group
        self.armedSubParamId = Self.resolveSubParamId(
            for: tool, memory: subParamMemory
        )
        let nowCropEditing = (tool == .crop)
        // Set the session flag FIRST so `effectiveImageSize` resolves to the
        // full frame before we fit — entering crop fits the whole frame, not
        // the cropped extent.
        session.cropEditingActive = nowCropEditing
        if nowCropEditing && !wasCropEditing {
            // Entering crop — reset the aspect lock and force fit + zero pan.
            cropAspectId = .free
            zoom.resetToFit()
        }
    }

    /// Arm a group. Re-arms the first tool in that group if the currently-
    /// armed tool is not a member.
    public func arm(group: ToolGroup) {
        self.armedGroup = group
        if armedTool.group != group {
            arm(tool: Tool.tools(in: group).first ?? armedTool)
        }
    }

    /// Tools visible in `group` given the current model state (#276).
    /// Mirrors `Tool.tools(in:)` but additionally hides `.hsl` while Black
    /// & White is engaged: the 24-band HSL panel is meaningless once the
    /// image renders through the 8-band gray mixer instead (the pipeline
    /// forces the HSL bands inert while `blackWhite == .on`, same as
    /// `grayMixer*` is inert while it is `.off`). Views that render a
    /// tool-pill row for a group must call this instead of
    /// `Tool.tools(in:)` so the row reacts to the toggle.
    public func visibleTools(in group: ToolGroup) -> [Tool] {
        Tool.tools(in: group).filter { !($0 == .hsl && session.model.blackWhite == .on) }
    }

    /// True while the HSL 8-band surface may be rendered (#274 × #276).
    ///
    /// `StackedAdjustmentsPanel` pins `HSLSection` to the Color section
    /// rather than keying it on the armed tool — HSL carries 24 fields
    /// and no primary, so it is filtered out of the living-slider stack
    /// and cannot inherit the Black & White gate from either
    /// `visibleTools(in:)` or the `armedTool` normalisation. That one
    /// surface asks here. Derived from `visibleTools(in:)` rather than
    /// restating the rule, so the two can't drift.
    public var showsHSLSurface: Bool {
        visibleTools(in: .color).contains(.hsl)
    }

    /// Set the Black & White toggle (#276). Commits a snapshot first — the
    /// toggle is a discrete on/off action (like the "As Shot" WB reset in
    /// `ColorAccessoryRow`), not a continuous drag, so it gets its own undo
    /// entry. When turning it ON while `.hsl` is the armed tool, arms
    /// `.bwMix` instead — `.hsl` disappears from `visibleTools(in:)` the
    /// moment B&W engages, so nothing should remain armed on a tool the
    /// pill row no longer shows.
    public func setBlackWhite(_ mode: BlackWhiteMode) {
        commit()
        // Read the armed tool BEFORE the model moves: once `blackWhite`
        // is `.on`, `armedTool` normalises `.hsl` away on its own, so the
        // test below would never fire and the storage would keep pointing
        // at `.hsl` — flipping B&W back off would silently re-arm it.
        let wasHSLArmed = armedTool == .hsl
        session.model.blackWhite = mode
        if mode == .on && wasHSLArmed {
            arm(tool: .bwMix)
        }
    }

    /// Arm a sub-param of the armed tool (#1108, spec §10.0). No-op for
    /// ids the tool doesn't declare (and therefore for single-param
    /// tools). Remembered per tool for the session.
    public func arm(subParamId: String) {
        guard let sub = armedTool.subParams.first(where: { $0.id == subParamId })
        else { return }
        cancelGesture()
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
    /// Reads the DEFERRED value while a commit-on-release gesture parks one
    /// (#1153), so the slider, drag bar and value chip track the finger even
    /// though the model — and therefore the decode — has not moved.
    public var armedDisplayValue: Double {
        if let sub = armedSubParam {
            return deferredDisplayValue ?? session.model[keyPath: sub.keyPath]
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
        if gestureActive, armedCommitsOnRelease {
            deferredDisplayValue = value
            return
        }
        if let sub = armedSubParam {
            session.model[keyPath: sub.keyPath] = value
        } else {
            ToolValueMapping.apply(value, to: &session.model, tool: armedTool)
        }
    }

    // MARK: Commit-on-release (#1153)
    //
    // Decode-product sub-params (Noise → Deep / Prefilter) must not write the
    // model per drag sample: `RawCoreBridge.stripAppleGPUStages` KEEPS those
    // fields, so every write invalidates the decoded-buffer cache key and
    // forces a full re-decode — seconds of BM3D. A gesture over one of them
    // parks its display value here (the views read it through
    // `armedDisplayValue`) and `endGesture()` performs the single real write.

    /// In-flight, uncommitted display value; `nil` when nothing is deferred.
    public private(set) var deferredDisplayValue: Double?
    /// `true` between `beginGesture()` and `endGesture()`.
    @ObservationIgnored private var gestureActive = false

    /// `true` when writes from the armed pair are held until gesture end.
    public var armedCommitsOnRelease: Bool { armedSubParam?.commitsOnRelease ?? false }

    /// Mark the start of a continuous value gesture (drag bar, living
    /// slider, canvas scrub). Inert for every per-tick tool; pairs with
    /// `endGesture()`. IDEMPOTENT: `LivingSliderRow` has no drag-start hook
    /// and calls this from its value setter, so a repeat must not discard
    /// the value already parked by the same gesture.
    public func beginGesture() {
        guard !gestureActive else { return }
        deferredDisplayValue = nil
        gestureActive = true
    }

    /// Mark the end of a continuous value gesture and flush the parked
    /// value, if any, as the single model write of the whole gesture.
    public func endGesture() {
        wheelFlushTask?.cancel()
        let deferred = deferredDisplayValue
        gestureActive = false
        deferredDisplayValue = nil
        guard let deferred else { return }
        setArmedDisplayValue(deferred)
    }

    /// Abandon a gesture without committing its parked value (the armed
    /// pair changed under it, or the gesture was interrupted).
    public func cancelGesture() {
        wheelFlushTask?.cancel()
        gestureActive = false
        deferredDisplayValue = nil
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
        // A wheel has no "release", but a burst of detents is a gesture all
        // the same — writing a decode-product field per detent would kick a
        // re-decode per detent (#1153). Park the value and flush it when the
        // detents stop, the same trailing-idle shape the burst's own undo
        // coalescing already uses.
        if armedCommitsOnRelease { beginGesture() }
        setArmedInternalValue(DragBarMath.clamp(armedInternalValue + Double(steps) * unit))
        if armedCommitsOnRelease { scheduleWheelFlush() }
    }

    /// Trailing-idle delay after the last wheel detent before a parked
    /// commit-on-release value is written. Shorter than `WheelNudgeBurst`'s
    /// 0.5 s undo window so the decode starts before the burst is
    /// considered over, long enough that a continuous scroll doesn't flush
    /// mid-gesture.
    private static let wheelFlushDelay = Duration.milliseconds(250)

    /// The pending flush; cancelled and rescheduled on every detent, so only
    /// the last one survives. `@ObservationIgnored` — bookkeeping only.
    @ObservationIgnored private var wheelFlushTask: Task<Void, Never>?

    private func scheduleWheelFlush() {
        wheelFlushTask?.cancel()
        wheelFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.wheelFlushDelay)
            guard !Task.isCancelled, let self else { return }
            self.endGesture()
        }
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
        // A reset is an explicit, discrete edit — it always writes through,
        // even for a commit-on-release sub-param (#1153).
        cancelGesture()
        commit()
        if let sub = armedSubParam {
            setArmedDisplayValue(sub.defaultDisplayValue)
        } else {
            setArmedDisplayValue(ToolValueMapping.defaultDisplayValue(for: armedTool))
        }
    }

    /// Reset every tool in `group` to its canonical default as a SINGLE
    /// undo boundary: commit once up front, then batch-apply defaults
    /// without arming each tool (arming per tool would spawn extra
    /// crop-session transitions and undo entries).
    ///
    /// Tools with a tool-level display range reset through
    /// `ToolValueMapping` exactly as before. Tools that have NO
    /// tool-level range but do declare sub-params — HSL is the only one
    /// (#274), with 24 band fields and no primary — reset every declared
    /// sub-param instead; otherwise "Reset Color" would silently leave
    /// all 24 HSL fields set. Multi-param tools that DO have a
    /// tool-level range keep their existing primary-only semantics.
    public func resetGroup(_ group: ToolGroup) {
        let tools = Tool.tools(in: group).filter(\.isWired)
        guard !tools.isEmpty else { return }
        commit()
        for tool in tools {
            if ToolValueMapping.displayRange(for: tool) != nil {
                ToolValueMapping.apply(
                    ToolValueMapping.defaultDisplayValue(for: tool),
                    to: &session.model,
                    tool: tool
                )
            } else {
                for sub in tool.subParams {
                    session.model[keyPath: sub.keyPath] = sub.defaultDisplayValue
                }
            }
        }
    }

    // `resetAll()` — a thin wrapper over `session.resetToOriginal()`, i.e.
    // "revert to the model as it was at session open" — was removed in #2244.
    // It read like the epic's RESET but was strictly weaker: on an image that
    // already carried sidecar edits it restored those edits rather than the
    // factory defaults #1370 specifies, and it was the only reset the shipped
    // UI called. The editor now calls `resetToFactoryDefaults()` below;
    // `EditSession.resetToOriginal()` remains as a session-level primitive.

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
