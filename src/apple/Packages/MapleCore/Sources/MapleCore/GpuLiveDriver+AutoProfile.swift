import Foundation

@MainActor
extension GpuLiveDriver {
  /// A completed provisional fit (including valid absence) can be reused
  /// without asking the source actor for a file on every slider tick.
  var needsAutoProfileFit: Bool {
    !autoProfileFitDone || autoProfileFitTask != nil
  }

  /// Fit the Auto Profile curve + residual LUT for `rawPath` once per open (the
  /// A2 artifacts the chain's curve/LUT passes reapply every tick). No-op after
  /// the first call per open, or when `model.profile != .auto`.
  @discardableResult
  public func fitAutoProfileIfNeeded(
    rawPath: String, model: AdjustmentModel, quality: PipelineRenderer.Quality
  ) async -> Bool {
    guard let s = session else { return false }
    // A new source/decode is still preparing: replace its old native tail
    // with the fresh proxy instead of retaining stale source artifacts.
    if nativeAutoProfileID != nil {
      nativeAutoProfileID = nil
      autoProfileFitDone = false
      autoProfileFitOutcome = nil
    }
    guard model.profile == .auto else { return false }
    if let fit = autoProfileFitTask {
      return await fit.value
    }
    guard !autoProfileFitDone else { return autoProfileFitOutcome ?? false }
    // #1472: later requests join actual fit completion. Marking done before
    // the actor call returns let them launch native development during the
    // provisional fit. A retired session cannot clear its replacement's job.
    let fit = Task { [weak self] in
      guard !Task.isCancelled else { return false }
      let outcome = await s.fitAutoProfile(rawPath: rawPath, quality: quality)
      guard !Task.isCancelled, let self, self.session === s else { return false }
      self.autoProfileFitDone = true
      self.autoProfileFitOutcome = outcome
      self.autoProfileFitTask = nil
      return outcome
    }
    autoProfileFitTask = fit
    return await fit.value
  }

  func installNativeAutoProfile(_ prepared: NativeAutoProfile) async {
    guard let session, nativeAutoProfileID != prepared.id else { return }
    nativeAutoProfileID = prepared.id
    autoProfileFitDone = true
    autoProfileFitOutcome = true
    await session.setNativeAutoProfile(prepared)
  }
}
