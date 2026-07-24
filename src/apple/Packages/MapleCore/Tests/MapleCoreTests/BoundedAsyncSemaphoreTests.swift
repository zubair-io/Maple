// BoundedAsyncSemaphoreTests.swift
//
// Regression coverage for the permit-handoff race fixed on
// `BoundedAsyncSemaphore` (`MapleCloudKit/Cloud/BoundedAsyncSemaphore.swift`),
// hoisted out of a private `TVAsyncSemaphore` in
// `Maple TV/TVTimelineViewModel.swift` specifically so this algorithm is
// reachable from `swift test` (jules review, PR #2110 — the buggy version
// decremented `current` in `release()` before resuming a waiter, who then
// incremented `current` again on resume; an `acquire()` interleaved in that
// window could see `current < value` and over-admit past the cap).
//
// These tests spawn many concurrent tasks against a shared semaphore and
// track observed peak concurrency via a separate actor (so the tracking
// itself can't introduce a race), asserting the peak never exceeds the
// configured `value`. Run repeatedly / with many tasks and a `Task.yield()`
// while "holding" the permit to maximize the chance of hitting the handoff
// window if the bug were still present.

import XCTest
@testable import MapleCloudKit

final class BoundedAsyncSemaphoreTests: XCTestCase {

  /// Tracks concurrently-held permits from outside the semaphore, so the
  /// assertion doesn't rely on the semaphore's own (possibly buggy)
  /// bookkeeping.
  private actor ConcurrencyTracker {
    private var current = 0
    private(set) var peak = 0

    func enter() {
      current += 1
      peak = max(peak, current)
    }

    func exit() {
      current -= 1
    }
  }

  private func runStress(cap: Int, taskCount: Int, iterations: Int = 5) async {
    for _ in 0..<iterations {
      let semaphore = BoundedAsyncSemaphore(value: cap)
      let tracker = ConcurrencyTracker()

      await withTaskGroup(of: Void.self) { group in
        for _ in 0..<taskCount {
          group.addTask {
            try? await semaphore.acquire()
            await tracker.enter()
            // Hold the permit across a suspension point to widen the
            // window in which a racy implementation could over-admit.
            await Task.yield()
            await tracker.exit()
            await semaphore.release()
          }
        }
      }

      let peak = await tracker.peak
      XCTAssertLessThanOrEqual(
        peak, cap,
        "observed concurrency \(peak) exceeded cap \(cap) — permit-handoff bound violated"
      )
    }
  }

  func test_peakConcurrencyNeverExceedsCap_valueTwo() async {
    await runStress(cap: 2, taskCount: 50)
  }

  func test_peakConcurrencyNeverExceedsCap_valueThree() async {
    await runStress(cap: 3, taskCount: 50)
  }

  /// value=1 degenerates to full serialization: at most one task holds
  /// the permit at a time, and — separately — every task must actually
  /// complete (no deadlock in the handoff path).
  func test_valueOne_serializesAndAllTasksComplete() async {
    let semaphore = BoundedAsyncSemaphore(value: 1)
    let tracker = ConcurrencyTracker()
    let completed = ConcurrencyTracker() // reused as a plain counter via enter()

    await withTaskGroup(of: Void.self) { group in
      for _ in 0..<50 {
        group.addTask {
          try? await semaphore.acquire()
          await tracker.enter()
          await Task.yield()
          await tracker.exit()
          await semaphore.release()
          await completed.enter()
        }
      }
    }

    let peak = await tracker.peak
    let completedCount = await completed.peak
    XCTAssertEqual(peak, 1, "value=1 must fully serialize acquire/release")
    XCTAssertEqual(completedCount, 50, "every task must complete — no deadlock in the handoff path")
  }

  /// A cap clamp sanity check: a 0 (or negative) value would make
  /// `acquire()` suspend forever if not clamped to ≥1.
  func test_zeroValueClampsToOne_doesNotDeadlock() async throws {
    let semaphore = BoundedAsyncSemaphore(value: 0)
    try await semaphore.acquire()
    await semaphore.release()
    // Reaching this point without hanging proves the clamp took effect.
  }

  // MARK: - Cancellation (#2112)

