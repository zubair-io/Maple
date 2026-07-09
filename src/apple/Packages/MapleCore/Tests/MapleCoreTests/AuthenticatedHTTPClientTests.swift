import XCTest
@testable import MapleCore

final class AuthenticatedHTTPClientTests: XCTestCase {
  func testInjectsBearerOnEveryRequest() async throws {
    StubURLProtocol.register()
    StubURLProtocol.handler = { req in
      XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer A1")
      return (200, Data("{}".utf8), [:])
    }
    let session = TestURLSession.make()
    let client = AuthenticatedHTTPClient(server: URL(string: "https://x.test")!, urlSession: session, tokensProvider: { AuthTokens(access: "A1", refresh: "R1") }, onSignOut: {})
    _ = try await client.data(for: URLRequest(url: URL(string: "https://x.test/api/folders")!))
  }

  func testRefreshesOn401AndRetries() async throws {
    StubURLProtocol.register()
    var calls = 0
    StubURLProtocol.handler = { req in
      calls += 1
      if req.url!.path == "/api/auth/refresh" {
        return (200, Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8), [:])
      }
      let auth = req.value(forHTTPHeaderField: "Authorization")
      if auth == "Bearer A1" { return (401, Data("{}".utf8), [:]) }
      if auth == "Bearer A2" { return (200, Data("{}".utf8), [:]) }
      return (500, Data("{}".utf8), [:])
    }
    var current = AuthTokens(access: "A1", refresh: "R1")
    let session = TestURLSession.make()
    let client = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: session,
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: {}
    )
    let (_, resp) = try await client.data(for: URLRequest(url: URL(string: "https://x.test/api/folders")!))
    XCTAssertEqual((resp as! HTTPURLResponse).statusCode, 200)
    XCTAssertEqual(current.access, "A2")
  }

  func testRefreshWithoutRefreshTokenInBodyKeepsCurrentAndDoesNotSignOut() async throws {
    // Resilience against a server that rotates via cookie and returns ONLY
    // `access_token` in the body (the pre-fix / web contract). A native client
    // has no cookie, so it can't learn a rotated refresh token here — but it
    // must NOT choke on the absent field and sign out. It keeps the refresh
    // token it presented and takes the new access token.
    StubURLProtocol.register()
    defer { StubURLProtocol.reset() }
    var signedOut = false
    StubURLProtocol.handler = { req in
      if req.url!.path == "/api/auth/refresh" {
        return (200, Data(#"{"access_token":"A2"}"#.utf8), [:])
      }
      let auth = req.value(forHTTPHeaderField: "Authorization")
      if auth == "Bearer A1" { return (401, Data("{}".utf8), [:]) }
      if auth == "Bearer A2" { return (200, Data("{}".utf8), [:]) }
      return (500, Data("{}".utf8), [:])
    }
    var current = AuthTokens(access: "A1", refresh: "R1")
    let session = TestURLSession.make()
    let client = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!, urlSession: session,
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: { signedOut = true }
    )
    let (_, resp) = try await client.data(for: URLRequest(url: URL(string: "https://x.test/api/folders")!))
    XCTAssertEqual((resp as! HTTPURLResponse).statusCode, 200)
    XCTAssertEqual(current.access, "A2")
    XCTAssertEqual(current.refresh, "R1")
    XCTAssertFalse(signedOut)
  }

  func testProactivelyRefreshesExpiredAccessTokenBeforeRequest() async throws {
    // The access token is already past its exp. The client should refresh
    // BEFORE dispatching the request — so the request carries a fresh token
    // and never eats a 401 round-trip.
    StubURLProtocol.register()
    defer { StubURLProtocol.reset() }
    var refreshCount = 0
    var dataAuthHeader: String?
    StubURLProtocol.handler = { req in
      if req.url!.path == "/api/auth/refresh" {
        refreshCount += 1
        return (200, Data(#"{"access_token":"FRESH","refresh_token":"R2"}"#.utf8), [:])
      }
      dataAuthHeader = req.value(forHTTPHeaderField: "Authorization")
      return (200, Data("{}".utf8), [:])
    }
    var current = AuthTokens(access: Self.jwt(expiringIn: -10), refresh: "R1")
    let session = TestURLSession.make()
    let client = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!, urlSession: session,
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: {}
    )
    _ = try await client.data(for: URLRequest(url: URL(string: "https://x.test/api/a")!))
    XCTAssertEqual(refreshCount, 1)
    XCTAssertEqual(dataAuthHeader, "Bearer FRESH")
    XCTAssertEqual(current.access, "FRESH")
  }

  func testDoesNotProactivelyRefreshValidAccessToken() async throws {
    StubURLProtocol.register()
    defer { StubURLProtocol.reset() }
    var refreshCount = 0
    StubURLProtocol.handler = { req in
      if req.url!.path == "/api/auth/refresh" {
        refreshCount += 1
        return (200, Data(#"{"access_token":"X","refresh_token":"Y"}"#.utf8), [:])
      }
      return (200, Data("{}".utf8), [:])
    }
    var current = AuthTokens(access: Self.jwt(expiringIn: 3600), refresh: "R1")
    let session = TestURLSession.make()
    let client = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!, urlSession: session,
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: {}
    )
    _ = try await client.data(for: URLRequest(url: URL(string: "https://x.test/api/a")!))
    XCTAssertEqual(refreshCount, 0)
  }

  func testPersistsRotatedTokensOncePerRefreshUnderConcurrency() async throws {
    // Three concurrent requests all 401 and coalesce onto one refresh. The
    // rotated pair must be persisted exactly ONCE — not once per awaiter — so we
    // don't fan out redundant Keychain writes and File-Provider mirror tasks for
    // the same tokens.
    StubURLProtocol.register()
    defer { StubURLProtocol.reset() }
    StubURLProtocol.handler = { req in
      if req.url!.path == "/api/auth/refresh" {
        return (200, Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8), [:])
      }
      let auth = req.value(forHTTPHeaderField: "Authorization")
      return (auth == "Bearer A2") ? (200, Data("{}".utf8), [:]) : (401, Data("{}".utf8), [:])
    }
    var current = AuthTokens(access: "A1", refresh: "R1")
    var persistCount = 0
    let session = TestURLSession.make()
    let client = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!, urlSession: session,
      tokensProvider: { current },
      onTokensRefreshed: { current = $0; persistCount += 1 },
      onSignOut: {}
    )
    async let r1 = client.data(for: URLRequest(url: URL(string: "https://x.test/api/a")!))
    async let r2 = client.data(for: URLRequest(url: URL(string: "https://x.test/api/b")!))
    async let r3 = client.data(for: URLRequest(url: URL(string: "https://x.test/api/c")!))
    _ = try await (r1, r2, r3)
    XCTAssertEqual(persistCount, 1)
  }

  /// Minimal JWT (unsigned) carrying an `exp` claim `seconds` from now. The
  /// client only base64url-decodes the payload to read `exp`; it never verifies
  /// the signature (it holds no secret), so a placeholder signature is fine.
  static func jwt(expiringIn seconds: TimeInterval) -> String {
    func b64url(_ d: Data) -> String {
      d.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    }
    let header = b64url(Data(#"{"alg":"HS256","typ":"JWT"}"#.utf8))
    let exp = Int(Date().timeIntervalSince1970 + seconds)
    let payload = b64url(Data("{\"exp\":\(exp)}".utf8))
    return "\(header).\(payload).sig"
  }

  func testSingleFlightRefresh() async throws {
    StubURLProtocol.register()
    var refreshCount = 0
    StubURLProtocol.handler = { req in
      if req.url!.path == "/api/auth/refresh" { refreshCount += 1; return (200, Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8), [:]) }
      let auth = req.value(forHTTPHeaderField: "Authorization")
      return (auth == "Bearer A2") ? (200, Data("{}".utf8), [:]) : (401, Data("{}".utf8), [:])
    }
    var current = AuthTokens(access: "A1", refresh: "R1")
    let session = TestURLSession.make()
    let client = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!, urlSession: session,
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: {}
    )
    async let r1 = client.data(for: URLRequest(url: URL(string: "https://x.test/api/a")!))
    async let r2 = client.data(for: URLRequest(url: URL(string: "https://x.test/api/b")!))
    async let r3 = client.data(for: URLRequest(url: URL(string: "https://x.test/api/c")!))
    _ = try await (r1, r2, r3)
    XCTAssertEqual(refreshCount, 1)
  }
}
