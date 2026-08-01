// SearchCursorPaginationTests.swift
//
// Seek pagination on the Apple search path (#2129). Three layers:
//
//   1. `SearchParams.listQueryItems` — a cursor REPLACES `page` on the
//      wire; sending both would be ambiguous, and the server ignores
//      `page` when a cursor is present.
//   2. `SearchResponse` — `nextCursor` decodes, and is absent-tolerant so a
//      server predating the field still deserialises.
//   3. `SearchViewModel.loadMore()` — uses the cursor the previous page
//      handed back, and falls back to `page + 1` when there is none (an
//      unseekable sort, a relevance-ranked placeQuery, an older server).
//
// Layer 3 asserts on the URL the VM actually put on the wire, captured
// through `StubURLProtocol`, rather than on VM state — the bug this guards
// against is sending the wrong pagination param, which is invisible from
// the outside otherwise.

import XCTest
@testable import MapleCore
@testable import MapleCloudKit

final class SearchCursorPaginationTests: XCTestCase {

  private func dict(_ items: [URLQueryItem]) -> [String: String] {
    Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
  }

  // MARK: - 1. Query serialisation

  func test_listItems_cursorReplacesPage() {
    let p = SearchParams(libraryID: "lib-1")
    let d = dict(p.listQueryItems(page: 7, limit: 50, cursor: "OPAQUE-CURSOR"))
    XCTAssertEqual(d["cursor"], "OPAQUE-CURSOR")
    XCTAssertNil(d["page"], "page and cursor must never both go on the wire")
    XCTAssertEqual(d["limit"], "50")
    XCTAssertEqual(d["sort"], "captured_desc")
  }

  func test_listItems_nilOrEmptyCursorKeepsPage() {
    let p = SearchParams(libraryID: "lib-1")
    let withNil = dict(p.listQueryItems(page: 3, limit: 50, cursor: nil))
    XCTAssertEqual(withNil["page"], "3")
    XCTAssertNil(withNil["cursor"])

    let withEmpty = dict(p.listQueryItems(page: 3, limit: 50, cursor: ""))
    XCTAssertEqual(withEmpty["page"], "3")
    XCTAssertNil(withEmpty["cursor"])
  }

  // MARK: - 2. Response decoding

  func test_decode_nextCursorPresent() throws {
    let json = #"{"total":9,"page":0,"limit":2,"results":[],"nextCursor":"abc123"}"#
    let resp = try JSONDecoder().decode(SearchResponse.self, from: Data(json.utf8))
    XCTAssertEqual(resp.nextCursor, "abc123")
  }

  func test_decode_nextCursorNullOrAbsent() throws {
    let withNull = #"{"total":9,"page":0,"limit":2,"results":[],"nextCursor":null}"#
    XCTAssertNil(try JSONDecoder().decode(SearchResponse.self, from: Data(withNull.utf8)).nextCursor)
    // Absent — a server predating #2129 must still decode.
    let absent = #"{"total":9,"page":0,"limit":2,"results":[]}"#
    XCTAssertNil(try JSONDecoder().decode(SearchResponse.self, from: Data(absent.utf8)).nextCursor)
  }

