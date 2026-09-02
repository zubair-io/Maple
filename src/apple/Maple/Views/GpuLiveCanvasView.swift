// GpuLiveCanvasView.swift — the live editor canvas backed by the wgpu chain
// presenting into a CAMetalLayer (epic #925, P4b-apple / #1028).
//
// Runtime-gated: used only when `GpuLiveFlag.isEnabled` (default on /
// `MAPLE_GPU_LIVE != 0`). With the flag off, `EditorView` shows the CPU
// `CanvasImageView` path byte-for-byte.
//
// ## Role — host + register, the scheduler presents
//
// This is the colour-correct sibling of `GpuDebugView.MetalPresentView` (P1b's
// passthrough proof), specialised for the live editor:
//
//   * It hosts ONE `CAMetalLayer` and REGISTERS it with the session's
//     `GpuLiveDriver` (`register(layer:)`). The driver presents the chain output
//     INTO this layer from `EditSession.decodeAndRender` on every scheduler tick
//     — so unlike the P1b one-shot, this view does NOT call present itself; it
//     only owns the surface and keeps it sized to the canvas.
//   * On first layout (once the layer exists and is sized) it kicks an initial
//     render so the first frame lands — subsequent frames are driven by slider
//     edits / zoom through the existing two-phase scheduler.
//
// `CanvasZoomHost` owns the viewport and is the ONLY writer of
// `session.previewSize`. This leaf is framed as the full displayed image; at
// 100% its bounds can be sensor-sized even though most of it is clipped by the
// viewport. Treating those leaf bounds as the viewport requests a full-sensor
// decode. The controller therefore registers the layer only; wgpu configures a
// viewport-sized drawable and CoreAnimation scales it across the image leaf.
//
// Colour space: the chain's `display_encode` stage bakes IN whichever
// primaries `CanvasColorSpace.current` selects (`target_primaries`, #1337/
// #1338) — sRGB or true Display P3 — and the layer tag must always name
// THAT SAME space, or CoreAnimation double-converts: tag sRGB over P3-encoded
// bytes washes the image out, tag P3 over sRGB-encoded bytes over-saturates
// it (#1512 — the bug this exact mismatch caused when the tag was hardcoded
// to `.displayP3` while the chain was still sRGB-only). `GpuLiveDriver.
// retagLayerIfNeeded` re-reads the same setting every present and keeps the
// tag in lockstep with what `GpuLiveParams`/`PipelineRenderer` just baked
// into the pixels.

import SwiftUI
import MapleCore
import QuartzCore
#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

/// Owns the canvas `CAMetalLayer` for the wgpu live path and registers it with
/// the session's driver. The driver presents into it from the render scheduler
/// and — per #1338 — owns the colour-space tag too, keeping it in lockstep
/// with the SAME `CanvasColorSpace` setting `PipelineRenderer`/`GpuLiveParams`
/// read on every render call (`GpuLiveDriver.retagLayerIfNeeded`); this
/// controller only manages the layer's identity + size and triggers the first
/// render once the surface is ready. Before that first present the layer has
/// no explicit colorspace tag — harmless, since nothing has been drawn into
/// it yet for CoreAnimation to mis-tag.
@MainActor
final class GpuLiveCanvasController {
    let layer = CAMetalLayer()
    private weak var session: EditSession?
    private var didRegister = false

    init() {
        layer.pixelFormat = .bgra8Unorm
        layer.framebufferOnly = true
        layer.isOpaque = true
    }

    func bind(session: EditSession) {
        self.session = session
    }

