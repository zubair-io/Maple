import Foundation
import XCTest

@testable import Maple

final class InviteQRTests: XCTestCase {
  func testRoundTripUsesOnlyServerAndCode() throws {
    let server = try XCTUnwrap(URL(string: "https://maple.example"))
    let payload = buildInvitePayload(server: server, code: "ABCD2345")
    XCTAssertFalse(payload.contains("email="))
    XCTAssertEqual(parseInviteQR(payload), InviteQR(server: server, code: "ABCD2345"))
  }

  func testDuplicateFieldsAreRejectedWithoutCrashing() throws {
    let server = try XCTUnwrap(URL(string: "https://maple.example"))
    let payload = buildInvitePayload(server: server, code: "ABCD2345")
    XCTAssertNil(parseInviteQR(payload + "&code=EFGH2345"))
    XCTAssertNil(parseInviteQR(payload + "&server=duplicate"))
  }

  func testUnsupportedServersAndMalformedCodesAreRejected() throws {
    for value in ["file:///etc/passwd", "https://user:password@maple.example"] {
      let server = try XCTUnwrap(URL(string: value))
      XCTAssertNil(parseInviteQR(buildInvitePayload(server: server, code: "ABCD2345")))
    }
    let server = try XCTUnwrap(URL(string: "https://maple.example"))
    XCTAssertNil(parseInviteQR(buildInvitePayload(server: server, code: "ABCD0123")))
    XCTAssertNil(parseInviteQR(buildInvitePayload(server: server, code: "SHORT")))
  }
}
