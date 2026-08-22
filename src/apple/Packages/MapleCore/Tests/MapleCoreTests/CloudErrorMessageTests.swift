// CloudErrorMessageTests.swift — non-2xx bodies become human-readable
// messages; a Cloudflare 502's HTML error page must never reach a banner.
import XCTest
@testable import MapleCloudKit
final class CloudErrorMessageTests: XCTestCase {
  func test_htmlBody_collapsesToStatusLine() {
    let html = Data("<!DOCTYPE html><html><title>502: Bad gateway</title>…".utf8)
    XCTAssertEqual(
      cloudErrorMessage(status: 502, data: html),
      "Server temporarily unavailable (502). Try again in a moment."
    )
  }

  func test_shortJSONBody_passesThrough() {
    let body = Data(#"{"error":"bad libraryId"}"#.utf8)
    XCTAssertEqual(cloudErrorMessage(status: 400, data: body), #"{"error":"bad libraryId"}"#)
  }

  func test_emptyBody_reportsStatus() {
    XCTAssertEqual(cloudErrorMessage(status: 500, data: Data()), "Server error (500).")
  }
}
