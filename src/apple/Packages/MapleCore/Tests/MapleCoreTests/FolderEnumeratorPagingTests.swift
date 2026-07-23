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
    enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
    let success = await observer.waitUntilFinished(timeoutSeconds: 5)
    XCTAssertTrue(success, "enumeration did not finish in time")
    XCTAssertNil(observer.error)
    // Three didEnumerate calls (one per page). First page also carries
    // the injected `.maple/` synthetic directory (issue #102), so the
    // first batch is one larger than the raw image count.
    XCTAssertEqual(observer.batches.count, 3)
    XCTAssertEqual(observer.batches.map(\.count), [3 + 1, 3, 2])
  }
}

/// Test helper — records observer callbacks and exposes an async wait.
final class TestEnumerationObserver: NSObject, NSFileProviderEnumerationObserver, @unchecked Sendable {
  var batches: [[NSFileProviderItem]] = []
  var finished = false
  var error: Error?
  private let cv = NSCondition()

  func didEnumerate(_ items: [NSFileProviderItemProtocol]) {
    cv.lock()
    batches.append(items as! [NSFileProviderItem])
    cv.unlock()
  }
  func finishEnumerating(upTo nextPage: NSFileProviderPage?) {
    cv.lock(); finished = true; cv.signal(); cv.unlock()
  }
  func finishEnumeratingWithError(_ error: Error) {
    cv.lock(); self.error = error; finished = true; cv.signal(); cv.unlock()
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
