import CoreGraphics
import Foundation
import XCTest

@testable import MapleCore

final class RawDecodeCancellationTests: XCTestCase {
  private actor Provider {
    var calls = 0
    func cancelled() throws -> Data {
      calls += 1
      throw CancellationError()
    }
  }

  func testCancelledSourceDoesNotRetryThroughUnsizedDecode() async {
    let provider = Provider()
    let asset = AssetRef(displayName: "remote.CR2", hintExtension: "cr2") {
      try await provider.cancelled()
    }
    let result = await ImageEditPipeline().decodeSceneLinearSized(
      asset: asset, targetSize: CGSize(width: 1500, height: 1000))
    XCTAssertNil(result)
    let calls = await provider.calls
    XCTAssertEqual(calls, 1, "Cancelled remote I/O must not start a second RAW fetch")
  }

  func testAlreadyCancelledDecodeDoesNotFetchSource() async {
    let provider = Provider()
    let asset = AssetRef(displayName: "remote.CR2", hintExtension: "cr2") {
      try await provider.cancelled()
    }
    let task = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return await ImageEditPipeline().decodeSceneLinearSized(
        asset: asset, targetSize: CGSize(width: 1500, height: 1000))
    }
    let result = await task.value
    XCTAssertNil(result)
    let calls = await provider.calls
    XCTAssertEqual(calls, 0)
  }
}
