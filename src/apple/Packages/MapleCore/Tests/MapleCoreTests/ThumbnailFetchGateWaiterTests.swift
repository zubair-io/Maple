// ThumbnailFetchGateWaiterTests — cancellation belongs to one waiter, not
// to the shared fetch (#5735). Grid cells coalesce on one fetch per
// thumbnail; a cell leaving the screen must not take the bytes away from
// the cells still showing that thumbnail, and a fetch already on the wire
// finishes so its result reaches the cache.

import XCTest

@testable import MapleCore

final class ThumbnailFetchGateWaiterTests: XCTestCase {
  func testCancellingTheFirstWaiterStillDeliversToTheOthers() async {
    let gate = ThumbnailFetchGate(maxConcurrent: 1)
    let work = BlockingWork()

    let first = Task { await gate.fetch(key: "shared") { await work.run() } }
    await work.waitUntilStarted()
    let second = Task { await gate.fetch(key: "shared") { await work.run() } }
    await waitForWaiters(gate, key: "shared", count: 2)

    first.cancel()
    await waitForWaiters(gate, key: "shared", count: 1)
    await work.release()

    let delivered = await second.value
    let cancelledResult = await first.value
    XCTAssertEqual(delivered, BlockingWork.bytes)
    XCTAssertNil(cancelledResult)
    let runs = await work.runs
    let sawCancellation = await work.sawCancellation
    XCTAssertEqual(runs, 1)
    XCTAssertFalse(sawCancellation, "the fetch other cells still wait on must not be cancelled")
  }

  func testCancellingACoalescedWaiterStillDeliversToTheFirst() async {
    let gate = ThumbnailFetchGate(maxConcurrent: 1)
    let work = BlockingWork()

    let first = Task { await gate.fetch(key: "shared") { await work.run() } }
    await work.waitUntilStarted()
    let second = Task { await gate.fetch(key: "shared") { await work.run() } }
    await waitForWaiters(gate, key: "shared", count: 2)

    second.cancel()
    await waitForWaiters(gate, key: "shared", count: 1)
    await work.release()

    let delivered = await first.value
    XCTAssertEqual(delivered, BlockingWork.bytes)
    let sawCancellation = await work.sawCancellation
    XCTAssertFalse(sawCancellation)
  }

  func testLastWaiterLeavingLetsARunningFetchFinish() async {
    let gate = ThumbnailFetchGate(maxConcurrent: 1)
    let work = BlockingWork()

    let only = Task { await gate.fetch(key: "solo") { await work.run() } }
    await work.waitUntilStarted()
    only.cancel()
    await waitForWaiters(gate, key: "solo", count: 0)
    await work.release()

    let result = await only.value
    XCTAssertNil(result, "a cancelled caller gets nothing back")
    await work.waitUntilFinished()
    let sawCancellation = await work.sawCancellation
    XCTAssertFalse(sawCancellation, "a fetch already on the wire runs to completion")
  }

  func testLastWaiterLeavingAQueuedFetchSkipsItsWork() async {
    let gate = ThumbnailFetchGate(maxConcurrent: 1)
    let holder = BlockingWork()
    let queuedWork = BlockingWork()

    let holding = Task { await gate.fetch(key: "holder") { await holder.run() } }
    await holder.waitUntilStarted()
    let queued = Task { await gate.fetch(key: "queued") { await queuedWork.run() } }
    await waitForWaiters(gate, key: "queued", count: 1)
    queued.cancel()
    let queuedResult = await queued.value
    await holder.release()
    _ = await holding.value

    XCTAssertNil(queuedResult)
    let queuedRuns = await queuedWork.runs
    XCTAssertEqual(queuedRuns, 0, "nobody waits on it, so it never starts")
  }

  private func waitForWaiters(
    _ gate: ThumbnailFetchGate, key: String, count: Int,
    file: StaticString = #filePath, line: UInt = #line
  ) async {
    let deadline = ContinuousClock.now + .seconds(5)
    while ContinuousClock.now < deadline {
      if await gate.waiterCount(forKey: key) == count { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("waiter count never reached \(count)", file: file, line: line)
  }
}

/// A fetch that blocks until released, then reports whether its task was
/// cancelled the way a `URLSession` request would see it.
actor BlockingWork {
  static let bytes = Data("thumbnail".utf8)

  private(set) var runs = 0
  private(set) var sawCancellation = false
  private var started = false
  private var finished = false
  private var released = false
  private var startWaiters: [CheckedContinuation<Void, Never>] = []
  private var finishWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

  func run() async -> Data? {
    runs += 1
    started = true
    for waiter in startWaiters { waiter.resume() }
    startWaiters.removeAll()
    if !released { await withCheckedContinuation { releaseWaiters.append($0) } }
    let cancelled = Task.isCancelled
    sawCancellation = sawCancellation || cancelled
    finished = true
    for waiter in finishWaiters { waiter.resume() }
    finishWaiters.removeAll()
    return cancelled ? nil : Self.bytes
  }

  func release() {
    released = true
    for waiter in releaseWaiters { waiter.resume() }
    releaseWaiters.removeAll()
  }

  func waitUntilStarted() async {
    if started { return }
    await withCheckedContinuation { startWaiters.append($0) }
  }

  func waitUntilFinished() async {
    if finished { return }
    await withCheckedContinuation { finishWaiters.append($0) }
  }
}
