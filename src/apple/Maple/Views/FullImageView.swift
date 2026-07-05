// FullImageView.swift — Full-resolution canvas with zoom/pan, toolbar, and
// before/after.
//
// The zoom/pan/gesture machinery that used to live here verbatim was
// extracted into the shared `CanvasZoomHost` + `CanvasZoomController` +
// `CanvasZoomModel` stack (#1099, spec §5.0) so the S5 `EditorView` and
// this legacy surface run the exact same model:
//
//   • `pixelScale`: real screen pixels per image pixel — 0 = fit,
//     1.0 = pixel-perfect, 8.0 cap (docs/zoom.md).
//   • Pinch anchored against a start-captured scale, pan clamped,
//     snap-to-fit below fit × 1.02, double-tap reset, zoom badge.
//
// This file keeps what is specific to the legacy surface: the GPU-live
// vs CPU canvas branch, the before/after + error + progress overlays,
// the GPU frame-time HUD, and the toolbar (⌘0 fit / ⌘1 100% / ⌘= in /
// ⌘- out) driving the shared controller.
//
// The view pushes `pixelScale` and `previewSize` onto the session (via
// the controller) so the pipeline's two-phase render can retarget the
// refined pass at the right size — a 100% zoom on a 100MP RAW renders at
// full resolution, while fit mode stays at viewport resolution for the
// 16ms slider budget.

import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins
import MapleCore

struct FullImageView: View {
    /// `EditSession` is `@Observable`; SwiftUI tracks property access directly.
    let session: EditSession

    /// Shared zoom state + session plumbing (#1099). Rebuilt whenever
    /// the hosted session object changes (SwiftUI reuses this view
    /// across selection changes) — see the `.task(id:)` below.
    @State private var zoomController: CanvasZoomController?

    @FocusState private var isFocused: Bool

    // MARK: - Canvas content (CPU CIImage vs wgpu live present)

    /// True when the canvas should present via the wgpu live path. Gates on
    /// the flag + `!showingOriginal` only — #1331 extended the chain to
    /// non-RAW input shapes (JPEG / HEIF / pano PNG via
    /// `InputShape::LinearRec2020Fp16`), so the canvas must mount for both
    /// RAW and non-RAW assets so `driver.register(layer:)` fires and the
    /// `no-layer` reject path never engages. The `isRaw` parameter on the
    /// VM predicate is preserved for ABI but ignored. See #1362.
    private var useGpuCanvas: Bool {
        FullImageViewVM.shouldPresentViaGpuCanvas(
            flagEnabled: GpuLiveFlag.isEnabled,
            isRaw: session.asset.isRaw,
            showingOriginal: session.showingOriginal,
            presentFailed: session.gpuPresentFailed
        )
    }

    /// True when the host should render the canvas leaf (vs the
    /// placeholder). The GPU layer mounts immediately; the CPU leaf
    /// needs a published preview (and the before/after "original"
    /// overlay always shows the placeholder, as before).
    private var canvasIsReady: Bool {
        useGpuCanvas || (!session.showingOriginal && session.renderedPreview != nil)
    }

    /// The canvas leaf the zoom host frames + pans. The wgpu chain
    /// presents directly into a `CAMetalLayer` (`GpuLiveCanvasView`, no
    /// `renderedPreview` CIImage) when `useGpuCanvas` holds; otherwise
    /// the CPU `CIImageView` rasters `renderedPreview` exactly as
    /// before. The frame is driven by the session's `nativeImageSize`
    /// exclusively (via `CanvasZoomController.displayFrameInPoints`) —
    /// the CIImage itself may be at a smaller resolution (embedded
    /// preview, half-res fast phase) and CoreImage upscales to fill.
    @ViewBuilder
    private var canvasLeaf: some View {
        if useGpuCanvas {
            GpuLiveCanvasView(session: session)
                .accessibilityIdentifier(
                    FullImageViewVM.canvasAccessibilityID(
                        isRendering: session.isRendering,
                        hasPreview: session.gpuFramePresented // true once the wgpu chain presented a frame (#1069)
                    )
                )
        } else if let ci = session.showingOriginal ? nil : session.renderedPreview {
            // UITest harness sentinel — the identifier only appears once
            // the refine pass has published a preview AND `isRendering`
            // has flipped false. The harness waits via
            // NSPredicate(exists==1) on
            // `app.otherElements["canvas-render-ready"]`. See
            // .archived-plans/plans/2026-04-25-xcuitest-visual-harness.md.
            CIImageView(image: ci)
                .accessibilityIdentifier(
                    FullImageViewVM.canvasAccessibilityID(
                        isRendering: session.isRendering,
                        hasPreview: session.renderedPreview != nil
                    )
                )
        }
    }

