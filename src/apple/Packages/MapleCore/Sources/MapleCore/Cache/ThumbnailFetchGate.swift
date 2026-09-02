// ThumbnailFetchGate.swift — bounds concurrent thumbnail fetches for a
// single backend (PhotoKit or cloud) and coalesces duplicate in-flight
// requests for the same key.
//
// #2528: the browse grid's local path is already concurrency-gated
// (`ThumbnailLoader.acquireDecodeSlot`/`maxConcurrentDecodes`), but the
// PhotoKit and cloud fetch paths in `ThumbnailProvider` (app target) had no
// cap at all — `PhotoThumbnailCell`/`CloudThumbTile` each drive their own
// `.task` per visible cell, so a cold open of a PhotoKit or cloud folder
// fired one `PHImageManager.requestImage` / network request per realized
// tile simultaneously.
//
// This mirrors `ThumbnailLoader`'s contract — coalesce-then-gate, with the
// semaphore acquired INSIDE the detached task rather than before
// registering it in `inFlight` — but is built on `BoundedAsyncSemaphore`
// (MapleCloudKit) instead of a second hand-rolled waiter list, per the
// ticket's fix sketch. It lives in MapleCore (not the app target) purely so
// it's testable via `swift test` without linking Photos.framework; the
// PhotoKit/cloud specifics stay in `ThumbnailProvider`, which owns one
// instance of this type per backend so a slow cloud host can never starve
// PhotoKit fetches of their own slots, or vice versa.

import Foundation

public actor ThumbnailFetchGate {
  private let semaphore: BoundedAsyncSemaphore
  private var inFlight: [String: Task<Data?, Never>] = [:]

  public init(maxConcurrent: Int) {
    self.semaphore = BoundedAsyncSemaphore(value: maxConcurrent)
  }

  /// Run `work` for `key`, admitting at most `maxConcurrent` concurrent
  /// fetches across every caller of this gate, and collapsing duplicate
  /// concurrent requests for the same key into one shared result.
  ///
  /// The in-flight check and task registration below have no `await`
  /// between them, so two callers for the same key can never both start a
  /// fetch — the same no-interleaving contract `ThumbnailLoader.load(for:)`
  /// documents for the local path. The semaphore acquire happens inside the
  /// detached task (not here) for the same reason: an `await` before
  /// registration would reopen that race.
  public func fetch(key: String, _ work: @escaping @Sendable () async -> Data?) async -> Data? {
    if let existing = inFlight[key] {
      return await Self.awaitCancellably(existing)
    }

    let sem = semaphore
    let task = Task.detached(priority: .utility) { () -> Data? in
      do {
        try await sem.acquire()
      } catch {
        // Queued behind the cap and cancelled before a permit was handed
        // out — no permit to release, nothing to fetch.
        return nil
      }
      defer {
        // Fire-and-forget release: `defer` can't `await`, and the detached
        // task here must not inherit this task's cancellation.
        Task.detached { await sem.release() }
      }
      return await work()
    }
    inFlight[key] = task
    let result = await Self.awaitCancellably(task)
    // Conditional removal: a concurrent `cancelAll()`-equivalent could in
    // principle have cleared and re-registered this key with a NEWER task
    // by the time we get here (same hazard `ThumbnailLoader.inFlight`
    // guards against) — evicting unconditionally would drop that newer
    // task's coalescing entry out from under it.
    if inFlight[key] == task {
      inFlight.removeValue(forKey: key)
    }
    return result
  }

  /// Awaits `task`'s result while propagating THIS caller's own
  /// cancellation into it (jules review, PR #3159). `Task.detached` does
  /// not inherit cancellation from its creator, and a plain `await
  /// task.value` does not observe the AWAITING task's cancellation either
  /// — so on rapid grid scrolling, where SwiftUI cancels the `.task` for
  /// every cell that leaves the screen, an off-screen cell's fetch would
  /// otherwise keep running (or sit queued) forever, permanently occupying
  /// a gate slot and starving the newly-visible on-screen cells — exactly
  /// the thundering-herd problem this gate exists to prevent.
  ///
  /// `withTaskCancellationHandler` bridges the two: if the CALLING task is
  /// cancelled while this await is suspended, `onCancel` fires and cancels
  /// `task` directly, which unblocks a still-queued `sem.acquire()` (its
  /// own cancellation-aware wait) or, once a permit was already granted,
  /// simply leaves `work()` to run to completion without anyone left
  /// waiting on it.
  ///
  /// Used for BOTH the fresh-fetch path and the coalesced-await path
  /// above, so cancelling a coalesced (second, third, …) caller also
  /// cancels the shared fetch every other coalesced caller is waiting on.
  /// Accepted trade-off: grid thumbnails rarely coalesce in practice, and
  /// re-fetching a `nil` result is cheap next to persistent starvation.
  private static func awaitCancellably(_ task: Task<Data?, Never>) async -> Data? {
    await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }
  }
}
