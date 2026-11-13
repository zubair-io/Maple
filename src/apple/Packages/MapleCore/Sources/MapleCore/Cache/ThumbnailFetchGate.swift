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
  private struct Producer {
    let id: UUID
    let task: Task<Data?, Never>
  }

  private let semaphore: BoundedAsyncSemaphore
  private var inFlight: [String: Producer] = [:]
  /// Cells awaiting each producer. Cancellation belongs to one cell: a cell
  /// leaving the screen drops only its own entry (#5735).
  private var waiters: [UUID: Set<UUID>] = [:]
  /// Producers whose fetch has started. A started fetch runs to completion
  /// so its result reaches the backend's cache even if every cell left.
  private var running: Set<UUID> = []

  public init(maxConcurrent: Int) {
    self.semaphore = BoundedAsyncSemaphore(value: maxConcurrent)
  }

  /// Run `work` for `key`, admitting at most `maxConcurrent` concurrent
  /// fetches across every caller of this gate, and collapsing duplicate
  /// concurrent requests for the same key into one shared result.
  ///
  /// The in-flight check, task registration and waiter registration below
  /// have no `await` between them, so two callers for the same key can
  /// never both start a fetch — the same no-interleaving contract
  /// `ThumbnailLoader.load(for:)` documents for the local path. The
  /// semaphore acquire happens inside the detached task (not here) for the
  /// same reason: an `await` before registration would reopen that race.
  ///
  /// A cancelled caller gives up only its own share and gets `nil` back
  /// once the shared fetch settles. The fetch itself is cancelled only when
  /// no caller is left waiting AND it has not started yet — so a fetch still
  /// queued behind the cap never holds a slot for nobody (jules review,
  /// PR #3159), while one already on the wire finishes for the cells that
  /// remain or for the backend's cache.
  public func fetch(key: String, _ work: @escaping @Sendable () async -> Data?) async -> Data? {
    if let existing = inFlight[key] {
      return await wait(on: existing, key: key)
    }

    let id = UUID()
    let sem = semaphore
    let task = Task.detached(priority: .utility) { () -> Data? in
      do {
        try await sem.acquire()
      } catch {
        // Cancelled while queued behind the cap: no permit to release.
        await self.retire(id, key: key)
        return nil
      }
      guard await self.claimRun(id) else {
        await sem.release()
        await self.retire(id, key: key)
        return nil
      }
      let result = await work()
      await sem.release()
      await self.retire(id, key: key)
      return result
    }
    let producer = Producer(id: id, task: task)
    inFlight[key] = producer
    return await wait(on: producer, key: key)
  }

  /// Number of callers currently waiting on `key`'s fetch (test seam).
  func waiterCount(forKey key: String) -> Int {
    inFlight[key].map { waiters[$0.id]?.count ?? 0 } ?? 0
  }

  private func wait(on producer: Producer, key: String) async -> Data? {
    let waiter = UUID()
    waiters[producer.id, default: []].insert(waiter)
    return await withTaskCancellationHandler {
      let result = await producer.task.value
      leave(producer, key: key, waiter: waiter, cancelled: false)
      return Task.isCancelled ? nil : result
    } onCancel: {
      Task { await self.leave(producer, key: key, waiter: waiter, cancelled: true) }
    }
  }

  /// Marks `id` started, unless every caller already left — the actor
  /// serializes this against `leave`, so a fetch is either running (and
  /// kept) or abandoned before `work` begins, never cancelled mid-flight.
  private func claimRun(_ id: UUID) -> Bool {
    guard waiters[id]?.isEmpty == false, !Task.isCancelled else { return false }
    running.insert(id)
    return true
  }

  private func leave(_ producer: Producer, key: String, waiter: UUID, cancelled: Bool) {
    guard waiters[producer.id]?.remove(waiter) != nil else { return }
    guard waiters[producer.id]?.isEmpty == true else { return }
    waiters.removeValue(forKey: producer.id)
    guard cancelled, !running.contains(producer.id) else { return }
    producer.task.cancel()
    if inFlight[key]?.id == producer.id {
      inFlight.removeValue(forKey: key)
    }
  }

  /// Conditional removal: a newer producer may already own `key` (the last
  /// waiter abandoned this one before it started), and evicting it would
  /// drop that producer's coalescing entry out from under it.
  private func retire(_ id: UUID, key: String) {
    running.remove(id)
    if inFlight[key]?.id == id {
      inFlight.removeValue(forKey: key)
    }
  }
}
