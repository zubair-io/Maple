import XCTest

@testable import MapleCore

final class SSELineDecoderTests: XCTestCase {
  func testPreservesEventBoundariesWithEverySSELineEnding() {
    for ending in ["\n", "\r\n", "\r"] {
      let wire = [": keepalive", "", "id: 4", "data: first", "data: second", "", ""]
        .joined(separator: ending)
      XCTAssertEqual(
        decode(wire), [": keepalive", "", "id: 4", "data: first", "data: second", ""])
    }
  }

  func testKeepsUTF8AcrossIndividualBytesAndRemovesOnlyLeadingBOM() {
    XCTAssertEqual(
      decode("\u{FEFF}data: /写真/été.dng\n\ndata: \u{FEFF}retained\n\n"),
      ["data: /写真/été.dng", "", "data: \u{FEFF}retained", ""])
  }

  func testUnterminatedEventDoesNotAcquireAnEndBoundary() {
    XCTAssertEqual(decode("id: 4\ndata: incomplete"), ["id: 4"])
  }

  private func decode(_ wire: String) -> [String] {
    var decoder = SSELineDecoder()
    return wire.utf8.compactMap { decoder.append($0) }
  }
}
