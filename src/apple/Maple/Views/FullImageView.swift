// FullImageView.swift — Full-resolution canvas with zoom/pan, toolbar, and
// before/after.
//
// Zoom / pan implementation is ported verbatim from the Maple reference's
// `FullImageMode/FullImageView.swift` so the feel matches: pinch-to-zoom
// anchors against `pinchStartScale`, drag-to-pan accumulates into `basePan`
// on release, double-tap resets to fit, and the zoom indicator sits in the
// bottom-leading corner of the canvas. Keyboard shortcuts ⌘0/⌘1/⌘=/⌘- drive
// the same state transitions as the toolbar buttons.
//
// Zoom model (`pixelScale`): real screen pixels per image pixel.
//   • 0        = fit-to-viewport (resolved against `geo.size` + `displayScale`
//                at read time)
//   • 1.0      = pixel-perfect 1:1 (one image px = one real screen px)
//   • ≤ 8.0    = zoomed-in beyond native (upper bound matches reference)
//
// The view pushes `pixelScale` and `previewSize` onto the session so the
// pipeline's two-phase render can retarget the refined pass at the right
// size — a 100% zoom on a 100MP RAW renders at full resolution, while fit
// mode stays at viewport resolution for the 16ms slider budget.

import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins
import MapleCore

struct FullImageView: View {
    /// `EditSession` is `@Observable`; SwiftUI tracks property access directly.
    let session: EditSession

    // MARK: - Zoom state (ported verbatim from reference)

    /// Real screen pixels per image pixel.
    ///   • 0 = fit-to-viewport.
    ///   • 1.0 = pixel-perfect (1:1).
    ///   • > 1.0 = zoomed-in beyond native.
    /// Matches the reference's `FullImageView.pixelScale`.
    @State private var pixelScale: CGFloat = 0
    /// Scale captured at gesture start. `MagnifyGesture.value.magnification` is
    /// cumulative — anchor against this instead of the live pixelScale.
    @State private var baseScale: CGFloat = 0
    @State private var pinchStartScale: CGFloat?
    @State private var panOffset: CGSize = .zero
    @State private var basePan: CGSize = .zero
    @State private var viewportSize: CGSize = .zero

    @Environment(\.displayScale) private var displayScale
    @FocusState private var isFocused: Bool

    /// Upper clamp on `pixelScale`. Reference caps at 8× so a 24MP image
    /// can show pixel-level noise without the refine target blowing past
    /// sensible memory budgets.
    private let maxPixelScale: CGFloat = 8.0

    // MARK: - Canvas math (Ticket 10 item I — DRY value type)

    /// Build a `CanvasMath` snapshot from the current view state. The
    /// session's `nativeImageSize` is the only trustworthy image extent
    /// (every other source — `renderedPreview`, embedded JPEG, sized-FFI
    /// buffer — carries a smaller extent that, if fed into the
    /// canvas/zoom math, anchors "100%" to a preview-resolution
    /// baseline). When `nativeImageSize` is `.zero` the body's
    /// `imageExtent` accessor returns nil and we fall through to the
    /// placeholder branch — see notes on `CanvasMath.imageExtent`.
    ///
    /// `viewport` is in POINTS (SwiftUI's `geo.size`); we convert to
    /// real pixels here once so all `CanvasMath`-derived math operates
    /// on the same unit.
    private func canvasMath(viewport: CGSize) -> CanvasMath {
        let viewportPx = CGSize(
            width: viewport.width * displayScale,
            height: viewport.height * displayScale
        )
        return CanvasMath(
            viewportPx: viewportPx,
            nativeImageSize: session.nativeImageSize,
            pixelScale: pixelScale,
            panOffset: panOffset,
            displayScale: displayScale
        )
    }

    /// Resolves "fit" mode to a concrete scale. Reads `viewport` so the
    /// toolbar/keyboard paths (which don't have a `GeometryReader` in
    /// scope) can share the same math as gestures.
    private func effectivePixelScale(viewport: CGSize) -> CGFloat {
        canvasMath(viewport: viewport).effectivePixelScale
    }

    /// Real-screen-pixels-per-image-pixel for fit-to-viewport. Used by
    /// gestures + zoomOut to anchor "snap back to fit" math against the
    /// viewport's fit scale (independent of the user's current zoom).
    private func fitPixelScale(viewport: CGSize) -> CGFloat {
        canvasMath(viewport: viewport).fitPixelScale
    }

