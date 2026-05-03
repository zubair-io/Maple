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
