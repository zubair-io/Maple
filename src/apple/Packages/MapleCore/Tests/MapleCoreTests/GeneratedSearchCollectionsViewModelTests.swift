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

  func test_cover_isTheFirstPhotoOfTheSnapshotPage() async {
    let stub = CollectionsStub()
    let vm = makeVM(stub)

    await vm.load()

    XCTAssertEqual(vm.covers["gs1"]?.abs_path, "/p/a.dng")
    XCTAssertEqual(stub.coverRequests, 0, "no direct asset lookup may feed a cover")
  }

  func test_prefetchAsksForTheSnapshot_andTheLiveReloadDoesNot() async {
    let stub = CollectionsStub()
    let vm = makeVM(stub)

    await vm.load()
    let snapshot = await vm.firstPage(of: Self.card)
    XCTAssertTrue(snapshot.isSnapshot)
    XCTAssertEqual(stub.snapshotFlags, [true])

    let live = await vm.liveFirstPage(of: "gs1")
    XCTAssertEqual(live?.isSnapshot, false)
    XCTAssertEqual(stub.snapshotFlags, [true, false])
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
  private let coverAssetID: String?

  init(coverAssetID: String? = "cov1") {
    self.coverAssetID = coverAssetID
  }
  private var _assetRequests = 0
  private var _lastAssetsLimit: String?
  private var _coverRequests = 0
  private var _snapshotFlags: [Bool] = []

  var snapshotFlags: [Bool] { lock.withLock { _snapshotFlags } }
  var coverRequests: Int { lock.withLock { _coverRequests } }
  var assetRequests: Int { lock.withLock { _assetRequests } }
  var lastAssetsLimit: String? { lock.withLock { _lastAssetsLimit } }

  func respond(to request: URLRequest) -> StubResponse {
    let url = request.url!
    if url.path == "/api/assets/cov1" {
      lock.withLock { _coverRequests += 1 }
      return .http(
        status: 200,
        body: Data(#"{"abs_path":"/p/cover.dng","filename":"cover.dng"}"#.utf8))
    }
    guard url.path.hasSuffix("/assets") else {
      return .http(
        status: 200,
        body: Data(
          (#"{"results":[{"id":"gs1","theme":"season","title":"Autumn Colour","result_count":2,"#
            + (coverAssetID.map { #""cover_asset_id":"\#($0)","# } ?? "")
            + #""generated_for":"2026-10-07"}]}"#)
            .utf8))
    }
    let limit = URLComponents(url: url, resolvingAgainstBaseURL: false)?
      .queryItems?.first { $0.name == "limit" }?.value
    let snapshot =
      URLComponents(url: url, resolvingAgainstBaseURL: false)?
      .queryItems?.contains { $0.name == "snapshot" && $0.value == "1" } ?? false
    lock.withLock {
      _assetRequests += 1
      _lastAssetsLimit = limit
      _snapshotFlags.append(snapshot)
    }
    let asset =
      #"{"id":"fs:/p/a.dng","folder_id":"lib","abs_path":"/p/a.dng","filename":"a.dng"}"#
    return .http(
      status: 200,
      body: Data(#"{"total":2,"snapshot":\#(snapshot),"results":[\#(asset)]}"#.utf8))
  }
}
