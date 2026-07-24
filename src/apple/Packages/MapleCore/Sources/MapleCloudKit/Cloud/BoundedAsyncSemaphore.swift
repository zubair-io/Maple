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
// Foundation-only (portability guard — see `MapleCloudKitPortabilityTests`):
// the Maple TV target links MapleCloudKit without MapleCore or
// RawPipeline, so this file must not pull in any platform UI framework.

import Foundation

public actor BoundedAsyncSemaphore {
  private let value: Int
  private var current: Int = 0
  private var waiters: [CheckedContinuation<Void, Never>] = []

  /// Clamps to ≥1 — a 0/negative cap would suspend `acquire()` forever
  /// since `current < value` would never be true.
  public init(value: Int) {
    self.value = max(1, value)
  }

  public func acquire() async {
    if current < value {
      current += 1
      return
    }
    // Suspend. On resume, `release()` has handed us its permit WITHOUT
    // decrementing `current`, so the held-count already includes us —
    // do NOT increment here. (That increment, paired with a decrement in
    // `release()`, was the bug: it opened a window for an interleaved
    // `acquire()` to over-admit past `value`.)
    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
      waiters.append(cont)
    }
  }

  public func release() {
    if let waiter = waiters.first {
      waiters.removeFirst()
      waiter.resume() // Transfer this permit directly; `current` unchanged.
    } else {
      current -= 1 // No waiter: free the permit.
    }
  }
}
