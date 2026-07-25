// AllSourcesTimelineViewModelTests.swift
//
// #2273 — covers the two things unique to the aggregating VM over its
// single-library sibling (`CloudTimelineViewModelTests`):
//   1. bucket-count UNION math across several (server, library) sources
//      plus PhotoKit — a pure function, tested directly.
//   2. page-load fan-out across two distinct servers, merged into one cell
//      list, with per-asset routing back to the server that owns it.

import XCTest
@testable import MapleCore

@MainActor
final class AllSourcesTimelineViewModelTests: XCTestCase {

  typealias BucketKey = AllSourcesTimelineViewModel.BucketKey

  // MARK: - Pure bucket-union math

  /// Distinct (server, library) counts SUM (they're disjoint populations),
  /// then the PhotoKit local count folds in via `max` per month — matching
  /// `CloudTimelineViewModel`'s "at least one non-zero side wins" estimate.
  func test_unionBuckets_sumsAcrossSourcesAndMaxesWithLocal() throws {
    let julKey = BucketKey(year: 2024, month: 7)
    let junKey = BucketKey(year: 2024, month: 6)

    let serverA: [BucketKey: Int] = [julKey: 3, junKey: 1]
    let serverB: [BucketKey: Int] = [julKey: 2]
    // PhotoKit reports MORE for June than either cloud source alone — its
    // count must win via `max`, not get summed on top of the cloud count.
    let local: [(key: BucketKey, count: Int)] = [(key: junKey, count: 5)]

    let result = AllSourcesTimelineViewModel.unionBuckets(
      perSourceCounts: [serverA, serverB], localBuckets: local)

    let july = try XCTUnwrap(result.first { $0.year == 2024 && $0.month == 7 })
    XCTAssertEqual(july.count, 5, "July: 3 (server A) + 2 (server B) = 5")

    let june = try XCTUnwrap(result.first { $0.year == 2024 && $0.month == 6 })
    XCTAssertEqual(june.count, 5, "June: max(1 cloud, 5 local) = 5, not summed")

    // Descending year/month order, matching the cloud feed.
    XCTAssertEqual(result.first?.month, 7)
  }

  /// A month present ONLY in PhotoKit (no source has it) must still appear.
  func test_unionBuckets_includesLocalOnlyMonth() {
    let augKey = BucketKey(year: 2024, month: 8)
    let result = AllSourcesTimelineViewModel.unionBuckets(
      perSourceCounts: [[:]], localBuckets: [(key: augKey, count: 4)])

    XCTAssertEqual(result.count, 1)
    XCTAssertEqual(result.first?.count, 4)
  }

  /// No sources, no local content → empty, not a crash.
  func test_unionBuckets_emptyEverything() {
    XCTAssertTrue(AllSourcesTimelineViewModel.unionBuckets(perSourceCounts: [], localBuckets: []).isEmpty)
  }

  // MARK: - Fan-out across servers

  /// `loadBuckets()` fans `/api/search/buckets` out to every (server,
  /// library) and sums their counts into one union. Two DISTINCT servers,
  /// distinguished by host, each answering for their own single library.
  func test_loadBuckets_fansOutAcrossServersAndSumsCounts() async throws {
    let serverA = URL(string: "https://cloud-a.test")!
    let serverB = URL(string: "https://cloud-b.test")!

    let session = URLSession.stubbedSequence { req in
      let host = req.url?.host ?? ""
      let json: String
      if host == "cloud-a.test" {
        json = #"{"total":3,"buckets":[{"year":2024,"month":7,"count":3}],"untimed_count":0}"#
      } else {
        json = #"{"total":2,"buckets":[{"year":2024,"month":7,"count":2}],"untimed_count":0}"#
      }
      let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                  headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }

    let sourceA = AllSourcesTimelineViewModel.ServerSource(
      server: serverA, libraryIDs: ["libA"],
      searchClient: CloudSearchClient(server: serverA,
                                       httpClient: .unauthenticated(server: serverA, urlSession: session)),
      thumbClient: CloudThumbClient(server: serverA,
                                     httpClient: .unauthenticated(server: serverA, urlSession: session)))
    let sourceB = AllSourcesTimelineViewModel.ServerSource(
      server: serverB, libraryIDs: ["libB"],
      searchClient: CloudSearchClient(server: serverB,
                                       httpClient: .unauthenticated(server: serverB, urlSession: session)),
      thumbClient: CloudThumbClient(server: serverB,
                                     httpClient: .unauthenticated(server: serverB, urlSession: session)))

    let vm = AllSourcesTimelineViewModel(
      sources: [sourceA, sourceB],
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()))

