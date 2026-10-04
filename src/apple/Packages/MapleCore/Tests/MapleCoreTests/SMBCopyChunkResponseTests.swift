import Foundation
import XCTest

@testable import AMSMB2

final class SMBCopyChunkResponseTests: XCTestCase {
  private func response(_ chunks: UInt32, _ chunkBytes: UInt32, _ totalBytes: UInt32) throws
    -> IOCtl.SrvCopyChunkResponse
  {
    let bytes = [chunks, chunkBytes, totalBytes].flatMap { value in
      (0..<4).map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) }
    }
    return try IOCtl.SrvCopyChunkResponse(data: Data(bytes))
  }

  func testLimitsHonorBothChunkAndTotalBounds() throws {
    XCTAssertEqual(
      try response(256, 1_048_576, 16_777_216).reducedChunkSize(rejectedLength: 4_194_304),
      1_048_576)
    XCTAssertEqual(
      try response(1, 1_048_576, 65_536).reducedChunkSize(rejectedLength: 4_194_304), 65_536)
  }

  func testInvalidLimitsFailClosed() throws {
    for values: (UInt32, UInt32, UInt32) in [
      (0, 1, 1), (1, 0, 1), (1, 1, 0), (1, 4096, 4096), (1, UInt32.max, UInt32.max),
    ] {
      XCTAssertThrowsError(
        try response(values.0, values.1, values.2).reducedChunkSize(rejectedLength: 4096))
    }
    for count in [0, 4, 8, 11, 13, 16] {
      XCTAssertThrowsError(try IOCtl.SrvCopyChunkResponse(data: Data(repeating: 0, count: count)))
    }
  }

  func testOnlyCompleteAcknowledgedChunkAdvances() throws {
    XCTAssertNoThrow(try response(1, 0, 4096).validateCopied(length: 4096))
    for values: (UInt32, UInt32, UInt32) in [
      (0, 0, 4096), (2, 0, 4096), (1, 1, 4096), (1, 0, 4095),
    ] {
      XCTAssertThrowsError(try response(values.0, values.1, values.2).validateCopied(length: 4096))
    }
  }
}
