import MapleCore

/// A panorama stitch's pause on the backup (#5653): the engine is stopped when
/// `pause()` returns and comes back when the stitch lets go. Only iOS and
/// iPadOS apply it; macOS has no per-process memory limit to share.
struct EnginePanoPause: PanoBackgroundPausing {
  static var forThisPlatform: (any PanoBackgroundPausing)? {
    #if os(iOS)
      EnginePanoPause()
    #else
      nil
    #endif
  }

  func pause() async -> PanoBackgroundPause {
    let held = await EngineHost.shared.pauseForPanorama()
    return PanoBackgroundPause(stoppedRunningWork: held.stoppedRunningWork) {
      Task { @MainActor in await EngineHost.shared.releasePause(held.id) }
    }
  }
}
