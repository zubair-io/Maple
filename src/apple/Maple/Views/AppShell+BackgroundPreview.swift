import MapleCore
import SwiftUI

extension AppShell {
  /// Persist the editing session's developed preview when the app
  /// backgrounds (jules review, #2009).
  ///
  /// On iOS a bare `Task { … }` would be aborted mid-flight when the OS
  /// suspends the process. Hold a UIKit background-task assertion for the
  /// async readback + AVIF encode + local write (or `/api/preview` PUT).
  /// This is async-friendly — no thread blocking: the persist runs on the
  /// MainActor while the assertion is held (unlike a `DispatchSemaphore`
  /// inside `performExpiringActivity`, whose wait could stall the actor and
  /// starve the very persist Task it's waiting on). `end()` is idempotent, so
  /// whichever of the completion or the OS expiration handler fires first
  /// releases the assertion exactly once. Best-effort: the preview is a pure
  /// cache, so an early expiration just leaves it to regenerate on next open.
  ///
  /// macOS doesn't suspend the process on background the way iOS does (as the
  /// `scenePhase` comment above notes), so a plain task lands the write.
  @MainActor
  func persistPreviewOnBackground(_ session: EditSession) {
    #if os(iOS)
      let bgTask = BackgroundTaskAssertion()
      // Deliberately proceeding even when the assertion is denied
      // (`begin` returns false — Low Power Mode, near-suspension): the
      // persist is a pure cache and may be cut short, but the release
      // MUST still run — the scenePhase handler excluded this session
      // from the bulk release precisely because this path owns it
      // (#2037/#2947); bailing out here left the active editor's buffers
      // resident in a backgrounded app. `end()` no-ops without one.
      _ = bgTask.begin(name: "app.justmaple.aperture.preview-persist") {
        bgTask.end()
      }
      Task { @MainActor in
        await session.persistDisplayPreviewOnExit()
        // #2037 — now that the exit persist has read whatever GPU frame
        // was live, release this session's decoded/tile/GPU buffers too
        // (backgrounded apps are jetsam's first victims). Sequenced
        // AFTER the persist — see `releaseTransientMemoryForAllSessions`'s
        // `excluding` doc for why running it concurrently would race.
        await session.releaseTransientMemory()
        bgTask.end()
      }
    #else
      Task { await session.persistDisplayPreviewOnExit() }
    #endif
  }

}
