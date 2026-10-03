import CoreImage
import Foundation

@MainActor
extension EditSession {
  /// The image currently on the canvas, for agent inspection. Joins any
  /// scheduled or in-flight render first so the pixels reflect `model` as
  /// it stands now. On the GPU-live path (which presents straight to the
  /// layer and never publishes a CIImage) it reruns the presented chain
  /// with a readback, using the same WB anchor as the live present.
  func agentCanvasSnapshot() async -> CIImage? {
    _ = await latestRenderSchedule?.value
    await renderActor.awaitCurrentRenderIfInFlight()
    guard gpuFramePresented, !gpuPresentFailed, let driver = gpuLiveDriver else {
      return renderedPreview
    }
    let resolvedIsRaw = await renderActor.resolvedIsRaw(for: asset.id) ?? asset.isRaw
    let anchor = wbDeltaAnchor
    guard
      let frame = await driver.renderCurrentFrameBytes(
        model: model,
        asShotCCT: resolvedIsRaw ? (anchor?.temperature ?? asShotCCT) : 6500,
        asShotTint: resolvedIsRaw ? (anchor?.tint ?? asShotTint) : 0,
        wbFrame: resolvedIsRaw ? wbSliderFrame : nil)
    else { return nil }
    return Self.ciImageFromGpuRgb(frame.bytes, width: frame.width, height: frame.height)
  }
}
