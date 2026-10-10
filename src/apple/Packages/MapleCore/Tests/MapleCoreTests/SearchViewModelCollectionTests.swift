// SearchViewModelCollectionTests.swift
//
// SearchViewModel's result-publishing order (results before the slower
// facets request, #4408) and its generated-search collection mode (#4410):
// a tapped card shows the collection's cached first page without a request
// and pages on through the collection endpoint until a new search.

import XCTest

@testable import MapleCloudKit
@testable import MapleCore

@MainActor
final class SearchViewModelCollectionTests: XCTestCase {

  func test_submit_publishesResultsBeforeSlowFacetsArrive() async throws {
    let server = URL(string: "https://stub.test")!
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [SlowFacetsURLProtocol.self]
    let gate = SlowFacetsURLProtocol.armGate()
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(
        server: server, urlSession: URLSession(configuration: cfg)))
    let vm = SearchViewModel(server: server, libraryID: "lib-test", searchClient: client)
    vm.params.placeQuery = "panama"

    let submit = Task { await vm.submit() }
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while vm.results.isEmpty, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(5))
    }

    XCTAssertEqual(vm.results.map(\.id), ["fs:/p/a.dng"], "results must not wait for facets")
    XCTAssertFalse(vm.isLoading, "the grid's spinner must clear once results land")
    XCTAssertNil(vm.facets, "precondition: facets are still in flight")

    gate.signal()
    await submit.value
    XCTAssertEqual(vm.facets?.total, 1)
  }

  // MARK: - Generated-search collection (#4410)

  func test_showCollection_showsCachedPageWithoutARequest() async throws {
    let counter = RequestCounter()
    let vm = makeCountingVM(counter)
    var seed = SearchParams(libraryID: "lib-test")
    seed.placeQuery = "autumn foliage"

    vm.showCollection(
      params: seed,
      firstPage: GeneratedSearchAssetPage(results: [Self.makeAsset(id: "c1")], total: 3)
    ) { _, _ in GeneratedSearchAssetPage(results: [], total: 3) }
    await vm.submitIfChanged()

    XCTAssertEqual(vm.results.map(\.id), ["c1"])
    XCTAssertEqual(vm.total, 3)
    XCTAssertFalse(vm.isLoading)
    XCTAssertEqual(vm.params.placeQuery, "autumn foliage")
    XCTAssertEqual(counter.count, 0, "the cached page must not re-run the search")
  }

  func test_showCollection_replacesSnapshotWithLivePageThenPaginatesFromIt() async throws {
    let vm = makeVM()
    var requestedOffsets: [Int] = []
    vm.showCollection(
      params: SearchParams(libraryID: "lib-test"),
      firstPage: GeneratedSearchAssetPage(
        results: [Self.makeAsset(id: "snap")], total: 2, isSnapshot: true),
      nextPage: { offset, _ in
        requestedOffsets.append(offset)
        return GeneratedSearchAssetPage(results: [Self.makeAsset(id: "tail")], total: 3)
      },
      liveFirstPage: {
        try? await Task.sleep(for: .milliseconds(50))
        return GeneratedSearchAssetPage(
          results: [Self.makeAsset(id: "live1"), Self.makeAsset(id: "live2")], total: 3)
      })

    XCTAssertEqual(vm.results.map(\.id), ["snap"], "the snapshot paints first")
    await vm.loadMore()
    XCTAssertEqual(requestedOffsets, [], "no pagination while the live page is in flight")

    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while vm.results.map(\.id) != ["live1", "live2"], ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertEqual(vm.results.map(\.id), ["live1", "live2"])
    XCTAssertEqual(vm.total, 3)

    await vm.loadMore()
    XCTAssertEqual(requestedOffsets, [2])
    XCTAssertEqual(vm.results.map(\.id), ["live1", "live2", "tail"])
  }

  func test_showCollection_loadMorePagesThroughTheCollection() async {
    let vm = makeVM()
    var requestedOffsets: [Int] = []
    vm.showCollection(
      params: SearchParams(libraryID: "lib-test"),
      firstPage: GeneratedSearchAssetPage(results: [Self.makeAsset(id: "c1")], total: 2)
    ) { offset, _ in
      requestedOffsets.append(offset)
      return GeneratedSearchAssetPage(results: [Self.makeAsset(id: "c2")], total: 2)
    }

    await vm.loadMore()

    XCTAssertEqual(requestedOffsets, [1])
    XCTAssertEqual(vm.results.map(\.id), ["c1", "c2"])
    XCTAssertFalse(vm.canLoadMore)
  }

  func test_submit_leavesCollectionMode() async {
    let vm = makeVM()
    var pagerCalls = 0
    vm.showCollection(
      params: SearchParams(libraryID: "lib-test"),
      firstPage: GeneratedSearchAssetPage(results: [Self.makeAsset(id: "c1")], total: 5)
    ) { _, _ in
      pagerCalls += 1
      return GeneratedSearchAssetPage(results: [], total: 5)
    }

    await vm.submit()
    vm.seedForLoadMore(results: [Self.makeAsset(id: "s1")], total: 9)
    await vm.loadMore()

    XCTAssertEqual(pagerCalls, 0, "after a new search, paging must not use the collection endpoint")
  }

  func test_resetFilters_dropsFiltersAndResultsWithoutARequest() async {
    let counter = RequestCounter()
    let vm = makeCountingVM(counter)
    vm.params.placeQuery = "autumn"
    vm.params.people = ["Priya Patel"]
    vm.params.sort = .capturedAsc
    vm.showCollection(
      params: vm.params,
      firstPage: GeneratedSearchAssetPage(results: [Self.makeAsset(id: "c1")], total: 1)
    ) { _, _ in GeneratedSearchAssetPage(results: [], total: 1) }

    vm.resetFilters()
    await vm.submitIfChanged()

    XCTAssertFalse(vm.hasUnifiedFilters)
    XCTAssertEqual(vm.params.placeQuery, "")
    XCTAssertEqual(vm.params.sort, .capturedAsc, "sort is a preference, not a filter")
    XCTAssertTrue(vm.results.isEmpty)
    XCTAssertEqual(vm.total, 0)
    XCTAssertEqual(counter.count, 0, "clearing must not fetch anything")
    XCTAssertNil(vm.facets, "the panel must refetch unfiltered facets, not keep the filtered set")
  }

  func test_resetFilters_duringFacetLoad_refetchesForTheNewParams() async throws {
    let gate = SlowFacetsURLProtocol.armGate()
    let server = URL(string: "https://stub.test")!
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [SlowFacetsURLProtocol.self]
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(
        server: server, urlSession: URLSession(configuration: cfg)))
    let vm = SearchViewModel(server: server, libraryID: "lib-test", searchClient: client)
    vm.params.people = ["Priya Patel"]

    let firstLoad = Task { await vm.loadFacetsIfNeeded() }
    try await Task.sleep(for: .milliseconds(50))
    vm.resetFilters()
    // One signal per facets request: the superseded one, then its refetch.
    gate.signal()
    gate.signal()
    await firstLoad.value

    XCTAssertEqual(vm.facets?.total, 1, "the superseded load must refetch for the reset params")
  }

  // MARK: - Helpers

  private func makeVM() -> SearchViewModel {
    let server = URL(string: "https://stub.test")!
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(
        server: server, urlSession: URLSession.stubbedAlwaysFailing(with: URLError(.cancelled))))
    return SearchViewModel(server: server, libraryID: "lib-test", searchClient: client)
  }

  /// A VM whose every request bumps `counter` (then fails at the transport
  /// level), so a test can assert no request was issued.
  private func makeCountingVM(_ counter: RequestCounter) -> SearchViewModel {
    let server = URL(string: "https://stub.test")!
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    StubURLProtocol.reset()
    StubURLProtocol.responder = { _ in
      counter.increment()
      return .failure(URLError(.notConnectedToInternet))
    }
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(
        server: server, urlSession: URLSession(configuration: cfg)))
    return SearchViewModel(server: server, libraryID: "lib-test", searchClient: client)
  }

  private static func makeAsset(id: String) -> SearchAsset {
    SearchAsset(
      id: id, folder_id: "lib-test",
      abs_path: "/photos/\(id).dng",
      filename: "\(id).dng")
  }
}

/// Answers `/api/search` at once and holds `/api/search/facets` on a
/// background queue until the test signals the gate — `StubURLProtocol`
/// answers on the loading thread, so blocking it there would stall both.
final class SlowFacetsURLProtocol: URLProtocol {
  nonisolated(unsafe) private static var gate = DispatchSemaphore(value: 0)

  static func armGate() -> DispatchSemaphore {
    gate = DispatchSemaphore(value: 0)
    return gate
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard request.url?.path == "/api/search/facets" else {
      respond(
        #"{"results":[{"id":"fs:/p/a.dng","folder_id":"lib","abs_path":"/p/a.dng","filename":"a.dng"}],"total":1,"page":0,"limit":100}"#
      )
      return
    }
    let gate = Self.gate
    DispatchQueue.global().async {
      gate.wait()
      self.respond(
        #"{"total":1,"cameras":[],"lenses":[],"extensions":[],"scene_types":[],"activities":[],"subjects":[],"is_screenshot":{"true":0,"false":1,"unknown":0},"people":[],"places":[]}"#
      )
    }
  }

  override func stopLoading() {}

  private func respond(_ json: String) {
    let response = HTTPURLResponse(
      url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(json.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
}
