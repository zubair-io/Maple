// CropOverlayLayerView.swift — hosts the crop overlay's own layer (#5715).
//
// The overlay is drawn by the shared Rust renderer, not SwiftUI: wgpu into a
// dedicated, transparent `CAMetalLayer` when the GPU path is available, the
// Rust CPU rasterizer into a plain layer's contents otherwise (or after a GPU
// failure). The layer sits upright above the straighten-rotated canvas,
// overscanning the view by `CropOverlayInput.overscan` on every side, and is
// redrawn only when the overlay input changes; it never touches the develop
// chain.
//
// Redraws run on a serial queue so the GPU lock or a drawable wait never
// blocks the main thread, and coalesce: while one redraw is in flight only
// the latest input is kept. A failed GPU frame is redrawn once on the CPU,
// off the main thread; the layer switches to the CPU for good only when the
// GPU is unavailable or fails three frames in a row.

import MapleCore
import QuartzCore
import SwiftUI

#if canImport(AppKit)
  import AppKit
#endif
#if canImport(UIKit)
  import UIKit
#endif

@MainActor
final class CropOverlayLayerController {
  let metalLayer = CAMetalLayer()
  let cpuLayer = CALayer()
  private let generation = CropOverlaySurface.nextGeneration()
  private let queue = DispatchQueue(label: "app.justmaple.crop-overlay", qos: .userInteractive)
  private let rasterPool = CropOverlayRasterPool()
  private var useGpu: Bool
  private var consecutiveGpuFailures = 0
  private var cpuForNextFrame = false
  private var released = false
  private var pending: CropOverlayInput?
  private var submitted: CropOverlayInput?
  private var inFlight = false

  init(preferGpu: Bool) {
    useGpu = preferGpu
    metalLayer.pixelFormat = .bgra8Unorm
    metalLayer.framebufferOnly = true
    metalLayer.isOpaque = false
    metalLayer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
    metalLayer.isHidden = !preferGpu
    cpuLayer.isOpaque = false
    cpuLayer.contentsGravity = .resize
    cpuLayer.isHidden = preferGpu
  }

  func layout(bounds: CGRect, scale: CGFloat) {
    let surface = bounds.insetBy(dx: -CropOverlayInput.overscan, dy: -CropOverlayInput.overscan)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    metalLayer.frame = surface
    metalLayer.contentsScale = scale
    cpuLayer.frame = surface
    cpuLayer.contentsScale = scale
    CATransaction.commit()
  }

  func update(_ input: CropOverlayInput) {
    guard input != (pending ?? submitted) else { return }
    pending = input
    drainIfIdle()
  }

  private func drainIfIdle() {
    guard !released, !inFlight, let input = pending else { return }
    pending = nil
    submitted = input
    inFlight = true
    let target = RedrawTarget(
      layer: metalLayer, generation: generation, useGpu: useGpu && !cpuForNextFrame,
      rasterPool: rasterPool)
    cpuForNextFrame = false
    queue.async { [weak self] in
      let outcome = target.draw(input)
      DispatchQueue.main.async {
        self?.finish(input, outcome)
      }
    }
  }

  private func finish(_ input: CropOverlayInput, _ outcome: RedrawOutcome) {
    inFlight = false
    switch outcome {
    case .gpu(.presented):
      consecutiveGpuFailures = 0
      showGpu()
    case .gpu(.empty):
      showCpu(nil)
    case .gpu(let failure):
      consecutiveGpuFailures += 1
      useGpu = failure != .unavailable && consecutiveGpuFailures < 3
      cpuForNextFrame = true
      pending = pending ?? input
    case .cpuImage(let image):
      showCpu(image)
    }
    drainIfIdle()
  }

  /// Tear down: stop redrawing and, behind any in-flight present, release the
  /// GPU surface, which retains this controller's layer.
  func release() {
    released = true
    pending = nil
    let generation = generation
    queue.async { CropOverlaySurface.releaseGpu(generation: generation) }
  }

  private func showGpu() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    metalLayer.isHidden = false
    cpuLayer.isHidden = true
    cpuLayer.contents = nil
    CATransaction.commit()
  }

  private func showCpu(_ image: CGImage?) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    cpuLayer.contents = image
    cpuLayer.isHidden = false
    metalLayer.isHidden = true
    CATransaction.commit()
  }
}

private enum RedrawOutcome: @unchecked Sendable {
  case gpu(CropOverlaySurface.GpuPresentResult)
  case cpuImage(CGImage?)
}

/// What one off-main redraw needs. The layer is only handed to the Rust
/// present, which owns its drawable; nothing else touches it off the main
/// thread.
private struct RedrawTarget: @unchecked Sendable {
  let layer: CAMetalLayer
  let generation: UInt64
  let useGpu: Bool
  let rasterPool: CropOverlayRasterPool

  func draw(_ input: CropOverlayInput) -> RedrawOutcome {
    guard useGpu else { return .cpuImage(rasterPool.rasterize(input)) }
    return .gpu(CropOverlaySurface.presentGpu(input, layer: layer, generation: generation))
  }
}

#if canImport(AppKit)
  struct CropOverlayLayerView: NSViewRepresentable {
    let input: CropOverlayInput

    func makeCoordinator() -> CropOverlayLayerController {
      CropOverlayLayerController(preferGpu: GpuLiveFlag.isEnabled)
    }

    func makeNSView(context: Context) -> NSView {
      HostView(controller: context.coordinator)
    }

    func updateNSView(_ nsView: NSView, context: Context) {
      context.coordinator.update(input)
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: CropOverlayLayerController) {
      coordinator.release()
    }

    final class HostView: NSView {
      private let controller: CropOverlayLayerController
      init(controller: CropOverlayLayerController) {
        self.controller = controller
        super.init(frame: .zero)
        wantsLayer = true
        clipsToBounds = false
        layer?.addSublayer(controller.cpuLayer)
        layer?.addSublayer(controller.metalLayer)
      }
      required init?(coder: NSCoder) { fatalError("not used") }
      override func hitTest(_ point: NSPoint) -> NSView? { nil }
      override func layout() {
        super.layout()
        controller.layout(bounds: bounds, scale: window?.backingScaleFactor ?? 2)
      }
    }
  }
#elseif canImport(UIKit)
  struct CropOverlayLayerView: UIViewRepresentable {
    let input: CropOverlayInput

    func makeCoordinator() -> CropOverlayLayerController {
      CropOverlayLayerController(preferGpu: GpuLiveFlag.isEnabled)
    }

    func makeUIView(context: Context) -> UIView {
      HostView(controller: context.coordinator)
    }

    func updateUIView(_ uiView: UIView, context: Context) {
      context.coordinator.update(input)
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: CropOverlayLayerController) {
      coordinator.release()
    }

    final class HostView: UIView {
      private let controller: CropOverlayLayerController
      init(controller: CropOverlayLayerController) {
        self.controller = controller
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        clipsToBounds = false
        layer.addSublayer(controller.cpuLayer)
        layer.addSublayer(controller.metalLayer)
      }
      required init?(coder: NSCoder) { fatalError("not used") }
      override func layoutSubviews() {
        super.layoutSubviews()
        let scale = window?.screen.scale ?? max(traitCollection.displayScale, 1)
        controller.layout(bounds: bounds, scale: scale)
      }
    }
  }
#endif
