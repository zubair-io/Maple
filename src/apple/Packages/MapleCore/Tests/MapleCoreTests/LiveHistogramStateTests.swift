import XCTest

@testable import MapleCore

@MainActor
final class LiveHistogramStateTests: XCTestCase {
  func testTwoViewsAndRepeatedReadersShareOneComputation() async throws {
    let state = LiveHistogramState()
    let barrier = HistogramStateBarrier()
    var computations = 0
    let entered = expectation(description: "computation started")
    let first = Task {
      try await state.read {
        computations += 1
        entered.fulfill()
        await barrier.wait()
        return Self.histogram(7)
      }
    }
    await fulfillment(of: [entered], timeout: 2)
    let readers = (0..<40).map { _ in
      Task {
        try await state.read {
          computations += 1
          return Self.histogram(99)
        }
      }
    }
    barrier.release()
    let firstResult = try await first.value
    XCTAssertEqual(firstResult?.r, [7])
    for reader in readers {
      let result = try await reader.value
      XCTAssertEqual(result?.r, [7])
    }
    XCTAssertEqual(computations, 1)
    state.framePresented()
    let newer = try await state.read {
      computations += 1
      return Self.histogram(8)
    }
    XCTAssertEqual(newer?.r, [8])
    XCTAssertEqual(computations, 2)
  }

  func testNewFrameRejectsOldResultWithoutClearingNewComputation() async throws {
    let state = LiveHistogramState()
    let barrier = HistogramStateBarrier()
    let entered = expectation(description: "old computation started")
    let old = Task {
      try await state.read {
        entered.fulfill()
        await barrier.wait()
        return Self.histogram(1)
      }
    }
    await fulfillment(of: [entered], timeout: 2)
    state.framePresented()
    let newer = try await state.read { Self.histogram(2) }
    XCTAssertEqual(newer?.r, [2])
    barrier.release()
    do {
      _ = try await old.value
      XCTFail("Old frame escaped its revision")
    } catch { XCTAssertTrue(error is CancellationError) }
    let reused = try await state.read {
      XCTFail("Old completion evicted new result")
      return nil
    }
    XCTAssertEqual(reused?.r, [2])
  }

  func testCancelledViewDoesNotCancelTheOtherViewsResult() async throws {
    let state = LiveHistogramState()
    let barrier = HistogramStateBarrier()
    let entered = expectation(description: "shared computation started")
    let first = Task {
      try await state.read {
        entered.fulfill()
        await barrier.wait()
        return Self.histogram(3)
      }
    }
    await fulfillment(of: [entered], timeout: 2)
    first.cancel()
    barrier.release()
    do {
      _ = try await first.value
      XCTFail("Cancelled view received a result")
    } catch { XCTAssertTrue(error is CancellationError) }
    let other = try await state.read {
      XCTFail("Shared result was discarded")
      return nil
    }
    XCTAssertEqual(other?.r, [3])
  }

  private static func histogram(_ value: Int) -> CloudHistogram {
    CloudHistogram(r: [value], g: [value], b: [value])
  }
}

@MainActor
private final class HistogramStateBarrier {
  private var continuation: CheckedContinuation<Void, Never>?
  func wait() async { await withCheckedContinuation { continuation = $0 } }
  func release() {
    continuation?.resume()
    continuation = nil
  }
}
