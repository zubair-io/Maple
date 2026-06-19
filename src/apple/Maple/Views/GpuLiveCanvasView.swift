// GpuLiveCanvasView.swift — the live editor canvas backed by the wgpu chain
// presenting into a CAMetalLayer (epic #925, P4b-apple / #1028).
//
// Runtime-gated: used only when `GpuLiveFlag.isEnabled` (default on /
// `MAPLE_GPU_LIVE != 0`). With the flag off, `FullImageView` shows the CPU
// `CIImageView` path byte-for-byte.
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
// Colour space: the chain outputs sRGB-primary, gamma-encoded pixels, so the
// layer is tagged sRGB (#1512) and CoreAnimation converts sRGB → the display's
// space (P3 on a P3 panel). It was previously tagged Display P3, which made
// CoreAnimation treat the sRGB bytes as ALREADY P3 and skip the conversion,
// over-saturating every image. See the tag set in `init()` below.

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
        // The present chain writes sRGB-primary, sRGB-gamma pixels
        // (`display_encode` with target_primaries=0). Tag the layer sRGB so
        // CoreAnimation color-manages sRGB→the display's space (P3 on a P3
        // panel) — exactly the conversion the header comment above describes.
        // Tagging the layer `.displayP3` (the old value) instead told
        // CoreAnimation the bytes were ALREADY P3, so NO conversion ran and
        // sRGB values were reinterpreted as P3 — over-saturating every image
        // (raw + non-raw); neutrals were unaffected (gray axis is tag-invariant).
        // #1512.
        //
        // NOTE: this tag MUST track `GpuLiveParams.target_primaries`. It is `0`
        // (sRGB) today, so the canvas caps at sRGB gamut. When #1338 wires the
        // Display-P3 path (`target_primaries = 1`, outputting P3-primary pixels to
        // use the panel's full gamut), this tag must flip back to `.displayP3` so
        // the layer tag again matches the encoded primaries.
        if let srgb = CGColorSpace(name: CGColorSpace.sRGB) {
            layer.colorspace = srgb
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
        // Round to integer pixels BEFORE setting `drawableSize` and propagating
        // to `previewSize`. The wgpu present chain asserts
        // `surface_dims == image_dims`, where image_dims comes from
        // `Int(prescaledExtent.width.rounded())` — passing a fractional
        // `bounds.width * scale` to `drawableSize` (e.g. 913.5) and to the
        // decode `targetSize` lands on `914` for the surface but `913` for the
        // image after `prescaledExtent` rounds the other way. The present
        // throws `GpuLiveError(1)` and the canvas reads as a black surface
        // — the exact root cause of the #1240 "image disappears" report.
        // Rounding both inputs to the same integer here keeps them aligned.
        let w = pixelWidth.rounded()
        let h = pixelHeight.rounded()
        let size = CGSize(width: w, height: h)
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
            // Cloud / sourceless cold-open follow-up (#1362): when the canvas
            // doesn't have `nativeImageSize` until the decode publishes, the
            // first render happens BEFORE this controller mounts, so it lands
            // on CPU. `ensureRenderStarted` then short-circuits subsequent
            // renders (its `renderedPreview == nil` guard) and the chip stays
            // on CPU until the user drags a slider. This kicks one explicit
            // render against the now-registered layer so the GPU path engages
            // and the chip flips immediately.
            session.kickRenderAfterGpuCanvasMount()
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
        override func layoutSubviews() {
            super.layoutSubviews()
            let scale = window?.screen.scale ?? UIScreen.main.scale
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