  func test_seekExhausted_onlyWhenTheChainEndedOnASeekableQuery() throws {
    func exhausted(_ json: String) throws -> Bool {
      try JSONDecoder().decode(SearchResponse.self, from: Data(json.utf8)).seekExhausted
    }
    // Exhausted: the query WAS seekable and handed back no cursor.
    XCTAssertTrue(
      try exhausted(#"{"total":9000,"page":0,"limit":2,"results":[],"cursorPaging":true,"nextCursor":null}"#))
    // Not exhausted: the chain continues.
    XCTAssertFalse(
      try exhausted(#"{"total":9000,"page":0,"limit":2,"results":[],"cursorPaging":true,"nextCursor":"c"}"#))
    // Not exhausted: seek pagination was never available, so the caller must
    // keep paging rather than treating this as the end of the list.
    XCTAssertFalse(
      try exhausted(#"{"total":9000,"page":0,"limit":2,"results":[],"cursorPaging":false,"nextCursor":null}"#))
    // A server predating the field omits it — same as unseekable.
    XCTAssertFalse(try exhausted(#"{"total":9000,"page":0,"limit":2,"results":[]}"#))
  }

  // MARK: - 3. loadMore() pagination mode

  @MainActor
  func test_exhaustedChainClampsStaleTotalSoLoadMoreStops() async {
    // The regression this guards: `total` is cached server-side for 30 s, so
    // it can overstate the set. If the seek chain ends while `total` still
    // says 9000, `canLoadMore` stays true and loadMore() drops back to deep
    // page-based SKIP pagination — the cost this feature exists to remove.
    let recorder = URLRecorder()
    let vm = makeRecordingVM(recorder, nextCursor: nil, cursorPaging: true, total: 9000)

    await vm.submit()

    XCTAssertEqual(vm.total, 1, "an exhausted chain must clamp the stale total to the rows held")
    XCTAssertFalse(vm.canLoadMore, "an exhausted chain must close the infinite-scroll gate")
    let before = recorder.searchURLs.count
    await vm.loadMore()
    XCTAssertEqual(recorder.searchURLs.count, before, "loadMore must not fall back to page paging")
  }

  @MainActor
  func test_unseekableQueryKeepsTheStaleTotalAndKeepsPaging() async {
    // Control for the test above: with cursorPaging false, a nil cursor says
    // nothing about the end of the list, so `total` must still be believed.
    let recorder = URLRecorder()
    let vm = makeRecordingVM(recorder, nextCursor: nil, cursorPaging: false, total: 9000)

    await vm.submit()

    XCTAssertEqual(vm.total, 9000)
    XCTAssertTrue(vm.canLoadMore)
    await vm.loadMore()
    XCTAssertTrue(recorder.searchURLs.last?.contains("page=1") == true)
  }

  @MainActor
  func test_loadMore_seeksWithTheCursorTheFirstPageReturned() async {
    let recorder = URLRecorder()
    let vm = makeRecordingVM(recorder, nextCursor: "CURSOR-PAGE-1")

    await vm.submit()
    XCTAssertEqual(vm.nextCursor, "CURSOR-PAGE-1")

    await vm.loadMore()
    let loadMoreURL = recorder.searchURLs.last
    XCTAssertNotNil(loadMoreURL)
    XCTAssertTrue(loadMoreURL!.contains("cursor=CURSOR-PAGE-1"),
                  "loadMore must seek with the server's cursor — got \(loadMoreURL ?? "")")
    XCTAssertFalse(loadMoreURL!.contains("page="),
                   "a seek request must not also carry page=")
  }

  @MainActor
  func test_loadMore_fallsBackToPageWhenTheServerOffersNoCursor() async {
    // `cursorPaging: false` is what makes a nil cursor mean "seek pagination
    // isn't available here" rather than "the chain is exhausted" — the latter
    // stops paging entirely (see the exhaustion tests above).
    let recorder = URLRecorder()
    let vm = makeRecordingVM(recorder, nextCursor: nil, cursorPaging: false)

    await vm.submit()
    XCTAssertNil(vm.nextCursor)

    await vm.loadMore()
    let loadMoreURL = recorder.searchURLs.last
    XCTAssertNotNil(loadMoreURL)
    XCTAssertTrue(loadMoreURL!.contains("page=1"),
                  "without a cursor loadMore must page — got \(loadMoreURL ?? "")")
    XCTAssertFalse(loadMoreURL!.contains("cursor="))
  }

  // MARK: - Helpers

  /// A VM whose every `/api/search` request records its URL and answers with
  /// one full page carrying `nextCursor`. `/api/search/facets` answers with a
  /// minimal facets body so `submit()`'s concurrent facet fetch succeeds.
  @MainActor
  private func makeRecordingVM(_ recorder: URLRecorder,
                               nextCursor: String?,
                               cursorPaging: Bool = true,
                               total: Int = 99) -> SearchViewModel {
    let server = URL(string: "https://stub.test")!
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    StubURLProtocol.reset()
    let cursorJSON = nextCursor.map { "\"\($0)\"" } ?? "null"
    StubURLProtocol.responder = { request in
      let url = request.url?.absoluteString ?? ""
      if url.contains("/api/search/facets") {
        return .http(status: 200, body: Data(Self.facetsBody.utf8))
      }
      recorder.record(url)
      let body = """
      {"total":\(total),"page":0,"limit":100,
       "results":[{"id":"fs:/p/a.dng","folder_id":"lib-test",
                   "abs_path":"/p/a.dng","filename":"a.dng"}],
       "cursorPaging":\(cursorPaging),"nextCursor":\(cursorJSON)}
      """
      return .http(status: 200, body: Data(body.utf8))
    }
    let session = URLSession(configuration: cfg)
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    return SearchViewModel(server: server, libraryID: "lib-test", searchClient: client)
  }

  private static let facetsBody = """
  {"total":99,"cameras":[],"lenses":[],"extensions":[],"iso_range":null,
   "capture_range":null,"scene_types":[],"activities":[],"subjects":[],
   "is_screenshot":{"true":0,"false":0,"unknown":0}}
  """
}

/// Thread-safe tally of the `/api/search` URLs the VM issued —
/// `StubURLProtocol`'s responder runs off the main actor.
final class URLRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var urls: [String] = []
  var searchURLs: [String] { lock.withLock { urls } }
  func record(_ url: String) { lock.withLock { urls.append(url) } }
}
