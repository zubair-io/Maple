// EditSession+CanvasPlaceholder.swift — hands the editor's seed still to the
// GPU canvas as its placeholder (#5758).

import CoreGraphics

@MainActor
extension EditSession {
  /// Draw `image` (the grid thumbnail, then the display preview) on the GPU
  /// canvas, in the photo's frame, until the photo's first rendered frame
  /// replaces it. A no-op without the GPU canvas or once it has presented.
  public func showCanvasPlaceholder(_ image: CGImage) async {
    guard let driver = gpuLiveDriver, !gpuFramePresented else { return }
    let pixels = await Task.detached(priority: .userInitiated) {
      GpuPlaceholderPixels(image: image)
    }.value
    guard let pixels, !Task.isCancelled else { return }
    if await driver.showPlaceholder(pixels, viewportPx: previewSize) {
      canvasPlaceholderOnScreen = true
    }
  }

  /// The canvas has a new, empty layer: nothing drawn into the last one,
  /// rendered frame or placeholder, is on screen any more.
  public func canvasLayerReplaced() {
    gpuFramePresented = false
    canvasPlaceholderOnScreen = false
  }
}
