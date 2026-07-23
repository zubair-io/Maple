import XCTest
import Foundation
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
      onTokensRefreshed: { _ in },
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

  // MARK: - Page-streaming child lookup (Issues #1 and #2)

  /// Builds two paged dir-listings such that the target child sits on the
  /// FIRST page. The streaming child-lookup helpers must return after one
  /// request and never fetch the second page.
  func testFindChildDirStopsOnFirstPageMatch() async throws {
    StubURLProtocol.register()
    StubURLProtocol.reset()
    var hits: [String] = []
    StubURLProtocol.handler = { req in
      hits.append(req.url?.query ?? "")
      // First request (no cursor): a 500-entry page with the target dir
      // included, plus a next_cursor so we can detect over-fetching.
      let body = #"""
      {"path":"/p","parent":"/","dirs":[{"name":"target","path":"/p/target","mtime":"2026-05-16T00:00:00Z"}],"images":[],"sidecars":[],"next_cursor":"page2"}
      """#
      return (200, Data(body.utf8), [:])
    }
    let session = TestURLSession.make()
    let http = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: session,
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onTokensRefreshed: { _ in },
      onSignOut: {}
    )
    let catalog = RemoteCatalog(http: http,
                                server: URL(string: "https://x.test")!,
                                downloadURLSession: session)
    let found = try await FileProviderExtensionCore.findChildDir(
      catalog: catalog,
      absolutePath: "/p",
      childName: "target"
    )
    XCTAssertNotNil(found)
    XCTAssertEqual(found?.name, "target")
    // Critical: only one HTTP call — the second page (1000-entry tail)
    // is never fetched because the match was on page 1.
    XCTAssertEqual(hits.count, 1, "expected one paged listDir call; got \(hits.count)")
    XCTAssertTrue(hits[0].contains("limit=500"))
    XCTAssertFalse(hits[0].contains("cursor="))
  }

  /// Target lives on page TWO. The helper must follow the cursor exactly
  /// once and stop after the match — never walk the full directory.
  func testFindChildDirFollowsCursorAndStops() async throws {
    StubURLProtocol.register()
    StubURLProtocol.reset()
    var hits: [String] = []
    StubURLProtocol.handler = { req in
      let q = req.url?.query ?? ""
      hits.append(q)
      // First page: 500 unrelated dirs (we only need a few in JSON since
      // the helper just iterates the array), next_cursor advertises page2.
      if !q.contains("cursor=") {
        let body = #"""
        {"path":"/p","parent":"/","dirs":[{"name":"other_a","path":"/p/other_a","mtime":"2026-05-16T00:00:00Z"}],"images":[],"sidecars":[],"next_cursor":"page2"}
        """#
        return (200, Data(body.utf8), [:])
      }
      // Second page contains the target plus a third-page cursor we
      // must NOT follow.
      let body = #"""
      {"path":"/p","parent":"/","dirs":[{"name":"target","path":"/p/target","mtime":"2026-05-16T00:00:00Z"}],"images":[],"sidecars":[],"next_cursor":"page3"}
      """#
      return (200, Data(body.utf8), [:])
    }
    let session = TestURLSession.make()
    let http = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: session,
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onTokensRefreshed: { _ in },
      onSignOut: {}
    )
    let catalog = RemoteCatalog(http: http,
                                server: URL(string: "https://x.test")!,
                                downloadURLSession: session)
    let found = try await FileProviderExtensionCore.findChildDir(
      catalog: catalog,
      absolutePath: "/p",
      childName: "target"
    )
    XCTAssertEqual(found?.name, "target")
    XCTAssertEqual(hits.count, 2, "expected exactly two paged calls; got \(hits.count)")
    XCTAssertTrue(hits[1].contains("cursor=page2"))
  }

  /// Asset-lookup variant: the matching image is on page 1, so the helper
  /// must NOT fetch the second page even though it advertises one.
  func testFindAssetIDStopsOnFirstPageMatch() async throws {
    StubURLProtocol.register()
    StubURLProtocol.reset()
    var hits = 0
    StubURLProtocol.handler = { _ in
      hits += 1
      let body = #"""
      {"path":"/p","parent":"/","dirs":[],"images":[{"name":"IMG_1.ARW","path":"/p/IMG_1.ARW","mtime":"2026-05-16T00:00:00Z","size":3,"ext":"arw","id":"deadbeef"}],"sidecars":[],"next_cursor":"page2"}
      """#
      return (200, Data(body.utf8), [:])
    }
    let session = TestURLSession.make()
    let http = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: session,
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onTokensRefreshed: { _ in },
      onSignOut: {}
    )
    let catalog = RemoteCatalog(http: http,
                                server: URL(string: "https://x.test")!,
                                downloadURLSession: session)
    let id = try await FileProviderExtensionCore.findAssetID(
      catalog: catalog,
      absolutePath: "/p",
      canonicalBase: "IMG_1"
    )
    XCTAssertEqual(id, "deadbeef")
    XCTAssertEqual(hits, 1, "expected one call; got \(hits)")
  }

  /// Asset-lookup variant: match on the third (final) page. Verifies the
  /// helper follows the cursor chain and terminates when next_cursor is nil.
  func testFindAssetIDExhaustsCursorChain() async throws {
    StubURLProtocol.register()
    StubURLProtocol.reset()
    var hits: [String] = []
    StubURLProtocol.handler = { req in
      let q = req.url?.query ?? ""
      hits.append(q)
      // Determine page number from cursor query (none, page2, page3).
      if q.contains("cursor=page3") {
        let body = #"""
        {"path":"/p","parent":"/","dirs":[],"images":[{"name":"IMG_1.ARW","path":"/p/IMG_1.ARW","mtime":"2026-05-16T00:00:00Z","size":3,"ext":"arw","id":"feedface"}],"sidecars":[]}
        """#
        return (200, Data(body.utf8), [:])
      }
      let next = q.contains("cursor=page2") ? "page3" : "page2"
      let body = """
      {"path":"/p","parent":"/","dirs":[],"images":[],"sidecars":[],"next_cursor":"\(next)"}
      """
      return (200, Data(body.utf8), [:])
    }
    let session = TestURLSession.make()
    let http = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: session,
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onTokensRefreshed: { _ in },
      onSignOut: {}
    )
    let catalog = RemoteCatalog(http: http,
                                server: URL(string: "https://x.test")!,
                                downloadURLSession: session)
    let id = try await FileProviderExtensionCore.findAssetID(
      catalog: catalog,
      absolutePath: "/p",
      canonicalBase: "IMG_1"
    )
    XCTAssertEqual(id, "feedface")
    XCTAssertEqual(hits.count, 3)
  }
}
