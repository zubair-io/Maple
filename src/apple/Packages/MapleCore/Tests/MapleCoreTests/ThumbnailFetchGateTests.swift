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

  func test_duplicateKeyCoalescesIntoOneFetch() async {
    let gate = ThumbnailFetchGate(maxConcurrent: 1)
    let tracker = ConcurrencyTracker()
    let expectedBytes = Data("shared".utf8)

    async let first = gate.fetch(key: "same-key") {
      await tracker.enter()
      // Wide enough that the second caller below is guaranteed to observe
      // this fetch already in flight before it completes.
      try? await Task.sleep(for: .milliseconds(50))
      await tracker.exit()
      return expectedBytes
    }
    // Give `first` a chance to register in `inFlight` before firing the
    // second call for the same key.
    try? await Task.sleep(for: .milliseconds(5))
    async let second = gate.fetch(key: "same-key") {
      await tracker.enter()  // Must NOT be reached — this is the point.
      await tracker.exit()
      return Data("must-not-run".utf8)
    }

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
}
