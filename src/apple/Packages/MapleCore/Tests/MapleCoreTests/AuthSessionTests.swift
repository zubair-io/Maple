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

  // MARK: - init / hydration

  func testInit_noTokens_isSignedOut() {
    let s = makeSession()
    XCTAssertFalse(s.isSignedIn)
    XCTAssertFalse(s.hasCredentials)
    XCTAssertNil(s.user)
  }

  func testInit_tokensAndCache_isSignedInWithUser() throws {
    try TokenStore.save(tokens, server: server)
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
    try TokenStore.save(tokens, server: server)
    let s = makeSession()
    XCTAssertTrue(s.isSignedIn)
    XCTAssertTrue(s.hasCredentials)
    XCTAssertNil(s.user)
  }

  // MARK: - bootstrap success

  func testBootstrap_meSucceeds_populatesUserAndCache() async throws {
    try TokenStore.save(tokens, server: server)
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
    try TokenStore.save(tokens, server: server)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { _ in .failure(URLError(.notConnectedToInternet)) }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertEqual(s.user, cachedUser, "offline /me must NOT wipe the cached user")
    XCTAssertTrue(s.hasCredentials, "offline /me must NOT clear the Keychain")
    XCTAssertNotNil(try TokenStore.load(server: server))
  }

  func testBootstrap_5xx_preservesCachedState() async throws {
    try TokenStore.save(tokens, server: server)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { _ in .http(status: 503, body: Data("down".utf8)) }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertEqual(s.user, cachedUser)
    XCTAssertTrue(s.hasCredentials)
    XCTAssertNotNil(try TokenStore.load(server: server))
  }

  func testBootstrap_decodeFailure_preservesCachedState() async throws {
    try TokenStore.save(tokens, server: server)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { _ in .http(status: 200, body: Data("not-json".utf8)) }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertEqual(s.user, cachedUser)
    XCTAssertTrue(s.hasCredentials)
  }

  // MARK: - bootstrap auth failures (refresh path)

  func testBootstrap_meReturns401_refreshSucceeds_updatesUser() async throws {
    try TokenStore.save(tokens, server: server)
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
    XCTAssertEqual(try TokenStore.load(server: server), freshTokens)
  }

  func testBootstrap_meReturns401_refreshAlso401_clearsEverything() async throws {
    try TokenStore.save(tokens, server: server)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { req in
      return .http(status: 401, body: Data())
    }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertNil(s.user)
    XCTAssertFalse(s.hasCredentials)
    XCTAssertNil(try TokenStore.load(server: server))
    XCTAssertNil(AuthUserCache.load(server: server))
  }

  /// The bug Copilot flagged: a 5xx on /api/auth/refresh used to fall
  /// through to the catch-all that cleared tokens. With the typed
  /// branch, 5xx during refresh now preserves credentials so the user
  /// can retry once the server recovers.
  func testBootstrap_meReturns401_refresh5xx_preservesTokens() async throws {
    try TokenStore.save(tokens, server: server)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { req in
      if req.url?.path == "/api/auth/refresh" { return .http(status: 503, body: Data()) }
      return .http(status: 401, body: Data())
    }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertTrue(s.hasCredentials, "refresh 5xx must NOT clear the Keychain")
    XCTAssertNotNil(try TokenStore.load(server: server))
    XCTAssertEqual(AuthUserCache.load(server: server), cachedUser)
  }

  func testBootstrap_meReturns401_refreshNetworkFailure_preservesTokens() async throws {
    try TokenStore.save(tokens, server: server)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { req in
      if req.url?.path == "/api/auth/refresh" { return .failure(URLError(.timedOut)) }
      return .http(status: 401, body: Data())
    }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertTrue(s.hasCredentials)
    XCTAssertNotNil(try TokenStore.load(server: server))
  }

  func testBootstrap_meReturns403_refreshAlso403_clearsEverything() async throws {
    try TokenStore.save(tokens, server: server)
    AuthUserCache.save(cachedUser, server: server)
    StubURLProtocol.responder = { _ in .http(status: 403, body: Data()) }
    let s = makeSession()
    await s.bootstrapAndRestore()
    XCTAssertFalse(s.hasCredentials)
    XCTAssertNil(try TokenStore.load(server: server))
  }

  // MARK: - signOut

  func testSignOut_clearsTokensCacheAndUser() async throws {
    try TokenStore.save(tokens, server: server)
    AuthUserCache.save(cachedUser, server: server)
    // Logout endpoint just needs to not 5xx; AuthSession ignores its
    // result either way.
    StubURLProtocol.responder = { _ in .http(status: 200, body: Data("{}".utf8)) }
    let s = makeSession()
    await s.signOut()
    XCTAssertNil(s.user)
    XCTAssertFalse(s.hasCredentials)
    XCTAssertNil(try TokenStore.load(server: server))
    XCTAssertNil(AuthUserCache.load(server: server))
  }

  // MARK: - helpers

  private static func meBody(user: AuthUser) -> Data {
    let json = #"{"user":{"id":"\#(user.id)","email":"\#(user.email)","role":"\#(user.role)"},"credentials":[]}"#
    return Data(json.utf8)
  }
}
