// CloudTimelineUnionTests.swift
//
// Covers the PhotoKit + Cloud bucket UNION behaviour of
// CloudTimelineViewModel (issue #616): the timeline must be the union of
// both streams, seeded from PhotoKit for instant / offline first paint, and
// must keep showing local cells when the cloud page is empty or unreachable.
//
// Split out from CloudTimelineViewModelTests to keep both files under the
// 600-LOC hard budget (tools/check-file-budget.sh).

import XCTest
@testable import MapleCore

@MainActor
final class CloudTimelineUnionTests: XCTestCase {

  /// The section list must be seeded from PhotoKit synchronously at init —
  /// before any /api/search/buckets round-trip — so the local half of the
  /// timeline paints within one frame of launch and works offline.
  func test_init_seedsBucketsFromPhotoKitWithoutNetwork() throws {
    let server = URL(string: "https://example.test")!
    // An unreachable client — the assert runs before any await, so init
    // must not depend on the network to populate the section list.
    let searchClient = CloudSearchClient.preview(server: server)

    let (adapter, _) = try makeAdapterSeeded(localIDs: ["P1", "P2"], year: 2024, month: 7)
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()),
      photoKitMerge: adapter)

    XCTAssertTrue(vm.buckets.contains { $0.year == 2024 && $0.month == 7 },
                  "init must seed buckets from PhotoKit; got \(vm.buckets)")
    XCTAssertEqual(vm.buckets.first { $0.year == 2024 && $0.month == 7 }?.count, 2)
  }

  /// A month that exists ONLY in PhotoKit (not yet backed up) must get a
  /// section even though the cloud's /buckets feed doesn't list it.
  func test_loadBuckets_unionsLocalOnlyMonth() async throws {
    let server = URL(string: "https://example.test")!
    // Cloud knows about 2024-06 only.
    let json = """
    {"total":1,"buckets":[{"year":2024,"month":6,"count":1}],"untimed_count":0}
    """
    let session = URLSession.stubbed(response: json)
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    // PhotoKit knows about 2024-07 (local-only).
    let (adapter, _) = try makeAdapterSeeded(localIDs: ["P1"], year: 2024, month: 7)
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()),
      photoKitMerge: adapter)

    await vm.loadBuckets()

    XCTAssertTrue(vm.buckets.contains { $0.year == 2024 && $0.month == 7 },
                  "local-only month missing from union: \(vm.buckets)")
    XCTAssertTrue(vm.buckets.contains { $0.year == 2024 && $0.month == 6 },
                  "cloud month missing from union: \(vm.buckets)")
    // Descending order: 2024-07 before 2024-06.
    XCTAssertEqual(vm.buckets.first?.month, 7)
  }

  /// The reported bug: when the cloud page is empty (server inconsistency or
  /// offline) the section must still render the PhotoKit-local cells instead
  /// of going blank. merge(local, []) → all .localOnly.
  func test_loadPage_rendersLocalCellsWhenCloudPageEmpty() async throws {
    let server = URL(string: "https://example.test")!
    let emptyPage = """
    {"total":0,"page":0,"limit":200,"results":[]}
    """
    let session = URLSession.stubbed(response: emptyPage)
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let (adapter, _) = try makeAdapterSeeded(localIDs: ["P1", "P2"], year: 2024, month: 7)
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()),
      photoKitMerge: adapter)

    await vm.loadPage(year: 2024, month: 7)
    let key = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)
    let merged = vm.mergedPagesByBucket[key] ?? []
    XCTAssertEqual(merged.count, 2,
                   "expected the two local cells to survive an empty cloud page, got \(merged)")
    XCTAssertTrue(merged.allSatisfy {
      if case .localOnly = $0 { return true }
      return false
    }, "every cell should be .localOnly when the cloud page is empty: \(merged)")
  }

  // MARK: - Helpers

  /// Construct a PhotoKitMergeAdapter pre-seeded with one month of ImageRefs
  /// by writing the on-disk cache fixture `init(diskCacheURL:)` reads.
  private func makeAdapterSeeded(localIDs: [String],
                                 year: Int, month: Int) throws -> (PhotoKitMergeAdapter, URL) {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("UnionTests-merge-\(UUID()).json")
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }

    let refs = localIDs.map { ImageRef(id: $0, displayName: $0, url: nil, captureDate: nil) }
    let key = PhotoKitMergeAdapter.BucketKey(year: year, month: month)
    let buckets: [PhotoKitMergeAdapter.BucketKey: [ImageRef]] = [key: refs]
    try PhotoKitMergeAdapter.encodeBuckets(buckets).write(to: url)
    return (PhotoKitMergeAdapter(diskCacheURL: url), url)
  }

  private func tmpDir() -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("UnionTests-\(UUID())")
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
}
