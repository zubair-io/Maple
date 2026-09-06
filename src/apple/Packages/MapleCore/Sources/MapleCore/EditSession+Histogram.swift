import CoreImage
import Foundation
import os

@MainActor
extension EditSession {
  /// Read the displayed image after the current fast render, without touching
  /// original bytes or refitting Auto Profile. Called after the UI debounce,
  /// never from a slider's render/present path.
  public func histogramForCurrentPreview() async throws -> CloudHistogram? {
    await renderActor.awaitCurrentRenderIfInFlight()
    try Task.checkCancellation()
    return try await histogramState.read { [weak self] in
      guard let self else { return nil }
      let start = ContinuousClock.now
      let revision = histogramState.revision
      defer {
        Logger(subsystem: "app.justmaple.aperture", category: "live-histogram").notice(
          "histogram revision=\(revision) elapsed=\(String(describing: start.duration(to: .now)), privacy: .public) cancelled=\(Task.isCancelled)"
        )
      }
      let colorSpace = CanvasColorSpace.current
      if gpuFramePresented && !gpuPresentFailed {
        guard let driver = gpuLiveDriver else { return nil }
        return try await driver.histogramForCurrentFrame()
      }
      guard previewIsFullRender, let image = renderedPreview else { return nil }
      return try await LocalHistogram.displayedImage(
        image, context: pipeline.context, colorSpace: colorSpace)
    }
  }
}
