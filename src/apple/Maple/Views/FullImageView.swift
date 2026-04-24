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

    /// Image pixel extent — prefers the native RAW size (from EditSession once
    /// decode has landed) and falls back to the currently-displayed preview's
    /// extent. On first open we don't yet know the RAW size, so we let fit
    /// resolve against the preview so zoom math doesn't crash.
    private var imageExtent: CGSize? {
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

    // MARK: - Body

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // Background
                MapleTokens.imageCanvas.ignoresSafeArea()

                if let ci = session.showingOriginal ? nil : session.renderedPreview {
                    let extent = ci.extent.size
                    let scale = effectivePixelScale(viewport: geo.size)
                    // `scale` is real-px-per-image-px; SwiftUI frames are in
                    // points, so divide by displayScale. This mirrors the
                    // reference's inline sizing approach — explicit frame
                    // instead of `.scaleEffect`, which gives predictable
                    // pan math (`panOffset` is in points applied directly).
                    let displayW = extent.width * scale / displayScale
                    let displayH = extent.height * scale / displayScale

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
            .onChange(of: pixelScale) { _, _ in
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
        }
    }

    private func setZoom(to scale: CGFloat) {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
            pixelScale = min(max(scale, 0.05), maxPixelScale)
            baseScale = pixelScale
            panOffset = .zero
            basePan = .zero
        }
    }

    private func zoomIn() {
        // Anchor at fit when we're in fit mode so the first ⌘= actually zooms.
        let current = pixelScale == 0
            ? effectivePixelScale(viewport: viewportSize)
            : pixelScale
        withAnimation(.easeInOut(duration: 0.15)) {
            pixelScale = min(current * 1.25, maxPixelScale)
            baseScale = pixelScale
        }
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
        }
    }
}

// MARK: - CIImageView

/// Renders a CIImage into a SwiftUI view via a CGImage raster.
struct CIImageView: View {
    let image: CIImage

    private static let context = CIContext()

    var body: some View {
        if let cgImg = Self.context.createCGImage(image, from: image.extent) {
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
