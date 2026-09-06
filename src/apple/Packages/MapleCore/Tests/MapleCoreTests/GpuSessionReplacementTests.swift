import XCTest

@testable import MapleCore

@MainActor
final class GpuSessionReplacementTests: XCTestCase {
  private let identity = GpuUploadIdentity(decodeGeneration: 1, crop: .identity)

  func testOnlyNewestWaitingReplacementAllocatesPixels() async throws {
    let driver = GpuLiveDriver()
    let barrier = TeardownBarrier()
    driver.sessionTeardown = Task { await barrier.wait() }
    let readbacks = ReadbackRecorder()
    var requests: [Task<Bool, Error>] = []
    // Simulate the old GPU actor being occupied by a slow profile fit.
    // Each new request must wait without materializing its image buffer.
    for generation in 1...40 {
      let started = expectation(description: "replacement \(generation) queued")
      let request = Task { @MainActor in
        started.fulfill()
        do {
          try await driver.open(
            width: 16, height: 16,
            identity: .init(decodeGeneration: UInt64(generation), crop: .identity)
          ) {
            readbacks.append(UInt64(generation))
            return Self.pixels()
          }
          return true
        } catch is CancellationError {
          return false
        }
      }
      requests.append(request)
      await fulfillment(of: [started], timeout: 5)
    }
    XCTAssertTrue(readbacks.values.isEmpty)
    barrier.release()
    for (index, request) in requests.enumerated() {
      let opened = try await request.value
      XCTAssertEqual(opened, index == requests.count - 1)
    }
    XCTAssertEqual(readbacks.values, [40])
    XCTAssertTrue(
      driver.isOpen(
        coveringWidth: 16, height: 16,
        identity: .init(decodeGeneration: 40, crop: .identity)))
    // Exercise the actual Rust GPU session, not just the coverage bookkeeping.
    let rendered = await driver.renderCurrentFrameBytes(model: .default)
    XCTAssertEqual(rendered?.bytes.count, 16 * 16 * 3)
    await driver.closeSession()
  }

  func testCancelledWaiterNeverAllocatesOrOpens() async throws {
    let driver = GpuLiveDriver()
    let barrier = TeardownBarrier()
    driver.sessionTeardown = Task { await barrier.wait() }
    let started = expectation(description: "open queued")
    let request = Task { @MainActor in
      started.fulfill()
      try await driver.open(width: 16, height: 16, identity: identity) {
        XCTFail("Cancelled request allocated pixels")
        return Self.pixels()
      }
    }
    await fulfillment(of: [started], timeout: 5)
    request.cancel()
    barrier.release()
    do {
      try await request.value
      XCTFail("Cancelled open succeeded")
    } catch is CancellationError {}
    XCTAssertFalse(driver.hasSession)
    // Cancellation must not poison the shared teardown barrier.
    try await driver.open(width: 16, height: 16, identity: identity, pixels: Self.pixels)
    XCTAssertTrue(driver.hasSession)
    await driver.closeSession()
  }

  func testEvictionInvalidatesAnOpenAlreadyWaitingForTeardown() async throws {
    let driver = GpuLiveDriver()
    let barrier = TeardownBarrier()
    driver.sessionTeardown = Task { await barrier.wait() }
    let started = expectation(description: "open queued")
    let request = Task { @MainActor in
      started.fulfill()
      try await driver.open(width: 16, height: 16, identity: identity) {
        XCTFail("Evicted editor reopened")
        return Self.pixels()
      }
    }
    await fulfillment(of: [started], timeout: 5)
    let closing = expectation(description: "eviction queued")
    let eviction = Task { @MainActor in
      closing.fulfill()
      await driver.closeSession()
    }
    await fulfillment(of: [closing], timeout: 5)
    barrier.release()
    await eviction.value
    do {
      try await request.value
      XCTFail("Superseded open succeeded")
    } catch is CancellationError {}
    XCTAssertFalse(driver.hasSession)
    XCTAssertNil(driver.currentDims)
  }

  func testCoveringUploadReusesPixelsAndFailureClearsCoverage() async throws {
    let driver = GpuLiveDriver()
    try await driver.open(width: 16, height: 16, identity: identity, pixels: Self.pixels)
    try await driver.open(width: 8, height: 8, identity: identity) {
      XCTFail("Covering upload should not read pixels again")
      return []
    }
    enum ReadbackFailure: Error { case failed }
    do {
      try await driver.open(
        width: 16, height: 16,
        identity: .init(decodeGeneration: 2, crop: .identity)
      ) { throw ReadbackFailure.failed }
      XCTFail("Readback failure was swallowed")
    } catch ReadbackFailure.failed {}
    XCTAssertFalse(driver.hasSession)
    XCTAssertNil(driver.currentDims)
    try await driver.open(width: 16, height: 16, identity: identity, pixels: Self.pixels)
    XCTAssertTrue(driver.hasSession)
    await driver.closeSession()
  }

