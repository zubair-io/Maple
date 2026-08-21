// SearchViewModelTests.swift
//
// Regression tests for SearchViewModel cancellation behaviour introduced in
// PR #467 (fix(apple): cloud search polish — silent cancellation).
//
// A cancelled request (URLError.cancelled / CancellationError) must:
//   - leave loadError == nil  (no spurious error banner)
//   - leave existing results intact (results not cleared)
//
// Uses StubURLProtocol to deliver a transport-level cancellation error
// without any real network involvement.

import XCTest
@testable import MapleCore
@testable import MapleCloudKit

@MainActor
final class SearchViewModelTests: XCTestCase {

  // MARK: - submit() cancellation

  func test_submit_urlErrorCancelled_doesNotSetLoadError() async {
    let vm = makeVM(throwing: URLError(.cancelled))
    await vm.submit()
    XCTAssertNil(vm.loadError,
      "A cancelled request must not surface an error banner")
  }

  func test_submit_urlErrorCancelled_doesNotClearExistingResults() async {
    let existing = [makeAsset(id: "keep-me")]
    let vm = makeVM(throwing: URLError(.cancelled), preSeedResults: existing)
    await vm.submit()
    // results must be unchanged — we kept the old set
    XCTAssertEqual(vm.results.map(\.id), existing.map(\.id),
      "Cancellation must leave existing results in place")
  }

  func test_submit_swiftCancellationError_doesNotSetLoadError() async {
    let vm = makeVM(throwing: CancellationError())
    await vm.submit()
    XCTAssertNil(vm.loadError,
      "A Swift CancellationError must not surface an error banner")
  }

  func test_submit_swiftCancellationError_doesNotClearExistingResults() async {
    let existing = [makeAsset(id: "keep-me-2")]
    let vm = makeVM(throwing: CancellationError(), preSeedResults: existing)
    await vm.submit()
    XCTAssertEqual(vm.results.map(\.id), existing.map(\.id))
  }

  // MARK: - loadMore() cancellation

  func test_loadMore_urlErrorCancelled_doesNotSetLoadError() async {
    // Seed the VM with one page of results so canLoadMore is true.
    let vm = makeVM(throwing: URLError(.cancelled))
    // Directly seed state as if a prior submit succeeded.
    vm.seedForLoadMore(results: [makeAsset(id: "p1")], total: 99)

    await vm.loadMore()

    XCTAssertNil(vm.loadError,
      "A cancelled loadMore must not set loadError")
  }

  func test_loadMore_urlErrorCancelled_doesNotMutateResults() async {
    let vm = makeVM(throwing: URLError(.cancelled))
    let seed = [makeAsset(id: "p1"), makeAsset(id: "p2")]
    vm.seedForLoadMore(results: seed, total: 99)

    await vm.loadMore()

    XCTAssertEqual(vm.results.map(\.id), seed.map(\.id),
      "Cancelled loadMore must not append or remove results")
  }

  // MARK: - cancelPendingDebounce()

  // Observe whether the debounce fired by counting issued requests, not by
  // watching loadError: the auth HTTP client retries a transport failure
  // with backoff, so the error only lands after the request already started
  // — but the request (the responder call) happens right after the debounce.

  func test_cancelPendingDebounce_preventsScheduledSubmit() async throws {
    let counter = RequestCounter()
    let vm = makeCountingVM(counter)
    vm.params.placeQuery = "cat"
    vm.queryChanged()             // schedules the 250 ms debounced submit
    vm.cancelPendingDebounce()    // ...which we cancel before it can fire
    try await Task.sleep(for: .milliseconds(400))
    XCTAssertEqual(counter.count, 0,
      "A cancelled debounce must issue no search request")
  }

  func test_queryChanged_withoutCancel_firesSubmit() async throws {
    // Control: proves the debounce actually fires, so the cancel test above
    // isn't passing vacuously.
    let counter = RequestCounter()
    let vm = makeCountingVM(counter)
    vm.params.placeQuery = "cat"
    vm.queryChanged()
    try await Task.sleep(for: .milliseconds(400))
    XCTAssertGreaterThan(counter.count, 0,
      "An un-cancelled debounce must issue at least one request")
  }

  // MARK: - Filters-only search (#2866)

  func test_filtersOnlySearch_emptyTextStillFetches() async throws {
    // A search with no free text but an active unified filter (people /
    // place / date) is a real search — it must hit the network.
    let counter = RequestCounter()
    let vm = makeCountingVM(counter)
    vm.params.placeQuery = ""
    vm.params.place = ["Portland, OR"]
    XCTAssertTrue(vm.hasUnifiedFilters)
    vm.queryChanged()
    try await Task.sleep(for: .milliseconds(400))
    XCTAssertGreaterThan(counter.count, 0,
      "A filters-only search (empty text) must issue a request")
  }

  func test_unifiedFilterCount_passthrough() {
    let server = URL(string: "https://acct.example")!
    let vm = SearchViewModel(
      server: server,
      libraryID: nil,
      searchClient: CloudSearchClient.preview(server: server))
    XCTAssertEqual(vm.unifiedFilterCount, 0)
    vm.params.people = ["Priya Patel"]
    vm.params.from = "2026-01-01"
    XCTAssertEqual(vm.unifiedFilterCount, 2)
    XCTAssertTrue(vm.hasUnifiedFilters)
  }

