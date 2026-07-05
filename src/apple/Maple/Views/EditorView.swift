// EditorView.swift — Pro Editor Canvas-first (A2, #1555).
//
// Canvas-first shell: a full-bleed image canvas fills the viewport and
// frosted-glass chrome layers float above it.  On regular size class
// (iPad/Mac) all five chrome elements are shown; on compact (iPhone)
// the left filmstrip rail and right tool dock are hidden, leaving only
// the top pill, the bottom control card, and the value-chip HUD.
//
// ┌─────────────────────────────────────────────────────────────────┐
// │      [back]  filename  [before/after]  [undo]  [info] [share]  │  ← top pill (glass)
// │                                                                 │
// │  [filmstrip  │                                  │  tool dock]  │
// │  [rail       │          CANVAS                  │  (right)  ]  │  ← regular only
// │  (left)      │     (full bleed, GPU/CPU)        │             │
// │              │                                  │             │
// │         [GROUP TABS ── living-slider grid]                     │  ← bottom card (glass)
// └─────────────────────────────────────────────────────────────────┘
//
// Control-panel variants (TEMPORARY — for design exploration):
//   .compact (.default) — ToolDock (group-switcher) on the right + ControlCard at the bottom.
//   .panel              — StackedAdjustmentsPanel replaces the dock + card.
// The variant is selected via `ControlVariantToggle` (a small segmented
// control placed top-trailing below the pill) and persisted with @AppStorage.
// Both the toggle and the branching in this file are clearly marked TEMPORARY
// and must be removed before the design review concludes.
//
// All existing canvas logic (CanvasZoomHost, GPU/CPU leaf, crop overlay,
// ValueChipOverlay, wheel nudge, zoom toolbar) is preserved unchanged.
// EditorHeader, DragBar, and ToolPillRow are kept as files (their previews
// and tests remain valid) but are no longer used in this layout.
//
// The chrome view structs each live in their own sibling file (the
// codebase convention — one view per file): PillHeader.swift,
// FilmstripRail.swift, ToolDock.swift, ControlCard.swift,
// LivingSliderGrid.swift, CanvasImageView.swift.  This file is the thin
// ZStack composer + the canvas-leaf wiring.
//
// Chrome recede: on compact, a 3-second idle timer dims the chrome to 0.15
// opacity; any touch on the canvas restores it.  Regular size class always
// keeps chrome fully visible.

import SwiftUI
import MapleCore

// MARK: - EditorView

struct EditorView: View {
    @Bindable var state: EditorState
    let onDismiss: () -> Void
    let onShare: () -> Void
    let onInfo: () -> Void

    /// Optional filmstrip data — when empty the filmstrip rail collapses.
    var filmstripAssets: [AssetRef] = []
    var onSelectAsset: (AssetRef) -> Void = { _ in }
    /// Source the filmstrip assets came from, forwarded to ThumbnailLoader.
    var filmstripSource: (any ImageSource)? = nil

    @Environment(\.horizontalSizeClass) private var hSizeClass

    /// Chrome recede state for compact (iPhone). Timer resets on any
    /// canvas interaction; regular size class never recedes.
    @State private var chromeVisible = true
    @State private var recedeTask: Task<Void, Never>?

    /// Presets sheet / popover.
    @State private var presetsOpen = false
    @State private var presetStore = PresetStore()

    /// Value HUD (center) — fades in while a value is being scrubbed, then
    /// recedes.  Mirrors the web `hudVisible()` gated HUD layer; replaces the
    /// always-on top-center chip that collided with the pill header.
    @State private var hudVisible = false
    @State private var hudHideTask: Task<Void, Never>?

    // ── TEMPORARY: control-panel variant (exploration only) ──────────────────
    // Persisted with @AppStorage so the choice survives app restarts during
    // design review.  Default is `.compact` (the existing A2 layout).
    // REMOVE this property + the branching it drives before shipping.
    @AppStorage("proControlVariant") private var controlVariant: String = ControlVariant.compact.rawValue

    private var activeVariant: ControlVariant {
        ControlVariant(rawValue: controlVariant) ?? .compact
    }
    // ── END TEMPORARY ─────────────────────────────────────────────────────────

