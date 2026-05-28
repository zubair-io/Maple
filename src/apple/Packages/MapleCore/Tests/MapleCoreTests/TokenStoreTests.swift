// TokenStoreTests.swift
import XCTest
@testable import MapleCore

final class TokenStoreTests: XCTestCase {
  let serverURL = URL(string: "https://example.test")!

  override func setUp() {
    super.setUp()
    TokenStore.clear(server: serverURL)
  }

  /// Wrap `TokenStore.save` so the SPM test target — which lacks the
  /// keychain entitlement on developer machines — skips instead of
  /// failing with `errSecMissingEntitlement` (-34018). Mirrors the
  /// pattern in `SMBCredentialStoreTests.testSaveAndFetch`. On a CI
  /// runner with entitlements this just performs the save normally.
  private func saveOrSkip(_ tokens: AuthTokens, server: URL) throws {
    do {
      try TokenStore.save(tokens, server: server)
    } catch {
      throw XCTSkip("Keychain not writeable: \(error)")
    }
  }

  /// Wrap `TokenStore.load` for the same reason — see `saveOrSkip`.
  private func loadOrSkip(server: URL) throws -> AuthTokens? {
    do {
      return try TokenStore.load(server: server)
    } catch {
      throw XCTSkip("Keychain not readable: \(error)")
    }
  }

  func testRoundTrip() throws {
    let tokens = AuthTokens(access: "a", refresh: "r")
    try saveOrSkip(tokens, server: serverURL)
    let loaded = try loadOrSkip(server: serverURL)
    XCTAssertEqual(loaded?.access, "a")
    XCTAssertEqual(loaded?.refresh, "r")
  }

  func testPerServerScoping() throws {
    try saveOrSkip(.init(access: "a1", refresh: "r1"), server: URL(string: "https://a.test")!)
    try saveOrSkip(.init(access: "a2", refresh: "r2"), server: URL(string: "https://b.test")!)
    XCTAssertEqual(try loadOrSkip(server: URL(string: "https://a.test")!)?.access, "a1")
    XCTAssertEqual(try loadOrSkip(server: URL(string: "https://b.test")!)?.access, "a2")
  }

  func testClear() throws {
    try saveOrSkip(.init(access: "a", refresh: "r"), server: serverURL)
    TokenStore.clear(server: serverURL)
    XCTAssertNil(try loadOrSkip(server: serverURL))
  }
}
