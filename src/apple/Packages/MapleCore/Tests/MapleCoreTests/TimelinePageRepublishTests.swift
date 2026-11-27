import Observation
import XCTest

@testable import MapleCore

@MainActor
final class ObservationChangeCounter {
  private(set) var count = 0
  private let read: @MainActor () -> Void

  init(_ read: @escaping @MainActor () -> Void) {
    self.read = read
    arm()
  }

  private func arm() {
    withObservationTracking {
      read()
    } onChange: { [self] in
      MainActor.assumeIsolated {
        count += 1
        arm()
      }
    }
  }
}

@MainActor
final class TimelinePageRepublishTests: XCTestCase {
  private typealias CloudKey = CloudTimelineViewModel.BucketKey
  private typealias AllKey = AllSourcesTimelineViewModel.BucketKey

  private let server = URL(string: "https://example.test")!
  private let cloudKey = CloudKey(year: 2024, month: 7)
  private let allKey = AllKey(year: 2024, month: 7)

  // MARK: - CloudTimelineViewModel

  func test_cloud_identicalFreshPagePublishesOnce() async throws {
    let page = Self.pageJSON(ids: ["a", "b", "c"])
    let vm = try await makeCloudVM(cached: page, network: page)
    let pages = ObservationChangeCounter { _ = vm.pagesByBucket }
    let merged = ObservationChangeCounter { _ = vm.mergedPagesByBucket }

    await vm.loadPage(year: 2024, month: 7)

    XCTAssertEqual(pages.count, 1)
    XCTAssertEqual(merged.count, 1)
    XCTAssertEqual(vm.pagesByBucket[cloudKey]?.map(\.id), ["a", "b", "c"])
    XCTAssertEqual(vm.mergedPagesByBucket[cloudKey]?.count, 3)
  }

  func test_cloud_differentFreshPageIsPublishedAndMerged() async throws {
    let vm = try await makeCloudVM(
      cached: Self.pageJSON(ids: ["a", "b"]), network: Self.pageJSON(ids: ["a", "b", "c"]))
    let pages = ObservationChangeCounter { _ = vm.pagesByBucket }
    let merged = ObservationChangeCounter { _ = vm.mergedPagesByBucket }

    await vm.loadPage(year: 2024, month: 7)

    XCTAssertEqual(pages.count, 2)
    XCTAssertEqual(merged.count, 2)
    XCTAssertEqual(vm.pagesByBucket[cloudKey]?.map(\.id), ["a", "b", "c"])
    XCTAssertEqual(vm.mergedPagesByBucket[cloudKey]?.count, 3)
  }

  func test_cloud_localChangeAfterSkippedRepublishStillRemerges() async throws {
    let page = Self.pageJSON(ids: ["a"])
    let adapter = try seededAdapter(localIDs: ["L1"])
    let vm = try await makeCloudVM(cached: page, network: page, adapter: adapter)

    await vm.loadPage(year: 2024, month: 7)
    XCTAssertEqual(vm.mergedPagesByBucket[cloudKey]?.count, 2, "one local-only plus one cloud-only")

    adapter.invalidate()
    await adapter.warmUp()

    XCTAssertEqual(vm.mergedPagesByBucket[cloudKey]?.count, 1, "local cell gone after warm-up")
  }

  // MARK: - AllSourcesTimelineViewModel

  func test_allSources_identicalFreshPagePublishesOnce() async throws {
    let page = Self.pageJSON(ids: ["a", "b", "c"])
    let vm = try await makeAllSourcesVM(cached: page, network: page)
    let pages = ObservationChangeCounter { _ = vm.pagesByBucket }
    let merged = ObservationChangeCounter { _ = vm.mergedPagesByBucket }

    await vm.loadPage(year: 2024, month: 7)

    XCTAssertEqual(pages.count, 1)
    XCTAssertEqual(merged.count, 1)
    XCTAssertEqual(vm.pagesByBucket[allKey]?.map(\.id), ["a", "b", "c"])
    XCTAssertEqual(vm.mergedPagesByBucket[allKey]?.count, 3)
  }

