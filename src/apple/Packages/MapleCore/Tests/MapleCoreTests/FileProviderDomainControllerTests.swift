// FileProviderDomainControllerTests.swift
//
// Covers the auth-token gate added to `enable()` for #2540: enabling a
// domain for a server with no usable auth token must fail fast with a
// distinct, meaningful error — not silently register an unauthenticated
// domain and report success.
import Security
import XCTest
@testable import MapleCore

final class FileProviderDomainControllerTests: XCTestCase {

  private func tempConfig() -> FileProviderConfig {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("fp-domain-controller-test-\(UUID().uuidString)", isDirectory: true)
    return FileProviderConfig(directory: tmp)
  }

  /// Mirrors `TokenStoreTests.saveOrSkip` — the SPM test target lacks the
  /// keychain entitlement on developer machines, so a save that fails with
  /// `errSecMissingEntitlement` becomes a skip rather than a hard failure.
  private func saveTokenOrSkip(_ tokens: AuthTokens, server: URL) throws {
    do {
      try TokenStore.save(tokens, server: server)
    } catch let nsErr as NSError
      where nsErr.domain == "TokenStore" && nsErr.code == Int(errSecMissingEntitlement) {
      throw XCTSkip("Keychain entitlement not granted: \(nsErr)")
    }
  }

  /// No token stored for the server at all: `enable()` must throw
  /// `.noAuthToken` before it ever persists config or reaches
  /// `NSFileProviderManager.add` — so this doesn't need FP entitlements to
  /// run reliably.
  func testEnableFailsFastWhenNoTokenExists() async throws {
    let server = URL(string: "https://fp-domain-test-no-token-\(UUID().uuidString).invalid")!
    TokenStore.clear(server: server)
    let config = tempConfig()
    let controller = FileProviderDomainController(config: config)

    do {
      _ = try await controller.enable(serverURL: server, displayName: "No Token Server")
      XCTFail("enable() must not succeed without a usable auth token")
    } catch FileProviderDomainController.EnableError.noAuthToken {
      // expected
    }

    // The gate must fire before any partial state is persisted.
    let domainID = try XCTUnwrap(FileProviderDomainController.domainIdentifier(for: server))
    XCTAssertNil(config.load(domain: domainID), "no config should be written when the token gate rejects enable()")
  }

  /// A token with an empty access string is not usable — must be treated
  /// the same as "no token".
  func testEnableFailsFastWhenTokenHasEmptyAccessString() async throws {
    let server = URL(string: "https://fp-domain-test-empty-token-\(UUID().uuidString).invalid")!
    try saveTokenOrSkip(.init(access: "", refresh: "r"), server: server)
    defer { TokenStore.clear(server: server) }
    let controller = FileProviderDomainController(config: tempConfig())

    do {
      _ = try await controller.enable(serverURL: server, displayName: "Empty Token Server")
      XCTFail("enable() must not succeed with an empty access token")
    } catch FileProviderDomainController.EnableError.noAuthToken {
      // expected
    }
  }

  /// With a usable token present, `enable()` must get past the auth gate —
  /// any failure past that point is the OS-side `NSFileProviderManager.add`
  /// call, which needs real FP entitlements and is allowed to fail/skip on
  /// a bare dev box (mirrors `FileProviderMountTests`).
  func testEnableProceedsPastTheAuthGateWhenATokenExists() async throws {
    let server = URL(string: "https://fp-domain-test-with-token-\(UUID().uuidString).invalid")!
    try saveTokenOrSkip(.init(access: "access-token", refresh: "refresh-token"), server: server)
    defer { TokenStore.clear(server: server) }
    let controller = FileProviderDomainController(config: tempConfig())

    do {
      _ = try await controller.enable(serverURL: server, displayName: "Authed Server")
    } catch FileProviderDomainController.EnableError.noAuthToken {
      XCTFail("enable() must not gate on missing token when a usable token is present")
    } catch {
      // NSFileProviderManager.add failing in a bare SPM test sandbox is
      // expected and not what this test is about.
    }
  }

