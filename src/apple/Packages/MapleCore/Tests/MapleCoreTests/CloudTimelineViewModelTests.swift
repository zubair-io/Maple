// CloudTimelineViewModelTests.swift
import XCTest
@testable import MapleCore

@MainActor
final class CloudTimelineViewModelTests: XCTestCase {

  func test_loadBuckets_populatesFromNetwork() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    {"total":3,"buckets":[
      {"year":2024,"month":7,"count":2},
      {"year":2024,"month":6,"count":1}
    ],"untimed_count":0}
    """
    let session = URLSession.stubbed(response: json)
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-\(UUID()).buckets")
    let cache = CloudBucketsCache(baseDir: dir)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }

    let vm = CloudTimelineViewModel(server: server, libraryID: "lib1",
                                    searchClient: searchClient,
                                    bucketsCache: cache)
    await vm.loadBuckets()

    XCTAssertEqual(vm.buckets.count, 2)
    let firstBucket = try XCTUnwrap(vm.buckets.first)
    XCTAssertEqual(firstBucket.count, 2)
  }

  func test_loadPage_populatesPagesByBucket() async {
    let server = URL(string: "https://example.test")!
    let json = """
    {"total":1,"page":1,"limit":200,"results":[
      {"id":"a1","folder_id":"lib1","abs_path":"/x/a.dng","filename":"a.dng",
       "size":1024,"mtime":null,"captured_at":null,"camera":null,"lens":null,
       "iso":null,"aperture":null,"shutter":null,"focal_length":null,
       "rating":null,"flag":null,"color_label":null}
    ]}
    """
    let session = URLSession.stubbed(response: json)
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let dirB = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-\(UUID()).buckets")
    let dirP = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-\(UUID()).pages")
    addTeardownBlock {
      try? FileManager.default.removeItem(at: dirB)
      try? FileManager.default.removeItem(at: dirP)
    }

    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: dirB),
      pagesCache: CloudPagesCache(baseDir: dirP))

    await vm.loadPage(year: 2024, month: 7)
    let key = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)

    XCTAssertEqual(vm.pagesByBucket[key]?.count, 1)
    XCTAssertEqual(vm.pagesByBucket[key]?.first?.id, "a1")
  }

  /// Regression for #2108 (same class as the TV Timeline's D7 fix): the
  /// server's real `captured_at` values are Mongo Dates serialized via JS
  /// `toISOString()`, which always carry millisecond precision
  /// ("2022-09-10T11:32:07.000Z"). The old bare `ISO8601DateFormatter`
  /// silently returned nil for those, dropping the capture date off every
  /// cloud asset. `searchAssetToImageRef` now parses via `parseTimelineISO8601`
  /// (fractional-first, whole-seconds fallback).
  ///
  /// This deliberately uses a fractional-seconds string — every other fixture
  /// in this file uses whole-seconds (or null) `captured_at`, which the buggy
  /// formatter parsed fine, so the bug was invisible to the existing suite.
  func test_loadPage_parsesFractionalSecondsCapturedAt() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    {"total":1,"page":0,"limit":200,"results":[
      {"id":"a1","folder_id":"lib1","abs_path":"/lib/2022/09/a.dng","filename":"a.dng",
       "size":1024,"mtime":null,"captured_at":"2022-09-10T11:32:07.000Z","camera":null,"lens":null,
       "iso":null,"aperture":null,"shutter":null,"focal_length":null,
       "rating":null,"flag":null,"color_label":null}
    ]}
    """
    let session = URLSession.stubbed(response: json)
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    // An empty adapter (no PhotoKit) so the cloud asset becomes a single
    // `.cloudOnly` cell — the merge path that runs `searchAssetToImageRef`,
    // where the `captured_at` parse happens.
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()),
      photoKitMerge: PhotoKitMergeAdapter(diskCacheURL: nil))

    await vm.loadPage(year: 2022, month: 9)
    let key = CloudTimelineViewModel.BucketKey(year: 2022, month: 9)
    let merged = vm.mergedPagesByBucket[key] ?? []
    XCTAssertEqual(merged.count, 1)
    guard let first = merged.first, case .cloudOnly(let ref) = first else {
      XCTFail("expected one .cloudOnly cell, got \(merged)")
      return
    }

    let expected: Date = {
      let f = ISO8601DateFormatter()
      f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      return f.date(from: "2022-09-10T11:32:07.000Z")!
    }()
    XCTAssertEqual(ref.captureDate, expected,
      "millisecond-precision captured_at must parse to a Date (was nil before #2108 fix)")
  }

  /// `CloudTimelineViewModel`'s `semaphore` field is a `BoundedAsyncSemaphore`
  /// (MapleCloudKit) — the algorithm is fully stress-tested at the type
  /// level in `BoundedAsyncSemaphoreTests.swift` (many tasks, many
  /// iterations, an explicit `Task.yield()` while "holding" the permit to
  /// widen the permit-handoff race window from #2111). This is a lighter
  /// value=1 smoke test of the semaphore type itself; the VM's configured
  /// call-site cap (`maxConcurrentPageFetches`, default 2) is exercised by
  /// `test_loadPage_respectsMaxConcurrentPageFetches` below, and the real
  /// regression coverage for the race lives in `BoundedAsyncSemaphoreTests`.
  func test_boundedAsyncSemaphore_boundsConcurrency() async throws {
    let sem = BoundedAsyncSemaphore(value: 1)
    let counter = CounterActor()

    async let a: Void = {
      try await sem.acquire()
      let observed = await counter.increment()
      try? await Task.sleep(for: .milliseconds(10))
      _ = observed
      await counter.decrement()
      await sem.release()
    }()

    async let b: Void = {
      try await sem.acquire()
      let observed = await counter.increment()
      try? await Task.sleep(for: .milliseconds(10))
      _ = observed
      await counter.decrement()
      await sem.release()
    }()

    _ = try await (a, b)

    let max = await counter.observedMax
    XCTAssertEqual(max, 1, "semaphore(value:1) should never let two through at once")
  }

  /// Stale-completion guard. Switching libraries (or reloading) bumps
  /// the VM's generation counter; a slow in-flight request from the
  /// previous generation must NOT mutate `pagesByBucket` when it
  /// finally lands. Without this guard, a fast library switch would
  /// flash old assets into the new library's grid.
  func test_loadPage_dropsStaleCompletionAcrossReload() async throws {
    let server = URL(string: "https://example.test")!

    // Two stub responses with distinct asset IDs. The first call
    // (slow) returns asset "old"; the second (fast) returns "new".
    // Because the second loadBuckets bumps the generation, the slow
    // first response must be discarded once it lands.
    let json = """
    {"total":1,"page":0,"limit":200,"results":[
      {"id":"old","folder_id":"lib1","abs_path":"/x/old.dng","filename":"old.dng",
       "size":0,"mtime":null,"captured_at":null,"camera":null,"lens":null,
       "iso":null,"aperture":null,"shutter":null,"focal_length":null,
       "rating":null,"flag":null,"color_label":null}
    ]}
    """
    let session = URLSession.stubbed(response: json,
                                     delay: .milliseconds(150))
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-\(UUID()).stale")
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: dir.appending(path: "b")),
      pagesCache: CloudPagesCache(baseDir: dir.appending(path: "p")))

    // Kick off a slow page load…
    async let slow: Void = vm.loadPage(year: 2024, month: 7)
    // …then bump the generation by reloading buckets before the slow
    // page can finish. By the time the slow loadPage's await resolves,
    // its captured generation is stale and the guard short-circuits.
    try await Task.sleep(for: .milliseconds(20))
    await vm.loadBuckets()
    _ = await slow

    // The slow page response should NOT have been written into
    // pagesByBucket — generation guard fired.
    let key = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)
    XCTAssertNil(vm.pagesByBucket[key],
                 "stale loadPage completion must not populate pagesByBucket after generation bump")
  }

  /// /api/search calls are bounded by an internal `BoundedAsyncSemaphore`. A
  /// burst of N >> cap concurrent loadPage calls must serialize through
  /// the cap — observed by counting the maximum simultaneous in-flight
  /// requests at the URLProtocol layer.
  ///
  /// Runs several iterations with a real network-shaped delay (not just a
  /// `Task.yield()`) to widen the window the #2111 permit-handoff race
  /// needed to over-admit a third fetch past the cap of 2 — this is the
  /// VM-level companion to the type-level stress coverage in
  /// `BoundedAsyncSemaphoreTests`, confirming the fix holds through the
  /// actual call site, not just the isolated algorithm.
  func test_loadPage_respectsMaxConcurrentPageFetches() async throws {
    for iteration in 0..<5 {
      let server = URL(string: "https://example.test")!
      let inFlight = ConcurrentRequestTracker()

      let json = """
      {"total":0,"page":0,"limit":200,"results":[]}
      """
      let session = URLSession.stubbed(response: json,
                                       delay: .milliseconds(30),
                                       onRequestStart: { await inFlight.enter() },
                                       onRequestEnd:   { await inFlight.leave() })
      let searchClient = CloudSearchClient(
        server: server,
        httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

      let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("VMTests-\(UUID()).cap")
      addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
      let vm = CloudTimelineViewModel(
        server: server, libraryID: "lib1",
        searchClient: searchClient,
        bucketsCache: CloudBucketsCache(baseDir: dir.appending(path: "b")),
        pagesCache: CloudPagesCache(baseDir: dir.appending(path: "p")),
        maxConcurrentPageFetches: 2)

      // Fan out 12 distinct buckets concurrently — semaphore should pin
      // observedMax to 2.
      await withTaskGroup(of: Void.self) { group in
        for m in 1...12 {
          group.addTask { await vm.loadPage(year: 2024, month: m) }
        }
      }
      let observed = await inFlight.observedMax
      XCTAssertLessThanOrEqual(observed, 2,
                               "BoundedAsyncSemaphore(value: 2) must cap concurrent /api/search requests "
                               + "at 2 (observed \(observed), iteration \(iteration))")
    }
  }

  // MARK: - PhotoKit merge integration
  //
  // These exercise the `photoKitMerge:` integration without touching real
  // PhotoKit. The adapter is seeded by writing a known disk fixture and
  // letting `PhotoKitMergeAdapter.init(diskCacheURL:)` load it.

  /// Construct an adapter pre-seeded with one bucket of ImageRefs whose
  /// ids match what a cloud SearchAsset's `phasset_local_id` will reference.
  private func makeAdapterSeeded(localIDs: [String],
                                 year: Int, month: Int) throws -> (PhotoKitMergeAdapter, URL) {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-merge-\(UUID()).json")
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }

    let refs = localIDs.map { id in
      ImageRef(id: id, displayName: id, url: nil, captureDate: nil)
    }
    let key = PhotoKitMergeAdapter.BucketKey(year: year, month: month)
    let buckets: [PhotoKitMergeAdapter.BucketKey: [ImageRef]] = [key: refs]
    try PhotoKitMergeAdapter.encodeBuckets(buckets).write(to: url)

    return (PhotoKitMergeAdapter(diskCacheURL: url), url)
  }

  /// Same as `makeAdapterSeeded` but each local ImageRef carries a cloud
  /// identifier (the cross-device-stable key resolved via
  /// `PHPhotoLibrary.cloudIdentifierMappings(...)`).
  private func makeAdapterSeededWithCloudIDs(
    pairs: [(localId: String, cloudId: String)],
    year: Int, month: Int
  ) throws -> (PhotoKitMergeAdapter, URL) {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-merge-cid-\(UUID()).json")
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }

    let refs = pairs.map { p in
      ImageRef(id: p.localId,
               displayName: p.localId,
               url: nil,
               captureDate: nil,
               cloudIdentifier: p.cloudId)
    }
    let key = PhotoKitMergeAdapter.BucketKey(year: year, month: month)
    let buckets: [PhotoKitMergeAdapter.BucketKey: [ImageRef]] = [key: refs]
    try PhotoKitMergeAdapter.encodeBuckets(buckets).write(to: url)
    return (PhotoKitMergeAdapter(diskCacheURL: url), url)
  }

  /// SearchAsset JSON with `phasset_links` populated — the wire shape the
  /// server emits after a successful PhotoKit-backup upload.
  private func searchJSONWithPHLink(absPath: String, phid: String) -> String {
    """
    {"total":1,"page":1,"limit":200,"results":[
      {"id":"\(phid)-id","folder_id":"lib1","abs_path":"\(absPath)","filename":"a.dng",
       "size":1024,"mtime":null,"captured_at":null,"camera":null,"lens":null,
       "iso":null,"aperture":null,"shutter":null,"focal_length":null,
       "rating":null,"flag":null,"color_label":null,
       "phasset_links":[{"phasset_local_id":"\(phid)"}]}
    ]}
    """
  }

  func test_loadPage_buildsMergedCells_syncedWhenPHLinkMatches() async throws {
    let server = URL(string: "https://example.test")!
    let session = URLSession.stubbed(response: searchJSONWithPHLink(
      absPath: "/lib/2024/07/a.dng", phid: "P1"))
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let (adapter, _) = try makeAdapterSeeded(localIDs: ["P1"], year: 2024, month: 7)
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()),
      photoKitMerge: adapter)

    await vm.loadPage(year: 2024, month: 7)
    let key = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)
    let merged = vm.mergedPagesByBucket[key] ?? []
    XCTAssertEqual(merged.count, 1)
    guard let first = merged.first, case .synced(let local, let cloud) = first else {
      XCTFail("expected .synced when phasset_links matches adapter contents, got \(merged)")
      return
    }
    XCTAssertEqual(local.id, "P1")
    XCTAssertEqual(cloud.id, "fs:/lib/2024/07/a.dng")
  }

  func test_loadPage_buildsMergedCells_cloudOnlyWhenNoPHLinkMatch() async throws {
    let server = URL(string: "https://example.test")!
    let session = URLSession.stubbed(response: searchJSONWithPHLink(
      absPath: "/lib/2024/07/orphan.dng", phid: "no-such-phid"))
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let (adapter, _) = try makeAdapterSeeded(localIDs: ["P1"], year: 2024, month: 7)
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()),
      photoKitMerge: adapter)

    await vm.loadPage(year: 2024, month: 7)
    let key = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)
    let merged = vm.mergedPagesByBucket[key] ?? []
    // Expect: one .cloudOnly (the orphan upload) + one .localOnly (P1
    // that has no cloud counterpart).
    XCTAssertEqual(merged.count, 2)
    XCTAssertTrue(merged.contains(where: {
      if case .cloudOnly(let r) = $0, r.id == "fs:/lib/2024/07/orphan.dng" { return true }
      return false
    }), "missing expected .cloudOnly cell in \(merged)")
    XCTAssertTrue(merged.contains(where: {
      if case .localOnly(let r) = $0, r.id == "P1" { return true }
      return false
    }), "missing expected .localOnly cell in \(merged)")
  }

  /// Cross-device synced badge: the cloud row was uploaded from a different
  /// device, so its `phasset_local_id` doesn't match THIS device's
  /// PhotoKit, but the `phasset_cloud_id` does. The merge should treat
  /// the cell as `.synced` despite the phid mismatch.
  func test_loadPage_buildsMergedCells_syncedAcrossDevicesViaCloudId() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    {"total":1,"page":1,"limit":200,"results":[
      {"id":"a1","folder_id":"lib1","abs_path":"/lib/2024/07/a.dng","filename":"a.dng",
       "size":1024,"mtime":null,"captured_at":null,"camera":null,"lens":null,
       "iso":null,"aperture":null,"shutter":null,"focal_length":null,
       "rating":null,"flag":null,"color_label":null,
       "phasset_links":[{"phasset_local_id":"DEVICE_A_PHID","phasset_cloud_id":"icloud-XYZ"}]}
    ]}
    """
    let session = URLSession.stubbed(response: json)
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    // This device's PhotoKit has the same photo under a different phid
    // (DEVICE_B_PHID) but the same cloud id.
    let (adapter, _) = try makeAdapterSeededWithCloudIDs(
      pairs: [(localId: "DEVICE_B_PHID", cloudId: "icloud-XYZ")],
      year: 2024, month: 7)
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()),
      photoKitMerge: adapter)

    await vm.loadPage(year: 2024, month: 7)
    let key = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)
    let merged = vm.mergedPagesByBucket[key] ?? []
    XCTAssertEqual(merged.count, 1, "expected one synced cell, got \(merged)")
    guard let first = merged.first, case .synced(let local, let cloud) = first else {
      XCTFail("expected .synced via cross-device cloud id, got \(merged)")
      return
    }
    XCTAssertEqual(local.id, "DEVICE_B_PHID")
    XCTAssertEqual(cloud.id, "fs:/lib/2024/07/a.dng")
  }

  /// Regression for the "links[0] has no cloud id but links[1] does"
  /// case. The legacy single-field `cloudIdentifier` on the resulting
  /// ImageRef must be populated from the first NON-NIL cloud id, not
  /// blindly `links[0].phasset_cloud_id` — otherwise the cross-device
  /// match silently falls back to phid (or misses entirely) for older
  /// rows where the first uploading device had iCloud Photos off.
  func test_loadPage_buildsMergedCells_syncedWhenFirstLinkLacksCloudIdButLaterHasOne() async throws {
    let server = URL(string: "https://example.test")!
    // links[0] has no cloud id; links[1] does. The cell still has to
    // resolve via the cloud-id key.
    let json = """
    {"total":1,"page":1,"limit":200,"results":[
      {"id":"a1","folder_id":"lib1","abs_path":"/lib/2024/07/a.dng","filename":"a.dng",
       "size":1024,"mtime":null,"captured_at":null,"camera":null,"lens":null,
       "iso":null,"aperture":null,"shutter":null,"focal_length":null,
       "rating":null,"flag":null,"color_label":null,
       "phasset_links":[
         {"phasset_local_id":"OLDER_DEVICE_PHID"},
         {"phasset_local_id":"NEWER_DEVICE_PHID","phasset_cloud_id":"icloud-XYZ"}
       ]}
    ]}
    """
    let session = URLSession.stubbed(response: json)
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    // This device shares the iCloud account and resolves the same photo
    // under yet another phid + the same cloud id.
    let (adapter, _) = try makeAdapterSeededWithCloudIDs(
      pairs: [(localId: "THIS_DEVICE_PHID", cloudId: "icloud-XYZ")],
      year: 2024, month: 7)
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()),
      photoKitMerge: adapter)

    await vm.loadPage(year: 2024, month: 7)
    let key = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)
    let merged = vm.mergedPagesByBucket[key] ?? []
    XCTAssertEqual(merged.count, 1)
    guard let first = merged.first, case .synced(let local, _) = first else {
      XCTFail("expected .synced via the second link's cloud id, got \(merged)")
      return
    }
    XCTAssertEqual(local.id, "THIS_DEVICE_PHID")
  }

  /// Multi-device cloud row: `phasset_links` has TWO entries. The matching
  /// one is at index [1]. Today's bug walked only `phasset_links[0]`; the
  /// fix must walk every entry.
  func test_loadPage_buildsMergedCells_walksWholeLinksArray() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    {"total":1,"page":1,"limit":200,"results":[
      {"id":"a1","folder_id":"lib1","abs_path":"/lib/2024/07/a.dng","filename":"a.dng",
       "size":1024,"mtime":null,"captured_at":null,"camera":null,"lens":null,
       "iso":null,"aperture":null,"shutter":null,"focal_length":null,
       "rating":null,"flag":null,"color_label":null,
       "phasset_links":[
         {"phasset_local_id":"DEVICE_A_PHID"},
         {"phasset_local_id":"DEVICE_B_PHID"}
       ]}
    ]}
    """
    let session = URLSession.stubbed(response: json)
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let (adapter, _) = try makeAdapterSeeded(
      localIDs: ["DEVICE_B_PHID"], year: 2024, month: 7)
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()),
      photoKitMerge: adapter)

    await vm.loadPage(year: 2024, month: 7)
    let key = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)
    let merged = vm.mergedPagesByBucket[key] ?? []
    XCTAssertEqual(merged.count, 1)
    guard let first = merged.first, case .synced(let local, _) = first else {
      XCTFail("expected .synced when match is at links[1], got \(merged)")
      return
    }
    XCTAssertEqual(local.id, "DEVICE_B_PHID")
  }

  func test_warmUp_remergesPreviouslyLoadedBuckets() async throws {
    // Start with an adapter that has NO disk cache — assetsForMonth
    // returns []. Load a page (becomes all-cloudOnly). Then warm up the
    // adapter (in-test no PhotoKit, so cache stays empty but the
    // observer fires). The remerge should run against an empty adapter,
    // producing the same result — verifying the observer wiring runs
    // without crashing and the bucket is touched. Without a way to
    // inject fresh PhotoKit refs mid-flight we can't see a cellState
    // change, but the wiring path is what's worth testing.
    let server = URL(string: "https://example.test")!
    let session = URLSession.stubbed(response: searchJSONWithPHLink(
      absPath: "/lib/2024/07/a.dng", phid: "P1"))
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let adapter = PhotoKitMergeAdapter(diskCacheURL: nil)
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: CloudPagesCache(baseDir: tmpDir()),
      photoKitMerge: adapter)

    await vm.loadPage(year: 2024, month: 7)
    let key = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)
    let before = vm.mergedPagesByBucket[key] ?? []
    // P1 has no local counterpart in the empty adapter → .cloudOnly only.
    XCTAssertEqual(before.count, 1)
    guard let firstBefore = before.first, case .cloudOnly = firstBefore else {
      XCTFail("expected .cloudOnly with empty adapter, got \(before)")
      return
    }

    // Trigger warmUp; the VM's registered observer should re-run merge
    // for already-loaded buckets. Adapter still has empty PhotoKit (no
    // auth + no real library in test env), so cells stay .cloudOnly but
    // the mergedPagesByBucket entry is regenerated.
    await adapter.warmUp()
    let after = vm.mergedPagesByBucket[key] ?? []
    XCTAssertEqual(after.count, 1)
  }

  private func tmpDir() -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-\(UUID())")
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
}

/// Tracks the maximum number of overlapping HTTP requests seen during
/// a test — paired with `URLSession.stubbed`'s onRequestStart/end
/// hooks to validate the semaphore cap.
actor ConcurrentRequestTracker {
  private var current = 0
  private(set) var observedMax = 0
  func enter() { current += 1; if current > observedMax { observedMax = current } }
  func leave() { current -= 1 }
}

actor CounterActor {
  private var current = 0
  private(set) var observedMax = 0
  func increment() -> Int {
    current += 1
    if current > observedMax { observedMax = current }
    return current
  }
  func decrement() { current -= 1 }
}
