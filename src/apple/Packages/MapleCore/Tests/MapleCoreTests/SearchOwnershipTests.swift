import XCTest

@testable import MapleCloudKit
@testable import MapleCore

@MainActor
final class SearchOwnershipTests: XCTestCase {
  func testPreviousOwnersPaginationCannotAppendOrClearNewRequestState() async throws {
    let server = URL(string: "https://example.test")!
    let gate = OwnerRequestGate()
    addTeardownBlock { await gate.releaseAll() }
    let session = URLSession.stubbedSequence(
      onRequestStart: { await gate.enter() },
      { request in
        let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
        let owner = items.first { $0.name == "ownerId" }?.value ?? "all"
        let page = items.first { $0.name == "page" }?.value ?? "0"
        let body =
          request.url!.path.hasSuffix("facets")
          ? #"{"total":3,"cameras":[],"lenses":[],"extensions":[],"scene_types":[],"activities":[],"subjects":[],"is_screenshot":{"true":0,"false":0,"unknown":0}}"#
          : "{\"total\":3,\"page\":\(page),\"limit\":1,\"results\":[{\"id\":\"\(owner)-\(page)\",\"folder_id\":\"lib\",\"abs_path\":\"/\(owner).dng\",\"filename\":\"file.dng\",\"size\":1}]}"
        return (
          Data(body.utf8),
          HTTPURLResponse(
            url: request.url!, statusCode: 200,
            httpVersion: nil, headerFields: nil)!
        )
      })
    let client = CloudSearchClient(
      server: server,
      httpClient: .unauthenticated(server: server, urlSession: session))
    let vm = SearchViewModel(server: server, libraryID: "lib", searchClient: client, limit: 1)
    vm._testSeedForLoadMore(
      results: [
        SearchAsset(
          id: "seed", folder_id: "lib",
          abs_path: "/seed.dng", filename: "seed.dng", size: 1)
      ], total: 3)
    let old = Task { await vm.loadMore() }
    try await gate.waitForArrival(1)
    vm.params.ownerID = "member"
    XCTAssertTrue(vm.results.isEmpty)
    let first = Task { await vm.submit() }
    try await gate.waitForArrival(3)
    await gate.release(2)
    await gate.release(3)
    await first.value
    XCTAssertEqual(vm.results.map(\.id), ["member-0"])
    XCTAssertEqual(vm.page, 0)
    let next = Task { await vm.loadMore() }
    try await gate.waitForArrival(4)
    await gate.release(1)
    await old.value
    XCTAssertTrue(vm.isLoadingMore)
    XCTAssertEqual(vm.results.map(\.id), ["member-0"])
    await gate.release(4)
    await next.value
    XCTAssertEqual(vm.results.map(\.id), ["member-0", "member-1"])
    XCTAssertEqual(vm.page, 1)
    XCTAssertFalse(vm.isLoadingMore)
  }
}