  /// A meaningful, user-facing message backs the new error case — the
  /// Settings UI surfaces `error.localizedDescription` verbatim (see
  /// `FileProviderSettingsModel.enable`), so a generic
  /// "operation couldn't be completed" string would silently regress #2540.
  func testNoAuthTokenErrorHasAMeaningfulDescription() {
    let description = FileProviderDomainController.EnableError.noAuthToken.errorDescription
    XCTAssertNotNil(description)
    XCTAssertFalse(description?.isEmpty ?? true)
  }

  // MARK: - #2544: scheme-aware domain identity

  /// The core bug: `http://host:port` and `https://host:port` must
  /// produce DIFFERENT domain identifiers. Before the fix, only host +
  /// port were considered, so a self-hosted server that later turns on
  /// TLS silently reused the prior (now-wrong-protocol) domain and its
  /// stale cached state instead of getting a clean new identity.
  func testDomainIdentifierDiffersByScheme() throws {
    let http = try XCTUnwrap(URL(string: "http://maple.local:8080"))
    let https = try XCTUnwrap(URL(string: "https://maple.local:8080"))
    let httpID = try XCTUnwrap(FileProviderDomainController.domainIdentifier(for: http))
    let httpsID = try XCTUnwrap(FileProviderDomainController.domainIdentifier(for: https))
    XCTAssertNotEqual(httpID, httpsID,
                      "http and https on the same host:port must not collide on one FP domain")
  }

  /// Same URL, same scheme, called twice — the identifier must be
  /// stable so `enable()` / `reconcile()` / `FileProviderMount.domain(forServer:)`
  /// all agree on the same domain across calls.
  func testDomainIdentifierIsStableForTheSameURL() throws {
    let url = try XCTUnwrap(URL(string: "https://maple.local:8080"))
    let first = FileProviderDomainController.domainIdentifier(for: url)
    let second = FileProviderDomainController.domainIdentifier(for: url)
    XCTAssertEqual(first, second)
  }

  /// A URL with no explicit port must still differ by scheme (the port
  /// branch isn't the only place scheme needs to be folded in).
  func testDomainIdentifierDiffersBySchemeWithoutExplicitPort() throws {
    let http = try XCTUnwrap(URL(string: "http://maple.local"))
    let https = try XCTUnwrap(URL(string: "https://maple.local"))
    let httpID = try XCTUnwrap(FileProviderDomainController.domainIdentifier(for: http))
    let httpsID = try XCTUnwrap(FileProviderDomainController.domainIdentifier(for: https))
    XCTAssertNotEqual(httpID, httpsID)
  }

  /// Two genuinely different servers (different host) must never
  /// collide, scheme aside — a basic sanity check that the scheme
  /// change didn't accidentally coarsen the identifier in some other
  /// way (e.g. dropping the port).
  func testDomainIdentifierStillDiffersByHostAndPort() throws {
    let a = try XCTUnwrap(URL(string: "https://maple.local:3000"))
    let b = try XCTUnwrap(URL(string: "https://maple.local:4000"))
    let c = try XCTUnwrap(URL(string: "https://other.local:3000"))
    let idA = FileProviderDomainController.domainIdentifier(for: a)
    let idB = FileProviderDomainController.domainIdentifier(for: b)
    let idC = FileProviderDomainController.domainIdentifier(for: c)
    XCTAssertNotEqual(idA, idB)
    XCTAssertNotEqual(idA, idC)
  }

