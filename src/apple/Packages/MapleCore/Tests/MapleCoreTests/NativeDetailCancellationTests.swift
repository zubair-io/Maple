import CoreGraphics
import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class NativeDetailCancellationTests: XCTestCase {
  func testInvalidationDuringSnapshotSkipsNativeDecodeAndFallback() async {
    // No RAW is needed: invalidated work must stop before opening the file.
    // Before the guard this missing source reaches native decode, fails, and
    // returns false to request an obsolete whole-image fallback.
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-native-cancel-\(UUID().uuidString).dng")
    let session = EditSession(asset: AssetRef(url: url))
    session.nativeImageSize = CGSize(width: 8000, height: 6000)
    session.viewportSourceRect = CGRect(x: 1000, y: 1000, width: 800, height: 600)

    let entered = expectation(description: "snapshot actor held")
    let release = DispatchSemaphore(value: 0)
    defer { release.signal() }
    let blocked = Task {
      await session.renderActor.holdNativeSnapshotQueue(entered: entered, release: release)
    }
    await fulfillment(of: [entered], timeout: 5)
    let obsolete = Task { await session.refineNativeDetail(gen: 0) }
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while session.nativeDetailInFlightID == nil {
      guard ContinuousClock.now < deadline else {
        XCTFail("Native detail did not reach its snapshot suspension")
        obsolete.cancel()
        release.signal()
        await blocked.value
        _ = await obsolete.value
        return
      }
      try? await Task.sleep(for: .milliseconds(5))
    }

    session.clearNativeDetailPreview()
    release.signal()
    await blocked.value
    let handled = await obsolete.value
    XCTAssertTrue(handled, "Invalidated native detail must not request a fallback render")
    XCTAssertNil(session.nativeDetailPreview)
    XCTAssertNil(session.nativeDetailInFlightID)
    XCTAssertFalse(session.isRendering)
  }
}

extension RenderActor {
  fileprivate func holdNativeSnapshotQueue(
    entered: XCTestExpectation, release: DispatchSemaphore
  ) {
    entered.fulfill()
    XCTAssertEqual(release.wait(timeout: .now() + 10), .success)
  }
}
