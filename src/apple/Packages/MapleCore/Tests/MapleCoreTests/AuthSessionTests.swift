import Security
import XCTest
@testable import MapleCore

/// Covers the offline-tolerant bootstrap matrix introduced to stop the
/// app forcing the sign-in sheet whenever a cold-start /api/auth/me
/// failed. Each test pins down one cell of the matrix: which error
/// types preserve the cached user, which trigger refresh, which clear
/// tokens entirely.
@MainActor
final class AuthSessionTests: XCTestCase {
  private let server = URL(string: "https://authsession-test.invalid:8443")!
  private let tokens = AuthTokens(access: "A1", refresh: "R1")
  private let cachedUser = AuthUser(id: "u-cached", email: "cached@x", role: "member")
  private let freshUser  = AuthUser(id: "u-fresh",  email: "fresh@x",  role: "member")

  override func setUp() async throws {
    StubURLProtocol.register()
    StubURLProtocol.reset()
    TokenStore.clear(server: server)
    AuthUserCache.clear(server: server)
  }

  override func tearDown() async throws {
    StubURLProtocol.reset()
    TokenStore.clear(server: server)
    AuthUserCache.clear(server: server)
  }

  private func makeSession() -> AuthSession {
    let client = AuthClient(server: server, urlSession: TestURLSession.make())
    return AuthSession(server: server, client: client)
  }

  /// Wrap `TokenStore.save` so the SPM test target — which lacks the
  /// keychain entitlement on developer machines — skips instead of
  /// failing with `errSecMissingEntitlement` (-34018). Mirrors the
  /// pattern in `SMBCredentialStoreTests.testSaveAndFetch`. On a CI
  /// runner with entitlements this just performs the save normally.
  /// Narrowed catch: only the entitlement-missing case becomes
  /// `XCTSkip`; any other error (unexpected OSStatus, decode failure,
  /// etc.) propagates so the test fails with real signal.
  private func saveTokensOrSkip(_ tokens: AuthTokens) throws {
    do {
      try TokenStore.save(tokens, server: server)
    } catch let nsErr as NSError
      where nsErr.domain == "TokenStore" && nsErr.code == Int(errSecMissingEntitlement) {
      throw XCTSkip("Keychain entitlement not granted: \(nsErr)")
    }
  }

  /// Wrap `TokenStore.load` for the same reason — see `saveTokensOrSkip`.
  private func loadTokensOrSkip() throws -> AuthTokens? {
    do {
      return try TokenStore.load(server: server)
    } catch let nsErr as NSError
      where nsErr.domain == "TokenStore" && nsErr.code == Int(errSecMissingEntitlement) {
      throw XCTSkip("Keychain entitlement not granted: \(nsErr)")
    }
  }

  // MARK: - init / hydration

  func testInit_noTokens_isSignedOut() {
    let s = makeSession()
    XCTAssertFalse(s.isSignedIn)
    XCTAssertFalse(s.hasCredentials)
    XCTAssertNil(s.user)
  }

