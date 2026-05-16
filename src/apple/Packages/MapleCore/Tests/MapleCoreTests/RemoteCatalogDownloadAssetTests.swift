import XCTest
@testable import MapleCore

final class RemoteCatalogDownloadAssetTests: XCTestCase {
  override func setUp() {
    super.setUp()
    StubURLProtocol.register()
    StubURLProtocol.reset()
  }

  override func tearDown() {
    StubURLProtocol.reset()
    super.tearDown()
  }

  func testDownloadAssetStreamsBytesToFile() async throws {
    let payload = Data(repeating: 0xAB, count: 1024 * 1024) // 1 MB
    StubURLProtocol.handler = { req in
      XCTAssertEqual(req.url!.path, "/api/assets/abc/raw")
      XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer A1")
      return (200, payload, [:])
    }
    let session = TestURLSession.make()
    let http = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: session,
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onSignOut: {}
    )
    let catalog = RemoteCatalog(http: http,
                                server: URL(string: "https://x.test")!,
                                downloadURLSession: session)
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: tmp) }
    try await catalog.downloadAsset(assetID: "abc", to: tmp)
    let written = try Data(contentsOf: tmp)
    XCTAssertEqual(written, payload)
  }

  func testDownloadAssetRefreshesOn401AndRetries() async throws {
    let payload = Data("retry-ok".utf8)
    var calls: [(path: String, auth: String?)] = []
    StubURLProtocol.handler = { req in
      calls.append((req.url!.path, req.value(forHTTPHeaderField: "Authorization")))
      if req.url!.path == "/api/auth/refresh" {
        return (200, Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8), [:])
      }
      let auth = req.value(forHTTPHeaderField: "Authorization")
      if auth == "Bearer A1" { return (401, Data("nope".utf8), [:]) }
      if auth == "Bearer A2" { return (200, payload, [:]) }
      return (500, Data("?".utf8), [:])
    }
    var current = AuthTokens(access: "A1", refresh: "R1")
    let session = TestURLSession.make()
    let http = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: session,
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: {}
    )
    let catalog = RemoteCatalog(http: http,
                                server: URL(string: "https://x.test")!,
                                downloadURLSession: session)
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: tmp) }
    try await catalog.downloadAsset(assetID: "xyz", to: tmp)
    XCTAssertEqual(try Data(contentsOf: tmp), payload)
    XCTAssertEqual(current.access, "A2")
    // Three calls total: 401, refresh, retry-200.
    XCTAssertEqual(calls.count, 3)
  }
}
