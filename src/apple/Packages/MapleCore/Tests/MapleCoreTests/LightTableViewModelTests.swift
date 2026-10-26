// LightTableViewModelTests.swift
//
// While a backup runs into an empty library the screen saver can open before
// the first upload becomes an asset, so the first load legitimately finds
// nothing. `isAwaitingContent` is what keeps the Light Table reloading until
// the library fills, and a populated reload must leave a pool the ambient
// cycle can draw from (#5457).

import XCTest

@testable import MapleCloudKit

@MainActor
final class LightTableViewModelTests: XCTestCase {

  func test_emptyLibraryAwaitsContent_thenAPopulatedReloadFeedsTheCycle() async {
    let stub = LightTableLibraryStub()
    let vm = makeVM(stub, libraryID: "lib-empty-then-filled")

    await vm.load()

    XCTAssertTrue(vm.isAwaitingContent, "an empty library must keep the table reloading")
    XCTAssertNil(vm.loadError, "an empty library is not an error")
    XCTAssertNil(vm.next())

    stub.setAssetIDs(["fs:/p/first-upload.dng"])
    await vm.load()

    XCTAssertFalse(vm.isAwaitingContent, "photos have arrived, so reloading must stop")
    XCTAssertEqual(vm.next()?.id, "fs:/p/first-upload.dng")
  }

  func test_failedLoadAwaitsContent() async {
    let stub = LightTableLibraryStub()
    stub.setFailing(true)
    let vm = makeVM(stub, libraryID: "lib-failing")

    await vm.load()

    XCTAssertTrue(vm.isAwaitingContent)
    XCTAssertNotNil(vm.loadError)
  }

  private func makeVM(_ stub: LightTableLibraryStub, libraryID: String) -> LightTableViewModel {
    let server = URL(string: "https://stub.test")!
    StubURLProtocol.reset()
    StubURLProtocol.responder = { request in stub.respond(to: request) }
    let httpClient = AuthenticatedHTTPClient.unauthenticated(
      server: server, urlSession: TestURLSession.make())
    return LightTableViewModel(
      libraryID: libraryID,
      searchClient: CloudSearchClient(server: server, httpClient: httpClient),
      generatedSearchClient: GeneratedSearchClient(server: server, httpClient: httpClient))
  }

  override func tearDown() {
    StubURLProtocol.reset()
    super.tearDown()
  }
}

/// Serves every `/api/search` source the same asset list (empty until set)
/// and no memories. The responder runs off the main actor.
final class LightTableLibraryStub: @unchecked Sendable {
  private let lock = NSLock()
  private var assetIDs: [String] = []
  private var failing = false

  func setAssetIDs(_ ids: [String]) { lock.withLock { assetIDs = ids } }
  func setFailing(_ value: Bool) { lock.withLock { failing = value } }

  func respond(to request: URLRequest) -> StubResponse {
    let (ids, fails) = lock.withLock { (assetIDs, failing) }
    guard request.url?.path == "/api/search" else {
      return .http(status: 200, body: Data(#"{"results":[]}"#.utf8))
    }
    guard !fails else { return .failure(URLError(.notConnectedToInternet)) }
    let results = ids.map {
      #"{"id":"\#($0)","folder_id":"lib","abs_path":"/p/a.dng","filename":"a.dng"}"#
    }
    let body =
      #"{"total":\#(ids.count),"page":0,"limit":40,"results":["#
      + results.joined(separator: ",") + "]}"
    return .http(status: 200, body: Data(body.utf8))
  }
}
