// Coverage for the interactive lane on `BoundedAsyncSemaphore` (#6019).

import XCTest

@testable import MapleCloudKit

final class BoundedAsyncSemaphorePriorityTests: XCTestCase {
  private actor GrantLog {
    private(set) var labels: [String] = []

    func record(_ label: String) {
      labels.append(label)
    }
  }

  private actor Hold {
    private(set) var isHeld = false
    private var isReleased = false
    private var waiter: CheckedContinuation<Void, Never>?

    func wait() async {
      isHeld = true
      guard !isReleased else { return }
      await withCheckedContinuation { waiter = $0 }
    }

    func release() {
      isReleased = true
      waiter?.resume()
      waiter = nil
    }
  }

  /// Queues one waiter and returns once the semaphore has registered it, so
  /// the queue order inside each lane is exactly the call order.
  private func enqueue(
    _ label: String,
    priority: BoundedAsyncSemaphore.Priority,
    on semaphore: BoundedAsyncSemaphore,
    log: GrantLog
  ) async -> Task<Void, Error> {
    let queuedBefore = await semaphore.queuedCount
    let task = Task {
      try await semaphore.acquire(priority: priority)
      await log.record(label)
      await semaphore.release()
    }
    let queued = await semaphore.waitForQueue(atLeast: queuedBefore + 1)
    XCTAssertTrue(queued, "\(label) never reached the waiter queue")
    return task
  }

  func test_interactiveWaiterOvertakesFiftyQueuedStandardWaiters() async throws {
    let semaphore = BoundedAsyncSemaphore(value: 2)
    let log = GrantLog()
    try await semaphore.acquire()
    try await semaphore.acquire()

    var waiters: [Task<Void, Error>] = []
    for index in 0..<50 {
      waiters.append(await enqueue("S\(index)", priority: .standard, on: semaphore, log: log))
    }
    waiters.append(await enqueue("I", priority: .interactive, on: semaphore, log: log))

    await semaphore.release()
    for waiter in waiters { try await waiter.value }
    await semaphore.release()

    let labels = await log.labels
    let standardAheadOfInteractive = labels.firstIndex(of: "I") ?? labels.count
    print(
      "[#6019] standard waiters granted before the interactive waiter: \(standardAheadOfInteractive)"
    )
    XCTAssertEqual(standardAheadOfInteractive, 0)
    XCTAssertEqual(labels, ["I"] + (0..<50).map { "S\($0)" })
  }

  func test_eachLaneStaysFirstComeFirstServed() async throws {
    let semaphore = BoundedAsyncSemaphore(value: 1)
    let log = GrantLog()
    try await semaphore.acquire()

    let order: [(String, BoundedAsyncSemaphore.Priority)] = [
      ("S0", .standard), ("I0", .interactive), ("S1", .standard),
      ("I1", .interactive), ("S2", .standard), ("I2", .interactive),
    ]
    var waiters: [Task<Void, Error>] = []
    for (label, priority) in order {
      waiters.append(await enqueue(label, priority: priority, on: semaphore, log: log))
    }

    await semaphore.release()
    for waiter in waiters { try await waiter.value }

    let labels = await log.labels
    XCTAssertEqual(labels, ["I0", "I1", "I2", "S0", "S1", "S2"])
  }

  func test_cancelledInteractiveWaiterLeavesTheQueue() async throws {
    let semaphore = BoundedAsyncSemaphore(value: 1)
    let log = GrantLog()
    try await semaphore.acquire()

    let standard = await enqueue("S0", priority: .standard, on: semaphore, log: log)
    let cancelled = await enqueue("I0", priority: .interactive, on: semaphore, log: log)
    let interactive = await enqueue("I1", priority: .interactive, on: semaphore, log: log)

    cancelled.cancel()
    do {
      try await cancelled.value
      XCTFail("a cancelled interactive acquire must throw")
    } catch is CancellationError {}
    let queuedAfterCancel = await semaphore.queuedCount
    XCTAssertEqual(queuedAfterCancel, 2)

    await semaphore.release()
    try await interactive.value
    try await standard.value

    let labels = await log.labels
    XCTAssertEqual(labels, ["I1", "S0"])
    let queuedAtEnd = await semaphore.queuedCount
    XCTAssertEqual(queuedAtEnd, 0)
  }

  func test_standardWaiterIsServedAfterABurstOfInteractiveHandoffs() async throws {
    XCTAssertEqual(
      BoundedAsyncSemaphore.interactiveBurstLimit, 4,
      "the expected grant order below is written for a burst limit of 4")
    let semaphore = BoundedAsyncSemaphore(value: 1)
    let log = GrantLog()
    try await semaphore.acquire()

    var waiters: [Task<Void, Error>] = []
    for index in 0..<2 {
      waiters.append(await enqueue("S\(index)", priority: .standard, on: semaphore, log: log))
    }
    for index in 0..<10 {
      waiters.append(await enqueue("I\(index)", priority: .interactive, on: semaphore, log: log))
    }

    await semaphore.release()
    for waiter in waiters { try await waiter.value }

    let labels = await log.labels
    XCTAssertEqual(
      labels,
      ["I0", "I1", "I2", "I3", "S0", "I4", "I5", "I6", "I7", "S1", "I8", "I9"])
  }

  func test_interactiveHandoffsWithNoStandardWaiterDoNotCountTowardTheBurst() async throws {
    let semaphore = BoundedAsyncSemaphore(value: 1)
    let log = GrantLog()
    let hold = Hold()
    try await semaphore.acquire()

    var waiters: [Task<Void, Error>] = []
    for index in 0...BoundedAsyncSemaphore.interactiveBurstLimit {
      waiters.append(await enqueue("I\(index)", priority: .interactive, on: semaphore, log: log))
    }
    let queuedBeforeHolder = await semaphore.queuedCount
    let holder = Task {
      try await semaphore.acquire(priority: .interactive)
      await log.record("H")
      await hold.wait()
      await semaphore.release()
    }
    let holderQueued = await semaphore.waitForQueue(
      atLeast: queuedBeforeHolder + 1, timeout: .seconds(20))
    XCTAssertTrue(holderQueued)

    await semaphore.release()
    let holding = await waitForCondition(timeout: .seconds(20)) { await hold.isHeld }
    XCTAssertTrue(holding, "precondition: the streak ended with the permit still held")
    let standard = await enqueue("S", priority: .standard, on: semaphore, log: log)
    let interactive = await enqueue("I", priority: .interactive, on: semaphore, log: log)

    await hold.release()
    for waiter in waiters + [holder, interactive, standard] { try await waiter.value }

    let labels = await log.labels
    XCTAssertEqual(
      Array(labels.suffix(3)), ["H", "I", "S"],
      "a streak that passed over no standard waiter owes the standard lane nothing")
  }
}
