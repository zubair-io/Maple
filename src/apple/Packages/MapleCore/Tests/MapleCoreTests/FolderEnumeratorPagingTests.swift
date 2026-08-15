import XCTest
import FileProvider
@testable import MapleCore

final class FolderEnumeratorPagingTests: XCTestCase {
  override func setUp() {
    super.setUp()
    StubURLProtocol.register()
    StubURLProtocol.reset()
  }
  override func tearDown() {
    StubURLProtocol.reset()
    super.tearDown()
  }

  /// #2550: each `enumerateItems` call now surfaces exactly ONE server
  /// page and returns the next page via `finishEnumerating(upTo:)` — no
  /// internal full-drain loop. This test drives the OS side of that
  /// contract explicitly: three calls, each feeding the PRIOR call's
  /// returned page back in as `startingAt:`, mirroring how the real OS
  /// resumes a multi-page enumeration.
  func testFolderEnumeratorFollowsCursorToCompletion() async throws {
    // Three pages of fake images. Server hands them back one page at a time,
    // attaching next_cursor on the first two.
    let pages: [(images: Int, nextCursor: String?)] = [
      (3, "p1"),
      (3, "p2"),
      (2, nil),
    ]
    StubURLProtocol.handler = { req in
      let q = req.url?.query ?? ""
      let idx: Int
      if q.contains("cursor=p1") { idx = 1 }
      else if q.contains("cursor=p2") { idx = 2 }
      else { idx = 0 }
      let p = pages[idx]
      var imgs: [String] = []
      for i in 0..<p.images {
        let name = "IMG_\(idx)_\(i).dng"
        let path = "/lib/\(name)"
        imgs.append("{\"name\":\"\(name)\",\"path\":\"\(path)\",\"mtime\":\"2026-01-01T00:00:00Z\",\"size\":1,\"ext\":\"dng\",\"id\":\"a\(idx)\(i)\"}")
      }
      let cursorField = p.nextCursor.map { ",\"next_cursor\":\"\($0)\"" } ?? ""
      let json = "{\"path\":\"/lib\",\"parent\":\"/\",\"dirs\":[],\"images\":[\(imgs.joined(separator: ","))],\"sidecars\":[]\(cursorField)}"
      return (200, Data(json.utf8), [:])
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
    let containerID = NSFileProviderItemIdentifier("folder/aaa:")
    let enumerator = FolderEnumerator(
      catalog: catalog,
      folderID: "aaa",
      relativePath: "",
      absolutePath: "/lib",
      containerIdentifier: containerID,
      pageSize: 3
    )
    let observer = TestEnumerationObserver()

    // Call 1: OS's initial page. First page also carries the injected
    // `.maple/` synthetic directory (issue #102).
    enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
    var success = await observer.waitUntilFinished(timeoutSeconds: 5)
    XCTAssertTrue(success, "call 1 did not finish in time")
    XCTAssertNil(observer.error)
    XCTAssertEqual(observer.batches.count, 1, "one didEnumerate call per enumerateItems call")
    XCTAssertEqual(observer.batches.map(\.count), [3 + 1])
    let page1 = try XCTUnwrap(observer.lastNextPage, "must return a continuation page — more items remain")

    // Call 2: OS resumes with the page WE returned.
    observer.resetForNextCall()
    enumerator.enumerateItems(for: observer, startingAt: page1)
    success = await observer.waitUntilFinished(timeoutSeconds: 5)
    XCTAssertTrue(success, "call 2 did not finish in time")
    XCTAssertNil(observer.error)
    XCTAssertEqual(observer.batches.map(\.count), [3], "no repeated .maple/ on a resumed page")
    let page2 = try XCTUnwrap(observer.lastNextPage)

    // Call 3: final page — no further continuation.
    observer.resetForNextCall()
    enumerator.enumerateItems(for: observer, startingAt: page2)
    success = await observer.waitUntilFinished(timeoutSeconds: 5)
    XCTAssertTrue(success, "call 3 did not finish in time")
    XCTAssertNil(observer.error)
    XCTAssertEqual(observer.batches.map(\.count), [2])
    XCTAssertNil(observer.lastNextPage, "last page must signal completion with a nil next page")
  }

  /// #2550 regression: the OS can hand `enumerateItems` a page token
  /// from a PRIOR, interrupted enumeration — this must resume the
  /// SERVER walk from that exact cursor, not silently restart from the
  /// top. Before the fix, `FolderEnumerator` ignored `startingAt`
  /// entirely and always began its internal loop at `cursor: nil`.
  func testFolderEnumeratorResumesFromOSSuppliedPageWithoutRestarting() async throws {
    var requestedCursors: [String?] = []
    StubURLProtocol.handler = { req in
      let q = req.url?.query ?? ""
      requestedCursors.append(q.contains("cursor=p2") ? "p2" : nil)
      // Only page 2's content is ever needed for this test.
      let json = """
      {"path":"/lib","parent":"/","dirs":[],"images":[
        {"name":"B.dng","path":"/lib/B.dng","mtime":"2026-01-01T00:00:00Z","size":1,"ext":"dng","id":"b0"}
      ],"sidecars":[]}
      """
      return (200, Data(json.utf8), [:])
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
    let containerID = NSFileProviderItemIdentifier("folder/aaa:")
    let enumerator = FolderEnumerator(
      catalog: catalog,
      folderID: "aaa",
      relativePath: "",
      absolutePath: "/lib",
      containerIdentifier: containerID,
      pageSize: 3
    )
    let observer = TestEnumerationObserver()
    // Simulate the OS resuming an interrupted enumeration directly at
    // page "p2" — no prior call to this enumerator instance at all.
    enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data("p2".utf8)))
    let success = await observer.waitUntilFinished(timeoutSeconds: 5)
    XCTAssertTrue(success, "enumeration did not finish in time")
    XCTAssertNil(observer.error)
    XCTAssertEqual(requestedCursors, ["p2"], "must hit the server with the OS-supplied cursor, not restart from the top")
    let items = observer.batches.flatMap { $0 }
    XCTAssertFalse(items.contains { $0.filename == ".maple" },
                    ".maple/ was already delivered on the original (unseen-by-this-call) first page; a resumed page must not re-inject it")
    XCTAssertEqual(items.map(\.filename), ["B.dng"])
  }
}