  /// A task suspended in `acquire()` (queued behind the cap, not yet
  /// handed a permit) that gets cancelled must throw `CancellationError`,
  /// be removed from the waiter queue, and leave the cap intact — a
  /// subsequent `acquire()` must still be able to proceed once a permit is
  /// available, proving nothing was leaked (no stranded waiter, no
  /// phantom held permit).
  func test_cancelledWhileQueued_throwsAndLeavesCapIntact() async throws {
    let semaphore = BoundedAsyncSemaphore(value: 1)

    // Hold the only permit so the second `acquire()` below is forced to
    // queue rather than take the fast path.
    try await semaphore.acquire()

    let queuedStarted = ResumeGate()
    let queuedTask = Task {
      await queuedStarted.signal()
      try await semaphore.acquire()
    }

    // Wait until the queued task has actually started running before
    // cancelling it. The extra yields/sleep give it a real chance to reach
    // the suspension point inside `acquire()`, but this isn't load-bearing
    // for correctness either way: the semaphore's own internal
    // race-handling (pre-cancel bookkeeping in `cancelWaiter`) covers a
    // cancel that lands before registration too, so the assertions below
    // hold regardless of exactly which internal path is hit.
    await queuedStarted.wait()
    await Task.yield()
    try? await Task.sleep(for: .milliseconds(5))
    queuedTask.cancel()

    do {
      try await queuedTask.value
      XCTFail("cancelled acquire() must throw")
    } catch is CancellationError {
      // expected
    }

    // Release the first permit and prove the semaphore still works: a
    // fresh acquire() must succeed without hanging and without exceeding
    // the cap of 1.
    await semaphore.release()
    try await semaphore.acquire()
    await semaphore.release()
  }

  /// Hammers the timing window around `release()`'s permit handoff racing
  /// against cancellation of the very waiter being handed the permit
  /// (the "cancel-after-handoff" race called out in the semaphore's doc
  /// comment). Across many iterations, concurrency must never exceed the
  /// cap and every permit taken must eventually be accounted for (no
  /// task hangs waiting for a permit that was leaked).
  func test_cancelAfterHandoffRace_neverExceedsCapAndBalances() async {
    let cap = 2
    let iterations = 200

    for _ in 0..<iterations {
      let semaphore = BoundedAsyncSemaphore(value: cap)
      let tracker = ConcurrencyTracker()

      await withTaskGroup(of: Void.self) { group in
        // A handful of holder tasks that acquire, briefly hold (widening
        // the handoff race window), and release.
        for _ in 0..<6 {
          group.addTask {
            do {
              try await semaphore.acquire()
            } catch {
              return
            }
            await tracker.enter()
            await Task.yield()
            await tracker.exit()
            await semaphore.release()
          }
        }
        // A handful of tasks that acquire and are cancelled essentially
        // immediately, racing their own cancellation against a concurrent
        // release()'s handoff. Whichever outcome wins, the permit must
        // end up either genuinely held (and later released above) or
        // fully returned — never both, never neither.
        for _ in 0..<6 {
          let task = Task {
            do {
              try await semaphore.acquire()
            } catch is CancellationError {
              return
            } catch {
              return
            }
            await tracker.enter()
            await Task.yield()
            await tracker.exit()
            await semaphore.release()
          }
          task.cancel()
          group.addTask { _ = await task.value }
        }
      }

      let peak = await tracker.peak
      XCTAssertLessThanOrEqual(
        peak, cap,
        "cancel-after-handoff race let observed concurrency \(peak) exceed cap \(cap)"
      )

      // The semaphore must still be fully usable afterward — if any
      // permit were leaked (never released) or double-handed-out, this
      // final drain would either hang or let concurrency exceed the cap.
      let counter = ConcurrencyTracker()
      await withTaskGroup(of: Void.self) { group in
        for _ in 0..<cap {
          group.addTask {
            try? await semaphore.acquire()
            await counter.enter()
            await Task.yield()
            await counter.exit()
            await semaphore.release()
          }
        }
      }
      let drainPeak = await counter.peak
      XCTAssertLessThanOrEqual(drainPeak, cap, "post-race drain exceeded cap — a permit leaked")
    }
  }
}

/// Deterministic single-shot signal, so cancellation tests don't rely on
/// sleeps to sequence "task has started" before "cancel it".
private actor ResumeGate {
  private var isSignaled = false
  private var continuation: CheckedContinuation<Void, Never>?

  func signal() {
    isSignaled = true
    continuation?.resume()
    continuation = nil
  }

  func wait() async {
    if isSignaled { return }
    await withCheckedContinuation { continuation = $0 }
  }
}
