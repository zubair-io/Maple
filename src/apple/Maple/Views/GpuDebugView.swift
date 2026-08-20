// GpuDebugView.swift — wgpu/Metal validation surface (epic #925 / P1b, #988).
//
// This is the Apple-side proof harness for the GPU resource core: it runs the
// wgpu→Metal exposure parity FFI and shows the max abs diff in-app (device logs
// aren't capturable on-device, so the number must be visible), and it hosts a
// CAMetalLayer that wgpu presents a passthrough test pattern into.
//
// Runtime-gated, reached only when launched with `MAPLE_GPU_DEBUG=1` (see
// `MapleApp.body`). The GPU FFI surface (`maple_gpu_*`) it calls is now compiled
// into the xcframework unconditionally (gpu is the default xcframework build —
// see scripts/build-xcframework.sh; the cbindgen header declares the symbols
// unconditionally), so this view always compiles and links.
//
// Nothing here ships in the normal shell; the live edit path is P4. P1b proves
// the surface tag + plumbing (passthrough), NOT a colour-correct render (P2).

import SwiftUI
import Observation
import RawPipeline
import QuartzCore
#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

// MARK: - FFI bridge

/// Error wrapper for the GPU FFI bridge — carries the message (from
/// `maple_last_error` or the return code) so the debug view can surface it.
/// `Result`'s failure type must be an `Error`, so we can't use a bare `String`.
struct GpuDebugError: Error {
    let message: String
}

/// Thin Swift wrapper over the GPU validation FFI. Both entries are
/// self-contained one-shots in Rust — each builds and drops its own wgpu
/// context, so nothing crosses the boundary that must be kept on one thread.
/// Per the P1a note, `GpuContext` is `!Send`/`!Sync`, but it never escapes the
/// FFI call, so these are safe to invoke from the main thread.
enum GpuDebugBridge {
    /// Run the wgpu→Metal exposure-parity chain over `nPixels` deterministic
    /// pixels at `ev` and return the max abs diff vs the CPU oracle, or an
    /// error. A value `< 1e-4` is a pass (the WGSL kernel matched the CPU
    /// reference on Metal).
    static func exposureParity(nPixels: UInt32 = 256, ev: Float = 0.5) -> Result<Float, GpuDebugError> {
        var maxDiff: Float = .nan
        let rc = maple_gpu_exposure_parity(nPixels, ev, &maxDiff)
        guard rc == 0 else {
            return .failure(GpuDebugError(
                message: lastError() ?? "maple_gpu_exposure_parity returned \(rc)"))
        }
        return .success(maxDiff)
    }

    /// Present the wgpu passthrough test pattern into `layer` (a CAMetalLayer)
    /// at `width × height`. Returns an error on failure. The layer is borrowed
    /// for the call only (the Rust side drops the surface before returning) —
    /// pass it unretained.
    @discardableResult
    static func present(layer: CAMetalLayer, width: UInt32, height: UInt32) -> Result<Void, GpuDebugError> {
        let ptr = Unmanaged.passUnretained(layer).toOpaque()
        let rc = maple_gpu_present_test_pattern(ptr, width, height)
        guard rc == 0 else {
            return .failure(GpuDebugError(
                message: lastError() ?? "maple_gpu_present_test_pattern returned \(rc)"))
        }
        return .success(())
    }

    private static func lastError() -> String? {
        guard let cstr = maple_last_error() else { return nil }
        return String(cString: cstr)
    }
}

// MARK: - CAMetalLayer host (passthrough present surface)

/// Hosts a `CAMetalLayer` and asks wgpu to present the passthrough test pattern
/// into it once the layer has a non-zero drawable size. wgpu creates its Metal
/// surface directly from this layer (no MTKView, no CoreImage) — this is the
/// CAMetalLayer interop proof.
///
/// `@Observable` so the SwiftUI `status` readout updates when the present
/// completes or fails — in-app surfacing is the ONLY on-device verification
/// mechanism (device logs aren't capturable), so a present failure must be
/// visible, not silent.
///
/// Colour-space tag: we set `layer.colorspace` explicitly to Display P3 and
/// document it. This is the AUTHORITATIVE colour-space declaration for the
/// passthrough proof. P1b does NOT make the pixels colour-correct (the
/// Rec.2020→display + AgX encode is P2) — it proves the tag is set on purpose
/// and the plumbing works end to end.
@Observable
final class MetalPresentLayerController {
    @ObservationIgnored let layer = CAMetalLayer()
    @ObservationIgnored private var didPresent = false
    private(set) var status: String = "waiting for layout…"

    init() {
        layer.pixelFormat = .bgra8Unorm
        layer.framebufferOnly = true
        layer.isOpaque = true
        // Explicit, deliberate colour-space tag (see the type doc). Display P3
        // is Maple's canvas working display space on Apple; tagging the layer
        // keeps wide-gamut Macs from reinterpreting the buffer.
        if let p3 = CGColorSpace(name: CGColorSpace.displayP3) {
            layer.colorspace = p3
        }
    }

    /// Set the drawable size from the host view's pixel bounds and attempt a
    /// present if sized and not already done. One-shot: P1b presents a single
    /// frame; a redraw loop is P4. Call from the host view's `layout()` /
    /// `layoutSubviews()`, where bounds are authoritative (calling from
    /// `updateNSView`/`updateUIView` can race final layout and read 0×0).
    func layoutAndPresent(pixelWidth: CGFloat, pixelHeight: CGFloat) {
        guard pixelWidth >= 1, pixelHeight >= 1 else { return }
        layer.drawableSize = CGSize(width: pixelWidth, height: pixelHeight)
        guard !didPresent else { return }
        didPresent = true
        switch GpuDebugBridge.present(
            layer: layer,
            width: UInt32(pixelWidth),
            height: UInt32(pixelHeight)
        ) {
        case .success:
            status = "presented \(Int(pixelWidth))×\(Int(pixelHeight)) (wgpu→CAMetalLayer)"
        case .failure(let err):
            status = "present FAILED: \(err.message)"
            // Allow a retry on the next layout pass if the first frame raced
            // the surface being ready.
            didPresent = false
        }
    }
}

