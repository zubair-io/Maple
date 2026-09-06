import QuartzCore
import XCTest

@testable import MapleCore

@MainActor
final class GpuPresentationOutcomeTests: XCTestCase {
  func testOnlySuccessfulCurrentPresentationReportsAFrame() async throws {
    let driver = GpuLiveDriver()
    let absent = await driver.present(model: .default) { _ in
      XCTFail("Missing session is not an error")
    }
    XCTAssertFalse(absent)
    let pixels = [Float](repeating: 0.18, count: 16 * 16 * 4)
    try await driver.open(
      width: 16, height: 16,
      identity: .init(decodeGeneration: 1, crop: .identity)
    ) { pixels }
    let noLayer = await driver.present(model: .default) { _ in
      XCTFail("Missing layer is not an error")
    }
    XCTAssertFalse(noLayer)
    let layer = CAMetalLayer()
    layer.bounds = CGRect(x: 0, y: 0, width: 16, height: 16)
    driver.register(layer: layer)
    let cancelled = Task { @MainActor in
      await driver.present(model: .default) { _ in XCTFail("Cancellation is not GPU failure") }
    }
    cancelled.cancel()
    let didCancel = await cancelled.value
    XCTAssertFalse(didCancel)
    let before = try await driver.histogramForCurrentFrame()
    XCTAssertNil(before)
    let presented = await driver.present(model: .default) { error in
      XCTFail("Present failed: \(error)")
    }
    XCTAssertTrue(presented)
    let after = try await driver.histogramForCurrentFrame()
    XCTAssertNotNil(after)
    await driver.closeSession()
    withExtendedLifetime(layer) {}
  }

  func testNativeCancelledPresentHasNoPublishedHistogram() async throws {
    let session = try GpuLiveSession(
      pixels: [Float](repeating: 0.18, count: 16 * 16 * 4), width: 16, height: 16)
    let layer = CAMetalLayer()
    layer.bounds = CGRect(x: 0, y: 0, width: 16, height: 16)
    let cancel = CancelFlag()
    cancel.requestCancel()
    let elapsed = try await session.present(model: .default, layer: layer, cancel: cancel)
    XCTAssertNil(elapsed)
    let histogram = try await session.displayedHistogram()
    XCTAssertNil(histogram)
    await session.close()
    withExtendedLifetime(layer) {}
  }

  func testReplacingSurfaceDropsQueuedPresentationAndAcceptsNewSurface() async throws {
    try await assertSurfaceReplacement(closeBeforePresent: false)
  }

  func testReplacingSurfaceDoesNotReportErrorsFromAbandonedSurface() async throws {
    try await assertSurfaceReplacement(closeBeforePresent: true)
  }

  private func assertSurfaceReplacement(closeBeforePresent: Bool) async throws {
    let driver = GpuLiveDriver()
    let pixels = [Float](repeating: 0.18, count: 16 * 16 * 4)
    try await driver.open(
      width: 16, height: 16,
      identity: .init(decodeGeneration: 1, crop: .identity)
    ) { pixels }
    let oldLayer = CAMetalLayer()
    oldLayer.bounds = CGRect(x: 0, y: 0, width: 16, height: 16)
    driver.register(layer: oldLayer)
    let session = try XCTUnwrap(driver.session)
    let occupied = expectation(description: "session actor occupied")
    let release = DispatchSemaphore(value: 0)
    let blocked = Task.detached {
      await session.holdPresentationQueue(
        occupied: occupied, release: release, closeBeforePresent: closeBeforePresent)
    }
    await fulfillment(of: [occupied], timeout: 5)
    let queued = expectation(description: "old surface present queued")
    let stale = Task { @MainActor in
      queued.fulfill()
      return await driver.present(model: .default) { error in
        XCTFail("Abandoned surface reported an error: \(error)")
      }
    }
    await fulfillment(of: [queued], timeout: 5)
    let newLayer = CAMetalLayer()
    newLayer.bounds = oldLayer.bounds
    driver.register(layer: newLayer)
    release.signal()
    await blocked.value
    let didPresentStaleSurface = await stale.value
    XCTAssertFalse(didPresentStaleSurface)
    if !closeBeforePresent {
      let didPresentCurrentSurface = await driver.present(model: .default) { error in
        XCTFail("Current surface failed: \(error)")
      }
      XCTAssertTrue(didPresentCurrentSurface)
    }
    await driver.closeSession()
    withExtendedLifetime((oldLayer, newLayer)) {}
  }
}

extension GpuLiveSession {
  fileprivate func holdPresentationQueue(
    occupied: XCTestExpectation, release: DispatchSemaphore, closeBeforePresent: Bool
  ) {
    occupied.fulfill()
    guard release.wait(timeout: .now() + 5) == .success else {
      XCTFail("Test did not release the occupied actor")
      return
    }
    if closeBeforePresent { close() }
  }
}
