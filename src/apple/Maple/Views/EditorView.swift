// EditorView.swift — Pro Editor Canvas-first (A2, #1555).
//
// Canvas-first shell: a full-bleed image canvas fills the viewport and
// frosted-glass chrome layers float above it.  On regular size class
// (iPad/Mac) all five chrome elements are shown; on compact (iPhone)
// the left filmstrip rail and right tool dock are hidden, leaving only
// the top pill, the bottom control card, and the value-chip HUD.
//
// ┌─────────────────────────────────────────────────────────────────┐
// │         [back]  filename  [before/after]  [undo]  [share]      │  ← top pill (glass)
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

    private var isRegular: Bool { hSizeClass == .regular }

    var body: some View {
        ZStack {
            // ── LAYER 0 : full-bleed canvas ──────────────────────────────
            canvasLayer

            // ── LAYER 1 : value-chip HUD (top-center, always) ─────────────
            VStack {
                ValueChipOverlay(state: state)
                    .padding(.top, 14)
                Spacer()
            }
            .frame(maxWidth: .infinity)
            .ignoresSafeArea(edges: .bottom)

            // ── LAYER 2 : left filmstrip rail (regular only) ───────────────
            if isRegular && !filmstripAssets.isEmpty {
                HStack {
                    FilmstripRail(
                        assets: filmstripAssets,
                        activeID: state.session.asset.id,
                        source: filmstripSource,
                        onSelect: onSelectAsset
                    )
                    Spacer()
                }
                .padding(.leading, 8)
                .frame(maxHeight: .infinity)
                .ignoresSafeArea(edges: .bottom)
                .opacity(chromeOpacity)
            }

            // ── LAYER 3 : right tool dock (regular only) ──────────────────
            if isRegular {
                HStack {
                    Spacer()
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
                }
                .padding(.trailing, 8)
                .frame(maxHeight: .infinity)
                .ignoresSafeArea(edges: .bottom)
                .opacity(chromeOpacity)
            }

            // ── LAYER 4 : top pill header ─────────────────────────────────
            VStack {
                PillHeader(
                    state: state,
                    onBack: onDismiss,
                    onShare: onShare,
                    showBeforeAfter: state.isDirty
                )
                .padding(.horizontal, 16)
                .padding(.top, 8)
                Spacer()
            }
            .frame(maxWidth: .infinity)
            .ignoresSafeArea(edges: .bottom)
            .opacity(chromeOpacity)

            // ── LAYER 5 : bottom control card ─────────────────────────────
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
            }
            .frame(maxWidth: .infinity)
            .ignoresSafeArea(edges: .bottom)
            .opacity(chromeOpacity)
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
        .onChange(of: state.armedTool) { _, _ in bumpChrome() }
        .onChange(of: state.armedGroup) { _, _ in bumpChrome() }
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
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapleTokens.bg)
        // Compact chrome recede: any tap on the canvas restores chrome.
        .contentShape(Rectangle())
        .onTapGesture {
            guard !isRegular else { return }
            bumpChrome()
        }
    }

    // MARK: - Canvas leaf helpers

    private var cropApplied: Bool {
        state.armedTool != .crop && !state.session.model.crop.isIdentity
    }

    private var useGpuCanvas: Bool {
        guard !cropApplied else { return false }
        return FullImageViewVM.shouldPresentViaGpuCanvas(
            flagEnabled: GpuLiveFlag.isEnabled,
            isRaw: state.session.asset.isRaw,
            showingOriginal: state.session.showingOriginal
        )
    }

    private var canvasIsReady: Bool {
        useGpuCanvas || state.session.renderedPreview != nil
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
        } else if let preview = state.session.renderedPreview {
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

// MARK: - Canvas image (CIImage → SwiftUI)

private struct CanvasImageView: View {
    let image: CIImage

    @Environment(\.displayScale) private var displayScale

    private static let context = CIContext()
    private static let outputColorSpace = CGColorSpace(name: CGColorSpace.displayP3)!

    var body: some View {
        Group {
            if let cgImg = Self.context.createCGImage(
                image,
                from: image.extent,
                format: .RGBA16,
                colorSpace: Self.outputColorSpace
            ) {
                Image(decorative: cgImg, scale: displayScale, orientation: .up)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - PillHeader

/// Frosted-glass content-width pill at the top of the canvas.
/// Contains: back chevron, filename, before/after toggle, undo, share.
private struct PillHeader: View {
    @Bindable var state: EditorState
    let onBack: () -> Void
    let onShare: () -> Void
    let showBeforeAfter: Bool

    var body: some View {
        HStack(spacing: 10) {
            // Back
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ProTokens.text)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")
            .accessibilityIdentifier("editor-back")

            // Filename
            Text(state.session.asset.displayName)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ProTokens.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("editor-filename")

            // Before/after toggle — shown only when there are edits
            if showBeforeAfter {
                Button {
                    state.session.showingOriginal.toggle()
                } label: {
                    Image(systemName: state.session.showingOriginal
                          ? "circle.lefthalf.filled"
                          : "circle.righthalf.filled")
                        .font(.system(size: 15, weight: .regular))
                        .foregroundStyle(state.session.showingOriginal
                                         ? ProTokens.accent
                                         : ProTokens.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(state.session.showingOriginal ? "Show edited" : "Show original")
                .accessibilityIdentifier("editor-before-after")
            }

            // Undo (tap) / Redo (long-press)
            Button(action: { state.undo() }) {
                Image(systemName: "arrow.uturn.backward")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle((state.canUndo || state.canRedo)
                                     ? ProTokens.text
                                     : ProTokens.textDim)
            }
            .buttonStyle(.plain)
            .disabled(!state.canUndo && !state.canRedo)
            .simultaneousGesture(
                LongPressGesture(minimumDuration: 0.5).onEnded { _ in state.redo() }
            )
            .accessibilityLabel("Undo")
            .accessibilityIdentifier("editor-undo")

            // Share / export
            Button(action: onShare) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(ProTokens.text)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Share")
            .accessibilityIdentifier("editor-share")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(glassBackground, in: Capsule())
        .accessibilityIdentifier("editor-pill-header")
    }

    private var glassBackground: some ShapeStyle {
        ProTokens.bg.opacity(ProGlass.opacity)
    }
}

// MARK: - FilmstripRail

/// Vertical filmstrip rail shown on the leading edge (regular size class).
/// Reuses FilmstripCell data and thumbnail loading from FilmstripView.
private struct FilmstripRail: View {
    let assets: [AssetRef]
    let activeID: AssetRef.ID?
    var source: (any ImageSource)? = nil
    let onSelect: (AssetRef) -> Void

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            LazyVStack(spacing: 4) {
                ForEach(assets, id: \.id) { asset in
                    FilmstripRailCell(
                        asset: asset,
                        isActive: asset.id == activeID,
                        source: source,
                        onSelect: onSelect
                    )
                }
            }
            .padding(.vertical, 8)
        }
        .frame(width: 56)
        .background(glassBackground, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityIdentifier("editor-filmstrip-rail")
    }

    private var glassBackground: some ShapeStyle {
        ProTokens.bg.opacity(ProGlass.opacity)
    }
}

private struct FilmstripRailCell: View {
    let asset: AssetRef
    let isActive: Bool
    let source: (any ImageSource)?
    let onSelect: (AssetRef) -> Void

    @State private var thumbData: Data?
    @State private var loadTask: Task<Void, Never>?
    @State private var loadedForID: AssetRef.ID?

    var body: some View {
        Button {
            onSelect(asset)
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 4)
                    .fill(ProTokens.panel)

                if let data = thumbData, let cg = ThumbnailImage.cgImage(from: data) {
                    #if os(macOS)
                    Image(nsImage: NSImage(cgImage: cg, size: .zero))
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                    #else
                    Image(uiImage: UIImage(cgImage: cg))
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                    #endif
                }

                if isActive {
                    RoundedRectangle(cornerRadius: 4)
                        .strokeBorder(ProTokens.accent, lineWidth: 2)
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(asset.displayName)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .onAppear { startLoad() }
        .onDisappear {
            loadTask?.cancel()
            loadTask = nil
        }
    }

    private func startLoad() {
        if loadedForID == asset.id, thumbData != nil { return }
        guard loadTask == nil else { return }
        let capturedAsset = asset
        let capturedSource = source
        loadTask = Task { @MainActor in
            let data = await ThumbnailLoader.shared.load(
                for: capturedAsset, from: capturedSource
            )
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: 0.18)) {
                thumbData = data
                loadedForID = capturedAsset.id
            }
            loadTask = nil
        }
    }
}

// MARK: - ToolDock

/// Vertical glass column of tool-group pills on the trailing edge
/// (regular size class).  Shows tools for the currently-armed group
/// in a vertically-centered scroll.
private struct ToolDock: View {
    @Bindable var state: EditorState
    var onPresetsTap: () -> Void = {}

    var body: some View {
        let tools = Tool.tools(in: state.armedGroup)
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 6) {
                ForEach(tools, id: \.self) { tool in
                    ToolDockButton(state: state, tool: tool, onPresetsTap: onPresetsTap)
                }
            }
            .padding(.vertical, 10)
        }
        .frame(width: 64)
        .background(glassBackground, in: RoundedRectangle(cornerRadius: 12))
        .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
        .accessibilityIdentifier("editor-tool-dock")
    }

    private var glassBackground: some ShapeStyle {
        ProTokens.bg.opacity(ProGlass.opacity)
    }
}

private struct ToolDockButton: View {
    @Bindable var state: EditorState
    let tool: Tool
    var onPresetsTap: () -> Void = {}

    private var isSelected: Bool { state.armedTool == tool }

    private var isModified: Bool {
        if tool == .crop { return !state.session.model.crop.isIdentity }
        guard tool.isWired else { return false }
        let subs = tool.subParams
        if !subs.isEmpty {
            return subs.contains { sub in
                abs(state.session.model[keyPath: sub.keyPath] - sub.defaultDisplayValue) > 1e-6
            }
        }
        let v = ToolValueMapping.currentDisplayValue(state.session.model, tool: tool)
        let neutral = ToolValueMapping.defaultDisplayValue(for: tool)
        return abs(v - neutral) > 1e-6
    }

    var body: some View {
        Button {
            state.arm(tool: tool)
            if tool == .presets { onPresetsTap() }
        } label: {
            VStack(spacing: 4) {
                ZStack {
                    Circle()
                        .fill(isSelected
                              ? ProTokens.accent(0x28)
                              : ProTokens.panel)
                        .overlay(
                            Circle().stroke(
                                isSelected ? ProTokens.accent : ProTokens.border,
                                lineWidth: 0.5
                            )
                        )
                        .frame(width: 36, height: 36)

                    Image(systemName: ToolGlyph.sfSymbol(for: tool))
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(isSelected ? ProTokens.accent : ProTokens.text)

                    if isModified {
                        Circle()
                            .fill(ProTokens.accent)
                            .frame(width: 5, height: 5)
                            .offset(x: 12, y: 12)
                    }
                }
                Text(tool.displayName)
                    .font(.system(size: 9, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? ProTokens.accent : ProTokens.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(width: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tool.displayName)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("editor-dock-tool-\(tool.rawValue)")
    }
}

// MARK: - ControlCard

/// Frosted-glass bottom card: group tabs + living-slider grid for the
/// active group, plus the sub-param chip row and color accessory when
/// applicable.  Replaces the bottom VStack (DragBar + ToolPillRow +
/// GroupTabsView) from the old layout.
private struct ControlCard: View {
    @Bindable var state: EditorState
    var onPresetsTap: () -> Void = {}

    var body: some View {
        VStack(spacing: 0) {
            // Crop toolbar replaces sliders while Crop is armed
            if state.armedTool == .crop {
                CropToolbar(state: state)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 8)
            } else {
                // Sub-param chip row for multi-param tools
                let subs = state.armedSubParams
                if subs.count > 1 {
                    SubParamRow(state: state)
                        .padding(.vertical, 4)
                }
                // Color-group profile + as-shot row
                if state.armedGroup == .color {
                    ColorAccessoryRow(state: state)
                        .transition(.opacity)
                }
                // Living-slider grid for all tools in the active group
                LivingSliderGrid(state: state)
            }

            Divider()
                .background(ProTokens.border)

            GroupTabsView(state: state)
                .padding(.horizontal, 4)
        }
        .background(glassBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .accessibilityIdentifier("editor-control-card")
    }

    private var glassBackground: some ShapeStyle {
        ProTokens.bg.opacity(ProGlass.opacity)
    }
}

// MARK: - LivingSliderGrid

/// Scrollable grid of LivingSliders for all wired tools in the active group.
/// Each slider drives its tool's value directly through the EditorState's
/// setArmedDisplayValue path, committing an undo boundary on drag-end.
private struct LivingSliderGrid: View {
    @Bindable var state: EditorState

    var body: some View {
        let tools = Tool.tools(in: state.armedGroup)
            .filter { $0.isWired && ToolValueMapping.displayRange(for: $0) != nil }

        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                ForEach(tools, id: \.self) { tool in
                    LivingSliderRow(state: state, tool: tool)
                        .contentShape(Rectangle())
                        .onTapGesture { state.arm(tool: tool) }
                }
            }
        }
        .frame(maxHeight: 280)
        .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
    }
}

// MARK: - LivingSliderRow

/// A single LivingSlider wired to a tool's AdjustmentModel field.
/// Arms the tool on tap and highlights when it is the armed tool.
private struct LivingSliderRow: View {
    @Bindable var state: EditorState
    let tool: Tool

    private var range: ClosedRange<Double> {
        ToolValueMapping.displayRange(for: tool) ?? (0...100)
    }

    private var defaultValue: Double { ToolValueMapping.defaultDisplayValue(for: tool) }

    private var isBipolar: Bool {
        let r = range
        // Bipolar when the range spans both sides of the default or
        // when the default sits inside rather than at an edge.
        let mid = (r.lowerBound + r.upperBound) / 2
        return abs(defaultValue - mid) < (r.upperBound - r.lowerBound) * 0.05
            && r.lowerBound < defaultValue
    }

    private var displayString: String? {
        switch tool {
        case .temp: return String(format: "%.0f K", state.session.model.temperature)
        case .captureSigma: return String(format: "%.2f px", state.session.model.captureSharpeningSigma)
        default: return nil
        }
    }

    /// Binding that reads/writes directly through the model, committing
    /// on value change (DragGesture.onEnded calls onCommit separately).
    private var valueBinding: Binding<Double> {
        Binding(
            get: { ToolValueMapping.currentDisplayValue(state.session.model, tool: tool) },
            set: { newVal in
                // Arm this tool whenever its slider is dragged, so the
                // value chip and tool dock both reflect the active tool.
                if state.armedTool != tool { state.arm(tool: tool) }
                ToolValueMapping.apply(newVal, to: &state.session.model, tool: tool)
            }
        )
    }

    var body: some View {
        LivingSlider(
            label: tool.displayName,
            value: valueBinding,
            range: range,
            isBipolar: isBipolar,
            defaultValue: defaultValue,
            gradient: GradientCatalog.stops(for: tool),
            displayValue: displayString,
            onCommit: { state.commit() }
        )
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
