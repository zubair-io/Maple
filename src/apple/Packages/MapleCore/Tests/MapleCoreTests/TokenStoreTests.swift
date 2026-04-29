// TokenStoreTests.swift
import XCTest
@testable import MapleCore

final class TokenStoreTests: XCTestCase {
  let serverURL = URL(string: "https://example.test")!

  override func setUp() {
    super.setUp()
    TokenStore.clear(server: serverURL)
  }

  func testRoundTrip() throws {
    let tokens = AuthTokens(access: "a", refresh: "r")
    try TokenStore.save(tokens, server: serverURL)
    let loaded = try TokenStore.load(server: serverURL)
    XCTAssertEqual(loaded?.access, "a")
    XCTAssertEqual(loaded?.refresh, "r")
  }

  func testPerServerScoping() throws {
    try TokenStore.save(.init(access: "a1", refresh: "r1"), server: URL(string: "https://a.test")!)
    try TokenStore.save(.init(access: "a2", refresh: "r2"), server: URL(string: "https://b.test")!)
    XCTAssertEqual(try TokenStore.load(server: URL(string: "https://a.test")!)?.access, "a1")
    XCTAssertEqual(try TokenStore.load(server: URL(string: "https://b.test")!)?.access, "a2")
  }

  func testClear() throws {
    try TokenStore.save(.init(access: "a", refresh: "r"), server: serverURL)
    TokenStore.clear(server: serverURL)
    XCTAssertNil(try TokenStore.load(server: serverURL))
  }
}
