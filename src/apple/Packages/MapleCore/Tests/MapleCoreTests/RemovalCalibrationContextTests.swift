import Foundation
import XCTest

@testable import MapleCore

final class RemovalCalibrationContextTests: XCTestCase {
  private func handle() throws -> MapleRawHandle {
    let raw = try XCTUnwrap(
      Bundle.module.url(forResource: "source", withExtension: "dng", subdirectory: "removal"))
    return try PipelineRenderer.openRawHandle(rawPath: raw)
  }

  func testRetainedNativeContextsHaveStableSourceCoordinates() throws {
    let raw = try handle()
    let region = try RemovalBridge.calibrationContext(
      handle: raw, x: 1, y: 1, width: 7, height: 5)
    XCTAssertEqual(region.count, 7 * 5 * 3)
    XCTAssertTrue(region.allSatisfy(\.isFinite))
    let inner = try RemovalBridge.calibrationContext(
      handle: raw, x: 2, y: 2, width: 3, height: 2)
    let expected = (1...2).flatMap { row in
      Array(region[(row * 7 + 1) * 3..<(row * 7 + 4) * 3])
    }
    XCTAssertEqual(inner.map(\.bitPattern), expected.map(\.bitPattern))
    XCTAssertEqual(
      try RemovalBridge.calibrationContext(handle: raw, x: 1, y: 1, width: 7, height: 5)
        .map(\.bitPattern), region.map(\.bitPattern))
  }

  func testInvalidGeometryAndCancellationCannotPublishPixels() throws {
    let raw = try handle()
    for (x, width, height): (UInt32, UInt32, UInt32) in [
      (0, 0, 1), (0, 1, 0), (0, 1025, 1), (.max, 1, 1), (15, 2, 1),
    ] {
      XCTAssertThrowsError(
        try RemovalBridge.calibrationContext(handle: raw, x: x, y: 0, width: width, height: height))
    }
    let cancel = CancelFlag()
    cancel.requestCancel()
    XCTAssertThrowsError(
      try RemovalBridge.calibrationContext(
        handle: raw, x: 1, y: 1, width: 7, height: 5, cancel: cancel)
    ) { error in
      guard case PipelineError.cancelled = error else {
        return XCTFail("Expected cancellation, got \(error)")
      }
    }
    XCTAssertEqual(
      try RemovalBridge.calibrationContext(handle: raw, x: 1, y: 1, width: 7, height: 5).count, 105)
  }
}
