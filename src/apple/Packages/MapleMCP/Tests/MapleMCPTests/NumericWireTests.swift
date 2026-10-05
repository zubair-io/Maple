import Foundation
import XCTest

@testable import MapleAgentWire

final class NumericWireTests: XCTestCase {
  func testJSONEncoderDoesNotNarrowHugeNumbersOrInt64Boundaries() throws {
    for value in [Double(Int64.max), Double(Int64.min), 1e100, -1e100] {
      let encoded = try JSONValue.number(value).encodedLine()
      XCTAssertEqual(try JSONValue.decode(encoded).numberValue, value)
    }
  }

}
