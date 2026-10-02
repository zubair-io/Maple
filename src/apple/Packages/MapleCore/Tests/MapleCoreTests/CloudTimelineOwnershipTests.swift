import XCTest

@testable import MapleCore

@MainActor
final class CloudTimelineOwnershipTests: XCTestCase {
  func testOldOwnerCompletionCannotOverwriteRowsOrReleaseNewOwnersInFlightKey() async throws {
    let server = URL(string: "https://example.test")!
    let gate = OwnerRequestGate()
    addTeardownBlock { await gate.releaseAll() }
    let session = URLSession.stubbedSequence(
      onRequestStart: { await gate.enter() },
      { request in
        let owner =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
          .first { $0.name == "ownerId" }?.value ?? "all"
        return (
          Self.pageData(owner),
          HTTPURLResponse(
            url: request.url!, statusCode: 200,
            httpVersion: nil, headerFields: nil)!
        )
      })
    let vm = makeVM(server: server, session: session)
    let key = CloudTimelineViewModel.BucketKey(year: 2026, month: 1)
    let old = Task { await vm.loadPage(year: 2026, month: 1) }
    try await gate.waitForArrival(1)
    vm.setOwnerID("member")
    let fresh = Task { await vm.loadPage(year: 2026, month: 1) }
    try await gate.waitForArrival(2)
    await gate.release(1)
    await old.value
    XCTAssertNil(vm.pagesByBucket[key])
    XCTAssertTrue(
      vm.inFlight.contains(key), "old cleanup must leave the new owner's request registered")
    await gate.release(2)
    await fresh.value
    XCTAssertEqual(vm.pagesByBucket[key]?.map(\.id), ["member"])
    XCTAssertTrue(vm.inFlight.isEmpty)
  }

  func testOfflineOwnerUsesItsOwnBucketAndPageCaches() async throws {
    let server = URL(string: "https://example.test")!
    let buckets = CloudBucketsCache(baseDir: temporaryDirectory())
    let pages = CloudPagesCache(baseDir: temporaryDirectory())
    for owner in [nil, "member-a", "member-b"] as [String?] {
      let count = owner == "member-a" ? 1 : 9
      await buckets.write(
        host: server.cacheHostKey, libraryID: "lib", pathPrefix: "folder",
        ownerID: owner,
        TimelineBuckets(
          total: count,
          buckets: [TimelineBucket(year: 2026, month: 1, count: count)], untimed_count: 0))
      let page = try JSONDecoder().decode(SearchResponse.self, from: Self.pageData(owner ?? "all"))
      await pages.write(
        host: server.cacheHostKey, libraryID: "lib", pathPrefix: "folder",
        ownerID: owner, year: 2026, month: 1, page: 0, page)
    }
    let session = URLSession.stubbed(response: "offline", status: 503)
    let client = CloudSearchClient(
      server: server,
      httpClient: .unauthenticated(server: server, urlSession: session))
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib", pathPrefix: "folder",
      searchClient: client, bucketsCache: buckets, pagesCache: pages)
    vm.setOwnerID("member-a")
    await vm.loadBuckets()
    await vm.loadPage(year: 2026, month: 1)
    XCTAssertEqual(vm.buckets.first?.count, 1)
    let key = CloudTimelineViewModel.BucketKey(year: 2026, month: 1)
    XCTAssertEqual(vm.pagesByBucket[key]?.map(\.id), ["member-a"])
    XCTAssertNotNil(vm.loadError)
    vm.setOwnerID("member-b")
    XCTAssertTrue(vm.pagesByBucket.isEmpty)
    XCTAssertTrue(vm.buckets.isEmpty)
    await vm.loadBuckets()
    await vm.loadPage(year: 2026, month: 1)
    XCTAssertEqual(vm.buckets.first?.count, 9)
    XCTAssertEqual(vm.pagesByBucket[key]?.map(\.id), ["member-b"])
    vm.setOwnerID("")
    XCTAssertNil(vm.ownerID)
    await vm.loadPage(year: 2026, month: 1)
    XCTAssertEqual(vm.pagesByBucket[key]?.map(\.id), ["all"])
  }

  private func makeVM(server: URL, session: URLSession) -> CloudTimelineViewModel {
    let client = CloudSearchClient(
      server: server,
      httpClient: .unauthenticated(server: server, urlSession: session))
    return CloudTimelineViewModel(
      server: server, libraryID: "lib", searchClient: client,
      bucketsCache: CloudBucketsCache(baseDir: temporaryDirectory()),
      pagesCache: CloudPagesCache(baseDir: temporaryDirectory()))
  }

  private func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }

  private nonisolated static func pageData(_ id: String) -> Data {
    Data(
      "{\"total\":1,\"page\":0,\"limit\":200,\"results\":[{\"id\":\"\(id)\",\"folder_id\":\"lib\",\"abs_path\":\"/\(id).dng\",\"filename\":\"\(id).dng\",\"size\":1}]}"
        .utf8)
  }
}
