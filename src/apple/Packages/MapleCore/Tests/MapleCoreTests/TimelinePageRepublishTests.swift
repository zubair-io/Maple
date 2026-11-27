import Observation
import XCTest

@testable import MapleCore

#if canImport(Photos)
  import Photos
#endif

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
    try XCTSkipIf(
      Self.hostPhotosLibraryIsReadable, "warmUp would enumerate the host Photos library")
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
    let folder = try await seededFolder(names: ["IMG_1.dng", "IMG_2.dng"])
    let vm = try await makeAllSourcesVM(
      libraries: [(id: "lib1", cached: page, network: page)], folderMerge: folder.adapter)

    await vm.loadPage(year: 2024, month: 7)
    XCTAssertEqual(vm.mergedPagesByBucket[allKey]?.count, 3, "two local-only plus one cloud-only")

    try FileManager.default.removeItem(at: folder.url.appendingPathComponent("IMG_2.dng"))
    await folder.adapter.warmUp()

    XCTAssertEqual(vm.mergedPagesByBucket[allKey]?.count, 2, "removed local cell is gone")
  }

  func test_allSources_identicalPagesFromTwoLibrariesArrivingInReverseOrderPublishOnce()
    async throws
  {
    let first = Self.pageJSON(ids: ["a", "b"])
    let second = Self.pageJSON(ids: ["c", "d"])
    let vm = try await makeAllSourcesVM(
      libraries: [
        (id: "lib1", cached: first, network: first), (id: "lib2", cached: second, network: second),
      ],
      firstRequestArrivesLast: true)
    let pages = ObservationChangeCounter { _ = vm.pagesByBucket }
    let merged = ObservationChangeCounter { _ = vm.mergedPagesByBucket }

    await vm.loadPage(year: 2024, month: 7)

    XCTAssertEqual(pages.count, 1)
    XCTAssertEqual(merged.count, 1)
    XCTAssertEqual(vm.pagesByBucket[allKey]?.map(\.id), ["a", "b", "c", "d"])
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

  private actor RequestOrder {
    private var started = 0
    func nextStartIndex() -> Int {
      defer { started += 1 }
      return started
    }
  }

  private func makeAllSourcesVM(
    cached: String, network: String
  ) async throws -> AllSourcesTimelineViewModel {
    try await makeAllSourcesVM(libraries: [(id: "lib1", cached: cached, network: network)])
  }

  private func makeAllSourcesVM(
    libraries: [(id: String, cached: String, network: String)],
    folderMerge: FolderMergeAdapter? = nil,
    firstRequestArrivesLast: Bool = false
  ) async throws -> AllSourcesTimelineViewModel {
    let pagesCache = CloudPagesCache(baseDir: tmpDir())
    for library in libraries {
      await pagesCache.write(
        host: server.cacheHostKey, libraryID: library.id, year: 2024, month: 7, page: 0,
        try Self.decode(library.cached))
    }
    let responses = Dictionary(uniqueKeysWithValues: libraries.map { ($0.id, $0.network) })
    let order = RequestOrder()
    let delayFirstStarted: @Sendable () async -> Void = {
      if await order.nextStartIndex() == 0 { try? await Task.sleep(for: .milliseconds(300)) }
    }
    let session = URLSession.stubbedSequence(
      onRequestStart: firstRequestArrivesLast ? delayFirstStarted : nil
    ) { request in
      let libraryID =
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
        .queryItems?.first { $0.name == "libraryId" }?.value ?? ""
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data((responses[libraryID] ?? "").utf8), response)
    }
    let source = AllSourcesTimelineViewModel.ServerSource(
      server: server, libraryIDs: libraries.map(\.id),
      searchClient: CloudSearchClient(
        server: server, httpClient: .unauthenticated(server: server, urlSession: session)),
      thumbClient: CloudThumbClient(
        server: server, httpClient: .unauthenticated(server: server, urlSession: session)))
    return AllSourcesTimelineViewModel(
      sources: [source],
      bucketsCache: CloudBucketsCache(baseDir: tmpDir()),
      pagesCache: pagesCache,
      folderMerge: folderMerge)
  }

  private static var hostPhotosLibraryIsReadable: Bool {
    #if canImport(Photos)
      let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
      return status == .authorized || status == .limited
    #else
      return false
    #endif
  }

  private func seededFolder(names: [String]) async throws -> (adapter: FolderMergeAdapter, url: URL)
  {
    let suiteName = "TimelinePageRepublishTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    addTeardownBlock { defaults.removePersistentDomain(forName: suiteName) }
    let folderURL = tmpDir()
    try FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: true)
    let fingerprints = try names.map { name in
      let file = folderURL.appendingPathComponent(name)
      try Data(name.utf8).write(to: file)
      let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
      return LibraryIndexStore.FingerprintUpdate(
        name: name, size: (attributes[.size] as? NSNumber)?.int64Value,
        mtime: attributes[.modificationDate] as? Date,
        dateTimeOriginal: "2024:07:11 09:00:00", cameraSerial: nil)
    }
    try await LibraryIndexStore(folderURL: folderURL).updateFingerprints(fingerprints)
    let bookmark = try folderURL.bookmarkData(
      options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
    SavedFolderStore.upsert(
      SavedFolder(path: folderURL.path, displayName: "A", bookmark: bookmark, lastOpened: Date()),
      into: defaults)
    let adapter = FolderMergeAdapter(defaults: defaults)
    await adapter.warmUp()
    return (adapter, folderURL)
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