  func testAlreadyCancelledRequestKeepsExistingUpload() async throws {
    let driver = GpuLiveDriver()
    try await driver.open(width: 16, height: 16, identity: identity, pixels: Self.pixels)
    let barrier = TeardownBarrier()
    let request = Task { @MainActor in
      await barrier.wait()
      try await driver.open(
        width: 16, height: 16,
        identity: .init(decodeGeneration: 2, crop: .identity)
      ) {
        XCTFail("Cancelled request read pixels")
        return Self.pixels()
      }
    }
    request.cancel()
    barrier.release()
    do {
      try await request.value
      XCTFail("Cancelled open succeeded")
    } catch is CancellationError {}
    XCTAssertTrue(driver.isOpen(coveringWidth: 16, height: 16, identity: identity))
    await driver.closeSession()
  }

  func testNewOpenAfterEvictionWaitsForTeardownAndSurvives() async throws {
    let driver = GpuLiveDriver()
    let barrier = TeardownBarrier()
    driver.sessionTeardown = Task { await barrier.wait() }
    let closing = expectation(description: "eviction queued")
    let eviction = Task { @MainActor in
      closing.fulfill()
      await driver.closeSession()
    }
    await fulfillment(of: [closing], timeout: 5)
    let started = expectation(description: "fresh open queued")
    let readbacks = ReadbackRecorder()
    let request = Task { @MainActor in
      started.fulfill()
      try await driver.open(width: 16, height: 16, identity: identity) {
        readbacks.append(1)
        return Self.pixels()
      }
    }
    await fulfillment(of: [started], timeout: 5)
    XCTAssertEqual(readbacks.values.count, 0)
    barrier.release()
    await eviction.value
    try await request.value
    XCTAssertEqual(readbacks.values.count, 1)
    XCTAssertTrue(driver.isOpen(coveringWidth: 16, height: 16, identity: identity))
    await driver.closeSession()
  }

  func testSlowReadbackLeavesMainActorResponsiveAndSupersededOpenCannotPublish() async throws {
    let driver = GpuLiveDriver()
    let started = expectation(description: "background readback started")
    let release = DispatchSemaphore(value: 0)
    let old = Task {
      try await driver.open(width: 16, height: 16, identity: identity) {
        XCTAssertFalse(Thread.isMainThread)
        started.fulfill()
        XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
        return Self.pixels()
      }
    }
    await fulfillment(of: [started], timeout: 5)
    // Executing this continuation while readback waits proves MainActor is free.
    let newestStarted = expectation(description: "new open queued")
    let newestIdentity = GpuUploadIdentity(decodeGeneration: 2, crop: .identity)
    let newest = Task {
      newestStarted.fulfill()
      try await driver.open(width: 16, height: 16, identity: newestIdentity, pixels: Self.pixels)
    }
    await fulfillment(of: [newestStarted], timeout: 5)
    release.signal()
    do {
      try await old.value
      XCTFail("Superseded background open succeeded")
    } catch is CancellationError {}
    try await newest.value
    XCTAssertTrue(driver.isOpen(coveringWidth: 16, height: 16, identity: newestIdentity))
    await driver.closeSession()
  }

  func testCancelledBackgroundReadbackDoesNotOpenSession() async throws {
    let driver = GpuLiveDriver()
    let started = expectation(description: "readback started")
    let release = DispatchSemaphore(value: 0)
    let request = Task {
      try await driver.open(width: 16, height: 16, identity: identity) {
        started.fulfill()
        XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
        return Self.pixels()
      }
    }
    await fulfillment(of: [started], timeout: 5)
    request.cancel()
    release.signal()
    do {
      try await request.value
      XCTFail("Cancelled preparation succeeded")
    } catch is CancellationError {}
    XCTAssertFalse(driver.hasSession)
  }

  nonisolated private static func pixels() -> [Float] {
    Array(repeating: [Float(0.18), 0.18, 0.18, 1], count: 16 * 16).flatMap { $0 }
  }
}

@MainActor
private final class TeardownBarrier {
  private var released = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    guard !released else { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func release() {
    released = true
    let pending = waiters
    waiters.removeAll()
    for waiter in pending { waiter.resume() }
  }
}

private final class ReadbackRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [UInt64] = []

  var values: [UInt64] { lock.withLock { storage } }

  func append(_ value: UInt64) {
    lock.withLock { storage.append(value) }
  }
}
