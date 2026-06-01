// EditorView.swift — responsive-program S5a (#625).
//
// Top-level full-screen photo editor. Composes the 7 regions per spec §2:
//   1. (Status bar — platform)
//   2. EditorHeader (44pt)
//   3. Canvas region (flex) — image preview + ValueChipOverlay (top-center)
//   4. Filmstrip (optional, 48pt)
//   5. DragBar (30pt)
//   6. GroupTabsView (32pt)
//   7. ToolPillRow (~60pt)
//
// Push origin = Library Grid cell tap (S2). On phone, navigated into
// a `NavigationStack` with `.toolbar(.hidden, for: .tabBar)` so the
// bottom tab bar disappears for the duration.
//
// Sibling files own each region — this composer must stay thin to
// respect the per-file LoC budget. Logic that grows past a few lines
// belongs next door, not here.
//
// Spec: docs/design/responsive-program/s5-editor.md §2 + §3 + §5.

import SwiftUI
import MapleCore

struct EditorView: View {
    @Bindable var state: EditorState
    let onDismiss: () -> Void
    let onShare: () -> Void
    let onInfo: () -> Void

    /// Real-pixel conversion factor for the canvas geometry. The render
    /// pipeline targets hardware pixels, so the points the canvas reports
    /// are scaled by this before they reach `session.previewSize`. Mirrors
    /// `FullImageView`'s use of the same environment value.
    @Environment(\.displayScale) private var displayScale

    /// Optional filmstrip data — when empty the strip collapses to zero
    /// height (v0.1; the strip auto-shows when there are siblings).
    var filmstripAssets: [AssetRef] = []
    var onSelectAsset: (AssetRef) -> Void = { _ in }

    var body: some View {
        VStack(spacing: 0) {
            EditorHeader(
                state: state,
                onBack: onDismiss,
                onShare: onShare,
                onInfo: onInfo
            )

            // Canvas region (flex). The actual image render is owned by
            // the existing pipeline — for v0.1 the canvas hosts the
            // session's `renderedPreview` if present, otherwise a placeholder
            // tile sized to the dominant aspect ratio. The ValueChipOverlay
            // floats on top, 14pt below the top of the canvas region.
            ZStack(alignment: .top) {
                canvasContent
                ValueChipOverlay(state: state)
                    .padding(.top, 14)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MapleTokens.bg)
            // Report the canvas region's live size into the session so the
            // render pipeline has a real target. Captured on the
            // always-present container (NOT inside `CanvasImageView`, which
            // only exists once a preview lands) — otherwise the first render
            // would never get a non-zero `previewSize` and the canvas would
            // stay on the placeholder forever. Mirrors FullImageView's
            // `syncSessionToViewport`. iOS 17 / macOS 14 deployment targets
            // predate `onGeometryChange`, so we use the GeometryReader +
            // `onChange(of:)` pattern (same as FullImageView).
            .background(canvasSizeReader)
            // Canvas drag = 0.5:1 sensitivity into the armed tool, routed
            // through the same value pipe as the bar gesture.
            .gesture(canvasDragGesture)

            if !filmstripAssets.isEmpty {
                FilmstripView(
                    assets: filmstripAssets,
                    activeID: state.session.asset.id,
                    onSelect: onSelectAsset
                )
                Divider().background(MapleTokens.border)
            }

            DragBar(state: state)
            GroupTabsView(state: state)
            Divider().background(MapleTokens.border)
            ToolPillRow(state: state)
        }
        .background(MapleTokens.bg.ignoresSafeArea())
        .accessibilityIdentifier("editor-view")
        // Kick the render once this view is the active editor for the
        // current asset. `FullImageView` does this on `.onAppear`; the S5
        // editor never did, which is why it opened to a grey placeholder
        // on every platform (#827). `ensureRenderStarted()` is idempotent
        // (guards on `renderedPreview == nil`) and re-runs when the asset
        // id changes (filmstrip sibling switch). Both hosts —
        // `EditorDestination` (iPhone NavigationStack) and
        // `EditorSessionHost` (desktop center column, #816) — only render
        // `EditorView` once their `state` (and the host's `builtAssetID ==
        // session.asset.id` gate) resolves, so this `.task` fires against
        // the correct, matched session.
        .task(id: state.session.asset.id) {
            state.session.ensureRenderStarted()
        }
    }

