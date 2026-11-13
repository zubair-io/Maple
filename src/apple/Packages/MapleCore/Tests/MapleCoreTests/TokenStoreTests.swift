// TokenStoreTests.swift
import Security
import XCTest

@testable import MapleCloudKit
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

  func testClearAndSaveWaitForRefreshLockRelease() async throws {
    let server = URL(string: "https://lock-serialize-\(UUID().uuidString).test")!
    let lockEntered = expectation(description: "refresh lock held")
    let clearStarted = expectation(description: "clear task started")
    let saveStarted = expectation(description: "save task started")

    actor OrderRecorder {
      var events: [String] = []
      func append(_ event: String) { events.append(event) }
      func snapshot() -> [String] { events }
    }
    let recorder = OrderRecorder()

    let holder = Task {
      try await TokenStore.withRefreshLock(server: server) {
        lockEntered.fulfill()
        await fulfillment(of: [clearStarted, saveStarted], timeout: 2.0)
        // Give the contending writers time to hit flock(LOCK_EX | LOCK_NB) and sleep.
        try await Task.sleep(nanoseconds: 120_000_000)
        await recorder.append("refresh-persisted")
      }
    }

    await fulfillment(of: [lockEntered], timeout: 2.0)

    let clearer = Task.detached {
      clearStarted.fulfill()
      TokenStore.clear(server: server)
      await recorder.append("clear-completed")
    }

    let saver = Task.detached {
      saveStarted.fulfill()
      try? TokenStore.save(AuthTokens(access: "A", refresh: "R"), server: server)
      await recorder.append("save-completed")
    }

    try await holder.value
    await clearer.value
    await saver.value

    let events = await recorder.snapshot()
    XCTAssertEqual(events.first, "refresh-persisted")
    XCTAssertEqual(events.count, 3)
  }

  func testWithRefreshLockAllowsReentrantSaveAndClearOnSameTask() async throws {
    let server = URL(string: "https://lock-reentrant-\(UUID().uuidString).test")!
    var innerCompleted = false
    try await TokenStore.withRefreshLock(server: server) {
      TokenStore.clear(server: server)
      do {
        try TokenStore.save(AuthTokens(access: "A", refresh: "R"), server: server)
      } catch let nsErr as NSError
        where nsErr.domain == "TokenStore" && nsErr.code == Int(errSecMissingEntitlement)
      {
        // Expected on unentitled SPM test runners; the lock path already ran.
      }
      innerCompleted = true
    }
    XCTAssertTrue(innerCompleted)
  }

  #if canImport(Darwin)
    func testClearFallbackWhenLockDescriptorCannotBeOpened() async throws {
      let server = URL(string: "https://lock-broken-\(UUID().uuidString).test")!
      let lockDir = FileManager.default.temporaryDirectory
        .appendingPathComponent("AuthLocks", isDirectory: true)
        .appendingPathComponent("\(TokenStore.stableServerHash(server)).lock", isDirectory: true)
      try FileManager.default.createDirectory(at: lockDir, withIntermediateDirectories: true)
      defer {
        TokenStore.clearUnlockedObserverForTesting = nil
        try? FileManager.default.removeItem(at: lockDir)
      }

      let countLock = NSLock()
      nonisolated(unsafe) var clearCount = 0
      TokenStore.clearUnlockedObserverForTesting = { clearedServer in
        guard clearedServer == server else { return }
        countLock.lock()
        clearCount += 1
        countLock.unlock()
      }

      // `save` refuses to proceed when the lock file cannot be opened (EISDIR).
      XCTAssertThrowsError(
        try TokenStore.save(AuthTokens(access: "A", refresh: "R"), server: server))
      // `clear`, `clearAsync`, and `tryClearWithoutBlocking` must still execute
      // `clearUnlocked` rather than swallowing the lock error and skipping deletion.
      XCTAssertTrue(TokenStore.tryClearWithoutBlocking(server: server))
      TokenStore.clear(server: server)
      await TokenStore.clearAsync(server: server)
      XCTAssertEqual(clearCount, 3)
    }

    func testAsyncWritersYieldMainActorWhileWaitingForLock() async throws {
      let server = URL(string: "https://lock-mainactor-\(UUID().uuidString).test")!
      let lockHeld = expectation(description: "lock held")
      let asyncWaiterStarted = expectation(description: "async waiter started on MainActor")
      let mainActorProbeRan = expectation(description: "MainActor remained responsive")

      let holder = Task.detached {
        try await TokenStore.withRefreshLock(server: server) {
          lockHeld.fulfill()
          await self.fulfillment(of: [mainActorProbeRan], timeout: 2.0)
        }
      }

      await fulfillment(of: [lockHeld], timeout: 2.0)

      // Non-blocking helpers must return false immediately while the lock is held.
      XCTAssertFalse(
        try TokenStore.trySaveWithoutBlocking(AuthTokens(access: "A", refresh: "R"), server: server)
      )
      XCTAssertFalse(TokenStore.tryClearWithoutBlocking(server: server))

      let waiter = Task { @MainActor in
        asyncWaiterStarted.fulfill()
        await TokenStore.clearAsync(server: server)
      }

      await fulfillment(of: [asyncWaiterStarted], timeout: 2.0)

      let probe = Task { @MainActor in
        mainActorProbeRan.fulfill()
      }
      await probe.value

      try await holder.value
      await waiter.value
    }

    @MainActor
    func testDeferredRemoveClearIsCancelledWhenServerIsReAdded() async throws {
      let server = URL(string: "https://lock-readd-\(UUID().uuidString).test")!
      let suiteName = "TokenStoreReAddTests.\(UUID().uuidString)"
      let defaults = UserDefaults(suiteName: suiteName)!
      defer {
        TokenStore.clearUnlockedObserverForTesting = nil
        defaults.removePersistentDomain(forName: suiteName)
      }
      let registry = CloudServerRegistry(defaults: defaults)
      registry.register(server)

      let countLock = NSLock()
      nonisolated(unsafe) var clearCount = 0
      TokenStore.clearUnlockedObserverForTesting = { clearedServer in
        guard clearedServer == server else { return }
        countLock.lock()
        clearCount += 1
        countLock.unlock()
      }

      let lockHeld = expectation(description: "lock held")
      let allowRelease = expectation(description: "allow lock release")
      let holder = Task.detached {
        try await TokenStore.withRefreshLock(server: server) {
          lockHeld.fulfill()
          await self.fulfillment(of: [allowRelease], timeout: 2.0)
        }
      }
      await fulfillment(of: [lockHeld], timeout: 2.0)

      // Remove while the refresh lock is held (spawns a deferred clear task),
      // then re-add the same server URL before the lock is released.
      registry.remove(server)
      registry.register(server)
      allowRelease.fulfill()
      try await holder.value
      try await Task.sleep(nanoseconds: 120_000_000)

      XCTAssertEqual(
        clearCount, 0,
        "deferred clear from remove(_:) must be cancelled/invalidated when the server is re-added"
      )
    }
  #endif
}
