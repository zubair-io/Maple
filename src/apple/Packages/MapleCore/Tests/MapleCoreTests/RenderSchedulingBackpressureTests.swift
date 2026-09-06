import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class RenderSchedulingBackpressureTests: XCTestCase {
  func testCancelledQueuedFastWorkNeverStarts() async {
    let renderer = RenderActor(pipeline: ImageEditPipeline())
    let starts = StartedWork()
    await renderer.enqueueBurst { generation in await starts.record(Int(generation)) }
    await renderer.awaitCurrentRenderIfInFlight()
    let values = await starts.values
    XCTAssertEqual(values, [40], "Cancelled queued tasks must not enter decode or snapshot I/O")
  }

  func testStaleFastTailCannotCancelNewerRefine() async throws {
    let renderer = RenderActor(pipeline: ImageEditPipeline())
    let starts = StartedWork()
    let old = await renderer.scheduleRender(phase: .fast) { _ in }
    let latest = await renderer.scheduleRender(phase: .fast) { _ in }
    await renderer.scheduleRefine(expectedGeneration: latest) { _ in await starts.record(2) }
    await renderer.scheduleRefine(expectedGeneration: old) { _ in await starts.record(1) }
    try await Task.sleep(for: .milliseconds(250))
    let values = await starts.values
    XCTAssertEqual(values, [2], "An obsolete tail must not cancel the current generation's refine")
  }

  func testCancelAllRejectsAnOldRefineForwardedAfterTeardown() async {
    let renderer = RenderActor(pipeline: ImageEditPipeline())
    let old = await renderer.scheduleRender(phase: .fast) { _ in }
    await renderer.cancelAll()
    let cancelledGeneration = await renderer.currentGeneration()
    XCTAssertEqual(cancelledGeneration, old + 1)

    // Model a forwarding task that was already queued when teardown ran.
    // Rejection happens synchronously before any debounce task is created.
    let accepted = await renderer.scheduleRefine(expectedGeneration: old) { _ in
      XCTFail("A closed session's old refine must not restart work")
    }
    let inFlight = await renderer._testRefineTaskInFlight()
    XCTAssertEqual(accepted, cancelledGeneration)
    XCTAssertFalse(inFlight)
    await renderer.cancelAll()
  }

  func testCancelledCPURenderHoldsSlotUntilNativeWorkActuallyReturns() async throws {
    let firstRenderer = RenderActor(pipeline: ImageEditPipeline())
    let nextRenderer = RenderActor(pipeline: ImageEditPipeline())
    let started = expectation(description: "native CPU work entered")
    let release = DispatchSemaphore(value: 0)
    let entered = LockedStarts()
    let first = Task {
      try await firstRenderer.renderCPUPreview {
        entered.record(0)
        started.fulfill()
        _ = release.wait(timeout: .now() + 5)
        return CIImage.empty()
      }
    }
    await fulfillment(of: [started], timeout: 3)
    first.cancel()
    let obsolete = (1...40).map { id in
      let task = Task {
        try await nextRenderer.renderCPUPreview {
          entered.record(id)
          return CIImage.empty()
        }
      }
      task.cancel()
      return task
    }
    let tail = Task {
      try await nextRenderer.renderCPUPreview {
        entered.record(41)
        return CIImage.empty()
      }
    }
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(entered.values, [0], "A cancelled native render still owns its CPU slot")
    release.signal()
    do {
      _ = try await first.value
      XCTFail("Cancelled result must be dropped")
    } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
    for task in obsolete {
      do {
        _ = try await task.value
        XCTFail("Obsolete work entered CPU pipeline")
      } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
    }
    _ = try await tail.value
    XCTAssertEqual(entered.values, [0, 41])
  }
}

extension RenderActor {
  // Execute the burst without yielding this actor so each scheduled task is
  // queued behind the next cancellation, as in a congested input run loop.
  fileprivate func enqueueBurst(work: @escaping @Sendable (UInt64) async -> Void) {
    for _ in 0..<40 { scheduleRender(phase: .fast, work: work) }
  }
}

private actor StartedWork {
  var values: [Int] = []
  func record(_ value: Int) { values.append(value) }
}

private final class LockedStarts: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [Int] = []
  func record(_ value: Int) { lock.withLock { storage.append(value) } }
  var values: [Int] { lock.withLock { storage } }
}
