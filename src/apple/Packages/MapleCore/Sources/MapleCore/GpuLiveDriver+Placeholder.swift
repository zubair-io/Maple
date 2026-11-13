// GpuLiveDriver+Placeholder.swift — the canvas placeholder (#5758) and the
// layer colour tag both it and the live chain's present keep in step.

import CoreGraphics
import QuartzCore

extension GpuLiveDriver {
  /// Keep `layer.colorspace` in lockstep with `target` (#1338) — the exact
  /// `CanvasColorSpace` a present is ABOUT to encode into. Each present reads
  /// `CanvasColorSpace.current` ONCE and hands the SAME value to this call
  /// and to its encode — two independent `.current` reads a moment apart
  /// could observe a mid-flight Settings change differently and reproduce
  /// #1512 (CoreAnimation double- or non-converting the primaries) for
  /// exactly one frame (Copilot review on #3192).
  func retagLayerIfNeeded(_ layer: CAMetalLayer, to target: CanvasColorSpace) {
    guard target != taggedColorSpace else { return }
    let name: CFString = target == .displayP3 ? CGColorSpace.displayP3 : CGColorSpace.sRGB
    guard let space = CGColorSpace(name: name) else { return }
    layer.colorspace = space
    taggedColorSpace = target
  }

  /// Draw `pixels` on the canvas until the photo's first rendered frame
  /// replaces it, fitted to `viewportPx` (the viewport in pixels; zero while
  /// unknown). A later still (the display preview after the thumbnail)
  /// replaces an earlier one. Not presented once the live chain has started
  /// presenting into the current layer, so a placeholder never lands over a
  /// render, nor when its aspect would be stretched across the layer; it is
  /// kept for a newly registered layer. Returns whether it is now on screen.
  @discardableResult
  public func showPlaceholder(_ pixels: GpuPlaceholderPixels, viewportPx: CGSize) async -> Bool {
    guard placeholderGate.offer(pixels, viewportPx: viewportPx) else { return false }
    return await presentPendingPlaceholder()
  }

  /// Whether a placeholder can still be presented into the current layer.
  public var acceptsPlaceholder: Bool { placeholderGate.accepts }

  private func presentPendingPlaceholder() async -> Bool {
    guard placeholderGate.accepts, let pixels = placeholderGate.pending, let layer,
      pixels.fits(layer.bounds.size)
    else { return false }
    let viewportPx = placeholderGate.viewportPx
    let colorSpace = CanvasColorSpace.current
    retagLayerIfNeeded(layer, to: colorSpace)
    placeholderCancel?.requestCancel()
    let cancel = CancelFlag()
    placeholderCancel = cancel
    let generation = surfaceGeneration
    // A closed editor's still must not queue behind the next one's on the
    // shared presenter, nor rebuild the surface on its off-screen layer.
    let rc = await withTaskCancellationHandler {
      await GpuPlaceholderPresenter.shared.present(
        pixels, layer: layer, viewportPx: viewportPx, target: colorSpace, cancel: cancel,
        surfaceGeneration: generation)
    } onCancel: {
      cancel.requestCancel()
    }
    guard rc == 0, generation == surfaceGeneration, layer === self.layer else { return false }
    // The surface is now configured at the placeholder's size, so the next
    // chain present must not read its own last size as the drawable's.
    lastPresentedKey = nil
    return placeholderGate.accepts
  }

  /// The live chain is about to present into the layer: no placeholder may
  /// follow it, and one still in flight is dropped before it reaches the GPU
  /// or, if it already holds the GPU lock, presents before the chain does.
  func placeholderChainWillPresent() {
    placeholderGate.chainWillPresent()
    placeholderCancel?.requestCancel()
  }

  /// A new layer registered: show the open photo's still in it until the
  /// chain presents there.
  func placeholderLayerChanged() {
    placeholderCancel?.requestCancel()
    guard placeholderGate.layerChanged() else { return }
    Task { await presentPendingPlaceholder() }
  }
}
