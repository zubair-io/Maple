import XCTest
@testable import MapleCore

final class AuthenticatedHTTPClientInjectTests: XCTestCase {
  func testInjectAddsBearerHeader() async throws {
    let client = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: TestURLSession.make(),
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onSignOut: {}
    )
    let req = URLRequest(url: URL(string: "https://x.test/api/folders")!)
    let injected = try await client.inject(req)
    XCTAssertEqual(injected.value(forHTTPHeaderField: "Authorization"), "Bearer A1")
  }

  func testInjectWithoutTokensLeavesHeaderNil() async {
    let client = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: TestURLSession.make(),
      tokensProvider: { nil },
      onSignOut: {}
    )
    let req = URLRequest(url: URL(string: "https://x.test/api/folders")!)
    do {
      _ = try await client.inject(req)
      XCTFail("expected local authentication failure")
    } catch let error as AuthenticatedHTTPClient.AuthenticationError {
      XCTAssertEqual(error, .notAuthenticated)
    } catch {
      XCTFail("unexpected error: \(error)")
    }
  }

  func testRefreshIfNeededAndRetryReturnsOnSuccess() async throws {
    StubURLProtocol.register()
    StubURLProtocol.reset()
    var calls = 0
    StubURLProtocol.handler = { _ in
      calls += 1
      return (200, Data("ok".utf8), [:])
    }
    let session = TestURLSession.make()
    let client = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: session,
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onSignOut: {}
    )
    let req = URLRequest(url: URL(string: "https://x.test/api/x")!)
    let (data, resp) = try await client.refreshIfNeededAndRetry(request: req) { injected in
      try await session.data(for: injected)
    }
    XCTAssertEqual((resp as! HTTPURLResponse).statusCode, 200)
    XCTAssertEqual(String(data: data, encoding: .utf8), "ok")
    XCTAssertEqual(calls, 1)
  }

  func testRefreshIfNeededAndRetryRefreshesOn401() async throws {
    StubURLProtocol.register()
    StubURLProtocol.reset()
    StubURLProtocol.handler = { req in
      if req.url!.path == "/api/auth/refresh" {
        return (200, Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8), [:])
      }
      let auth = req.value(forHTTPHeaderField: "Authorization")
      if auth == "Bearer A1" { return (401, Data("nope".utf8), [:]) }
      if auth == "Bearer A2" { return (200, Data("ok".utf8), [:]) }
      return (500, Data("?".utf8), [:])
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
    let req = URLRequest(url: URL(string: "https://x.test/api/x")!)
    let (data, resp) = try await client.refreshIfNeededAndRetry(request: req) { injected in
      try await session.data(for: injected)
    }
    XCTAssertEqual((resp as! HTTPURLResponse).statusCode, 200)
    XCTAssertEqual(String(data: data, encoding: .utf8), "ok")
    XCTAssertEqual(current.access, "A2")
  }
}
