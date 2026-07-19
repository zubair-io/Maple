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
