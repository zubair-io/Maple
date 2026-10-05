// TokenStoreTests.swift
import Security
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
  /// Narrowed catch: only the entitlement-missing case becomes
  /// `XCTSkip`; any other error (unexpected OSStatus, etc.) propagates
  /// so the test fails with real signal.
  private func saveOrSkip(_ tokens: AuthTokens, server: URL) throws {
    do {
      try TokenStore.save(tokens, server: server)
    } catch let nsErr as NSError
      where nsErr.domain == "TokenStore" && nsErr.code == Int(errSecMissingEntitlement)
    {
      throw XCTSkip("Keychain entitlement not granted: \(nsErr)")
    }
  }

  /// Wrap `TokenStore.load` for the same reason — see `saveOrSkip`.
  private func loadOrSkip(server: URL) throws -> AuthTokens? {
    do {
      return try TokenStore.load(server: server)
    } catch let nsErr as NSError
      where nsErr.domain == "TokenStore" && nsErr.code == Int(errSecMissingEntitlement)
    {
      throw XCTSkip("Keychain entitlement not granted: \(nsErr)")
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

  #if os(macOS)
    func testMCPTokenPersistsAcrossStoreInstances() async throws {
      try await withMCPKeychain { service in
        let token = try await AgentMCPTokenStore(service: service).loadOrCreate()
        XCTAssertEqual(token.utf8.count, 64)
        XCTAssertTrue(token.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) })
        let reloaded = try await AgentMCPTokenStore(service: service).loadOrCreate()
        XCTAssertEqual(reloaded, token)
      }
    }

    func testMCPTokenReplacesMalformedKeychainItems() async throws {
      for seed in [Data(), Data("short".utf8), Data(repeating: 65, count: 64), Data([0xff])] {
        try await withMCPKeychain(seed: seed) { service in
          let token = try await AgentMCPTokenStore(service: service).loadOrCreate()
          XCTAssertEqual(token.utf8.count, 64)
          XCTAssertTrue(token.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) })
          let reloaded = try await AgentMCPTokenStore(service: service).loadOrCreate()
          XCTAssertEqual(reloaded, token, "The replacement must persist to the real Keychain")
        }
      }
    }

    private func withMCPKeychain(
      seed: Data? = nil, _ body: (String) async throws -> Void
    ) async throws {
      let service = "app.justmaple.tests.mcp.\(UUID().uuidString)"
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: "localhost",
      ]
      defer { SecItemDelete(query as CFDictionary) }
      do {
        if let seed {
          var insertion = query
          insertion[kSecValueData as String] = seed
          let status = SecItemAdd(insertion as CFDictionary, nil)
          guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
          }
        }
        try await body(service)
      } catch let error as NSError
        where error.domain == NSOSStatusErrorDomain && error.code == Int(errSecMissingEntitlement)
      {
        throw XCTSkip("Keychain entitlement not granted: \(error)")
      }
    }
  #endif
}
