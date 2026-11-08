// CropOverlayLayerView.swift — hosts the crop overlay's own layer (#5715).
//
// The overlay is drawn by the shared Rust renderer, not SwiftUI: wgpu into a
// dedicated, transparent `CAMetalLayer` when the GPU path is available, the
// Rust CPU rasterizer into a plain layer's contents otherwise (or after a GPU
// failure). The layer sits upright above the straighten-rotated canvas and is
// redrawn only when the overlay input changes; it never touches the develop
// chain.
//
// Redraws run on a serial queue so the GPU lock or a drawable wait never
// blocks the main thread, and coalesce: while one redraw is in flight only
// the latest input is kept.

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
  private var useGpu: Bool
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
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    metalLayer.frame = bounds
    metalLayer.contentsScale = scale
    cpuLayer.frame = bounds
    cpuLayer.contentsScale = scale
    CATransaction.commit()
  }

  func update(_ input: CropOverlayInput) {
    guard input != (pending ?? submitted) else { return }
    pending = input
    drainIfIdle()
  }

  private func drainIfIdle() {
    guard !inFlight, let input = pending else { return }
    pending = nil
    submitted = input
    inFlight = true
    let target = RedrawTarget(layer: metalLayer, generation: generation, useGpu: useGpu)
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
    case .gpuPresented:
      break
    case .cpuImage(let image):
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      cpuLayer.contents = image
      CATransaction.commit()
    case .gpuFailed:
      useGpu = false
      metalLayer.isHidden = true
      cpuLayer.isHidden = false
      pending = pending ?? input
    }
    drainIfIdle()
  }
}

private enum RedrawOutcome: @unchecked Sendable {
  case gpuPresented
  case gpuFailed
  case cpuImage(CGImage?)
}

/// What one off-main redraw needs. The layer is only handed to the Rust
/// present, which owns its drawable; nothing else touches it off the main
/// thread.
private struct RedrawTarget: @unchecked Sendable {
  let layer: CAMetalLayer
  let generation: UInt64
  let useGpu: Bool

  func draw(_ input: CropOverlayInput) -> RedrawOutcome {
    guard useGpu else { return .cpuImage(CropOverlaySurface.rasterize(input)) }
    return CropOverlaySurface.presentGpu(input, layer: layer, generation: generation)
      ? .gpuPresented : .gpuFailed
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

    final class HostView: NSView {
      private let controller: CropOverlayLayerController
      init(controller: CropOverlayLayerController) {
        self.controller = controller
        super.init(frame: .zero)
        wantsLayer = true
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

    final class HostView: UIView {
      private let controller: CropOverlayLayerController
      init(controller: CropOverlayLayerController) {
        self.controller = controller
        super.init(frame: .zero)
        isUserInteractionEnabled = false
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