  // MARK: - Facets-only load (#2879)

  func test_loadFacetsIfNeeded_populatesPickersWithoutRunningASearch() async {
    let stub = FacetStub()
    let vm = makeFacetVM(stub)

    await vm.loadFacetsIfNeeded()

    XCTAssertEqual(vm.peopleFacets.compactMap(\.value), ["Priya Patel"])
    XCTAssertEqual(vm.placeFacets.compactMap(\.value), ["Portland, OR"])
    XCTAssertTrue(vm.results.isEmpty,
      "A facets-only load must not populate results — the iPhone empty-query state shows Recents")
    XCTAssertEqual(stub.count(for: "/api/search"), 0,
      "A facets-only load must not hit the result endpoint")
    XCTAssertEqual(stub.count(for: "/api/search/facets"), 1)
  }

  func test_loadFacetsIfNeeded_isIdempotent() async {
    let stub = FacetStub()
    let vm = makeFacetVM(stub)

    await vm.loadFacetsIfNeeded()
    await vm.loadFacetsIfNeeded()

    XCTAssertEqual(stub.count(for: "/api/search/facets"), 1,
      "A second call with facets already loaded must not re-request")
  }

  func test_submitError_preservesPreviouslyLoadedFacets() async {
    let stub = FacetStub()
    let vm = makeFacetVM(stub)
    await vm.loadFacetsIfNeeded()
    XCTAssertFalse(vm.peopleFacets.isEmpty, "precondition: facets loaded")

    stub.failEverything = true
    await vm.submit()

    XCTAssertNotNil(vm.loadError, "precondition: the search actually failed")
    XCTAssertTrue(vm.results.isEmpty)
    XCTAssertEqual(vm.peopleFacets.compactMap(\.value), ["Priya Patel"],
      "A failed search must keep the last good facets — an aggregation hiccup shouldn't blank the pickers")
    XCTAssertEqual(vm.placeFacets.compactMap(\.value), ["Portland, OR"])
  }

  // MARK: - Account-wide search (nil libraryID)

  @MainActor
  func test_accountWideInit_omitsLibraryIdOnWire() {
    let server = URL(string: "https://acct.example")!
    let vm = SearchViewModel(
      server: server,
      libraryID: nil,
      searchClient: CloudSearchClient.preview(server: server))
    let items = vm.params.listQueryItems(page: 0, limit: 100)
    XCTAssertFalse(items.contains { $0.name == "libraryId" },
                   "account-wide search must not send a libraryId")
  }

  // MARK: - Helpers

  /// Build a SearchViewModel backed by a stub that immediately throws `error`
  /// for every request. When `preSeedResults` is non-empty the VM's results
  /// are set BEFORE submit() is called, simulating a prior successful load.
  // MARK: - Inferred-date attribution across the cache fast path (#2960)

  /// `submit()` short-circuits on a cached page. That path set results,
  /// cursor, total and facets but not `appliedDates`, so the previous
  /// query's window stayed on screen — the chip asserting a date filter the
  /// current query does not carry, which is the exact false state it exists
  /// to prevent.
  @MainActor func test_cachedPage_refreshesAppliedDates() async {
    let server = URL(string: "https://stub.test")!
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    StubURLProtocol.reset()
    StubURLProtocol.responder = { request in
      if (request.url?.path ?? "") == "/api/search/facets" {
        return .http(status: 200, body: Data(Self.minimalFacetsJSON.utf8))
      }
      // Only the dated query carries a window.
      let dated = (request.url?.query ?? "").contains("2024")
      let body = dated
        // `page` and `limit` are non-optional on `SearchResponse`; omitting
        // them makes decoding throw and the VM take its error path, which
        // looks exactly like "the field was never set".
        ? #"{"results":[],"total":0,"page":0,"limit":100,"dateFilter":{"from":"2024-01-01T00:00:00.000Z","to":"2024-12-31T23:59:59.999Z","inferredFrom":"2024"}}"#
        : #"{"results":[],"total":0,"page":0,"limit":100}"#
      return .http(status: 200, body: Data(body.utf8))
    }
    defer { StubURLProtocol.reset() }

    let session = URLSession(configuration: cfg)
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let vm = SearchViewModel(server: server, libraryID: "lib-test", searchClient: client)

    // 1. Undated query over the network — caches it, no window.
    vm.params.placeQuery = "beach"
    await vm.submit()
    XCTAssertNil(vm.appliedDates)

    // 2. Dated query — window applied and attributed.
    vm.params.placeQuery = "2024"
    await vm.submit()
    XCTAssertEqual(vm.appliedDates?.inferredFrom, "2024")

    // 3. Back to the undated query, now served from cache. Before the fix
    //    this still reported the 2024 window.
    vm.params.placeQuery = "beach"
    await vm.submit()
    XCTAssertNil(vm.appliedDates, "cached page left the previous query's date attribution on screen")
  }