/// Test helper — records observer callbacks and exposes an async wait.
///
/// #2550: each `enumerateItems(for:startingAt:)` call now handles
/// exactly ONE server page and returns the next page token via
/// `finishEnumerating(upTo:)` — `lastNextPage` captures that token so a
/// test can drive a multi-page walk explicitly (feeding it back in as
/// the next call's `startingAt:`) instead of expecting one call to
/// internally full-drain.
final class TestEnumerationObserver: NSObject, NSFileProviderEnumerationObserver, @unchecked Sendable {
  var batches: [[NSFileProviderItem]] = []
  var finished = false
  var error: Error?
  var lastNextPage: NSFileProviderPage?
  private let cv = NSCondition()

  func didEnumerate(_ items: [NSFileProviderItemProtocol]) {
    cv.lock()
    batches.append(items as! [NSFileProviderItem])
    cv.unlock()
  }
  func finishEnumerating(upTo nextPage: NSFileProviderPage?) {
    cv.lock(); lastNextPage = nextPage; finished = true; cv.signal(); cv.unlock()
  }
  func finishEnumeratingWithError(_ error: Error) {
    cv.lock(); self.error = error; finished = true; cv.signal(); cv.unlock()
  }

  /// Resets `finished`/`batches` so the SAME observer instance can drive
  /// a second `enumerateItems` call (the next page of a multi-page
  /// walk) and `waitUntilFinished` again for that call specifically.
  func resetForNextCall() {
    cv.lock(); finished = false; batches = []; error = nil; cv.unlock()
  }

  func waitUntilFinished(timeoutSeconds: TimeInterval) async -> Bool {
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
      cv.lock()
      let done = finished
      cv.unlock()
      if done { return true }
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
    return false
  }
}