    /// Push the current visible source rect + zoom to the session. Called
    /// from every path that mutates `pixelScale` or `panOffset` so the
    /// tile manager always sees the live viewport.
    private func notifyVisibleRegion() {
        let math = canvasMath(viewport: viewportSize)
        session.updateTileVisibleRegion(
            viewport: math.visibleSourceRect,
            zoom: math.effectivePixelScale
        )
    }

    /// Push viewport size + resolved pixel scale to the session. Called
    /// on first mount, on viewport resize, and after the metadata seed
    /// publishes a real `nativeImageSize` (where the fit-resolved scale
    /// changes from the pre-decode estimate to the real value). Captures
    /// the points → real-pixels conversion + `effectivePixelScale` in one
    /// place so we don't re-derive them at three call sites.
    private func syncSessionToViewport(_ viewport: CGSize) {
        let math = canvasMath(viewport: viewport)
        // `previewSize` is in real screen pixels — the pipeline's target
        // matches hardware and CoreImage auto-tiles only when it must.
        session.previewSize = math.viewportPx
        session.pixelScale = math.effectivePixelScale
    }

    // MARK: - Body

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // Background
                MapleTokens.imageCanvas.ignoresSafeArea()

                if let ci = session.showingOriginal ? nil : session.renderedPreview,
                   let frameInPoints = canvasMath(viewport: geo.size).displayFrameInPoints {
                    // Frame on the *virtual* image size — `nativeImageSize`
                    // exclusively. The CIImage itself may be at a smaller
                    // resolution (embedded preview, cached JPEG, half-res
                    // fast phase) and CoreImage will upscale to fill this
                    // frame. Falling back to `ci.extent.size` here would
                    // collapse the canvas to preview dims while waiting
                    // for native to seed — the user reported exactly this
                    // on iPad. `CanvasMath.displayFrameInPoints` returns
                    // nil when the native size hasn't seeded, so the
                    // placeholder branch fires instead of the wrong-scale
                    // canvas.
                    CIImageView(image: ci)
                        .frame(width: frameInPoints.width, height: frameInPoints.height)
                        .offset(panOffset)
                        .gesture(magnificationGesture(viewport: geo.size))
                        .simultaneousGesture(dragGesture(viewport: geo.size))
                        .onTapGesture(count: 2) { resetZoom() }
                        // UITest harness sentinel — the identifier only
                        // appears once the refine pass has published a
                        // preview AND `isRendering` has flipped false.
                        // The harness waits via NSPredicate(exists==1) on
                        // `app.otherElements["canvas-render-ready"]`. See
                        // docs/superpowers/plans/2026-04-25-xcuitest-visual-harness.md.
                        .accessibilityIdentifier(
                            (!session.isRendering && session.renderedPreview != nil)
                                ? "canvas-render-ready"
                                : "canvas-rendering"
                        )
                } else {
                    // Placeholder while rendering
                    RoundedRectangle(cornerRadius: 8)
                        .fill(MapleTokens.surfaceAlt)
                        .frame(maxWidth: 800, maxHeight: 600)
                        .overlay {
                            Image(systemName: "photo")
                                .font(.system(size: 60))
                                .foregroundStyle(MapleTokens.textMuted)
                        }
                }

                // Before/After overlay
                if session.showingOriginal {
                    VStack {
                        Spacer()
                        Text("BEFORE")
                            .font(.caption.bold())
                            .foregroundStyle(.white)
                            .padding(6)
                            .background(.black.opacity(0.6), in: Capsule())
                            .padding(.bottom, 12)
                    }
                }