    await vm.loadBuckets()

    XCTAssertEqual(vm.buckets.count, 1)
    XCTAssertEqual(vm.buckets.first?.count, 5, "3 (server A) + 2 (server B) = 5")
    XCTAssertNil(vm.loadError, "both sources succeeded — no error banner")
  }

  /// `loadPage()` fans `/api/search` out to every (server, library),
  /// merges every source's assets into one cell list, and records enough
  /// provenance that `server(for:)` can route a tap back to the server
  /// that actually owns the asset — the crux of #2273's "open the right
  /// server" requirement.
  func test_loadPage_mergesAcrossServersAndRoutesToOwningServer() async throws {
    let serverA = URL(string: "https://cloud-a.test")!
    let serverB = URL(string: "https://cloud-b.test")!

    let session = URLSession.stubbedSequence { req in
      let host = req.url?.host ?? ""
      let json: String
      if host == "cloud-a.test" {
        json = """
        {"total":1,"page":0,"limit":200,"results":[
          {"id":"a1","folder_id":"libA","abs_path":"/a/1.dng","filename":"1.dng",
           "size":1,"mtime":null,"captured_at":null,"camera":null,"lens":null,
           "iso":null,"aperture":null,"shutter":null,"focal_length":null,
           "rating":null,"flag":null,"color_label":null}
        ]}
        """
      } else {
        json = """
        {"total":1,"page":0,"limit":200,"results":[
          {"id":"b1","folder_id":"libB","abs_path":"/b/1.dng","filename":"1.dng",
           "size":1,"mtime":null,"captured_at":null,"camera":null,"lens":null,
           "iso":null,"aperture":null,"shutter":null,"focal_length":null,
           "rating":null,"flag":null,"color_label":null}
        ]}
        """
      }
      let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                  headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }

    let sourceA = AllSourcesTimelineViewModel.ServerSource(
      server: serverA, libraryIDs: ["libA"],
      searchClient: CloudSearchClient(server: serverA,
                                       httpClient: .unauthenticated(server: serverA, urlSession: session)),
      thumbClient: CloudThumbClient(server: serverA,
                                     httpClient: .unauthenticated(server: serverA, urlSession: session)))
    let sourceB = AllSourcesTimelineViewModel.ServerSource(
      server: serverB, libraryIDs: ["libB"],
      searchClient: CloudSearchClient(server: serverB,
                                       httpClient: .unauthenticated(server: serverB, urlSession: session)),
      thumbClient: CloudThumbClient(server: serverB,
                                     httpClient: .unauthenticated(server: serverB, urlSession: session)))

    let vm = AllSourcesTimelineViewModel(
      sources: [sourceA, sourceB],
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()))

    await vm.loadPage(year: 2024, month: 7)
    let key = BucketKey(year: 2024, month: 7)

    let merged = vm.mergedPagesByBucket[key] ?? []
    XCTAssertEqual(merged.count, 2, "one cell per server's asset, unioned")
    XCTAssertEqual(vm.pagesByBucket[key]?.count, 2)

    let assetA = try XCTUnwrap(vm.pagesByBucket[key]?.first { $0.id == "a1" })
    let assetB = try XCTUnwrap(vm.pagesByBucket[key]?.first { $0.id == "b1" })

    XCTAssertEqual(vm.server(for: assetA), serverA, "asset from server A must route back to server A")
    XCTAssertEqual(vm.server(for: assetB), serverB, "asset from server B must route back to server B")

    // Every cell resolved is .cloudOnly (no PhotoKit merge configured) —
    // `host(for:)` must resolve to the SAME host `server(for:)` used, since
    // ThumbnailProvider and the tap-routing both key off it.
    for cell in merged {
      guard case .cloudOnly(let ref) = cell else {
        XCTFail("expected .cloudOnly cells with no PhotoKit merge, got \(cell)")
        continue
      }
      let host = vm.host(for: cell)
      XCTAssertFalse(host.isEmpty, "cloudOnly cell must resolve a non-empty host: \(ref.id)")
    }
  }

  // MARK: - Helpers

  private func tmpDir() -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("AllSourcesTimelineVMTests-\(UUID())")
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
}