  func testInit_tokensAndCache_isSignedInWithUser() throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    let s = makeSession()
    XCTAssertTrue(s.isSignedIn)
    XCTAssertTrue(s.hasCredentials)
    XCTAssertEqual(s.user, cachedUser)
  }

  /// The upgrade case Copilot flagged: a user on a build prior to
  /// AuthUserCache has Keychain tokens but no cache file. Without the
  /// hasCredentials flag, the first cold-offline launch after upgrade
  /// would still flash the sign-in sheet. With it, `isSignedIn` is
  /// true and `user` fills in once /me succeeds.
  func testInit_tokensButNoCache_signedInWithoutUser() throws {
    try saveTokensOrSkip(tokens)
    let s = makeSession()
    XCTAssertTrue(s.isSignedIn)
    XCTAssertTrue(s.hasCredentials)
    XCTAssertNil(s.user)
  }

  // MARK: - bootstrap success

  func testBootstrap_meSucceeds_populatesUserAndCache() async throws {
    try saveTokensOrSkip(tokens)
    StubURLProtocol.responder = { req in
      XCTAssertEqual(req.url?.path, "/api/auth/me")
      return .http(status: 200, body: Self.meBody(user: self.freshUser))
    }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertEqual(s.user, freshUser)
    XCTAssertTrue(s.hasCredentials)
    XCTAssertEqual(AuthUserCache.load(server: server), freshUser)
  }

  // MARK: - bootstrap transient failures (cached state preserved)

  func testBootstrap_networkFailure_preservesCachedState() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { _ in .failure(URLError(.notConnectedToInternet)) }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertEqual(s.user, cachedUser, "offline /me must NOT wipe the cached user")
    XCTAssertTrue(s.hasCredentials, "offline /me must NOT clear the Keychain")
    XCTAssertNotNil(try loadTokensOrSkip())
  }

  func testBootstrap_5xx_preservesCachedState() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { _ in .http(status: 503, body: Data("down".utf8)) }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertEqual(s.user, cachedUser)
    XCTAssertTrue(s.hasCredentials)
    XCTAssertNotNil(try loadTokensOrSkip())
  }

  func testBootstrap_decodeFailure_preservesCachedState() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { _ in .http(status: 200, body: Data("not-json".utf8)) }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertEqual(s.user, cachedUser)
    XCTAssertTrue(s.hasCredentials)
  }

  // MARK: - bootstrap auth failures (refresh path)

  func testBootstrap_meReturns401_refreshSucceeds_updatesUser() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    let freshTokens = AuthTokens(access: "A2", refresh: "R2")
    StubURLProtocol.responder = { req in
      switch req.url?.path {
      case "/api/auth/me":
        let auth = req.value(forHTTPHeaderField: "Authorization")
        if auth == "Bearer A1" { return .http(status: 401, body: Data()) }
        if auth == "Bearer A2" { return .http(status: 200, body: Self.meBody(user: self.freshUser)) }
        return .http(status: 500, body: Data())
      case "/api/auth/refresh":
        return .http(status: 200, body: Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8))
      default:
        return .http(status: 404, body: Data())
      }
    }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertEqual(s.user, freshUser)
    XCTAssertTrue(s.hasCredentials)
    XCTAssertEqual(try loadTokensOrSkip(), freshTokens)
  }

  func testBootstrap_meReturns401_refreshAlso401_clearsEverything() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { req in
      return .http(status: 401, body: Data())
    }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertNil(s.user)
    XCTAssertFalse(s.hasCredentials)
    XCTAssertNil(try loadTokensOrSkip())
    XCTAssertNil(AuthUserCache.load(server: server))
  }

  /// The bug Copilot flagged: a 5xx on /api/auth/refresh used to fall
  /// through to the catch-all that cleared tokens. With the typed
  /// branch, 5xx during refresh now preserves credentials so the user
  /// can retry once the server recovers.
  func testBootstrap_meReturns401_refresh5xx_preservesTokens() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { req in
      if req.url?.path == "/api/auth/refresh" { return .http(status: 503, body: Data()) }
      return .http(status: 401, body: Data())
    }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertTrue(s.hasCredentials, "refresh 5xx must NOT clear the Keychain")
    XCTAssertNotNil(try loadTokensOrSkip())
    XCTAssertEqual(AuthUserCache.load(server: server), cachedUser)
  }

  func testBootstrap_meReturns401_refreshNetworkFailure_preservesTokens() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { req in
      if req.url?.path == "/api/auth/refresh" { return .failure(URLError(.timedOut)) }
      return .http(status: 401, body: Data())
    }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertTrue(s.hasCredentials)
    XCTAssertNotNil(try loadTokensOrSkip())
  }

  /// Regression: the previous combined `client.refresh()` did
  /// `/api/auth/refresh` followed by `/api/auth/me` inline and threw on
  /// the /me leg, which lost the rotated tokens — the server had
  /// invalidated the old refresh token but the new one was never
  /// persisted, so the next bootstrap got 401 and forced sign-in. The
  /// split `refreshTokens()` + separate /me path saves the rotation
  /// immediately; a /me failure after rotation is transient.
  func testBootstrap_refreshRotatesTokens_meAfterFails_persistsNewTokens() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    let freshTokens = AuthTokens(access: "A2", refresh: "R2")
    StubURLProtocol.responder = { req in
      switch req.url?.path {
      case "/api/auth/me":
        let auth = req.value(forHTTPHeaderField: "Authorization")
        if auth == "Bearer A1" { return .http(status: 401, body: Data()) }
        if auth == "Bearer A2" { return .http(status: 503, body: Data("transient".utf8)) }
        return .http(status: 500, body: Data())
      case "/api/auth/refresh":
        return .http(status: 200, body: Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8))
      default:
        return .http(status: 404, body: Data())
      }
    }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertEqual(try loadTokensOrSkip(), freshTokens,
                   "rotated tokens must be saved even when post-refresh /me fails")
    XCTAssertTrue(s.hasCredentials)
    // /me never returned a fresh user, so the cached one is the best
    // we have. Next bootstrap will fill it in.
    XCTAssertEqual(s.user, cachedUser)
  }

  func testBootstrap_meReturns403_refreshAlso403_clearsEverything() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { _ in .http(status: 403, body: Data()) }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertFalse(s.hasCredentials)
    XCTAssertNil(try loadTokensOrSkip())
  }

  // MARK: - forced sign-out (HTTP layer: live request 401 → refresh rejected)

  /// The desync bug: a live API request 401s and its token refresh is
  /// rejected (refresh token expired/revoked). The HTTP layer must drive the
  /// observable AuthSession to signed-out — not just clear the Keychain.
  /// Clearing only the Keychain (the old `onSignOut` behavior) left
  /// `isSignedIn` stuck true, so the very next request fired with no bearer
  /// ("missing bearer") and the sidebar never offered a way back in.
  func testHandleAuthExpired_clearsCredentialsAndFlipsSignedIn() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    let s = makeSession()
    XCTAssertTrue(s.isSignedIn, "precondition: a session with Keychain tokens is signed in")

    await s.handleAuthExpired()

    XCTAssertFalse(s.isSignedIn, "a rejected refresh must flip the observable session to signed-out")
    XCTAssertFalse(s.hasCredentials)
    XCTAssertNil(s.user)
    XCTAssertNil(try loadTokensOrSkip(), "forced sign-out must clear the Keychain")
    XCTAssertNil(AuthUserCache.load(server: server))
  }

  /// Entitlement-free coverage of the core flip: seeds the signed-in state
  /// via the preview constructor (no Keychain), so it actually RUNS on dev
  /// machines that lack the keychain entitlement — where the token-seeded
  /// tests above skip. `clearLocalCredentials` is test-safe here:
  /// `TokenStore.clear` of an absent entry is a no-op, and the File Provider
  /// token mirror early-returns when no domain is configured for the server.
  func testHandleAuthExpired_flipsPreviewSignedInToSignedOut() async {
    let s = AuthSession.preview(state: .signedInOwner, server: server)
    XCTAssertTrue(s.isSignedIn, "precondition: preview owner session is signed in")
    await s.handleAuthExpired()
    XCTAssertFalse(s.isSignedIn, "handleAuthExpired must flip isSignedIn to false")
    XCTAssertFalse(s.hasCredentials)
    XCTAssertNil(s.user)
  }

  /// Unlike `signOut()`, a forced expiry must NOT POST to `/api/auth/logout`
  /// — the tokens are already dead, so there's nothing to revoke server-side
  /// and a network round-trip would only delay clearing the UI state.
  func testHandleAuthExpired_doesNotCallServerLogout() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    var sawLogout = false
    StubURLProtocol.responder = { req in
      if req.url?.path == "/api/auth/logout" { sawLogout = true }
      return .http(status: 200, body: Data("{}".utf8))
    }
    let s = makeSession()
    await s.handleAuthExpired()
    XCTAssertFalse(sawLogout, "forced expiry must not hit the logout endpoint")
    XCTAssertFalse(s.isSignedIn)
  }

  /// End-to-end of the desync, wired the way `AppShell.makeAuthenticatedHTTPClient`
  /// wires it: route the client's `onSignOut` into `handleAuthExpired`. A request
  /// whose access token is dead AND whose refresh is rejected must leave the
  /// session signed-out (so no follow-up request fires tokenless).
  func testHTTPClientRefreshRejected_drivesSessionSignedOut() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    let s = makeSession()
    StubURLProtocol.responder = { _ in .http(status: 401, body: Data()) }

    let signedOut = expectation(description: "session forced signed-out")
    let testServer = server
    let http = AuthenticatedHTTPClient(
      server: testServer,
      urlSession: TestURLSession.make(),
      tokensProvider: { try? TokenStore.load(server: testServer) },
      onTokensRefreshed: { try? TokenStore.save($0, server: testServer) },
      onSignOut: {
        Task { @MainActor in
          await s.handleAuthExpired()
          signedOut.fulfill()
        }
      }
    )
    _ = try? await http.data(for: URLRequest(url: testServer.appending(path: "/api/folders")))
    await fulfillment(of: [signedOut], timeout: 2)
    XCTAssertFalse(s.isSignedIn, "after a rejected refresh the session must be signed-out")
  }

  // MARK: - signOut

  func testSignOut_clearsTokensCacheAndUser() async throws {
    try saveTokensOrSkip(tokens)
    AuthUserCache.save(cachedUser, server: server)
    // Logout endpoint just needs to not 5xx; AuthSession ignores its
    // result either way.
    StubURLProtocol.responder = { _ in .http(status: 200, body: Data("{}".utf8)) }
    let s = makeSession()
    await s.signOut()
    XCTAssertNil(s.user)
    XCTAssertFalse(s.hasCredentials)
    XCTAssertNil(try loadTokensOrSkip())
    XCTAssertNil(AuthUserCache.load(server: server))
  }

  // MARK: - helpers

  private static func meBody(user: AuthUser) -> Data {
    let json = #"{"user":{"id":"\#(user.id)","email":"\#(user.email)","role":"\#(user.role)"},"credentials":[]}"#
    return Data(json.utf8)
  }
}
