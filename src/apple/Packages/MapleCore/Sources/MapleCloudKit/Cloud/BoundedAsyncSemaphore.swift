// src/apple/Packages/MapleCore/Sources/MapleCloudKit/Cloud/BoundedAsyncSemaphore.swift
//
// Counting semaphore for bounded concurrency, hoisted here (from a
// private `TVAsyncSemaphore` in `Maple TV/TVTimelineViewModel.swift`) so
// `swift test` can exercise the real algorithm directly — the app-target
// original wasn't reachable from the test target, and it carried a
// permit-handoff race (jules review, PR #2110):
//
//   func release() {
//     current -= 1
//     if let w = waiters.first { waiters.removeFirst(); w.resume() }
//   }
//   func acquire() async {
//     if current < value { current += 1; return }
//     await withCheckedContinuation { waiters.append($0) }
//     current += 1   // <-- the bug: a window opens between release()'s
//                     //     decrement and this increment where an
//                     //     interleaved acquire() sees `current < value`
//                     //     and over-admits, letting concurrency exceed
//                     //     `value`.
//   }
//
// This version fixes it with a direct permit handoff: `release()` never
// decrements `current` when a waiter is waiting — it hands its permit
// straight to that waiter, who does NOT increment on resume. `current`
// only decrements when there's no waiter to hand off to. That keeps
// `current` == "permits currently held" atomically at every actor
// isolation boundary, with no window for over-admission.
//
// `CloudTimelineViewModel` (MapleCore) carried the SAME bug in its own
// module-local `AsyncSemaphore` (#2111 — same class of race as PR #2110,
// independently trace-confirmed: cap 2 → 3 concurrent /api/search calls).
// Rather than duplicate the fix, `CloudTimelineViewModel` now imports this
// type directly (MapleCore depends on MapleCloudKit — see
// `MapleCloudKitReexport.swift`) and the module-local `AsyncSemaphore` was
// deleted. Kept the `BoundedAsyncSemaphore` name (not `AsyncSemaphore`)
// for continuity with the TV-side history above, not because of a naming
// collision anymore.
//
// Cancellation (#2112): the version above suspended in `acquire()` via
// `withCheckedContinuation`, which has no cancellation support — a task
// cancelled while suspended there (e.g. a view disappearing mid-load)
// leaked its continuation and never resumed. `acquire()` is now `throws`:
// it wraps the wait in `withTaskCancellationHandler` + a THROWING
// continuation, and a cancelled waiter is removed from the queue and
// resumed with `CancellationError`.
//
// The delicate part is that `onCancel` runs as an unstructured, non-
// actor-isolated closure, so it can only ever schedule a hop back onto the
// actor (`Task { await self.cancelWaiter(id: id) }`) — it can't
// synchronously inspect or mutate waiter state. That hop can land at any
// point relative to `release()`'s handoff, including AFTER `release()` has
// already called `resume()` on this exact waiter's continuation (a
// continuation, once resumed, can never be un-resumed — the waiting task
// WILL receive that permit). Resuming it a second time from `cancelWaiter`
// would trap (double-resume), and simply ignoring the cancellation would
// hand the caller a permit it no longer wants with no way to know to give
// it back.
//
// Each waiter therefore gets a stable id, and the whole state machine is
// the FIFO `waiters` array: a waiter is cancellable exactly while it is
// still queued there. `cancelWaiter` for an id NOT in the queue is a
// deliberate no-op, which is safe because only two things ever remove a
// waiter:
//   - `release()` handed it the permit. The waiter's own task — not
//     `cancelWaiter` — then hands the permit back: it resumes normally
//     (having received it), notices `Task.isCancelled`, calls `release()`
//     on itself, and throws `CancellationError`. That keeps exactly one
//     release per permit no matter how the race lands.
//   - An earlier `cancelWaiter` for the same id already resumed it with
//     `CancellationError`.
// The remaining ordering hazard — `cancelWaiter` running BEFORE the
// continuation is registered — cannot happen: the setup closure of
// `withCheckedThrowingContinuation` runs synchronously on this actor's
// executor with no suspension after `acquire()` allocates the id, while
// `onCancel`'s unstructured `Task` must await the actor to call
// `cancelWaiter` — so registration always wins that race. (An earlier
// revision tracked `handedOffWaiterIDs`/`preCancelledWaiterIDs` sets for
// these cases; the pre-cancel path was unreachable, and the handed-off
// set leaked an entry whenever the resumed task cleared its id before
// `cancelWaiter` ran — flagged in review of #2218.)
//
// Foundation-only (portability guard — see `MapleCloudKitPortabilityTests`):
// the Maple TV target links MapleCloudKit without MapleCore or
// RawPipeline, so this file must not pull in any platform UI framework.
// (`Task`, `CheckedContinuation`, `withTaskCancellationHandler`, and
// `CancellationError` are Swift concurrency primitives, not Foundation —
// no new import is needed for them.)

import Foundation

public actor BoundedAsyncSemaphore {
  private let value: Int
  private var current: Int = 0

  private var waiters: [(id: UInt64, continuation: CheckedContinuation<Void, Error>)] = []
  private var waiterIDCounter: UInt64 = 0

  /// Clamps to ≥1 — a 0/negative cap would suspend `acquire()` forever
  /// since `current < value` would never be true.
  public init(value: Int) {
    self.value = max(1, value)
  }

  public func acquire() async throws {
    try Task.checkCancellation()

    if current < value {
      current += 1
      return
    }

    waiterIDCounter &+= 1
    let id = waiterIDCounter

    // Suspend. On resume, `release()` has handed us its permit WITHOUT
    // decrementing `current`, so the held-count already includes us —
    // do NOT increment here. (That increment, paired with a decrement in
    // `release()`, was the bug: it opened a window for an interleaved
    // `acquire()` to over-admit past `value`.)
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
        // Runs synchronously, still on the actor — no `await` separates
        // allocating `id` from this registration, so `cancelWaiter`
        // (which must hop onto the actor) can never observe `id` first.
        waiters.append((id: id, continuation: cont))
      }
    } onCancel: {
      Task { await self.cancelWaiter(id: id) }
    }

    guard Task.isCancelled else { return }
    // Cancel-after-handoff race: `onCancel` fired concurrently with — or
    // just after — `release()`'s `resume()`. We already hold the permit
    // (unavoidable — the continuation was resumed with success before we
    // ever observed the cancellation), so give it back ourselves and
    // surface the cancellation, rather than letting the caller believe it
    // acquired successfully.
    release()
    throw CancellationError()
  }

  public func release() {
    guard !waiters.isEmpty else {
      current -= 1 // No waiter: free the permit.
      return
    }
    let waiter = waiters.removeFirst()
    waiter.continuation.resume() // Transfer this permit directly; `current` unchanged.
  }

  /// Invoked (via an unstructured `Task`) from `acquire()`'s `onCancel`
  /// handler. A no-op when `id` is no longer queued: either `release()`
  /// already resumed that waiter with a permit (its own task hands the
  /// permit back once it observes `Task.isCancelled` — touching the
  /// continuation again here would double-resume), or an earlier
  /// cancellation already resumed it throwing. Registration always
  /// precedes this call (see the header comment), so "not queued" never
  /// means "not registered yet".
  private func cancelWaiter(id: UInt64) {
    guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
    waiters.remove(at: index).continuation.resume(throwing: CancellationError())
  }
}
