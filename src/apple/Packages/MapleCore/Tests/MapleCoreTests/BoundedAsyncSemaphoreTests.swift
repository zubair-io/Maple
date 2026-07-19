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
            await semaphore.acquire()
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
          await semaphore.acquire()
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
  func test_zeroValueClampsToOne_doesNotDeadlock() async {
    let semaphore = BoundedAsyncSemaphore(value: 0)
    await semaphore.acquire()
    await semaphore.release()
    // Reaching this point without hanging proves the clamp took effect.
  }
}
