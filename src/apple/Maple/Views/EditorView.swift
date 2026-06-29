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

            // ── LAYER 3 : right tool dock (regular only) ──────────────────
            // Vertically centered with its own max-height cap (set inside
            // ToolDock).  `alignment: .trailing` = right edge + vertical center.
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

            // ── LAYER 4 : top pill header ─────────────────────────────────
            VStack {
                PillHeader(
                    state: state,
                    onBack: onDismiss,
                    onShare: onShare,
                    onInfo: onInfo,
                    showBeforeAfter: state.isDirty
                )
                .padding(.horizontal, 16)
                .padding(.top, 8)
                Spacer()
            }
            .frame(maxWidth: .infinity)
            .ignoresSafeArea(edges: .bottom)
            .opacity(chromeOpacity)
            .allowsHitTesting(isRegular || chromeVisible)

            // ── LAYER 5 : bottom control card ─────────────────────────────
            GeometryReader { geo in
                VStack {
                    Spacer()
                    ControlCard(
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
                    // Contained width on regular (iPad/Mac) so the card centers
                    // between the filmstrip rail (~122pt left) and the tool dock
                    // (~76pt right). Clamped so it can't underlap either column
                    // on a narrow regular window. The `max(320, …)` floor keeps
                    // the value non-negative before `geo` settles — without it,
                    // `geo.size.width - 300` is < 0 during the first layout pass
                    // and SwiftUI logs "Invalid frame dimension (negative …)".
                    .frame(maxWidth: isRegular ? min(860, max(320, geo.size.width - 300)) : .infinity)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(maxWidth: .infinity)
            .ignoresSafeArea(edges: .bottom)
            .opacity(chromeOpacity)
            .allowsHitTesting(isRegular || chromeVisible)

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
        .background(MapleTokens.bg.ignoresSafeArea())
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
        .toolbar { editorZoomToolbar }
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
        // Render-path badge (bottom-trailing) — mirrors the zoom % badge
        // (bottom-leading, CanvasZoomHost) with the same pill style; surfaces
        // whether the canvas is on the wgpu live path (GPU) or the CPU
        // fallback (`gpuFramePresented` latches the first GPU present).
        .overlay(alignment: .bottomTrailing) {
            Text(state.session.gpuFramePresented ? "GPU" : "CPU")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 4))
                .padding(8)
                .allowsHitTesting(false)
                .accessibilityIdentifier("editor-render-path-badge")
        }
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
            showingOriginal: state.session.showingOriginal
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
            }
            .padding(24)
        }
    }

    // MARK: - Zoom toolbar (macOS)

    #if os(macOS)
    @ToolbarContentBuilder
    private var editorZoomToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button("Fit", systemImage: "arrow.down.right.and.arrow.up.left") {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    state.zoom.resetToFit()
                }
            }
            .keyboardShortcut("0", modifiers: .command)
            .help("Fit (⌘0)")
            .accessibilityLabel("Zoom to fit")
            .accessibilityIdentifier("editor-zoom-fit")

            Button("100%", systemImage: "1.circle") {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    state.zoom.zoomToScale(1.0)
                }
            }
            .keyboardShortcut("1", modifiers: .command)
            .help("Actual size (⌘1)")
            .accessibilityLabel("Zoom to 100 percent")
            .accessibilityIdentifier("editor-zoom-100")
        }
    }
    #endif
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