    /// Register the layer on first non-degenerate layout and kick the initial
    /// render. The bounds belong to the zoomed image leaf, not the clipped
    /// viewport, so they must never be written into `session.previewSize`.
    ///
    /// SINGLE-WRITER CONTRACT (#1769): this controller does NOT write
    /// `layer.drawableSize` — wgpu's `surface.configure` owns it (it sets the
    /// drawable size to the presented image dims on every (re)configure).
    /// The old write here ran on EVERY layout pass — and UIKit lays the iPad
    /// canvas out constantly (filmstrip, sidebar, zoom chrome, rotation) — so
    /// each 1-px disagreement with the image dims invalidated the layer's
    /// drawable pool without wgpu knowing. The next present then landed a
    /// SINGLE frame on a freshly-invalidated pool: the #1742-class splice with
    /// none of the settle double-present protection (that only engages when
    /// wgpu itself configures). The viewport pixel size still flows into
    /// `session.previewSize`, so the decode target (and therefore the
    /// configured drawable size) tracks the canvas as before.
    func layoutAndPresent(pixelWidth: CGFloat, pixelHeight: CGFloat) {
        guard pixelWidth >= 1, pixelHeight >= 1 else { return }
        guard let session, let driver = session.gpuLiveDriver else { return }
        if !didRegister {
            didRegister = true
            driver.register(layer: layer)
            // Re-entry contract (#1878): this controller (and its
            // CAMetalLayer) is created fresh on EVERY editor mount, while
            // the EditSession — including `gpuFramePresented` — survives in
            // AppShell's session store across editor⇄preview round trips.
            // A surviving `gpuFramePresented == true` describes the OLD,
            // torn-down layer; left set, every re-entry render kick
            // short-circuits (`kickRenderAfterGpuCanvasMount`'s
            // `!gpuFramePresented` guard) AND the CPU backdrop stays
            // hidden (`showCpuBackdrop` reads it), so the fresh blank
            // layer stays black forever. Reset it here — "no frame has
            // been presented into the CURRENT layer yet" — so the kick
            // below schedules a real present and the backdrop covers the
            // gap until it lands.
            session.gpuFramePresented = false
            // CanvasZoomHost has already (or will imminently) pushed the real
            // clipped viewport. Kick the first render without overwriting it
            // with this potentially sensor-sized leaf.
            session.ensureRenderStarted()
            // Cloud / sourceless cold-open follow-up (#1362): when the canvas
            // doesn't have `nativeImageSize` until the decode publishes, the
            // first render happens BEFORE this controller mounts, so it lands
            // on CPU. `ensureRenderStarted` then short-circuits subsequent
            // renders (its `renderedPreview == nil` guard) and the chip stays
            // on CPU until the user drags a slider. This kicks one explicit
            // render against the now-registered layer so the GPU path engages
            // and the chip flips immediately.
            session.kickRenderAfterGpuCanvasMount()
        }
    }
}

#if canImport(AppKit)
/// macOS host: a layer-backed NSView whose backing layer IS the canvas
/// CAMetalLayer. Sizing + registration fire from `layout()`.
struct GpuLiveCanvasView: NSViewRepresentable {
    let session: EditSession

    func makeNSView(context: Context) -> NSView {
        context.coordinator.bind(session: session)
        let view = LayerBackedView(controller: context.coordinator)
        view.wantsLayer = true
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // Layout (sizing + present) is driven by the view's own `layout()`.
    }

    func makeCoordinator() -> GpuLiveCanvasController { GpuLiveCanvasController() }

    final class LayerBackedView: NSView {
        private let controller: GpuLiveCanvasController
        init(controller: GpuLiveCanvasController) {
            self.controller = controller
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { fatalError("not used") }
        override func makeBackingLayer() -> CALayer { controller.layer }
        override func layout() {
            super.layout()
            // Apply layer geometry instantly — no implicit resize animation on
            // a zoom commit (mirrors the iOS sublayer fix, #1495).
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            controller.layer.frame = bounds
            let scale = window?.backingScaleFactor ?? 2.0
            controller.layoutAndPresent(
                pixelWidth: bounds.width * scale,
                pixelHeight: bounds.height * scale
            )
            CATransaction.commit()
        }
    }
}
#elseif canImport(UIKit)
/// iOS host: a UIView hosting the canvas CAMetalLayer as a sublayer (the
/// controller owns the instance so wgpu + SwiftUI share one layer). Sizing +
/// registration fire from `layoutSubviews()`.
struct GpuLiveCanvasView: UIViewRepresentable {
    let session: EditSession

    func makeUIView(context: Context) -> UIView {
        context.coordinator.bind(session: session)
        return MetalBackedView(controller: context.coordinator)
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // Layout (sizing + present) is driven by the view's own `layoutSubviews()`.
    }

    func makeCoordinator() -> GpuLiveCanvasController { GpuLiveCanvasController() }

    final class MetalBackedView: UIView {
        private let controller: GpuLiveCanvasController
        init(controller: GpuLiveCanvasController) {
            self.controller = controller
            super.init(frame: .zero)
            layer.addSublayer(controller.layer)
        }
        required init?(coder: NSCoder) { fatalError("not used") }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            // A pre-attach layout pass falls back to an unresolved trait
            // scale (below); force one more pass now that the window's real
            // screen scale is known, so the surface never stays at 1x.
            setNeedsLayout()
        }
        override func layoutSubviews() {
            super.layoutSubviews()
            // `displayScale` is the trait equivalent of the deprecated
            // `UIScreen.main.scale`; it's 0 while traits are unspecified
            // (no window yet), so clamp to a sane floor.
            let scale = window?.screen.scale ?? max(traitCollection.displayScale, 1)
            // The canvas layer is a SUBLAYER, so its geometry changes implicitly
            // animate (~0.25s). When the frame grows on a zoom commit the layer
            // would animate from `(0,0, oldSize)` outward — the image visibly
            // slides from the top-left and snaps to place. Disable the implicit
            // actions so the new size/scale apply instantly. (#1495)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            controller.layer.frame = bounds
            controller.layer.contentsScale = scale
            controller.layoutAndPresent(
                pixelWidth: bounds.width * scale,
                pixelHeight: bounds.height * scale
            )
            CATransaction.commit()
        }
    }
}
#endif