  /// The migration invariant, exercised on the "migration can't
  /// complete yet" branch: an already-installed domain, registered
  /// under the pre-#2544 scheme-blind identifier, must never be
  /// silently dropped by `reconcile()` just because the identifier
  /// algorithm changed underneath it. No token is saved for this
  /// server (deliberately — unlike `saveTokenOrSkip`'s callers, this
  /// doesn't need Keychain write access and so isn't skipped on a
  /// bare dev sandbox), so `enable()`'s existing #2540 token gate
  /// deterministically fails inside the migration attempt. The legacy
  /// config must survive that failure untouched — proving `reconcile()`
  /// only tears down the legacy id once the new one is confirmed
  /// installed, never speculatively.
  func testReconcileLeavesLegacyDomainInPlaceWhenMigrationCannotCompleteYet() async throws {
    let server = try XCTUnwrap(URL(string: "https://fp-domain-test-migrate-\(UUID().uuidString).invalid:8443"))
    TokenStore.clear(server: server)

    let config = tempConfig()
    // Simulate a domain that was installed before #2544, under the old
    // scheme-blind identifier for this same host:port.
    let legacyID = try XCTUnwrap(Self.legacyDomainIdentifierForTesting(server))
    let newID = try XCTUnwrap(FileProviderDomainController.domainIdentifier(for: server))
    XCTAssertNotEqual(legacyID, newID, "test setup assumes the legacy and new ids actually differ")
    config.save(.init(domainIdentifier: legacyID, displayName: "Migrate Me", serverURL: server))

    let controller = FileProviderDomainController(config: config)
    _ = await controller.reconcile(validServerURLs: [server])

    XCTAssertNotNil(config.load(domain: legacyID),
                    "a migration that can't complete (no token yet) must leave the legacy domain's "
                    + "config in place, not delete the user's only surviving File Sync state")
    XCTAssertNil(config.load(domain: newID),
                "no new config should appear when enable() never succeeded")
  }

  /// The migration invariant's happy path, gated behind the same
  /// Keychain-write caveat as `testEnableProceedsPastTheAuthGateWhenATokenExists`:
  /// with a usable token AND (on a machine with FP entitlements) a
  /// successful OS-level `enable()`, `reconcile()` must migrate the
  /// legacy domain forward rather than just deleting it — config for
  /// AT LEAST ONE of the two identifiers must survive; ending up with
  /// neither is exactly the silent-orphaning regression #2544 must not
  /// introduce.
  func testReconcileDoesNotOrphanAnAlreadyInstalledLegacyDomain() async throws {
    let server = try XCTUnwrap(URL(string: "https://fp-domain-test-migrate-\(UUID().uuidString).invalid:8443"))
    try saveTokenOrSkip(.init(access: "access-token", refresh: "refresh-token"), server: server)
    defer { TokenStore.clear(server: server) }

    let config = tempConfig()
    let legacyID = try XCTUnwrap(Self.legacyDomainIdentifierForTesting(server))
    let newID = try XCTUnwrap(FileProviderDomainController.domainIdentifier(for: server))
    XCTAssertNotEqual(legacyID, newID, "test setup assumes the legacy and new ids actually differ")
    config.save(.init(domainIdentifier: legacyID, displayName: "Migrate Me", serverURL: server))

    let controller = FileProviderDomainController(config: config)
    _ = await controller.reconcile(validServerURLs: [server])

    let legacySurvived = config.load(domain: legacyID) != nil
    let migrated = config.load(domain: newID) != nil
    XCTAssertTrue(legacySurvived || migrated,
                  "reconcile() must never end up with NEITHER the legacy nor the migrated config — "
                  + "that would silently disable File Sync for a still-connected server")
  }

  /// Local mirror of the pre-#2544 identifier algorithm (host + port,
  /// no scheme), used only to build the migration test's legacy
  /// fixture — the production algorithm this shadows now lives in
  /// `FileProviderDomainController` under a different (private) name.
  private static func legacyDomainIdentifierForTesting(_ serverURL: URL) -> String? {
    guard let host = serverURL.host, !host.isEmpty else { return nil }
    if let port = serverURL.port { return "\(host)-\(port)" }
    return host
  }
}
