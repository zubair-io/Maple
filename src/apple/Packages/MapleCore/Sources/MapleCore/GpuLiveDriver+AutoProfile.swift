import Foundation

@MainActor
extension GpuLiveDriver {
  /// Fit the Auto Profile curve + residual LUT for `rawPath` once per open (the
  /// A2 artifacts the chain's curve/LUT passes reapply every tick). No-op after
  /// the first call per open, or when `model.profile != .auto`.
  public func fitAutoProfileIfNeeded(
    rawPath: String, model: AdjustmentModel, quality: PipelineRenderer.Quality
  ) async {
    guard let s = session else { return }
    // A new source/decode is still preparing: replace its old native tail
    // with the fresh proxy instead of retaining stale source artifacts.
    if nativeAutoProfileID != nil {
      nativeAutoProfileID = nil
      autoProfileFitDone = false
    }
    if model.profile == .auto && !autoProfileFitDone {
      autoProfileFitDone = true
      await s.fitAutoProfile(rawPath: rawPath, quality: quality)
    }
  }

  func installNativeAutoProfile(_ prepared: NativeAutoProfile) async {
    guard let session, nativeAutoProfileID != prepared.id else { return }
    nativeAutoProfileID = prepared.id
    autoProfileFitDone = true
    await session.setNativeAutoProfile(prepared)
  }
}