    /// Placeholder while rendering (or while the zoom controller is
    /// being built on first mount).
    private var canvasPlaceholder: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(MapleTokens.surfaceAlt)
            .frame(maxWidth: 800, maxHeight: 600)
            .overlay {
                Image(systemName: "photo")
                    .font(.system(size: 60))
                    .foregroundStyle(MapleTokens.textMuted)
            }
    }

    // MARK: - GPU frame-time HUD (validation-only overlay)

    /// The GPU frame-time HUD overlay (#1053). Renders the HUD only when the GPU
    /// live path is active AND the HUD sub-flag is on (`MAPLE_GPU_HUD=1`); an
    /// `EmptyView` otherwise.
    @ViewBuilder
    private func frameTimeHud() -> some View {
        if GpuLiveFlag.isEnabled, GpuHudFlag.isEnabled,
           let stats = session.gpuLiveDriver?.frameStats {
            GpuFrameTimeHud(stats: stats)
        } else {
            EmptyView()
        }
    }

    // MARK: - Body

    var body: some View {
        ZStack {
            // Background
            MapleTokens.imageCanvas.ignoresSafeArea()

            // Canvas content — the shared zoom host frames the leaf at
            // the resolved display frame, owns pinch / pan / double-tap
            // / wheel routing, clips overflow, and renders the zoom
            // badge. Double-tap resets to fit (the legacy behavior; the
            // S5 editor opts into the fit ↔ 100% toggle instead).
            if let controller = zoomController, controller.session === session {
                CanvasZoomHost(
                    controller: controller,
                    doubleTapBehavior: .resetToFit,
                    canvasReady: canvasIsReady
                ) {
                    canvasLeaf
                } fallback: {
                    canvasPlaceholder
                }
            } else {
                // One transient frame on first mount / session swap
                // while the `.task(id:)` below builds the controller.
                canvasPlaceholder
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

            // Error banners — only mounted when an error is present so
            // the overlay never intercepts gestures while the canvas is clean.
            if let err = session.renderError ?? session.sidecarError {
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
                .allowsHitTesting(false)
            }

            // Loading indicator. Shown while the cold-open is still resolving
            // its first full-quality frame (`isResolvingFirstFrame`) — it stays
            // up from open, through the sub-second preview AND the seconds-long
            // background decode, until the real image actually publishes one
            // render step later (#1201). The frame-based term covers the
            // no-preview blank-canvas window; once a frame is up and the open has
            // resolved, a slider tick won't flash it. `gpuActive` mirrors
            // `useGpuCanvas` so non-RAW (CPU-canvas) assets key off
            // `renderedPreview` rather than the always-false `gpuFramePresented`.
            if EditSession.shouldShowLoadingIndicator(
                isResolvingFirstFrame: session.isResolvingFirstFrame,
                isRendering: session.isRendering,
                hasOnscreenFrame: EditSession.canvasHasFrame(
                    gpuActive: useGpuCanvas,
                    gpuFramePresented: session.gpuFramePresented,
                    hasRenderedPreview: session.renderedPreview != nil
                )
            ) {
                ProgressView()
                    .controlSize(.small)
                    .tint(.white)
            }
        }
        .overlay(alignment: .topTrailing) {
            // GPU frame-time HUD — validation-only (gpu build +
            // MAPLE_GPU_HUD=1); compiles out / EmptyView otherwise.
            frameTimeHud()
        }
        .background(MapleTokens.imageCanvas)
        .contentShape(Rectangle())
        .focusable()
        .focused($isFocused)
        .focusEffectDisabled()
        // Build / rebuild the zoom controller when the hosted session
        // object changes (SwiftUI reuses this view across navigation; a
        // controller pinned to the previous session would sync zoom into
        // the wrong pipeline). A fresh controller starts at fit.
        .task(id: ObjectIdentifier(session)) {
            if zoomController?.session !== session {
                zoomController = CanvasZoomController(session: session)
            }
        }
        .onAppear {
            isFocused = true
            // Reset to fit on (re-)open so every image lands in fit mode
            // regardless of the last visit's zoom (reference task(id:)
            // reset). No-op on first mount — the fresh controller is
            // already at fit.
            zoomController?.resetToFit()
            session.ensureRenderStarted()
        }
        .onChange(of: session.asset.id) { _, _ in
            // The zoom host resets zoom to fit itself; this view only
            // drops the GPU frame-time window so the new image's HUD
            // doesn't carry the prior image's samples (the driver /
            // session persist across the reused view). No-op when the
            // HUD isn't recording.
            session.gpuLiveDriver?.frameStats.reset()
        }
        .toolbar {
            // Zoom controls grouped on the LEADING toolbar edge (right of
            // the sidebar-toggle / Back, before the navigationTitle) per
            // the same UX rule as browseToolbar — header controls cluster
            // next to the menu button rather than across the title bar.
            // Keyboard shortcuts match (⌘0 Fit, ⌘1 100%, ⌘= in, ⌘- out).
            ToolbarItemGroup(placement: .navigation) {
                Button("Fit", systemImage: "arrow.down.right.and.arrow.up.left") {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        zoomController?.resetToFit()
                    }
                }
                .keyboardShortcut("0", modifiers: .command)
                .help("Fit (⌘0)")

                Button("100%", systemImage: "1.circle") {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        zoomController?.zoomToScale(1.0)
                    }
                }
                .keyboardShortcut("1", modifiers: .command)
                .help("Actual size (⌘1)")

                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        zoomController?.stepZoomOut()
                    }
                } label: {
                    Image(systemName: "minus.magnifyingglass")
                }
                .keyboardShortcut("-", modifiers: .command)
                .help("Zoom out (⌘−)")
                .accessibilityLabel("Zoom out")

                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        zoomController?.stepZoomIn()
                    }
                } label: {
                    Image(systemName: "plus.magnifyingglass")
                }
                .keyboardShortcut("=", modifiers: .command)
                .help("Zoom in (⌘=)")
                .accessibilityLabel("Zoom in")
            }
        }
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
    /// .archived-plans/plans/2026-04-24-ffi-split-plan-1.md Task 4 Step
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

// MARK: - Previews
//
// Issue #139 — full-image canvas against `EditSession.preview()`. The
// canvas shows its placeholder background because no render is ever
// produced (preview asset has no bytes), but the toolbar, zoom HUD and
// fit/pan controls all render — which is what the preview is here to
// surface.

#Preview("Default") {
    FullImageView(session: EditSession.preview())
        .frame(width: 900, height: 700)
}