                // Render error banner
                if let err = session.renderError {
                    VStack {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill")
                            Text(err.localizedDescription)
                                .font(.caption)
                                .lineLimit(2)
                        }
                        .foregroundStyle(.white)
                        .padding(8)
                        .background(Color.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 6))
                        .padding(.top, 12)
                        Spacer()
                    }
                }

                // Render indicator — only while we have no preview yet, so
                // slider ticks don't flash a spinner on every frame.
                if session.isRendering && session.renderedPreview == nil {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
            .overlay(alignment: .bottomLeading) {
                zoomIndicator(viewport: geo.size)
            }
            .onAppear {
                viewportSize = geo.size
                syncSessionToViewport(geo.size)
                session.ensureRenderStarted()
            }
            .onChange(of: geo.size) { _, newSize in
                viewportSize = newSize
                syncSessionToViewport(newSize)
            }
            .onChange(of: session.nativeImageSize) { _, _ in
                // Before the decode publishes real dimensions, fit mode has
                // to guess. Recompute once the size lands so the idle refine
                // stays at viewport resolution instead of accidentally
                // targeting the full preview buffer on first open.
                syncSessionToViewport(viewportSize)
            }
            .onChange(of: session.asset.id) { _, _ in
                // Asset switched under us (SwiftUI may reuse the view
                // across navigation). Reset zoom to fit so a stale
                // pixelScale from the previous image doesn't make the new
                // image's refine pass target the full native extent.
                pixelScale = 0
                panOffset = .zero
                basePan = .zero
                syncSessionToViewport(viewportSize)
            }
        }
        .background(MapleTokens.imageCanvas)
        .contentShape(Rectangle())
        .focusable()
        .focused($isFocused)
        .focusEffectDisabled()
        .onAppear {
            isFocused = true
            // Reset to fit on open so every image lands in fit mode
            // regardless of the last asset's zoom (reference task(id:) reset).
            pixelScale = 0
            baseScale = 0
            panOffset = .zero
            basePan = .zero
        }
        .toolbar {
            // Zoom controls. Buttons mirror the reference's toolbar items;
            // keyboard shortcuts match (⌘0 Fit, ⌘1 100%, ⌘= in, ⌘- out).
            ToolbarItemGroup(placement: .automatic) {
                Button("Fit", systemImage: "arrow.down.right.and.arrow.up.left") {
                    resetZoom()
                }
                .keyboardShortcut("0", modifiers: .command)
                .help("Fit (⌘0)")

                Button("100%", systemImage: "1.circle") {
                    setZoom(to: 1.0)
                }
                .keyboardShortcut("1", modifiers: .command)
                .help("Actual size (⌘1)")

                Button {
                    zoomOut()
                } label: {
                    Image(systemName: "minus.magnifyingglass")
                }
                .keyboardShortcut("-", modifiers: .command)
                .help("Zoom out (⌘−)")
                .accessibilityLabel("Zoom out")

                Button {
                    zoomIn()
                } label: {
                    Image(systemName: "plus.magnifyingglass")
                }
                .keyboardShortcut("=", modifiers: .command)
                .help("Zoom in (⌘=)")
                .accessibilityLabel("Zoom in")
            }
        }
    }

    // MARK: - Zoom indicator (reference's `zoomIndicator(viewport:)`)

    /// Live zoom-percentage label, pinned to the bottom-leading corner.
    /// Reference shows a raw percent at all times; we keep that so the user
    /// sees fit mode as a concrete number (e.g. "18%") rather than the word
    /// "Fit". Matches the reference 1:1.
    private func zoomIndicator(viewport: CGSize) -> some View {
        let percent = Int((effectivePixelScale(viewport: viewport) * 100).rounded())
        return Text("\(percent)%")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 4))
            .padding(8)
            .accessibilityLabel("Zoom \(percent) percent")
    }

    // MARK: - Gestures (ported from reference verbatim)

    private func magnificationGesture(viewport: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                // Anchor against the scale at gesture start — `magnification`
                // is cumulative, multiplying into live pixelScale compounds.
                let start = pinchStartScale ?? effectivePixelScale(viewport: viewport)
                if pinchStartScale == nil { pinchStartScale = start }

                let fit = fitPixelScale(viewport: viewport)
                let newScale = max(fit * 0.5, min(start * value.magnification, maxPixelScale))
                pixelScale = newScale
            }
            .onEnded { value in
                let start = pinchStartScale ?? effectivePixelScale(viewport: viewport)
                let fit = fitPixelScale(viewport: viewport)
                let newScale = max(fit * 0.5, min(start * value.magnification, maxPixelScale))
                pixelScale = newScale
                baseScale = newScale
                pinchStartScale = nil

                // Snap back to fit if pinched near unity — keeps the
                // indicator honest and prevents 0.998× oddities.
                if newScale <= fit * 1.02 {
                    pixelScale = 0
                    baseScale = 0
                    panOffset = .zero
                    basePan = .zero
                }
                // During the gesture, zoom is just a SwiftUI transform on
                // the current bitmap. Commit once on release so target-size
                // refinements don't swap brightness mid-pinch.
                session.pixelScale = effectivePixelScale(viewport: viewport)
                // Plan 3 — push the new visible rect to the tile
                // manager so the deep-zoom branch (>= 1.0) re-targets.
                notifyVisibleRegion()
            }
    }

    private func dragGesture(viewport: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                if pixelScale > 0 {
                    // Zoomed in — accumulate pan.
                    panOffset = CGSize(
                        width: basePan.width + value.translation.width,
                        height: basePan.height + value.translation.height
                    )
                }
                // Fit-mode horizontal swipes are handled by the library
                // view model / left-right arrow keys in AppShell; this view
                // doesn't fire navigation on drag to keep the reference's
                // pan-only feel.
            }
            .onEnded { _ in
                if pixelScale > 0 {
                    basePan = panOffset
                    // Plan 3 — pan committed; push new visible rect.
                    notifyVisibleRegion()
                }
            }
    }

    // MARK: - Zoom actions

    private func resetZoom() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
            pixelScale = 0
            baseScale = 0
            panOffset = .zero
            basePan = .zero
            session.pixelScale = effectivePixelScale(viewport: viewportSize)
        }
        // Plan 3 — fit mode disables the deep-zoom branch (zero rect).
        notifyVisibleRegion()
    }

    private func setZoom(to scale: CGFloat) {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
            pixelScale = min(max(scale, 0.05), maxPixelScale)
            baseScale = pixelScale
            panOffset = .zero
            basePan = .zero
            session.pixelScale = pixelScale
        }
        notifyVisibleRegion()
    }

    private func zoomIn() {
        // Anchor at fit when we're in fit mode so the first ⌘= actually zooms.
        let current = pixelScale == 0
            ? effectivePixelScale(viewport: viewportSize)
            : pixelScale
        withAnimation(.easeInOut(duration: 0.15)) {
            pixelScale = min(current * 1.25, maxPixelScale)
            baseScale = pixelScale
            session.pixelScale = pixelScale
        }
        notifyVisibleRegion()
    }

    private func zoomOut() {
        let fit = fitPixelScale(viewport: viewportSize)
        let current = pixelScale == 0 ? fit : pixelScale
        withAnimation(.easeInOut(duration: 0.15)) {
            let next = current / 1.25
            if next <= fit * 1.02 {
                pixelScale = 0
                baseScale = 0
                panOffset = .zero
                basePan = .zero
            } else {
                pixelScale = max(next, fit * 0.5)
                baseScale = pixelScale
            }
            session.pixelScale = effectivePixelScale(viewport: viewportSize)
        }
        notifyVisibleRegion()
    }
}