  func test_allSources_differentFreshPageIsPublishedAndMerged() async throws {
    let vm = try await makeAllSourcesVM(
      cached: Self.pageJSON(ids: ["a", "b"]), network: Self.pageJSON(ids: ["a", "b", "c"]))
    let pages = ObservationChangeCounter { _ = vm.pagesByBucket }
    let merged = ObservationChangeCounter { _ = vm.mergedPagesByBucket }

    await vm.loadPage(year: 2024, month: 7)

    XCTAssertEqual(pages.count, 2)
    XCTAssertEqual(merged.count, 2)
    XCTAssertEqual(vm.pagesByBucket[allKey]?.map(\.id), ["a", "b", "c"])
    XCTAssertEqual(vm.mergedPagesByBucket[allKey]?.count, 3)
  }

  func test_allSources_localChangeAfterSkippedRepublishStillRemerges() async throws {
    let page = Self.pageJSON(ids: ["a"])
    let adapter = try seededAdapter(localIDs: ["L1"])
    let vm = try await makeAllSourcesVM(cached: page, network: page, adapter: adapter)

    await vm.loadPage(year: 2024, month: 7)
    XCTAssertEqual(vm.mergedPagesByBucket[allKey]?.count, 2, "one local-only plus one cloud-only")

    adapter.invalidate()
    await adapter.warmUp()

    XCTAssertEqual(vm.mergedPagesByBucket[allKey]?.count, 1, "local cell gone after warm-up")
  }

  // MARK: - Fixtures

  private func makeCloudVM(
    cached: String, network: String, adapter: PhotoKitMergeAdapter? = nil
  ) async throws -> CloudTimelineViewModel {
    let pagesCache = CloudPagesCache(baseDir: tmpDir())
    await pagesCache.write(
      host: server.cacheHostKey, libraryID: "lib1", year: 2024, month: 7, page: 0,
      try Self.decode(cached))
    return CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient(serving: network),
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: pagesCache,
      photoKitMerge: adapter ?? PhotoKitMergeAdapter(diskCacheURL: nil))
  }

  private func makeAllSourcesVM(
    cached: String, network: String, adapter: PhotoKitMergeAdapter? = nil
  ) async throws -> AllSourcesTimelineViewModel {
    let pagesCache = CloudPagesCache(baseDir: tmpDir())
    await pagesCache.write(
      host: server.cacheHostKey, libraryID: "lib1", year: 2024, month: 7, page: 0,
      try Self.decode(cached))
    let session = URLSession.stubbed(response: network)
    let source = AllSourcesTimelineViewModel.ServerSource(
      server: server, libraryIDs: ["lib1"],
      searchClient: CloudSearchClient(
        server: server, httpClient: .unauthenticated(server: server, urlSession: session)),
      thumbClient: CloudThumbClient(
        server: server, httpClient: .unauthenticated(server: server, urlSession: session)))
    return AllSourcesTimelineViewModel(
      sources: [source],
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: pagesCache,
      photoKitMerge: adapter ?? PhotoKitMergeAdapter(diskCacheURL: nil))
  }

  private func searchClient(serving json: String) -> CloudSearchClient {
    CloudSearchClient(
      server: server,
      httpClient: .unauthenticated(server: server, urlSession: .stubbed(response: json)))
  }

  private func seededAdapter(localIDs: [String]) throws -> PhotoKitMergeAdapter {
    let refs = localIDs.map {
      ImageRef(
        id: $0, displayName: $0, url: nil,
        captureDate: Date(timeIntervalSince1970: 1_720_000_000))
    }
    let url = tmpDir().appendingPathExtension("json")
    try PhotoKitMergeAdapter.encodeBuckets(
      [PhotoKitMergeAdapter.BucketKey(year: 2024, month: 7): refs]
    ).write(to: url)
    return PhotoKitMergeAdapter(diskCacheURL: url)
  }

  static func pageJSON(ids: [String]) -> String {
    let rows = ids.map { id in
      """
      {"id":"\(id)","folder_id":"lib1","abs_path":"/lib/2024/07/\(id).dng","filename":"\(id).dng",
       "size":1024,"mtime":null,"captured_at":"2024-07-10T11:32:07.000Z","camera":null,"lens":null,
       "iso":null,"aperture":null,"shutter":null,"focal_length":null,
       "rating":null,"flag":null,"color_label":null}
      """
    }
    let results = rows.joined(separator: ",")
    return #"{"total":\#(ids.count),"page":0,"limit":200,"results":[\#(results)]}"#
  }

  private static func decode(_ json: String) throws -> SearchResponse {
    try JSONDecoder().decode(SearchResponse.self, from: Data(json.utf8))
  }

  private func tmpDir() -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("TimelinePageRepublishTests-\(UUID())")
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
}
