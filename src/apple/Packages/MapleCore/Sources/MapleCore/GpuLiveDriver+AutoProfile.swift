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
    guard model.profile == .auto else { return }
    if let fit = autoProfileFitTask {
      await fit.value
      return
    }
    guard !autoProfileFitDone else { return }
    // #1472: later requests join actual fit completion. Marking done before
    // the actor call returns let them launch native development during the
    // provisional fit. A retired session cannot clear its replacement's job.
    let fit = Task { [weak self] in
      guard !Task.isCancelled else { return }
      await s.fitAutoProfile(rawPath: rawPath, quality: quality)
      guard !Task.isCancelled, let self, self.session === s else { return }
      self.autoProfileFitDone = true
      self.autoProfileFitTask = nil
    }
    autoProfileFitTask = fit
    await fit.value
  }

  func installNativeAutoProfile(_ prepared: NativeAutoProfile) async {
    guard let session, nativeAutoProfileID != prepared.id else { return }
    nativeAutoProfileID = prepared.id
    autoProfileFitDone = true
    await session.setNativeAutoProfile(prepared)
  }
}
