// GeneratedSearchCollectionsViewModelTests.swift
//
// The cover fetch keeps each collection's first page (#4410), and opening a
// collection reuses it — the iPhone card tap and tvOS Memories both rely on
// `firstPage(of:)` not re-running the collection's query.

import XCTest

@testable import MapleCloudKit

@MainActor
final class GeneratedSearchCollectionsViewModelTests: XCTestCase {
  private static let card = GeneratedSearchCard(
    id: "gs1", theme: "season", title: "Autumn Colour", result_count: 2,
    generated_for: "2026-10-07")

  func test_load_keepsFirstPage_andFirstPageReusesIt() async {
    let stub = CollectionsStub()
    let vm = makeVM(stub)

    await vm.load()
    let page = await vm.firstPage(of: Self.card)

    XCTAssertEqual(vm.covers["gs1"]?.id, "fs:/p/a.dng")
    XCTAssertEqual(page.results.map(\.id), ["fs:/p/a.dng"])
    XCTAssertEqual(page.total, 2)
    XCTAssertEqual(stub.assetRequests, 1, "opening the collection must reuse the cover fetch")
    XCTAssertEqual(stub.lastAssetsLimit, "30")
  }

  func test_firstPage_fetchesWhenNotLoaded() async {
    let stub = CollectionsStub()
    let vm = makeVM(stub)

    let page = await vm.firstPage(of: Self.card)

    XCTAssertEqual(page.results.map(\.id), ["fs:/p/a.dng"])
    XCTAssertEqual(stub.assetRequests, 1)
  }

  private func makeVM(_ stub: CollectionsStub) -> GeneratedSearchCollectionsViewModel {
    let server = URL(string: "https://stub.test")!
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    StubURLProtocol.reset()
    StubURLProtocol.responder = { request in stub.respond(to: request) }
    let client = GeneratedSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(
        server: server, urlSession: URLSession(configuration: cfg)))
    return GeneratedSearchCollectionsViewModel(libraryID: "lib-test", client: client)
  }
}

/// Serves one generated-search card and a one-photo page for its assets,
/// tallying asset requests. The responder runs off the main actor.
final class CollectionsStub: @unchecked Sendable {
  private let lock = NSLock()
  private var _assetRequests = 0
  private var _lastAssetsLimit: String?

  var assetRequests: Int { lock.withLock { _assetRequests } }
  var lastAssetsLimit: String? { lock.withLock { _lastAssetsLimit } }

  func respond(to request: URLRequest) -> StubResponse {
    let url = request.url!
    guard url.path.hasSuffix("/assets") else {
      return .http(
        status: 200,
        body: Data(
          #"{"results":[{"id":"gs1","theme":"season","title":"Autumn Colour","result_count":2,"generated_for":"2026-10-07"}]}"#
            .utf8))
    }
    let limit = URLComponents(url: url, resolvingAgainstBaseURL: false)?
      .queryItems?.first { $0.name == "limit" }?.value
    lock.withLock {
      _assetRequests += 1
      _lastAssetsLimit = limit
    }
    return .http(
      status: 200,
      body: Data(
        #"{"total":2,"results":[{"id":"fs:/p/a.dng","folder_id":"lib","abs_path":"/p/a.dng","filename":"a.dng"}]}"#
          .utf8))
  }
}