#if canImport(AppKit)
/// macOS host: a layer-backed NSView whose backing layer IS the CAMetalLayer.
/// The present fires from `layout()`, where `bounds` is authoritative.
struct MetalPresentView: NSViewRepresentable {
    let controller: MetalPresentLayerController

    func makeNSView(context: Context) -> NSView {
        let view = LayerBackedView(controller: controller)
        view.wantsLayer = true
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // Layout (and thus the present) is driven by the view's own `layout()`
        // override, not here — `bounds` isn't final at update time.
    }

    /// NSView that installs the controller's CAMetalLayer as its backing layer,
    /// pins the layer frame to bounds, and triggers the present from `layout()`.
    final class LayerBackedView: NSView {
        private let controller: MetalPresentLayerController
        init(controller: MetalPresentLayerController) {
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
/// iOS host: a UIView hosting the controller's CAMetalLayer as a sublayer.
///
/// We add the CAMetalLayer as a SUBLAYER rather than overriding `layerClass`:
/// the controller owns the layer instance (so wgpu and SwiftUI share one
/// `CAMetalLayer`), and `layerClass` would force UIKit to construct its own.
/// A CAMetalLayer renders correctly as a sublayer; the present fires from
/// `layoutSubviews()`, where `bounds` is authoritative.
struct MetalPresentView: UIViewRepresentable {
    let controller: MetalPresentLayerController

    func makeUIView(context: Context) -> UIView {
        MetalBackedView(controller: controller)
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // Layout (and thus the present) is driven by the view's own
        // `layoutSubviews()` override, not here — `bounds` isn't final at
        // update time.
    }

    /// UIView that hosts the controller's CAMetalLayer as a sublayer, pins its
    /// frame to bounds, and triggers the present from `layoutSubviews()`.
    final class MetalBackedView: UIView {
        private let controller: MetalPresentLayerController
        init(controller: MetalPresentLayerController) {
            self.controller = controller
            super.init(frame: .zero)
            layer.addSublayer(controller.layer)
        }
        required init?(coder: NSCoder) { fatalError("not used") }
        override func layoutSubviews() {
            super.layoutSubviews()
            // `displayScale` is the trait equivalent of the deprecated
            // `UIScreen.main.scale`; it's 0 while traits are unspecified
            // (no window yet), so clamp to a sane floor.
            let scale = window?.screen.scale ?? max(traitCollection.displayScale, 1)
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

// MARK: - Debug view

/// The GPU validation screen: a parity readout (numeric, in-app) plus the
/// wgpu→CAMetalLayer passthrough present surface. Surfaced by launching with
/// `MAPLE_GPU_DEBUG=1` (see `MapleApp`).
struct GpuDebugView: View {
    @State private var parityResult: String = "not run"
    @State private var parityPass: Bool? = nil
    @State private var ev: Float = 0.5
    @State private var presentController = MetalPresentLayerController()

    var body: some View {
        VStack(spacing: 16) {
            Text("Maple GPU validation (wgpu / Metal) — #988")
                .font(.headline)
                .accessibilityIdentifier("gpu-debug-title")

            GroupBox("Exposure parity (wgpu→Metal vs CPU oracle)") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("EV")
                        Slider(value: $ev, in: -4...4, step: 0.5)
                        Text(String(format: "%+.1f", ev)).monospacedDigit()
                    }
                    HStack {
                        Button("Run parity") { runParity() }
                            .accessibilityIdentifier("gpu-run-parity")
                        Spacer()
                        Text(parityResult)
                            .monospaced()
                            .foregroundStyle(parityColor)
                            .accessibilityIdentifier("gpu-parity-result")
                    }
                    if let pass = parityPass {
                        Label(
                            pass ? "PASS (< 1e-4)" : "FAIL",
                            systemImage: pass ? "checkmark.seal.fill" : "xmark.seal.fill"
                        )
                        .foregroundStyle(pass ? .green : .red)
                        .accessibilityIdentifier("gpu-parity-verdict")
                    }
                }
                .padding(8)
            }

            GroupBox("Passthrough present (wgpu→CAMetalLayer)") {
                VStack(spacing: 8) {
                    // The four-quadrant test pattern: red TL, green TR, blue BL,
                    // white BR. A channel swap or gross colour shift is obvious.
                    MetalPresentView(controller: presentController)
                        .frame(height: 240)
                        .background(Color.black)
                        .accessibilityIdentifier("gpu-present-surface")
                    Text(presentController.status)
                        .font(.caption)
                        .monospaced()
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("gpu-present-status")
                }
                .padding(8)
            }

            Spacer()
        }
        .padding(24)
        .frame(minWidth: 420, minHeight: 560)
        .onAppear { runParity() }
    }

    private var parityColor: Color {
        switch parityPass {
        case .some(true): return .green
        case .some(false): return .red
        case .none: return .secondary
        }
    }

    private func runParity() {
        switch GpuDebugBridge.exposureParity(nPixels: 256, ev: ev) {
        case .success(let diff):
            parityResult = String(format: "max diff = %.3e", diff)
            parityPass = diff < 1e-4
        case .failure(let err):
            parityResult = "error: \(err.message)"
            parityPass = false
        }
    }
}
