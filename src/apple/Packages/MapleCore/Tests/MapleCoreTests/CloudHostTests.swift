// CloudHostTests.swift
import XCTest
@testable import MapleCore

final class CloudHostTests: XCTestCase {
  func test_bareDomain_addsHttps() {
    XCTAssertEqual(CloudHost.parse("myserver.com")?.url.absoluteString,
                   "https://myserver.com")
  }
  func test_explicitHttps_preserved() {
    XCTAssertEqual(CloudHost.parse("https://maple.example")?.url.absoluteString,
                   "https://maple.example")
  }
  func test_explicitHttp_preserved() {
    XCTAssertEqual(CloudHost.parse("http://localhost:3000")?.url.absoluteString,
                   "http://localhost:3000")
  }
  func test_whitespace_trimmed() {
    XCTAssertEqual(CloudHost.parse("  myserver.com  ")?.url.absoluteString,
                   "https://myserver.com")
  }
  func test_uppercase_lowercased() {
    XCTAssertEqual(CloudHost.parse("Maple.Example")?.url.absoluteString,
                   "https://maple.example")
  }
  func test_trailingSlash_stripped() {
    XCTAssertEqual(CloudHost.parse("myserver.com/")?.url.absoluteString,
                   "https://myserver.com")
  }
  func test_emptyString_isNil() {
    XCTAssertNil(CloudHost.parse(""))
  }
  func test_whitespaceOnly_isNil() {
    XCTAssertNil(CloudHost.parse("   "))
  }
  func test_pathInInput_isNil() {
    XCTAssertNil(CloudHost.parse("myserver.com/api/auth"))
  }
  func test_displayHost_stripsScheme() {
    XCTAssertEqual(CloudHost.parse("https://maple.example")?.displayHost,
                   "maple.example")
  }
}
