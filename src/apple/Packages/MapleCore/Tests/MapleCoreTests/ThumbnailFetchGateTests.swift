// ThumbnailFetchGateTests.swift — #2528.
//
// `ThumbnailFetchGate` is what caps the PhotoKit and cloud thumbnail fetch
// paths in `ThumbnailProvider` (app target); it lives here in MapleCore
// specifically so it's testable with synthetic work closures via
// `swift test`, without linking Photos.framework or hitting a real cloud
// server. Same style as `BoundedAsyncSemaphoreTests` — an out-of-band
// tracker actor records peak concurrency so the assertion doesn't rely on
// the gate's own (possibly buggy) bookkeeping.

import XCTest
@testable import MapleCore

final class ThumbnailFetchGateTests: XCTestCase {

  private actor ConcurrencyTracker {
    private var current = 0
    private(set) var peak = 0
    private(set) var callCount = 0

    func enter() {
      current += 1
      peak = max(peak, current)
      callCount += 1
    }

    func exit() {
      current -= 1
    }
  }

  // MARK: - Concurrency cap

  func test_peakConcurrencyNeverExceedsCap() async {
    let cap = 3
    let gate = ThumbnailFetchGate(maxConcurrent: cap)
    let tracker = ConcurrencyTracker()

    await withTaskGroup(of: Data?.self) { group in
      for i in 0..<30 {
        group.addTask {
          await gate.fetch(key: "distinct-\(i)") {
            await tracker.enter()
            // Hold the "fetch" across a suspension point to widen the
            // window in which an ungated implementation would over-admit.
            await Task.yield()
            await tracker.exit()
            return Data([UInt8(i)])
          }
        }
      }
    }

    let peak = await tracker.peak
    XCTAssertLessThanOrEqual(
      peak, cap,
      "observed concurrency \(peak) exceeded cap \(cap)"
    )
  }

  /// Every visible cell in a cold-opened grid requests a DISTINCT key
  /// (this test's real-world shape) — proves the cap alone bounds
  /// concurrency even with zero coalescing help, since #2528's grid is
  /// exactly "N distinct assets, one request per cell."
  func test_manyDistinctKeysAllComplete_gatedByCap() async {
    let cap = 4
    let gate = ThumbnailFetchGate(maxConcurrent: cap)
    let tracker = ConcurrencyTracker()

    await withTaskGroup(of: Data?.self) { group in
      for i in 0..<50 {
        group.addTask {
          await gate.fetch(key: "asset-\(i)") {
            await tracker.enter()
            await Task.yield()
            await tracker.exit()
            return Data([UInt8(i % 256)])
          }
        }
      }
    }

    let peak = await tracker.peak
    let calls = await tracker.callCount
    XCTAssertLessThanOrEqual(peak, cap)
    XCTAssertEqual(calls, 50, "every distinct key must eventually run its fetch")
  }

  // MARK: - Coalescing

  /// No blind sleeps. `first`'s `work` closure signals `started` the
  /// moment it runs, which can only happen AFTER `fetch` has already
  /// registered its task in `inFlight` (registration happens synchronously,
  /// immediately after the detached task is created — see `fetch`'s body
  /// — well before `work` itself ever starts). That registration then
  /// stays in place until `first`'s `work` returns, which is gated behind
  /// `releaseFirst` below and under this test's control — so `second`'s
  /// coalescing check is guaranteed to see the entry no matter how the
  /// scheduler interleaves the two tasks from here, PROVIDED `second`'s
  /// own actor hop has run by the time we call `releaseFirst.signal()`.
  /// The `Task.yield()` gives it that chance — same defensive-margin
  /// pattern `BoundedAsyncSemaphoreTests.test_cancelledWhileQueued_...`
  /// uses for an equivalent ordering (not load-bearing there; here it
  /// meaningfully reduces — though can't mathematically eliminate — the
  /// chance of the scheduler starving `second` past the release signal).
  func test_duplicateKeyCoalescesIntoOneFetch() async {
    let gate = ThumbnailFetchGate(maxConcurrent: 1)
    let tracker = ConcurrencyTracker()
    let expectedBytes = Data("shared".utf8)
    let started = ResumeGate()
    let releaseFirst = ResumeGate()

    async let first = gate.fetch(key: "same-key") {
      await tracker.enter()
      await started.signal()
      await releaseFirst.wait()
      await tracker.exit()
      return expectedBytes
    }
    await started.wait()

    async let second = gate.fetch(key: "same-key") {
      await tracker.enter()  // Must NOT be reached — this is the point.
      await tracker.exit()
      return Data("must-not-run".utf8)
    }
    await Task.yield()
    await Task.yield()
    await releaseFirst.signal()

    let (firstResult, secondResult) = await (first, second)

    XCTAssertEqual(firstResult, expectedBytes)
    XCTAssertEqual(secondResult, expectedBytes, "the coalesced caller must observe the first caller's result")
    let calls = await tracker.callCount
    XCTAssertEqual(calls, 1, "only one fetch should have actually run")
  }

