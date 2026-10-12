// SearchRankPinTests.swift
//
// Every page of one free-text search comes from one ranking (#4542). The
// server answers each page with an opaque `rankPin`; the view model sends it
// back with the next page, and when the server refuses a pinned page with
// 409 `rank_engine_changed` the view model restarts the search from page 0
// instead of appending a page ranked by another engine.

import XCTest

@testable import MapleCloudKit
@testable import MapleCore

final class SearchRankPinTests: XCTestCase {

  override func tearDown() {
    StubURLProtocol.reset()
    super.tearDown()
  }

  // MARK: - Wire format

  func test_listItems_carryTheRankPinOnlyWhenGiven() {
    let params = SearchParams(libraryID: "lib-1")
    let pinned = params.listQueryItems(page: 1, limit: 30, rankPin: "in-process:100")
    XCTAssertEqual(pinned.first { $0.name == "rankPin" }?.value, "in-process:100")
    XCTAssertNil(params.listQueryItems(page: 0, limit: 30).first { $0.name == "rankPin" })
  }

  func test_decode_rankPinPresentOrAbsent() throws {
    let pinned = #"{"total":1,"page":0,"limit":1,"results":[],"rankPin":"database:400"}"#
    let absent = #"{"total":1,"page":0,"limit":1,"results":[]}"#
    XCTAssertEqual(
      try JSONDecoder().decode(SearchResponse.self, from: Data(pinned.utf8)).rankPin,
      "database:400")
    XCTAssertNil(try JSONDecoder().decode(SearchResponse.self, from: Data(absent.utf8)).rankPin)
  }

  func test_client_throwsRankEngineChangedOnlyForThatRefusal() async {
    let server = URL(string: "https://stub.test")!
    let client = makeClient(server)
    var params = SearchParams(libraryID: "lib-1")
    params.placeQuery = "beach"

    StubURLProtocol.responder = { _ in
      .http(status: 409, body: Data(#"{"error":"restart","code":"rank_engine_changed"}"#.utf8))
    }
    do {
      _ = try await client.search(params, page: 1, limit: 30, rankPin: "in-process:100")
      XCTFail("expected rankEngineChanged")
    } catch {
      XCTAssertEqual(error as? SearchPagingError, .rankEngineChanged)
    }

    StubURLProtocol.responder = { _ in
      .http(status: 409, body: Data(#"{"error":"something else"}"#.utf8))
    }
    do {
      _ = try await client.search(params, page: 1, limit: 30)
      XCTFail("expected an HTTP error")
    } catch {
      XCTAssertNil(error as? SearchPagingError)
    }
  }

  // MARK: - View model

  @MainActor
  func test_loadMore_sendsBackThePinOfThePageBefore() async {
    let recorder = URLRecorder()
    let vm = makeVM(recorder) { url in
      url.contains("page=0")
        ? .http(status: 200, body: Self.page(id: "a", pin: "in-process:100"))
        : .http(status: 200, body: Self.page(id: "b", pin: "in-process:100,400"))
    }

    await vm.submit()
    await vm.loadMore()
    await vm.loadMore()

    XCTAssertFalse(recorder.searchURLs[0].contains("rankPin="))
    XCTAssertTrue(recorder.searchURLs[1].hasSuffix("rankPin=in-process:100"))
    XCTAssertTrue(recorder.searchURLs[2].hasSuffix("rankPin=in-process:100,400"))
  }

  @MainActor
  func test_loadMore_restartsFromPageZeroWhenTheEngineChanged() async {
    let recorder = URLRecorder()
    let firstPageServed = Counter()
    let vm = makeVM(recorder) { url in
      if url.contains("rankPin=") {
        return .http(
          status: 409, body: Data(#"{"error":"restart","code":"rank_engine_changed"}"#.utf8))
      }
      let isRestart = firstPageServed.next() > 0
      return .http(
        status: 200,
        body: Self.page(
          id: isRestart ? "fresh" : "stale", pin: isRestart ? "database:100" : "in-process:100"))
    }

    await vm.submit()
    XCTAssertEqual(vm.results.map(\.filename), ["stale.dng"])

    await vm.loadMore()

    XCTAssertEqual(vm.results.map(\.filename), ["fresh.dng"], "the restart replaces, never appends")
    XCTAssertEqual(vm.page, 0)
    XCTAssertNil(vm.loadError, "a restart is not an error")
    XCTAssertFalse(vm.isLoadingMore)
    let restart = recorder.searchURLs.last ?? ""
    XCTAssertTrue(restart.contains("page=0"))
    XCTAssertFalse(restart.contains("rankPin="), "a restarted first page is unpinned")

    await vm.loadMore()
    XCTAssertTrue(recorder.searchURLs.contains { $0.hasSuffix("rankPin=database:100") })
  }

  // MARK: - Helpers

  private static func page(id: String, pin: String) -> Data {
    Data(
      """
      {"total":500,"page":0,"limit":100,"more":true,
       "results":[{"id":"fs:/p/\(id).dng","folder_id":"lib-test",
                   "abs_path":"/p/\(id).dng","filename":"\(id).dng"}],
       "cursorPaging":false,"nextCursor":null,"rankPin":"\(pin)"}
      """.utf8)
  }

  private static let facetsBody = """
    {"total":500,"cameras":[],"lenses":[],"extensions":[],"iso_range":null,
     "capture_range":null,"scene_types":[],"activities":[],"subjects":[],
     "is_screenshot":{"true":0,"false":0,"unknown":0}}
    """

  private func makeClient(_ server: URL) -> CloudSearchClient {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    return CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(
        server: server, urlSession: URLSession(configuration: cfg)))
  }

  @MainActor
  private func makeVM(
    _ recorder: URLRecorder, search: @escaping @Sendable (String) -> StubResponse
  ) -> SearchViewModel {
    let server = URL(string: "https://stub.test")!
    StubURLProtocol.reset()
    StubURLProtocol.responder = { request in
      let url = request.url?.absoluteString.removingPercentEncoding ?? ""
      if url.contains("/api/search/facets") {
        return .http(status: 200, body: Data(Self.facetsBody.utf8))
      }
      recorder.record(url)
      return search(url)
    }
    let vm = SearchViewModel(
      server: server, libraryID: "lib-test", searchClient: makeClient(server))
    vm.params.placeQuery = "beach"
    return vm
  }
}

/// Thread-safe call counter — `StubURLProtocol`'s responder runs off the main actor.
private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  func next() -> Int {
    lock.withLock {
      defer { count += 1 }
      return count
    }
  }
}