// MARK: - CIImageView

/// Renders a CIImage into a SwiftUI view via a CGImage raster.
struct CIImageView: View {
    let image: CIImage

    @Environment(\.displayScale) private var displayScale

    /// Render-time CIContext. Output color space is Display P3 (extended
    /// linear conversion happens inside Core Image as it transcodes from
    /// the working `extendedLinearITUR_2020` / `extendedLinearSRGB`),
    /// pixel format is `.RGBA16` (16-bit-per-channel half-float) so the
    /// wide-gamut samples from the scene-linear chain don't get clipped
    /// to 8-bit-sRGB on the way to the canvas.
    ///
    /// On P3 displays this surfaces the wider-than-sRGB content (saturated
    /// reds/greens/blues that would otherwise clamp at the sRGB primary
    /// triangle). On sRGB displays the OS still tone-maps cleanly — the
    /// canvas just doesn't gain anything visually but doesn't regress.
    /// 16-bit reduces banding on smooth gradients (sky, skin shadows).
    ///
    /// Earlier docs ref (sRGB 8-bit rationale): see
    /// docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md Task 4 Step
    /// 4.0b — the determinism reasoning still holds, the choice of P3+16
    /// over sRGB+8 is the gamut/depth upgrade.
    private static let context = CIContext()
    private static let outputColorSpace = CGColorSpace(name: CGColorSpace.displayP3)!

    var body: some View {
        if let cgImg = Self.context.createCGImage(
            image,
            from: image.extent,
            format: .RGBA16,
            colorSpace: Self.outputColorSpace
        ) {
            // `Image(decorative:scale:orientation:)` is the explicit
            // pixel-to-point API and works identically on macOS and iOS.
            // The previous `Image(nsImage: NSImage(cgImage:size:.zero))`
            // path on macOS adopts the cgImage's pixel dimensions as the
            // NSImage's natural size in POINTS — at displayScale=2.0 that
            // yields a natural size twice the intended display size, and
            // `.resizable().aspectRatio(.fit)` does not reliably scale
            // down when natural points exceed the proposed frame. The
            // user reported this directly: a full-canvas-extent composite
            // from the deep-zoom refine pass renders at 2× the expected
            // zoom on macOS once the cgImage size exceeds the frame.
            // `Image(decorative:scale:)` carries the displayScale
            // explicitly, so 11648 px ÷ 2.0 = 5824 pt matches the frame.
            Image(decorative: cgImg, scale: displayScale, orientation: .up)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
        } else {
            Color.gray
        }
    }
}
