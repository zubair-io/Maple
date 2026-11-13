import XCTest

@testable import MapleCloudKit
@testable import MapleCore

/// #5050 review: a change to a server's 'Show one image for RAW+JPEG pairs' reloads the search and
/// Timeline sessions it feeds, so a result set never mixes pages folded under the old value with
/// pages fetched under the new one, and no hit keeps a JPEG the server no longer folds into it.
@MainActor
final class RawJpegStackRefreshTests: XCTestCase {
  private let server = URL(string: "https://example.test")!

  /// The server's stacking preference, flipped by the test like Settings would.
  private final class Stacking: @unchecked Sendable {
    var on = true
    var requests: [URL] = []
  }

  private static let facets =
    #"{"total":1,"cameras":[],"lenses":[],"extensions":[],"scene_types":[],"activities":[],"#
    + #""subjects":[],"is_screenshot":{"true":0,"false":1,"unknown":0},"people":[],"places":[]}"#

  private static func hit(_ name: String) -> String {
    #"{"id":"fs:/l/\#(name)","folder_id":"lib1","abs_path":"/l/\#(name)","filename":"\#(name)","#
      + #""captured_at":"2024-07-01T00:00:00.000Z"}"#
  }

  /// A server that folds the pair into the RAW when asked with `stack=1`, else lists both files.
  private func client(_ stacking: Stacking) -> CloudSearchClient {
    let session = URLSession.stubbedSequence { request in
      let url = request.url!
      stacking.requests.append(url)
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let folded = items.contains { $0.name == "stack" && $0.value == "1" }
      let body: String
      switch url.path {
      case "/api/search/facets":
        body = Self.facets
      case "/api/search/buckets":
        body = #"{"total":1,"buckets":[{"year":2024,"month":7,"count":1}],"untimed_count":0}"#
      default:
        let hits = (folded ? ["IMG_1.CR3"] : ["IMG_1.CR3", "IMG_1.JPG"]).map(Self.hit)
        body =
          #"{"results":[\#(hits.joined(separator: ","))],"total":\#(hits.count),"page":0,"#
          + #""limit":200}"#
      }
      let response = HTTPURLResponse(
        url: url, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(body.utf8), response)
    }
    return CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session),
      stacksRawJpeg: { stacking.on })
  }

  private func temporaryDirectory() -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("RawJpegStackRefreshTests-\(UUID())")
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    return dir
  }

  /// The shown search used to keep its folded results after stacking was turned off, and
  /// re-submitting it served them again from the page cache.
  func testTurningStackingOffReRunsTheShownSearchUnfolded() async {
    let stacking = Stacking()
    let vm = SearchViewModel(server: server, libraryID: "lib1", searchClient: client(stacking))
    vm.params.q = "beach"
    await vm.submit()
    XCTAssertEqual(vm.results.map(\.filename), ["IMG_1.CR3"])

    stacking.on = false
    await vm.refreshForStackingChange()

    XCTAssertEqual(vm.results.map(\.filename), ["IMG_1.CR3", "IMG_1.JPG"])
    XCTAssertEqual(vm.page, 0)
  }

  func testTheIdleSearchPageAsksNothing() async {
    let stacking = Stacking()
    let vm = SearchViewModel(server: server, libraryID: "lib1", searchClient: client(stacking))
    vm.resetFilters()

    stacking.on = false
    await vm.refreshForStackingChange()

    XCTAssertEqual(stacking.requests, [])
  }

  /// The library Timeline used to keep its folded months, here and in its page cache.
  func testTheLibraryTimelineDropsItsFoldedPagesAndReloads() async throws {
    let stacking = Stacking()
    let pagesCache = CloudPagesCache(baseDir: temporaryDirectory())
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1", searchClient: client(stacking),
      bucketsCache: CloudBucketsCache(baseDir: temporaryDirectory()), pagesCache: pagesCache)
    let july = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)
    await vm.loadPage(year: 2024, month: 7)
    XCTAssertEqual(vm.pagesByBucket[july]?.map(\.filename), ["IMG_1.CR3"])

    stacking.on = false
    await vm.reloadForStackingChange()

    XCTAssertNil(vm.pagesByBucket[july], "no folded page is left to mix with unfolded ones")
    let cached = await pagesCache.read(
      host: server.cacheHostKey, libraryID: "lib1", pathPrefix: nil, ownerID: nil,
      year: 2024, month: 7, page: 0)
    XCTAssertNil(cached, "nor in the page cache, which the month's next load paints first")
    XCTAssertEqual(vm.stackingRevision, 1, "the months on screen load again")
    XCTAssertEqual(vm.buckets.count, 1)
    await vm.loadPage(year: 2024, month: 7)
    XCTAssertEqual(vm.pagesByBucket[july]?.map(\.filename), ["IMG_1.CR3", "IMG_1.JPG"])
  }

  func testTheAllSourcesTimelineDropsItsFoldedPagesAndReloads() async throws {
    let stacking = Stacking()
    let pagesCache = CloudPagesCache(baseDir: temporaryDirectory())
    let source = AllSourcesTimelineViewModel.ServerSource(
      server: server, libraryIDs: ["lib1"], searchClient: client(stacking),
      thumbClient: CloudThumbClient(
        server: server, httpClient: .unauthenticated(server: server, urlSession: .shared)))
    let vm = AllSourcesTimelineViewModel(
      sources: [source], bucketsCache: CloudBucketsCache(baseDir: temporaryDirectory()),
      pagesCache: pagesCache, photoKitMerge: nil, folderMerge: nil)
    let july = AllSourcesTimelineViewModel.BucketKey(year: 2024, month: 7)
    await vm.loadPage(year: 2024, month: 7)
    XCTAssertEqual(vm.pagesByBucket[july]?.map(\.filename), ["IMG_1.CR3"])

    stacking.on = false
    await vm.reloadForStackingChange()

    XCTAssertNil(vm.pagesByBucket[july])
    let cached = await pagesCache.read(
      host: server.cacheHostKey, libraryID: "lib1", year: 2024, month: 7, page: 0)
    XCTAssertNil(cached)
    XCTAssertEqual(vm.stackingRevision, 1)
    await vm.loadPage(year: 2024, month: 7)
    XCTAssertEqual(vm.pagesByBucket[july]?.map(\.filename), ["IMG_1.CR3", "IMG_1.JPG"])
  }
}
