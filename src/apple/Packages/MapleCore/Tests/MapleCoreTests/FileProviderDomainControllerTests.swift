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
}
