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

    // MARK: - Fit math (ported from reference's `fitPixelScale`)

    /// Fit-to-viewport pixel scale. Real pixels per image pixel.
    /// Both viewport and image sizes are converted to real pixels first so
    /// the ratio is meaningful on retina displays.
    private func fitPixelScale(viewport: CGSize, imageSize: CGSize?) -> CGFloat {
        guard let imageSize,
              imageSize.width > 0, imageSize.height > 0,
              viewport.width > 0, viewport.height > 0
        else { return 1 }
        let viewportPx = CGSize(
            width: viewport.width * displayScale,
            height: viewport.height * displayScale
        )
        return min(viewportPx.width / imageSize.width,
                   viewportPx.height / imageSize.height)
    }

    /// Image pixel extent for fit / zoom math. Prefers `nativeImageSize` so
    /// the math is stable across fast-phase, refine-phase, cached-preview,
    /// and embedded-JPEG paints — those buffers can differ in extent from
    /// the real sensor dimensions (half-res decode + upscale, viewport-sized
    /// cache, 2048-max embedded preview). `renderedPreview.extent` is the
    /// fallback for the first paint before `nativeImageSize` is seeded.
    private var imageExtent: CGSize? {
        if session.nativeImageSize != .zero {
            return session.nativeImageSize
        }
        if let ci = session.renderedPreview {
            return ci.extent.size
        }
        return nil
    }

    /// Resolves "fit" mode to a concrete scale. Reads `viewportSize` so the
    /// toolbar/keyboard paths (which don't have a `GeometryReader` in scope)
    /// can share the same math as gestures.
    private func effectivePixelScale(viewport: CGSize) -> CGFloat {
        if pixelScale == 0 {
            return fitPixelScale(viewport: viewport, imageSize: imageExtent)
        }
        return pixelScale
    }

    /// Push the current visible source rect + zoom to the session. Called
    /// from every path that mutates `pixelScale` or `panOffset` so the
    /// tile manager always sees the live viewport. Wraps the pure
    /// helper `EditSession.computeVisibleSourceRect(...)` so the math
    /// is unit-testable from MapleCoreTests.
    private func notifyVisibleRegion() {
        let zoom = effectivePixelScale(viewport: viewportSize)
        let visible = EditSession.computeVisibleSourceRect(
            viewport: viewportSize,
            zoom: zoom,
            imageSize: imageExtent,
            panOffset: panOffset,
            displayScale: displayScale
        )
        session.updateTileVisibleRegion(viewport: visible, zoom: zoom)
    }

    // MARK: - Body

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // Background
                MapleTokens.imageCanvas.ignoresSafeArea()

                if let ci = session.showingOriginal ? nil : session.renderedPreview {
                    // Frame on the *virtual* image size — `nativeImageSize`
                    // once the decode has landed, otherwise the current
                    // buffer's extent as a best-effort. The CIImage itself
                    // may be at a smaller resolution (embedded preview,
                    // cached JPEG, half-res fast phase) and CoreImage will
                    // upscale to fill this frame. Keying the frame off
                    // `ci.extent` instead causes the picture to collapse
                    // whenever the preview buffer is smaller than native
                    // (embedded JPEG landed but decode hasn't) — the frame
                    // shrinks along with the buffer and the viewport looks
                    // like it went blank.
                    let virtualSize = imageExtent ?? ci.extent.size
                    let scale = effectivePixelScale(viewport: geo.size)
                    // `scale` is real-px-per-image-px; SwiftUI frames are in
                    // points, so divide by displayScale. Matches reference
                    // Maple's inline sizing approach — explicit frame
                    // instead of `.scaleEffect`, which gives predictable
                    // pan math (`panOffset` is in points applied directly).
                    let displayW = virtualSize.width * scale / displayScale
                    let displayH = virtualSize.height * scale / displayScale

                    CIImageView(image: ci)
                        .frame(width: displayW, height: displayH)
                        .offset(panOffset)
                        .gesture(magnificationGesture(viewport: geo.size))
                        .simultaneousGesture(dragGesture(viewport: geo.size))
                        .onTapGesture(count: 2) { resetZoom() }
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
                // previewSize in real screen pixels so the pipeline's target
                // matches hardware and CoreImage auto-tiles only when it must.
                session.previewSize = CGSize(
                    width: geo.size.width * displayScale,
                    height: geo.size.height * displayScale
                )
                session.pixelScale = effectivePixelScale(viewport: geo.size)
                session.ensureRenderStarted()
            }
            .onChange(of: geo.size) { _, newSize in
                viewportSize = newSize
                session.previewSize = CGSize(
                    width: newSize.width * displayScale,
                    height: newSize.height * displayScale
                )
                session.pixelScale = effectivePixelScale(viewport: newSize)
            }
            .onChange(of: session.nativeImageSize) { _, _ in
                // Before the decode publishes real dimensions, fit mode has
                // to guess. Recompute once the size lands so the idle refine
                // stays at viewport resolution instead of accidentally
                // targeting the full preview buffer on first open.
                session.pixelScale = effectivePixelScale(viewport: viewportSize)
            }
            .onChange(of: session.asset.id) { _, _ in
                // Asset switched under us (SwiftUI may reuse the view
                // across navigation). Reset zoom to fit so a stale
                // pixelScale from the previous image doesn't make the new
                // image's refine pass target the full native extent.
                pixelScale = 0
                panOffset = .zero
                basePan = .zero
                session.pixelScale = effectivePixelScale(viewport: viewportSize)
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

                let fit = fitPixelScale(viewport: viewport, imageSize: imageExtent)
                let newScale = max(fit * 0.5, min(start * value.magnification, maxPixelScale))
                pixelScale = newScale
            }
            .onEnded { value in
                let start = pinchStartScale ?? effectivePixelScale(viewport: viewport)
                let fit = fitPixelScale(viewport: viewport, imageSize: imageExtent)
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
        let fit = fitPixelScale(viewport: viewportSize, imageSize: imageExtent)
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

    /// Render-time CIContext. Output color space is sRGB so the
    /// Rec.2020->sRGB encode happens here, deterministically, exactly
    /// once on both legacy and scene-linear paths. Without this the
    /// scene-linear path's extendedLinearITUR_2020-tagged input lands
    /// in an implementation-defined pixel space at write-out — wide
    /// gamut on P3 hardware, primary-mismatched on others. See
    /// docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md Task 4
    /// Step 4.0b.
    private static let context = CIContext()
    private static let outputColorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    var body: some View {
        if let cgImg = Self.context.createCGImage(
            image,
            from: image.extent,
            format: .RGBA8,
            colorSpace: Self.outputColorSpace
        ) {
            #if os(macOS)
            Image(nsImage: NSImage(cgImage: cgImg, size: .zero))
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
            #else
            Image(uiImage: UIImage(cgImage: cgImg))
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
            #endif
        } else {
            Color.gray
        }
    }
}
