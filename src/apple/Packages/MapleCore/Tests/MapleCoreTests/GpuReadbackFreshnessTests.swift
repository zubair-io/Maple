import XCTest

@testable import MapleCore

@MainActor
final class GpuReadbackFreshnessTests: XCTestCase {
  func testClosingSessionWhileReadbackQueuedRejectsRetiredPixels() async throws {
    let driver = GpuLiveDriver()
    try await driver.open(
      width: 16, height: 16, identity: .init(decodeGeneration: 1, crop: .identity)
    ) {
      [Float](repeating: 0.18, count: 16 * 16 * 4)
    }
    let native = try XCTUnwrap(driver.session)
    let occupied = expectation(description: "GPU actor occupied")
    let release = DispatchSemaphore(value: 0)
    let blocked = Task.detached {
      await native.holdReadbackQueue(occupied: occupied, release: release)
    }
    await fulfillment(of: [occupied], timeout: 5)
    let enqueued = expectation(description: "Readback entered driver")
    let readback = Task { @MainActor in
      enqueued.fulfill()
      return await driver.renderCurrentFrameBytes(model: .default)
    }
    await fulfillment(of: [enqueued], timeout: 5)
    let close = Task { @MainActor in await driver.closeSession() }
    while driver.session != nil { await Task.yield() }
    release.signal()
    await blocked.value
    let retired = await readback.value
    XCTAssertNil(retired, "A completed read of a retired session must not seed a new cache entry")
    await close.value
  }
}

extension GpuLiveSession {
  fileprivate func holdReadbackQueue(occupied: XCTestExpectation, release: DispatchSemaphore) {
    occupied.fulfill()
    XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
  }
}