    // MARK: - Canvas geometry → previewSize

    /// Transparent backing layer that reports the canvas region's size and
    /// feeds it (in real pixels) to `session.previewSize`. Lives on the
    /// always-present ZStack so it fires for both the placeholder and the
    /// image branch — the first non-zero size drives the fast render via
    /// `previewSize.didSet`, and later changes (desktop window resize,
    /// iPhone rotation) schedule a refine.
    private var canvasSizeReader: some View {
        GeometryReader { geo in
            Color.clear
                .onAppear { updatePreviewSize(geo.size) }
                .onChange(of: geo.size) { _, newSize in
                    updatePreviewSize(newSize)
                }
        }
    }

    /// Pushes a points size into the session as real screen pixels, reusing
    /// `FullImageView`'s conversion helper so the math can't drift. Setting
    /// `previewSize` (its `didSet`) is what drives the (re-)render.
    private func updatePreviewSize(_ pointsSize: CGSize) {
        guard pointsSize.width > 0, pointsSize.height > 0 else { return }
        state.session.previewSize = FullImageViewVM.viewportInPixels(
            viewport: pointsSize,
            displayScale: displayScale
        )
    }

    // MARK: - Canvas

    @ViewBuilder
    private var canvasContent: some View {
        if let preview = state.session.renderedPreview {
            CanvasImageView(image: preview)
                .padding(12)
        } else {
            // Subtle placeholder so the chrome reads while a render is
            // pending or absent (e.g. preview EditSession in tests).
            // For a cloud open, the placeholder hosts the determinate
            // download bar while the remote bytes arrive (#822) — gated on
            // the session's `downloadProgress` (nil for local/PhotoKit, so
            // they show only the neutral tile).
            RoundedRectangle(cornerRadius: 4)
                .fill(MapleTokens.surfaceAlt)
                .aspectRatio(3.0 / 2.0, contentMode: .fit)
                .overlay { downloadOverlay }
                .padding(12)
                .accessibilityIdentifier("editor-canvas-placeholder")
        }
    }

    /// Determinate download progress shown over the placeholder while a
    /// cloud asset's bytes download. Local / PhotoKit sessions have no
    /// `downloadProgress`, so this is empty for them.
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
                    // No known total yet — indeterminate until the headers
                    // (or catalog size) supply one.
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

    // MARK: - Canvas drag

    @State private var canvasDragStartValue: Double?

    private var canvasDragGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { g in
                if canvasDragStartValue == nil {
                    canvasDragStartValue = ToolValueMapping.internalValue(
                        for: state.armedTool,
                        displayValue: state.armedDisplayValue
                    )
                    state.commit()
                }
                // Canvas sensitivity is 0.5:1 of bar (per spec §3) — bar
                // is implicitly the screen-width assumption; canvas drag
                // uses the same value/px relationship as the bar, but at
                // half. We approximate "bar width" by using the screen
                // width — the precise value will be tied to the actual
                // bar geometry once the editor wires a shared geometry.
                let approxBarWidth: CGFloat = 320
                let dv = DragBarMath.valueDelta(
                    forDeltaX: g.translation.width,
                    barWidth: approxBarWidth,
                    sensitivity: state.fineMode ? .fine : .canvas
                )
                let newV = DragBarMath.clamp((canvasDragStartValue ?? 0) + dv)
                state.setArmedInternalValue(newV)
            }
            .onEnded { _ in
                canvasDragStartValue = nil
                state.fineMode = false
            }
    }
}

// MARK: - Canvas image (CIImage → SwiftUI)

private struct CanvasImageView: View {
    let image: CIImage

    var body: some View {
        GeometryReader { _ in
            // Wrap the CIImage in a host backed by CGImage. The fast path
            // is good enough for v0.1 — the existing FullImageView has a
            // tuned variant (CGImage + display-link) that we'll lift in
            // a follow-up consolidation pass.
            if let cg = CIContext().createCGImage(image, from: image.extent) {
                Image(decorative: cg, scale: 1.0, orientation: .up)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else {
                Color.clear
            }
        }
    }
}

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