  func test_sameKeyRunsAgainAfterFirstFetchCompletes() async {
    let gate = ThumbnailFetchGate(maxConcurrent: 1)
    let tracker = ConcurrencyTracker()

    let first = await gate.fetch(key: "reused-key") {
      await tracker.enter()
      await tracker.exit()
      return Data("first".utf8)
    }
    let second = await gate.fetch(key: "reused-key") {
      await tracker.enter()
      await tracker.exit()
      return Data("second".utf8)
    }

    XCTAssertEqual(first, Data("first".utf8))
    XCTAssertEqual(second, Data("second".utf8), "a fresh fetch for the same key after completion must run again")
    let calls = await tracker.callCount
    XCTAssertEqual(calls, 2)
  }

  // MARK: - Result propagation

  func test_returnsNilWhenWorkReturnsNil() async {
    let gate = ThumbnailFetchGate(maxConcurrent: 2)
    let result = await gate.fetch(key: "failing") { nil }
    XCTAssertNil(result)
  }

  // MARK: - Cancellation propagation (jules review, PR #3159)

  /// A caller cancelled WHILE QUEUED behind the cap must free its slot for
  /// the next waiter — proving cancellation propagates from the awaiting
  /// caller into the detached fetch task, and from there into
  /// `BoundedAsyncSemaphore.acquire()`'s own cancellation handling.
  /// Before this fix, `Task.detached` never observed the awaiting
  /// caller's cancellation: a cancelled off-screen grid cell's fetch
  /// (SwiftUI cancels a cell's `.task` the moment it scrolls out of view)
  /// stayed queued forever, permanently occupying a gate slot and
  /// starving every cell scrolled INTO view after it — the exact
  /// thundering-herd/starvation failure this gate exists to prevent.
  func test_cancellingAQueuedCallerFreesItsSlotForTheNextWaiter() async {
    let gate = ThumbnailFetchGate(maxConcurrent: 1)
    let tracker = ConcurrencyTracker()
    let holderStarted = ResumeGate()
    let releaseHolder = ResumeGate()

    // Holds the only permit until we release it below.
    let holderTask = Task {
      await gate.fetch(key: "holder") {
        await tracker.enter()
        await holderStarted.signal()
        await releaseHolder.wait()
        await tracker.exit()
        return Data("holder".utf8)
      }
    }
    await holderStarted.wait()

    // Queued behind the cap (the holder has the only permit) — must
    // never get a chance to run `work` at all once cancelled.
    let queuedTask = Task {
      await gate.fetch(key: "queued") {
        await tracker.enter()  // Must NOT be reached.
        await tracker.exit()
        return Data("queued".utf8)
      }
    }
    // Not load-bearing for correctness (see `BoundedAsyncSemaphore`'s own
    // tests): the cap is a genuine capacity constraint here, not a timing
    // race — `queued` cannot acquire a permit no matter when it runs,
    // since the holder hasn't released. This just widens the window.
    await Task.yield()
    await Task.yield()
    queuedTask.cancel()
    let queuedResult = await queuedTask.value
    XCTAssertNil(queuedResult, "a cancelled queued fetch must resolve to nil, never run its work")

    // Requested only AFTER cancelling the queued one — must be able to
    // acquire the freed slot once the holder releases, proving the
    // cancelled caller actually gave its place back rather than leaking it
    // (the bug: the slot would otherwise stay occupied by a fetch nobody
    // is waiting on anymore).
    let thirdTask = Task {
      await gate.fetch(key: "third") {
        await tracker.enter()
        await tracker.exit()
        return Data("third".utf8)
      }
    }
    await releaseHolder.signal()
    let holderResult = await holderTask.value
    let thirdResult = await thirdTask.value

    XCTAssertEqual(holderResult, Data("holder".utf8))
    XCTAssertEqual(thirdResult, Data("third".utf8))
    let calls = await tracker.callCount
    XCTAssertEqual(calls, 2, "holder + third ran; the cancelled queued fetch's work must never run")
  }
}

/// Deterministic single-shot signal, so these tests don't rely on sleeps
/// to sequence "the other task has reached this point" before proceeding
/// — same helper `BoundedAsyncSemaphoreTests` uses.
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