  private static let minimalFacetsJSON = """
  {"total":0,"cameras":[],"lenses":[],"extensions":[],"scene_types":[],\
  "activities":[],"subjects":[],"is_screenshot":{"true":0,"false":0,"unknown":0},\
  "people":[],"places":[]}
  """

  private func makeVM(
    throwing error: Error,
    preSeedResults: [SearchAsset] = []
  ) -> SearchViewModel {
    let server = URL(string: "https://stub.test")!
    let session = URLSession.stubbedAlwaysFailing(with: error)
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let vm = SearchViewModel(server: server, libraryID: "lib-test", searchClient: client)
    if !preSeedResults.isEmpty {
      // Use the test-only setter so we can verify results survive cancellation.
      vm.setResultsForTesting(preSeedResults)
    }
    return vm
  }

  private func makeAsset(id: String) -> SearchAsset {
    SearchAsset(id: id, folder_id: "lib-test",
                abs_path: "/photos/\(id).dng",
                filename: "\(id).dng")
  }

  /// A VM whose every request bumps `counter` (then fails at the transport
  /// level). Lets a test assert whether the debounced `submit()` actually
  /// issued a request, independent of when the retried failure surfaces.
  private func makeCountingVM(_ counter: RequestCounter) -> SearchViewModel {
    let server = URL(string: "https://stub.test")!
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    StubURLProtocol.reset()
    StubURLProtocol.responder = { _ in
      counter.increment()
      return .failure(URLError(.notConnectedToInternet))
    }
    let session = URLSession(configuration: cfg)
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    return SearchViewModel(server: server, libraryID: "lib-test", searchClient: client)
  }

  /// A VM whose `/api/search/facets` responses come from `stub` (which also
  /// tallies requests per path, and can be flipped to fail everything).
  private func makeFacetVM(_ stub: FacetStub) -> SearchViewModel {
    let server = URL(string: "https://stub.test")!
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    StubURLProtocol.reset()
    StubURLProtocol.responder = { request in stub.respond(to: request) }
    let session = URLSession(configuration: cfg)
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    return SearchViewModel(server: server, libraryID: "lib-test", searchClient: client)
  }
}

/// Serves a fixed facets payload, tallies requests per URL path, and can be
/// switched to fail every request (the "aggregation hiccup" case). The
/// responder runs off the main actor, so the state is lock-guarded.
final class FacetStub: @unchecked Sendable {
  private let lock = NSLock()
  private var counts: [String: Int] = [:]
  private var _failEverything = false

  var failEverything: Bool {
    get { lock.withLock { _failEverything } }
    set { lock.withLock { _failEverything = newValue } }
  }

  func count(for path: String) -> Int { lock.withLock { counts[path] ?? 0 } }

  func respond(to request: URLRequest) -> StubResponse {
    let path = request.url?.path ?? ""
    let failing: Bool = lock.withLock {
      counts[path, default: 0] += 1
      return _failEverything
    }
    if failing { return .http(status: 500, body: Data("boom".utf8)) }
    guard path == "/api/search/facets" else {
      return .http(status: 200, body: Data(#"{"results":[],"total":0}"#.utf8))
    }
    return .http(status: 200, body: Data(Self.facetsJSON.utf8))
  }

  private static let facetsJSON = """
  {"total":7,"cameras":[],"lenses":[],"extensions":[],"scene_types":[],\
  "activities":[],"subjects":[],"is_screenshot":{"true":0,"false":7,"unknown":0},\
  "people":[{"value":"Priya Patel","count":4}],\
  "places":[{"value":"Portland, OR","count":3}]}
  """
}

/// Thread-safe request tally — `StubURLProtocol`'s responder runs off the
/// main actor, so the increment needs a lock.
final class RequestCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var _count = 0
  var count: Int { lock.withLock { _count } }
  func increment() { lock.withLock { _count += 1 } }
}

// MARK: - Test-only SearchViewModel extensions

extension SearchViewModel {
  /// Seed results + total directly, bypassing the network, so tests can
  /// verify that a subsequent cancellation leaves the state intact.
  @MainActor func setResultsForTesting(_ assets: [SearchAsset]) {
    _test_setResults(assets)
  }

  /// Seed the state that loadMore() requires to proceed (canLoadMore == true).
  @MainActor func seedForLoadMore(results: [SearchAsset], total: Int) {
    _test_seedForLoadMore(results: results, total: total)
  }
}

// MARK: - URLSession stub that always fails with a given error

extension URLSession {
  /// A stubbed URLSession that fails every request with `error`, simulating
  /// a transport-level cancellation (URLError(.cancelled)) or task cancellation.
  static func stubbedAlwaysFailing(with error: Error) -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    StubURLProtocol.reset()
    let captured = error   // capture before closure
    StubURLProtocol.responder = { _ in
      if let urlError = captured as? URLError {
        return .failure(urlError)
      }
      // For Swift CancellationError (not a URLError), map to the nearest
      // URLError equivalent — the VM path checks isCancellation() which
      // accepts NSURLErrorCancelled too.
      return .failure(URLError(.cancelled))
    }
    return URLSession(configuration: cfg)
  }
}
