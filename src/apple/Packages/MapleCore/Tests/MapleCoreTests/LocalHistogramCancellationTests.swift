import Foundation
import XCTest

@testable import MapleCore

final class LocalHistogramCancellationTests: XCTestCase {
  /// A provider held in flight stands in for slow file/PhotoKit I/O. Later
  /// histogram requests must wait BEFORE loading bytes, including non-RAWs.
  /// Cancelling queued slider updates must finish without reading their assets.
  func testRapidEditsDoNotLoadOverlappingHistograms() async {
    let entered = expectation(description: "first histogram has the slot")
    let blocked = HistogramBytesBarrier()
    let firstAsset = AssetRef(displayName: "first", hintExtension: "dng") {
      await blocked.read(entered: entered)
    }
    let first = Task {
      try await LocalHistogram.compute(asset: firstAsset, model: .default, culling: CullingState())
    }
    await fulfillment(of: [entered], timeout: 2)

    let prematureRead = expectation(description: "queued histogram must not load bytes")
    prematureRead.isInverted = true
    let reads = HistogramReadCounter()
    let nextAsset = AssetRef(displayName: "next", hintExtension: "dng") {
      await reads.record(prematureRead)
      return Data([0, 1, 2, 3])
    }
    let submitted = expectation(description: "rapid slider updates submitted")
    submitted.expectedFulfillmentCount = 40
    let updates = (0..<40).map { index in
      Task {
        submitted.fulfill()
        if index.isMultiple(of: 2) {
          return try await LocalHistogram.compute(
            asset: nextAsset, model: .default, culling: CullingState())
        }
        return try await LocalHistogram.computeNonRaw(asset: nextAsset, model: .default)
      }
    }
    await fulfillment(of: [submitted], timeout: 2)
    await fulfillment(of: [prematureRead], timeout: 0.2)
    for update in updates { update.cancel() }
    for update in updates {
      do {
        _ = try await update.value
        XCTFail("A cancelled histogram returned a result")
      } catch {
        XCTAssertTrue(error is CancellationError, "Expected cancellation, got \(error)")
      }
    }

    // Cancellation must also be checked after an already-started provider
    // finishes: its obsolete RAW must never reach the native decode.
    first.cancel()
    await blocked.release()
    do {
      _ = try await first.value
      XCTFail("A cancelled in-flight histogram returned a result")
    } catch {
      XCTAssertTrue(error is CancellationError, "Expected cancellation, got \(error)")
    }
  }

  func testAlreadyCancelledHistogramNeverReadsBytes() async {
    let read = expectation(description: "cancelled request must not read")
    read.isInverted = true
    let asset = AssetRef(displayName: "cancelled", hintExtension: "dng") {
      read.fulfill()
      return Data([0, 1, 2, 3])
    }
    let task = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await LocalHistogram.compute(
        asset: asset, model: .default, culling: CullingState())
    }
    do {
      _ = try await task.value
      XCTFail("Already-cancelled request returned a histogram")
    } catch {
      XCTAssertTrue(error is CancellationError, "Expected cancellation, got \(error)")
    }
    await fulfillment(of: [read], timeout: 0.1)
  }

  func testSourceFailureReleasesHistogramSlot() async {
    let attempted = expectation(description: "next request starts after source failure")
    for index in 0..<2 {
      let asset = AssetRef(displayName: "failure", hintExtension: "dng") {
        if index == 1 { attempted.fulfill() }
        throw CocoaError(.fileReadNoSuchFile)
      }
      do {
        _ = try await LocalHistogram.compute(asset: asset, model: .default, culling: CullingState())
        XCTFail("Unreadable asset returned a histogram")
      } catch {
        XCTAssertEqual((error as NSError).code, CocoaError.fileReadNoSuchFile.rawValue)
      }
    }
    await fulfillment(of: [attempted], timeout: 2)
  }
}

private actor HistogramBytesBarrier {
  private var continuation: CheckedContinuation<Data, Never>?

  func read(entered: XCTestExpectation) async -> Data {
    await withCheckedContinuation {
      continuation = $0
      entered.fulfill()
    }
  }

  func release() {
    continuation?.resume(returning: Data([0, 1, 2, 3]))
    continuation = nil
  }
}

private actor HistogramReadCounter {
  private var count = 0
  func record(_ expectation: XCTestExpectation) {
    count += 1
    if count == 1 { expectation.fulfill() }
  }
}
