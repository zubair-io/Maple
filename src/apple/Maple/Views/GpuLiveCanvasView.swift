// GpuLiveCanvasView.swift — the live editor canvas backed by the wgpu chain
// presenting into a CAMetalLayer (epic #925, P4b-apple / #1028).
//
// ENTIRELY gated behind `#if MAPLE_GPU`. With the flag undefined this file
// compiles to nothing and `FullImageView` shows the CPU `CIImageView` path
// byte-for-byte. Even WITH the flag compiled in, it is only used when
// `GpuLiveFlag.isEnabled` (a gpu build launched with `MAPLE_GPU_LIVE=1`); a gpu
// build with the env flag off still renders via `CIImageView`.
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
// The drawable size is set from the host view's pixel bounds. The present asserts
// `surface_dims == image_dims`, and the driver uploads the decoded buffer at the
// viewport-sized fast-phase target, so the canvas must request the SAME size the
// session's `fastTargetSize` resolves to. We drive the session's `previewSize`
// from the same pixel bounds (as the CPU `FullImageView` does), so the decode
// target and the layer size agree.
//
// Colour space: tagged Display P3 authoritatively on the Swift side (the chain
// outputs sRGB-primary gamma-encoded; CoreAnimation converts sRGB → P3 with
// everything in-gamut), mirroring `MetalPresentLayerController`.

#if MAPLE_GPU

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
/// the session's driver. The driver presents into it from the render scheduler;
/// this controller only manages the layer's size + colour-space tag and triggers
/// the first render once the surface is ready.
@MainActor
final class GpuLiveCanvasController {
    let layer = CAMetalLayer()
    private weak var session: EditSession?
    private var didRegister = false
    private var lastPixelSize: CGSize = .zero

    init() {
        layer.pixelFormat = .bgra8Unorm
        layer.framebufferOnly = true
        layer.isOpaque = true
        if let p3 = CGColorSpace(name: CGColorSpace.displayP3) {
            layer.colorspace = p3
        }
    }

    func bind(session: EditSession) {
        self.session = session
    }

    /// Size the drawable from the host view's pixel bounds, register the layer
    /// with the driver on first sizing, and kick the initial render. Called from
    /// the host view's `layout()` / `layoutSubviews()`, where bounds are
    /// authoritative.
    func layoutAndPresent(pixelWidth: CGFloat, pixelHeight: CGFloat) {
        guard pixelWidth >= 1, pixelHeight >= 1 else { return }
        let size = CGSize(width: pixelWidth, height: pixelHeight)
        // Avoid thrashing the drawable size on no-op layout passes.
        if size != lastPixelSize {
            layer.drawableSize = size
            lastPixelSize = size
        }
        guard let session, let driver = session.gpuLiveDriver else { return }
        if !didRegister {
            didRegister = true
            driver.register(layer: layer)
            // Push the viewport so the decode target (and thus the GPU upload /
            // the layer drawable) resolve to this size, then kick the first
            // render — subsequent frames ride the scheduler on edits.
            session.previewSize = size
            session.ensureRenderStarted()
        } else if size != session.previewSize {
            // A resize re-targets the decode (and re-opens the upload-once
            // session at the new dims) via the scheduler's refine path.
            session.previewSize = size
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
            controller.layer.frame = bounds
            let scale = window?.backingScaleFactor ?? 2.0
            controller.layoutAndPresent(
                pixelWidth: bounds.width * scale,
                pixelHeight: bounds.height * scale
            )
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
        override func layoutSubviews() {
            super.layoutSubviews()
            let scale = window?.screen.scale ?? UIScreen.main.scale
            controller.layer.frame = bounds
            controller.layer.contentsScale = scale
            controller.layoutAndPresent(
                pixelWidth: bounds.width * scale,
                pixelHeight: bounds.height * scale
            )
        }
    }
}
#endif

#endif
