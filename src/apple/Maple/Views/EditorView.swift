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
            // the existing pipeline — the canvas hosts the session's
            // `renderedPreview` if present, otherwise a placeholder tile
            // sized to the dominant aspect ratio. The ValueChipOverlay
            // floats on top, 14pt below the top of the canvas region.
            //
            // The shared `CanvasZoomHost` (#1099, spec §5.0) owns the
            // canvas geometry: it reports the live viewport into the
            // session (`previewSize` in real pixels — what used to be the
            // `canvasSizeReader` here), frames the leaf at the resolved
            // zoom (fit by default; goldens unaffected), and routes
            // gestures per the spec table — pinch zooms anchored at the
            // gesture, drag pans ONLY when zoomed in, double-tap toggles
            // fit ↔ 100%, ⌘+wheel zooms at the cursor, and the plain
            // wheel at fit nudges the armed tool (S5 desktop contract).
            //
            // NOTE: at fit, one-finger canvas drags stay intentionally
            // inert — tool value-adjust is NOT wired to a canvas drag
            // (#875 item 5: on iPhone the side-nav edge-swipe lives over
            // the canvas; routing canvas drags into the armed tool meant
            // an edge-swipe to open the nav also nudged the tool).
            // Value-adjust lives on `DragBar` (1:1 scrubbing) and, on
            // desktop, the wheel detents. This deviates from the spec
            // §5.0 row "drag at fit = armed-tool adjust 0.5:1" per the
            // user's explicit #875 request; when zoomed in the drag pans,
            // exactly per the table.
            ZStack(alignment: .top) {
                CanvasZoomHost(
                    controller: state.zoom,
                    doubleTapBehavior: .toggleFitAnd100,
                    // Wheel detents at fit nudge the armed tool. The nudge
                    // + undo-burst logic lives on `EditorState.wheelNudge`
                    // (MapleCore) so it's unit-testable — a burst breaks
                    // on a pause OR an armed-tool change (#1125 review).
                    onWheelEditing: { steps, unit in
                        state.wheelNudge(steps: steps, unit: unit)
                    },
                    canvasReady: state.session.renderedPreview != nil
                ) {
                    canvasLeaf
                } fallback: {
                    canvasPlaceholder
                }
                ValueChipOverlay(state: state)
                    .padding(.top, 14)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MapleTokens.bg)

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
        // Zoom commands (#1099, spec §5.0): ⌘0 fit / ⌘1 100% on desktop.
        // Bare 0/1 keep their S5 meanings (armed-tool reset / rating) —
        // fit and 100% take the modifier, matching the legacy Apple
        // shortcuts. macOS only: the iPhone push hides system chrome, and
        // the touch surfaces (pinch, double-tap) cover zoom there.
        #if os(macOS)
        .toolbar { editorZoomToolbar }
        #endif
    }

    // MARK: - Zoom toolbar (macOS)

    #if os(macOS)
    /// Fit / 100% controls in the window toolbar while the editor owns
    /// the center column. Mirrors the legacy `FullImageView` toolbar
    /// cluster (same placement rule: header controls group next to the
    /// menu button) and drives the same shared `CanvasZoomController`.
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

    /// The canvas leaf the zoom host frames + pans. The host resolves
    /// the display frame off the session's `nativeImageSize` — the only
    /// trustworthy image extent (the preview buffer may be smaller:
    /// embedded JPEG, half-res fast phase) — and returns nil until the
    /// metadata seed publishes, falling back to the placeholder rather
    /// than anchoring zoom math against a preview-resolution extent.
    /// At the default fit zoom the leaf's on-screen frame equals the
    /// *image* rect — chrome-free and letterbox-free. This is the same
    /// contract `FullImageView`'s `CIImageView` provided, which is what
    /// the visual-golden harness (`MapleUITests`) crops to: it
    /// screenshots the `canvas-render-ready` element's frame directly.
    @ViewBuilder
    private var canvasLeaf: some View {
        if let preview = state.session.renderedPreview {
            // UITest harness sentinel — the identifier only appears once
            // the refine pass has published a preview AND `isRendering`
            // has flipped false. The harness waits + crops on the element
            // whose id resolves to `canvas-render-ready` (an `otherElement`
            // — the composite frame + identifier surfaces as `.other`,
            // matching FullImageView's wrapper). Migrated from FullImageView
            // in #820. See .archived-plans/plans/2026-04-25-xcuitest-visual-harness.md.
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

    /// Subtle placeholder so the chrome reads while a render is
    /// pending or absent (e.g. preview EditSession in tests).
    /// For a cloud open, the placeholder hosts the determinate
    /// download bar while the remote bytes arrive (#822) — gated on
    /// the session's `downloadProgress` (nil for local/PhotoKit, so
    /// they show only the neutral tile).
    private var canvasPlaceholder: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(MapleTokens.surfaceAlt)
            .aspectRatio(3.0 / 2.0, contentMode: .fit)
            .overlay { downloadOverlay }
            .padding(12)
            .accessibilityIdentifier("editor-canvas-placeholder")
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

    @Environment(\.displayScale) private var displayScale

    /// Render-time CIContext + output color space. Lifted from
    /// `FullImageView.CIImageView` (the variant retired in #820) so the
    /// editor canvas paints through the same Display-P3 / 16-bit path —
    /// the visual-golden harness diffs this canvas against the golden the
    /// old wrapper produced, so the color path must match bit-for-bit.
    /// See `FullImageView.CIImageView`'s docs (pre-#820) for the P3+16
    /// gamut/depth rationale.
    private static let context = CIContext()
    private static let outputColorSpace = CGColorSpace(name: CGColorSpace.displayP3)!

    var body: some View {
        // `Group` lets the centering `.frame` below attach to the whole
        // if/else (a bare `if/else` in a ViewBuilder can't carry a trailing
        // modifier). Mirrors #875's wrapper.
        Group {
            if let cgImg = Self.context.createCGImage(
                image,
                from: image.extent,
                format: .RGBA16,
                colorSpace: Self.outputColorSpace
            ) {
                // `Image(decorative:scale:orientation:)` carries the
                // displayScale explicitly so a full-res cgImage scales down to
                // the proposed frame on macOS (NSImage's natural-size-in-points
                // path over-scales at displayScale=2). The parent frames this to
                // the resolved fit rect; `.fit` keeps the aspect inside it.
                Image(decorative: cgImg, scale: displayScale, orientation: .up)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                Color.clear
            }
        }
        // Centre the `.fit`-scaled image inside the flex canvas region
        // (#875 item 1). The call site already pins this view to the
        // resolved fit rect via `.frame(width:height:)`, so this infinite
        // frame clamps to that proposal and is pixel-equivalent — it keeps
        // the #875 centering contract for any path that hosts
        // `CanvasImageView` without an explicit outer frame.
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
