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
    /// Source the filmstrip assets came from, so `FilmstripView` cells can
    /// resolve thumbnails via `ThumbnailLoader` (the sourceless thumb path
    /// needs it for cloud / self-hosted libraries; filesystem assets load
    /// with `nil`). Threaded from the desktop host — the iPhone push
    /// passes no filmstrip, so it defaults to `nil` there.
    var filmstripSource: (any ImageSource)? = nil

    /// Whether the filmstrip is shown. Owned here (survives re-renders by
    /// view identity) so the show/hide choice persists while the editor is
    /// open (#875 item 4b). Defaults to shown.
    @State private var filmstripVisible = true

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
            // NOTE: tool value-adjust is intentionally NOT wired to a
            // canvas drag here (#875 item 5). On iPhone the side-nav
            // edge-swipe lives over the canvas; routing canvas drags into
            // the armed tool meant an edge-swipe to open the nav also
            // nudged the tool. Value-adjust now lives solely on `DragBar`
            // (1:1 scrubbing, unaffected on desktop). This deviates from
            // ui-spec §3 "canvas drag adjusts the armed tool" per the
            // user's explicit request.

            if !filmstripAssets.isEmpty {
                // Small centered toggle directly above the strip — hides /
                // shows it, persisting the choice via `filmstripVisible`
                // for the editor's lifetime (#875 item 4b).
                filmstripToggle
                if filmstripVisible {
                    FilmstripView(
                        assets: filmstripAssets,
                        activeID: state.session.asset.id,
                        source: filmstripSource,
                        onSelect: onSelectAsset
                    )
                    Divider().background(MapleTokens.border)
                }
            }

            // Post-canvas control order (#875 item 6): filmstrip + drag
            // area on top, then the TOOL row, then the section (group)
            // tabs below it. The single Divider sits between the tool row
            // and the group tabs.
            //
            // The Color group carries two non-slider controls relocated
            // from the removed Develop tab (#875): the Profile picker and
            // the As-Shot white-balance reset. They don't fit a drag-value
            // pill, so they surface as a contextual accessory strip shown
            // only while Color is armed, directly under the tool row.
            DragBar(state: state)
            ToolPillRow(state: state)
            if state.armedGroup == .color {
                ColorAccessoryRow(state: state)
                    .transition(.opacity)
            }
            Divider().background(MapleTokens.border)
            GroupTabsView(state: state)
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

    // MARK: - Filmstrip toggle

    /// Centered chevron button above the filmstrip that hides / shows it.
    /// Matches the editor's existing minimal control styling: a small
    /// MapleTokens-tinted SF Symbol on the canvas background, no chrome
    /// (#875 item 4b).
    private var filmstripToggle: some View {
        Button {
            withAnimation(MapleTokens.Motion.groupSwap) {
                filmstripVisible.toggle()
            }
        } label: {
            Image(systemName: filmstripVisible ? "chevron.down" : "chevron.up")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(MapleTokens.textMuted)
                .frame(maxWidth: .infinity)
                .frame(height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(MapleTokens.bg)
        .accessibilityLabel(filmstripVisible ? "Hide filmstrip" : "Show filmstrip")
        .accessibilityIdentifier("editor-filmstrip-toggle")
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

}

// MARK: - Canvas image (CIImage → SwiftUI)

private struct CanvasImageView: View {
    let image: CIImage

    var body: some View {
        // Wrap the CIImage in a host backed by CGImage. The fast path
        // is good enough for v0.1 — the existing FullImageView has a
        // tuned variant (CGImage + display-link) that we'll lift in
        // a follow-up consolidation pass.
        //
        // The `.fit`-scaled image is centered both axes inside an
        // infinite frame so the preview sits in the middle of the flex
        // canvas region rather than top-aligned with black space below
        // it (#875 item 1). A `.fit` image is letter/pillar-boxed, and
        // an infinite frame with no explicit alignment centers its
        // content — so a wide image centers vertically and a tall one
        // centers horizontally.
        Group {
            if let cg = CIContext().createCGImage(image, from: image.extent) {
                Image(decorative: cg, scale: 1.0, orientation: .up)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
