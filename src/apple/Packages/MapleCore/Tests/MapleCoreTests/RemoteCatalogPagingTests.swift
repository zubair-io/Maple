import XCTest
@testable import MapleCore

final class RemoteCatalogPagingTests: XCTestCase {
  func testDecodeUnpagedDirContentsOmitsCursor() throws {
    let json = #"""
    {"path":"/a","parent":"/","dirs":[],"images":[],"sidecars":[]}
    """#
    let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
    let parsed = try decoder.decode(DirContents.self, from: Data(json.utf8))
    XCTAssertNil(parsed.nextCursor)
  }

  func testDecodePagedDirContentsExposesCursor() throws {
    let json = #"""
    {"path":"/a","parent":"/","dirs":[],"images":[],"sidecars":[],"next_cursor":"eyJvZmZzZXQiOjUwMH0"}
    """#
    let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
    let parsed = try decoder.decode(DirContents.self, from: Data(json.utf8))
    XCTAssertEqual(parsed.nextCursor, "eyJvZmZzZXQiOjUwMH0")
  }

  func testListDirAppendsCursorAndLimit() async throws {
    StubURLProtocol.register()
    StubURLProtocol.reset()
    var receivedQuery: String?
    StubURLProtocol.handler = { req in
      receivedQuery = req.url?.query
      return (200, Data(#"{"path":"/p","parent":"/","dirs":[],"images":[],"sidecars":[]}"#.utf8), [:])
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
    _ = try await catalog.listDir(absolutePath: "/p", cursor: "abc", limit: 250)
    let q = receivedQuery ?? ""
    XCTAssertTrue(q.contains("path=/p"))
    XCTAssertTrue(q.contains("cursor=abc"))
    XCTAssertTrue(q.contains("limit=250"))
  }
}