    private var isRegular: Bool { hSizeClass == .regular }

    var body: some View {
        ZStack {
            // ── LAYER 0 : full-bleed canvas ──────────────────────────────
            canvasLayer

            // ── LAYER 1 : value HUD (center, fades in during scrub) ───────
            // Gated by `hudVisible` so it only appears while a value is being
            // changed — the always-on top-center chip used to overlap the
            // pill header (LAYER 4).
            ValueChipOverlay(state: state)
                .opacity(hudVisible ? 1 : 0)
                .animation(.easeOut(duration: 0.18), value: hudVisible)
                .allowsHitTesting(false)
                // `opacity(0)` stays in the a11y tree — hide it from VoiceOver
                // while it's not visible so the chip isn't read mid-scrub-idle.
                .accessibilityHidden(!hudVisible)

            // ── LAYER 2 : left filmstrip rail (regular only) ───────────────
            // Vertically centered with its own max-height cap (set inside
            // FilmstripRail) so it floats mid-canvas instead of spanning the
            // full height.  `alignment: .leading` = left edge + vertical center.
            if isRegular && !filmstripAssets.isEmpty {
                FilmstripRail(
                    assets: filmstripAssets,
                    activeID: state.session.asset.id,
                    source: filmstripSource,
                    onSelect: onSelectAsset
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .padding(.leading, 12)
                .ignoresSafeArea(edges: .bottom)
                .opacity(chromeOpacity)
                .allowsHitTesting(isRegular || chromeVisible)
            }

            // ── LAYER 3 : right tool dock / panel (branched by variant) ────
            //
            // .compact — ToolDock (group-switcher) on the trailing edge.
            //            Regular only; hidden on compact (phone).
            // .panel   — StackedAdjustmentsPanel on the trailing edge (regular)
            //            or as a bottom panel (compact).  Dock hidden.
            //
            // TEMPORARY: the variant branch below is exploration scaffolding —
            // remove when the design review concludes.
            switch activeVariant {
            case .compact:
                // Variant A: group-switcher dock (regular only, matches original A2).
                if isRegular {
                    ToolDock(state: state, onPresetsTap: { presetsOpen = true })
                        #if os(macOS)
                        .popover(isPresented: $presetsOpen, arrowEdge: .trailing) {
                            PresetsPanel(
                                state: state,
                                store: presetStore,
                                onApplied: { presetsOpen = false }
                            )
                            .frame(width: 340, height: 460)
                            .background(MapleTokens.surface)
                        }
                        #endif
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                        .padding(.trailing, 12)
                        .ignoresSafeArea(edges: .bottom)
                        .opacity(chromeOpacity)
                        .allowsHitTesting(isRegular || chromeVisible)
                }

            case .panel:
                // Variant B: stacked panel — on regular it anchors to the
                // trailing edge (the panel itself is right-anchored inside
                // StackedAdjustmentsPanel on regular); on compact it sits at
                // the bottom.
                StackedAdjustmentsPanel(
                    state: state,
                    onPresetsTap: { presetsOpen = true }
                )
                #if os(macOS)
                .popover(isPresented: $presetsOpen, arrowEdge: .trailing) {
                    PresetsPanel(
                        state: state,
                        store: presetStore,
                        onApplied: { presetsOpen = false }
                    )
                    .frame(width: 340, height: 460)
                    .background(MapleTokens.surface)
                }
                #endif
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: isRegular ? .trailing : .bottom)
                .ignoresSafeArea(edges: .bottom)
                .opacity(chromeOpacity)
                .allowsHitTesting(isRegular || chromeVisible)
            }

            // ── LAYER 3b : flyout slider panel (variant A / regular only) ──
            // The right-side single-group slider panel that sits just left of
            // the ToolDock — together they form the "Flyout — dock + slider
            // panel" Card layout.  Regular only; on compact (iPhone) the bottom
            // ControlCard (layer 5) is used instead.
            // TEMPORARY: control-variant exploration — remove with the rest.
            if activeVariant == .compact && isRegular {
                FlyoutSliderPanel(state: state)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                    .padding(.trailing, 88) // 12 dock pad + 64 dock width + 12 gap
                    .ignoresSafeArea(edges: .bottom)
                    .opacity(chromeOpacity)
                    .allowsHitTesting(isRegular || chromeVisible)
            }

            // ── LAYER 4 : top pill header ─────────────────────────────────
            //
            // Pill is centered horizontally so it floats symmetrically above
            // the canvas.  The ControlVariantToggle (exploration control) has
            // moved to Settings → General so it no longer clutters the canvas
            // chrome.
            VStack(spacing: 0) {
                HStack {
                    Spacer(minLength: 0)
                    PillHeader(
                        state: state,
                        onBack: onDismiss,
                        onShare: onShare,
                        onInfo: onInfo,
                        showBeforeAfter: state.isDirty
                    )
                    Spacer(minLength: 0)
                }
                Spacer()
            }
            .padding(.top, 8)
            .frame(maxWidth: .infinity)
            .ignoresSafeArea(edges: .bottom)
            .opacity(chromeOpacity)
            .allowsHitTesting(isRegular || chromeVisible)

            // ── LAYER 5 : bottom control bar (variant A / compact only) ───────
            //
            // Hidden when the panel variant is active — StackedAdjustmentsPanel
            // (layer 3) provides all slider controls.
            // Regular replaces this with FlyoutSliderPanel (layer 3b);
            // MobileControlBar is shown only on compact (iPhone).
            // MobileControlBar replaces ControlCard here; ControlCard.swift
            // is retained as a file (its preview / tests remain valid) but is
            // no longer mounted in this layout.
            if activeVariant == .compact && !isRegular {
                VStack {
                    Spacer()
                    MobileControlBar(
                        state: state,
                        onPresetsTap: { presetsOpen = true }
                    )
                    #if os(iOS)
                    .mapleBottomSheet(isPresented: $presetsOpen) {
                        PresetsPanel(
                            state: state,
                            store: presetStore,
                            onApplied: { presetsOpen = false }
                        )
                    }
                    #endif
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ignoresSafeArea(edges: .bottom)
                .opacity(chromeOpacity)
                .allowsHitTesting(isRegular || chromeVisible)
            }

            // ── LAYER 6 : cold-open loading bar ───────────────────────────
            // Pinned to the top edge and does NOT recede with the chrome (no
            // chromeOpacity) so the in-flight full-res render of a big RAW
            // stays legible — the instant embedded preview otherwise looks
            // "done" with no sign the real image is still resolving. Same
            // visibility contract as FullImageView: shows from open until the
            // full-quality frame publishes (`isResolvingFirstFrame`, cleared
            // only once `!isFullQualityDecoding` on both CPU and GPU paths). #1658
            if EditSession.shouldShowLoadingIndicator(
                isResolvingFirstFrame: state.session.isResolvingFirstFrame,
                isRendering: state.session.isRendering,
                hasOnscreenFrame: EditSession.canvasHasFrame(
                    gpuActive: useGpuCanvas,
                    gpuFramePresented: state.session.gpuFramePresented,
                    hasRenderedPreview: state.session.renderedPreview != nil
                )
            ) {
                VStack {
                    IndeterminateLoadingBar()
                        .padding(.horizontal, 16)
                        .padding(.top, 6)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
                .allowsHitTesting(false)
            }
        }
        // Full-bleed editor (#4 follow-up): on regular size class (Mac/iPad)
        // pull the content into the top safe-area inset left over from the
        // (now-hidden) title bar/toolbar so the canvas + pill reach the very
        // top edge instead of leaving an empty black strip. Compact (iPhone)
        // keeps its top inset so the pill clears the notch/status bar.
        .ignoresSafeArea(edges: isRegular ? .top : [])
        .background(MapleTokens.bg.ignoresSafeArea())
        // Scope the shell identifier to a CONTAINER element (#1769). A bare
        // `.accessibilityIdentifier` on a multi-element view BROADCASTS the
        // identifier onto every contained accessibility element, overriding
        // the ones they set for themselves — a11y dumps showed every editor
        // element (the `canvas-render-ready` sentinel, `canvas-zoom-indicator`,
        // even toolbar buttons) reading `editor-view` on BOTH platforms, which
        // silently broke the macOS golden visual harness (it waits on the
        // canvas sentinel) and blocked the iPad seam harness. `.contain`
        // makes `editor-view` its own container node and leaves descendants'
        // identifiers intact.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-view")
        // Kick the render once this view is the active editor for the
        // current asset.  `ensureRenderStarted()` is idempotent (guards
        // on `renderedPreview == nil`) and re-runs when the asset id
        // changes (filmstrip sibling switch).
        .task(id: state.session.asset.id) {
            state.session.ensureRenderStarted()
            scheduleRecede()
        }
        #if os(macOS)
        // Hide the macOS window toolbar in editor mode so the canvas is
        // full-bleed; zoom controls have moved into the pill header.
        // The toolbar reappears automatically when the editor is dismissed
        // (EditorView leaves the view hierarchy and its modifier disappears).
        .toolbar(.hidden, for: .windowToolbar)
        #endif
        .onChange(of: state.armedTool) { _, _ in bumpChrome(); flashHUD() }
        .onChange(of: state.armedGroup) { _, _ in bumpChrome() }
        .onChange(of: state.armedDisplayValue) { _, _ in flashHUD() }
        // Cancel the idle-recede + HUD timers on tear-down so they can't fire
        // and mutate state after the editor is gone (review #3).
        .onDisappear {
            recedeTask?.cancel()
            hudHideTask?.cancel()
        }
        // ── Arrow-key group cycling (regular / iPad & Mac only) ────────────
        // Down = next group (Detail → Light wraps), Up = previous.
        // `.focusable(isRegular)` makes the ZStack a key-event target when
        // no child slider has focus.  A focused LivingSlider consuming
        // `.handled` on its own arrow keys takes priority (innermost first).
        // CAVEAT TO VERIFY: on macOS focus may not land here after clicking
        // away from a slider — if so, add `.focusScope` or make the canvas
        // `.focusable()` as the default target.  On iPadOS this modifier is
        // load-bearing for hardware-keyboard delivery; confirm on device.
        .focusable(isRegular)
        .onKeyPress(.downArrow) {
            guard isRegular else { return .ignored }
            let all = ToolGroup.allCases
            let current = state.armedGroup
            let next = all[(all.firstIndex(of: current)! + 1) % all.count]
            withAnimation(MapleTokens.Motion.groupSwap) { state.arm(group: next) }
            return .handled
        }
        .onKeyPress(.upArrow) {
            guard isRegular else { return .ignored }
            let all = ToolGroup.allCases
            let current = state.armedGroup
            let prev = all[(all.firstIndex(of: current)! + all.count - 1) % all.count]
            withAnimation(MapleTokens.Motion.groupSwap) { state.arm(group: prev) }
            return .handled
        }
    }

    // MARK: - Chrome recede

    private var chromeOpacity: Double {
        guard !isRegular && !chromeVisible else { return 1.0 }
        return 0.15
    }

    private func bumpChrome() {
        guard !isRegular else { return }
        recedeTask?.cancel()
        chromeVisible = true
        scheduleRecede()
    }

    /// Flash the center value HUD, then schedule it to recede ~1.1s after the
    /// last value change (mirrors the web scrub HUD behaviour).
    private func flashHUD() {
        hudHideTask?.cancel()
        hudVisible = true
        hudHideTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1100))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) { hudVisible = false }
        }
    }

    private func scheduleRecede() {
        guard !isRegular else { return }
        recedeTask?.cancel()
        recedeTask = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: ProMotion.recede)) {
                chromeVisible = false
            }
        }
    }

    // MARK: - Canvas layer

    private var canvasLayer: some View {
        ZStack(alignment: .top) {
            CanvasZoomHost(
                controller: state.zoom,
                doubleTapBehavior: .toggleFitAnd100,
                onWheelEditing: { steps, unit in
                    state.wheelNudge(steps: steps, unit: unit)
                },
                canvasReady: canvasIsReady
            ) {
                canvasLeaf
            } fallback: {
                canvasPlaceholder
            }
            // Crop overlay (#638): shown while the Crop tool is armed.
            // The canvas renders UNCROPPED under the overlay.
            if state.armedTool == .crop {
                CropOverlay(state: state)
            }
            // Before/after "BEFORE" badge — surfaced while the session is
            // showing the original (the canvas itself falls back to the
            // placeholder, matching FullImageView's contract).
            if state.session.showingOriginal {
                VStack {
                    Spacer()
                    Text("BEFORE")
                        .font(.caption.bold())
                        .foregroundStyle(.white)
                        .padding(6)
                        .background(.black.opacity(0.6), in: Capsule())
                        .padding(.bottom, 12)
                }
                .allowsHitTesting(false)
                .accessibilityIdentifier("editor-before-badge")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapleTokens.bg)
        // Render-path badge and zoom % have moved to PillHeader — the
        // bottom-trailing GPU/CPU overlay is no longer rendered here.
        // Compact chrome recede: any tap on the canvas restores chrome.
        .contentShape(Rectangle())
        .onTapGesture {
            guard !isRegular else { return }
            bumpChrome()
        }
    }

    // MARK: - Canvas leaf helpers

    private var useGpuCanvas: Bool {
        // #1617: cropped frames now present via the GPU live path too — the
        // render layer crops the decoded buffer before the readback, so the
        // canvas no longer forces CPU for a static crop. Crop-EDITING still
        // shows the uncropped full frame (`effectiveCrop` folds in the armed
        // gate and `straightenAngle` drives the live rotation), which this
        // predicate already permits.
        FullImageViewVM.shouldPresentViaGpuCanvas(
            flagEnabled: GpuLiveFlag.isEnabled,
            isRaw: state.session.asset.isRaw,
            showingOriginal: state.session.showingOriginal,
            presentFailed: state.session.gpuPresentFailed
        )
    }

    /// True when the host should render the canvas leaf (vs the
    /// placeholder).  The GPU layer mounts immediately; the CPU leaf
    /// needs a published preview AND `!showingOriginal` — the
    /// before/after "original" view falls back to the placeholder, the
    /// same contract `FullImageView` enforces (review #1).
    private var canvasIsReady: Bool {
        useGpuCanvas || (!state.session.showingOriginal && state.session.renderedPreview != nil)
    }

    private var showCpuBackdrop: Bool {
        state.session.isFullQualityDecoding || !state.session.gpuFramePresented
    }

    private var straightenAngle: Double {
        guard state.armedTool == .crop else { return 0 }
        return state.session.model.crop.angle
    }

    @ViewBuilder
    private var canvasLeaf: some View {
        canvasLeafContent
            .rotationEffect(.degrees(straightenAngle))
    }

    @ViewBuilder
    private var canvasLeafContent: some View {
        if useGpuCanvas {
            ZStack {
                GpuLiveCanvasView(session: state.session)
                if showCpuBackdrop,
                   let preview = state.session.renderedPreview {
                    CanvasImageView(image: preview)
                        .allowsHitTesting(false)
                }
            }
            .accessibilityElement(children: .ignore)
            // The label is REQUIRED for the element to exist on iOS at all: a
            // children-ignored element with no label/traits is pruned from the
            // UIKit accessibility tree, which hid the ready sentinel from the
            // iPad XCUITest harness (#1769). macOS exposes it either way.
            // Also the repo's a11y contract: every element needs a label.
            .accessibilityLabel("Editor canvas")
            // Readiness rides BOTH the identifier (the macOS harness contract)
            // and the VALUE: on iOS the root-level `editor-view` identifier
            // (line ~289) clobbers every descendant element's identifier
            // (verified via a11y dump — even `canvas-zoom-indicator` reads
            // `editor-view` there), so the iPad harness matches on
            // label + value instead (#1769).
            .accessibilityValue(
                FullImageViewVM.canvasAccessibilityID(
                    isRendering: state.session.isRendering,
                    hasPreview: state.session.gpuFramePresented
                )
            )
            .accessibilityIdentifier(
                FullImageViewVM.canvasAccessibilityID(
                    isRendering: state.session.isRendering,
                    hasPreview: state.session.gpuFramePresented
                )
            )
        } else if let preview = state.session.showingOriginal ? nil : state.session.renderedPreview {
            // CPU path — suppressed while showing the original (review #1),
            // so the before/after toggle falls back to the placeholder
            // exactly as FullImageView does.
            CanvasImageView(image: preview)
                .accessibilityElement(children: .ignore)
                // See the GPU branch: label + value materialize the element
                // and carry the ready sentinel on iOS (#1769).
                .accessibilityLabel("Editor canvas")
                .accessibilityValue(
                    FullImageViewVM.canvasAccessibilityID(
                        isRendering: state.session.isRendering,
                        hasPreview: state.session.renderedPreview != nil
                    )
                )
                .accessibilityIdentifier(
                    FullImageViewVM.canvasAccessibilityID(
                        isRendering: state.session.isRendering,
                        hasPreview: state.session.renderedPreview != nil
                    )
                )
        }
    }

    private var canvasPlaceholder: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(MapleTokens.surfaceAlt)
            .aspectRatio(3.0 / 2.0, contentMode: .fit)
            .overlay { downloadOverlay }
            .padding(12)
            .accessibilityIdentifier("editor-canvas-placeholder")
    }

    /// "4.2 MB / 12 MB" or "4.2 MB" when the total is unknown. Adaptive units
    /// via `ByteCountFormatStyle`, monospaced digits at the call-site keep the
    /// number stable as bytes tick up. Local helper rather than two inline
    /// `.formatted(...)` calls per render — the placeholder re-evaluates on
    /// every `receivedBytes` Observable write, and a one-call hoisted helper
    /// keeps the body terse.
    private func downloadByteCountText(for progress: DownloadProgress) -> String {
        let style = ByteCountFormatStyle(style: .file)
        let received = progress.receivedBytes.formatted(style)
        if let total = progress.expectedBytes, total > 0 {
            return "\(received) / \(total.formatted(style))"
        }
        return received
    }

    /// Speed rendered as "320 KB" / "1.2 MB" — the calling site adds the "/ s"
    /// suffix so a future change to a different cadence label (e.g. "/ min")
    /// only touches that one line. The `Int64` cast clamps NaN / ±∞ /
    /// out-of-range values to 0…Int64.max so a corrupted
    /// `URLResourceValues` read (rare but theoretically possible from a
    /// misbehaving FileProvider extension) can't crash the editor. Real
    /// network rates fit Int64.max by orders of magnitude.
    private func downloadSpeedText(_ bytesPerSecond: Double) -> String {
        let clamped: Int64
        if bytesPerSecond.isNaN || bytesPerSecond <= 0 {
            clamped = 0
        } else if bytesPerSecond >= Double(Int64.max) {
            clamped = .max
        } else {
            clamped = Int64(bytesPerSecond)
        }
        return clamped.formatted(ByteCountFormatStyle(style: .file))
    }
    @ViewBuilder
    private var downloadOverlay: some View {
        if let progress = state.session.downloadProgress, progress.isDownloading {
            VStack(spacing: 10) {
                if let fraction = progress.fraction {
                    ProgressView(value: fraction)
                        .progressViewStyle(.linear)
                        .frame(maxWidth: 240)
                        .accessibilityIdentifier("editor-download-progress")
                        .accessibilityValue(Text("\(Int(fraction * 100)) percent"))
                } else {
                    ProgressView()
                        .progressViewStyle(.linear)
                        .frame(maxWidth: 240)
                        .accessibilityIdentifier("editor-download-progress")
                }
                Text("Downloading\u{2026}")
                    .font(.caption)
                    .foregroundStyle(MapleTokens.textMuted)
                // Bytes received / total + running-average speed. Both lines
                // are derived from `DownloadProgress`'s Observable state so
                // they tick alongside the progress bar without a timer.
                Text(downloadByteCountText(for: progress))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(MapleTokens.textMuted)
                if let speed = progress.bytesPerSecond {
                    Text("\(downloadSpeedText(speed)) / s")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(MapleTokens.textMuted)
                        .accessibilityIdentifier("editor-download-speed")
                }
            }
            .padding(24)
        }
    }

}

// MARK: - Preview

#if DEBUG
#Preview("EditorView") {
    let state = EditorState(session: EditSession.preview())
    return EditorView(
        state: state,
        onDismiss: {},
        onShare: {},
        onInfo: {}
    )
}
#endif
