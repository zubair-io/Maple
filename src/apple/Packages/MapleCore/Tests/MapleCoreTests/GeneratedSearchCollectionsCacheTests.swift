// GeneratedSearchCollectionsCacheTests.swift
//
// The For You row renders its cached set before any request (#4595), then
// revalidates: retired collections leave the cache, a cover changes only when
// the server names a different first photo and only once that photo is
// warmed, and the cached order is the order that was shown. Stale covers are
// bounded: trashed photos leave the cache at once, covers older than three
// days don't render, and an empty server page clears the cover.

import XCTest

@testable import MapleCloudKit

@MainActor
final class GeneratedSearchCollectionsCacheTests: XCTestCase {
  var directory: URL!

  override func setUp() async throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("for-you-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: directory)
  }

  func test_cachedCardsAndCovers_showBeforeAnyResponse() async throws {
    let cache = ForYouCache(directory: directory)
    await cache.write(
      Self.snapshot(["a": "old-a", "b": "old-b"]), libraryID: Self.library, host: Self.host)
    let stub = CachedCardsStub(covers: ["a": "old-a", "b": "old-b"])
    stub.hold()
    let vm = makeVM(stub, cache: cache)

    let load = Task { await vm.load() }
    try await waitUntil { !vm.collections.isEmpty }

    XCTAssertEqual(Set(vm.collections.map(\.id)), ["a", "b"])
    XCTAssertEqual(vm.covers["a"]?.id, "old-a")
    XCTAssertEqual(vm.covers["b"]?.id, "old-b")
    XCTAssertEqual(stub.served, 0, "nothing may have been answered yet")
    let opened = await vm.firstPage(of: vm.collections[0])
    XCTAssertFalse(opened.results.isEmpty, "opening a card uses the cached first page")

    stub.release()
    await load.value
  }

  func test_retiredCollections_arePrunedFromTheCache() async throws {
    let cache = ForYouCache(directory: directory)
    await cache.write(
      Self.snapshot(["a": "old-a", "gone": "old-gone"]), libraryID: Self.library, host: Self.host)
    let stub = CachedCardsStub(covers: ["a": "old-a"])
    let vm = makeVM(stub, cache: cache)

    await vm.load()

    XCTAssertEqual(vm.collections.map(\.id), ["a"])
    XCTAssertNil(vm.firstPages["gone"])
    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.collections.map(\.id), ["a"])
    XCTAssertEqual(stored.map { Set($0.firstPages.keys) }, ["a"])
  }

  func test_aNewCover_replacesTheOldOnlyOnceWarmed() async throws {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "old-a"]), libraryID: Self.library, host: Self.host)
    let stub = CachedCardsStub(covers: ["a": "new-a"])
    let warmer = CoverWarmerProbe()
    warmer.hold()
    let vm = makeVM(stub, cache: cache, warmer: warmer)

    let load = Task { await vm.load() }
    try await waitUntil { warmer.warmed == ["new-a"] }
    XCTAssertEqual(
      vm.covers["a"]?.id, "old-a", "the old cover stays up while the new one decodes")

    warmer.release()
    await load.value
    XCTAssertEqual(vm.covers["a"]?.id, "new-a")
    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.firstPages["a"]?.results.first?.id, "new-a")
  }

  func test_anUnchangedCover_isNeitherWarmedNorReplaced() async {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "old-a"]), libraryID: Self.library, host: Self.host)
    let warmer = CoverWarmerProbe()
    let vm = makeVM(CachedCardsStub(covers: ["a": "old-a"]), cache: cache, warmer: warmer)

    await vm.load()

    XCTAssertEqual(vm.covers["a"]?.id, "old-a")
    XCTAssertEqual(warmer.warmed, [])
  }

  func test_aCoverTheServerNoLongerReturns_isDropped() async {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "hidden-a"]), libraryID: Self.library, host: Self.host)
    let vm = makeVM(CachedCardsStub(covers: ["a": nil]), cache: cache)

    await vm.load()

    XCTAssertNil(vm.covers["a"], "an empty filtered page leaves the placeholder")
  }

  func test_anEmptyPage_clearsTheCoverEvenWhenAWarmerWouldFail() async {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "hidden-a"]), libraryID: Self.library, host: Self.host)
    let warmer = CoverWarmerProbe(succeeds: false)
    let vm = makeVM(CachedCardsStub(covers: ["a": nil]), cache: cache, warmer: warmer)

    await vm.load()

    XCTAssertNil(vm.covers["a"])
    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.firstPages["a"]?.results.count, 0)
  }

  func test_aReplacementCoverThatFailsToWarm_keepsTheOldCover() async {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "old-a"]), libraryID: Self.library, host: Self.host)
    let warmer = CoverWarmerProbe(succeeds: false)
    let vm = makeVM(CachedCardsStub(covers: ["a": "new-a"]), cache: cache, warmer: warmer)

    await vm.load()

    XCTAssertEqual(warmer.warmed, ["new-a"])
    XCTAssertEqual(vm.covers["a"]?.id, "old-a")
    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.firstPages["a"]?.results.first?.id, "old-a")
  }

  func test_aSnapshotOlderThanThreeDays_showsCardsWithoutCovers() async throws {
    let cache = ForYouCache(directory: directory)
    let saved = Date(timeIntervalSince1970: 1_800_000_000)
    await cache.write(
      Self.snapshot(["a": "old-a"], savedAt: saved), libraryID: Self.library, host: Self.host)
    let stub = CachedCardsStub(covers: ["a": "old-a"])
    stub.hold()
    let vm = makeVM(
      stub, cache: cache, now: saved.addingTimeInterval(3 * 24 * 60 * 60 + 1))

    let load = Task { await vm.load() }
    try await waitUntil { !vm.collections.isEmpty }

    XCTAssertEqual(vm.collections.map(\.id), ["a"])
    XCTAssertNil(vm.covers["a"], "a stale cover waits for the server")
    stub.release()
    await load.value
    XCTAssertEqual(vm.covers["a"]?.id, "old-a")
  }

  func test_aSnapshotWithinThreeDays_showsItsCovers() async throws {
    let cache = ForYouCache(directory: directory)
    let saved = Date(timeIntervalSince1970: 1_800_000_000)
    await cache.write(
      Self.snapshot(["a": "old-a"], savedAt: saved), libraryID: Self.library, host: Self.host)
    let stub = CachedCardsStub(covers: ["a": "old-a"])
    stub.hold()
    let vm = makeVM(stub, cache: cache, now: saved.addingTimeInterval(2 * 24 * 60 * 60))

    let load = Task { await vm.load() }
    try await waitUntil { !vm.collections.isEmpty }

    XCTAssertEqual(vm.covers["a"]?.id, "old-a")
    stub.release()
    await load.value
  }

  func test_trashedPhotos_leaveTheCacheAtOnce() async throws {
    let cache = ForYouCache(directory: directory)
    await cache.write(
      Self.snapshot(["a": "old-a", "b": "old-b"]), libraryID: Self.library, host: Self.host)
    await cache.write(Self.snapshot(["c": "old-c"]), libraryID: "another-library", host: Self.host)

    await cache.forgetAsset(host: Self.host, assetID: "old-a", absPath: "/elsewhere/a.dng")
    await cache.forgetFolder(host: Self.host, libraryFolderID: "lib", folderPath: "/q")
    await cache.forgetAsset(host: "other.test", assetID: "old-b", absPath: "/p/old-b.dng")

    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(
      stored.map { Set($0.firstPages.keys) }, ["b"],
      "matched by asset id; another server's trash leaves this one alone")
    XCTAssertEqual(stored?.collections.map(\.id), ["a", "b"], "the card stays, without a cover")
    let other = await cache.read(libraryID: "another-library", host: Self.host)
    XCTAssertEqual(other.map { Set($0.firstPages.keys) }, ["c"])

    let stub = CachedCardsStub(covers: ["a": "old-a", "b": "old-b"])
    stub.hold()
    let vm = makeVM(stub, cache: cache)
    let load = Task { await vm.load() }
    try await waitUntil { !vm.collections.isEmpty }
    XCTAssertNil(vm.covers["a"], "the trashed photo never renders from the cache")
    XCTAssertEqual(vm.covers["b"]?.id, "old-b")
    stub.release()
    await load.value
  }

  func test_aRefreshInFlight_cannotWriteATrashedCoverBack() async throws {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "old-a"]), libraryID: Self.library, host: Self.host)
    let warmer = CoverWarmerProbe()
    warmer.hold()
    let stub = CachedCardsStub(covers: ["a": "new-a"])
    let vm = makeVM(stub, cache: cache, warmer: warmer)

    let load = Task { await vm.load() }
    try await waitUntil { warmer.warmed == ["new-a"] }
    await cache.forgetAsset(host: Self.host, assetID: "new-a", absPath: "/p/new-a.dng")
    stub.covers = ["a": "old-a"]
    warmer.release()
    await load.value

    XCTAssertEqual(vm.covers["a"]?.id, "old-a", "the stale refresh never reaches the screen")
    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.firstPages["a"]?.results.first?.id, "old-a")
  }

  func test_trashingTheShownCoverDuringARefresh_clearsItFromTheScreen() async throws {
    let cache = ForYouCache(directory: directory)
    await cache.write(
      Self.snapshot(["a": "old-a", "b": "old-b"]), libraryID: Self.library, host: Self.host)
    let stub = CachedCardsStub(covers: ["a": "old-a", "b": "old-b"])
    stub.hold()
    let vm = makeVM(stub, cache: cache)

    let load = Task { await vm.load() }
    try await waitUntil { vm.covers["a"] != nil }
    await cache.forgetAsset(host: Self.host, assetID: "old-a", absPath: "/p/old-a.dng")
    stub.covers = ["a": nil, "b": "old-b"]
    stub.release()
    await load.value

    XCTAssertNil(vm.covers["a"])
    XCTAssertEqual(vm.covers["b"]?.id, "old-b")
  }

  func test_aRefreshAfterARestore_cachesThePhotoAgain() async {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "old-a"]), libraryID: Self.library, host: Self.host)
    await cache.forgetAsset(host: Self.host, assetID: "old-a", absPath: "/p/old-a.dng")

    let vm = makeVM(CachedCardsStub(covers: ["a": "old-a"]), cache: cache)
    await vm.load()

    XCTAssertEqual(vm.covers["a"]?.id, "old-a")
    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.firstPages["a"]?.results.first?.id, "old-a")
  }

  func test_trashOnAnotherServer_doesNotDiscardThisRefresh() async throws {
    let cache = ForYouCache(directory: directory)
    let warmer = CoverWarmerProbe()
    warmer.hold()
    let vm = makeVM(CachedCardsStub(covers: ["a": "new-a"]), cache: cache, warmer: warmer)

    let load = Task { await vm.load() }
    try await waitUntil { warmer.warmed == ["new-a"] }
    await cache.forgetAsset(host: "other.test", assetID: "new-a", absPath: "/p/new-a.dng")
    warmer.release()
    await load.value

    XCTAssertEqual(vm.covers["a"]?.id, "new-a")
  }

  func test_anUnrelatedTrashDuringAFirstVisit_stillLeavesCovers() async throws {
    let cache = ForYouCache(directory: directory)
    let warmer = CoverWarmerProbe()
    warmer.hold()
    let vm = makeVM(CachedCardsStub(covers: ["a": "new-a"]), cache: cache, warmer: warmer)

    let load = Task { await vm.load() }
    try await waitUntil { warmer.warmed == ["new-a"] }
    await cache.forgetAsset(host: Self.host, assetID: "elsewhere", absPath: "/x/elsewhere.dng")
    warmer.release()
    await load.value

    XCTAssertEqual(vm.covers["a"]?.id, "new-a", "the retry under the new epoch commits")
    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.firstPages["a"]?.results.first?.id, "new-a")
  }

  func test_trashesThatKeepOverlappingRefreshes_stillEndWithCovers() async {
    let cache = ForYouCache(directory: directory)
    let host = Self.host
    let warmer = CoverWarmerProbe(duringWarm: { call in
      guard call <= 2 else { return }
      await cache.forgetAsset(host: host, assetID: "elsewhere-\(call)", absPath: "/x/\(call)")
    })
    let vm = makeVM(CachedCardsStub(covers: ["a": "new-a"]), cache: cache, warmer: warmer)

    await vm.load()

    XCTAssertEqual(warmer.warmed.count, 3, "two stale refreshes, then one that commits")
    XCTAssertEqual(vm.covers["a"]?.id, "new-a")
    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.firstPages["a"]?.results.first?.id, "new-a")
  }

  func test_aKeptViewModel_dropsACoverTrashedAfterItLoaded() async throws {
    let cache = ForYouCache(directory: directory)
    let stub = CachedCardsStub(covers: ["a": "old-a", "b": "old-b"])
    let vm = makeVM(stub, cache: cache)
    await vm.load()
    XCTAssertEqual(vm.covers["a"]?.id, "old-a")

    await cache.forgetAsset(host: Self.host, assetID: "old-a", absPath: "/p/old-a.dng")
    stub.covers = ["a": "next-a", "b": "old-b"]
    stub.hold()
    let revalidate = Task { await vm.dropTrashedCovers() }
    try await waitUntil { vm.covers["a"] == nil }
    XCTAssertEqual(vm.covers["b"]?.id, "old-b", "untouched covers stay up")
    stub.release()
    await revalidate.value

    XCTAssertEqual(vm.covers["a"]?.id, "next-a", "the refresh brings the replacement")
  }

  func test_aTrashLandingAsTheCacheRenders_isDroppedEvenWhenTheRefreshFails() async throws {
    guard #available(macOS 26, iOS 26, tvOS 26, *) else {
      throw XCTSkip("Task.immediate needs the OS 26 runtime")
    }
    let cache = ForYouCache(directory: directory)
    await cache.write(
      Self.snapshot(["a": "old-a", "b": "old-b"]), libraryID: Self.library, host: Self.host)
    let vm = makeVM(CachedCardsStub(covers: [:]), cache: cache)
    StubURLProtocol.responder = { _ in .failure(URLError(.notConnectedToInternet)) }
    let host = Self.host
    // Fires inside `show(cached)`. `Task.immediate` queues the forget on the
    // cache actor before `load()` can make its next cache call, which is
    // where a separate epoch read used to sit.
    withObservationTracking {
      _ = vm.collections
    } onChange: {
      Task.immediate {
        await cache.forgetAsset(host: host, assetID: "old-a", absPath: "/p/old-a.dng")
      }
    }

    await vm.load()
    XCTAssertEqual(vm.covers["a"]?.id, "old-a", "the cache rendered before the trash landed")
    await vm.dropTrashedCovers()

    XCTAssertNil(vm.covers["a"], "the trashed cover is taken down although the server is down")
    XCTAssertEqual(vm.covers["b"]?.id, "old-b")
  }

  func test_aKeptViewModel_withNothingTrashed_doesNotRefetch() async {
    let cache = ForYouCache(directory: directory)
    let stub = CachedCardsStub(covers: ["a": "old-a"])
    let vm = makeVM(stub, cache: cache)
    await vm.load()
    let served = stub.served

    await vm.dropTrashedCovers()

    XCTAssertEqual(stub.served, served)
  }

  func test_twoServersWithTheSameLibraryID_keepSeparateSets() async {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "old-a"]), libraryID: Self.library, host: "one.test")
    await cache.write(Self.snapshot(["b": "old-b"]), libraryID: Self.library, host: "two.test")

    let one = await cache.read(libraryID: Self.library, host: "one.test")
    let two = await cache.read(libraryID: Self.library, host: "two.test")

    XCTAssertEqual(one?.collections.map(\.id), ["a"])
    XCTAssertEqual(two?.collections.map(\.id), ["b"])
  }

  func test_aTrashedFolder_dropsEveryPageShowingAPhotoInsideIt() async {
    let cache = ForYouCache(directory: directory)
    await cache.write(
      Self.snapshot(["a": "old-a", "b": "old-b"]), libraryID: Self.library, host: Self.host)

    await cache.forgetFolder(host: Self.host, libraryFolderID: "lib", folderPath: "/p")

    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.firstPages.isEmpty, true)
  }

  func test_theCachedOrder_isTheOrderShown() async {
    let ids = ["a", "b", "c", "d", "e", "f"]
    let cache = ForYouCache(directory: directory)
    let stub = CachedCardsStub(
      covers: Dictionary(uniqueKeysWithValues: ids.map { ($0, "c-\($0)") }))
    let store = ForYouSessionOrder()
    let vm = makeVM(stub, cache: cache, store: store)
    await vm.load()
    let shown = vm.collections.map(\.id)

    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.collections.map(\.id), shown)

    stub.hold()
    let returning = makeVM(stub, cache: cache, store: store)
    let load = Task { await returning.load() }
    try? await waitUntil { !returning.collections.isEmpty }
    XCTAssertEqual(
      returning.collections.map(\.id), shown, "the same session renders the same order")
    stub.release()
    await load.value
  }

  // MARK: - Helpers

  static let library = "lib-cache"
  static let host = "stub.test"

  static func snapshot(
    _ covers: [String: String], savedAt: Date = Date()
  ) -> ForYouSnapshot {
    let ids = covers.keys.sorted()
    return ForYouSnapshot(
      collections: ids.map {
        GeneratedSearchCard(
          id: $0, theme: "t", title: $0, result_count: 1, generated_for: CachedCardsStub.day)
      },
      firstPages: covers.mapValues {
        GeneratedSearchAssetPage(results: [asset($0)], total: 1, isSnapshot: true)
      },
      savedAt: savedAt)
  }

  static func asset(_ id: String) -> SearchAsset {
    let json = #"{"id":"\#(id)","folder_id":"lib","abs_path":"/p/\#(id).dng","filename":"x"}"#
    return try! JSONDecoder().decode(SearchAsset.self, from: Data(json.utf8))
  }

  private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<400 where !condition() {
      try await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTAssertTrue(condition(), "timed out waiting")
  }

  func makeVM(
    _ stub: CachedCardsStub, cache: ForYouCache, warmer: CoverWarmerProbe? = nil,
    store: ForYouSessionOrder = ForYouSessionOrder(), now: Date = Date()
  ) -> GeneratedSearchCollectionsViewModel {
    let server = URL(string: "https://stub.test")!
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    StubURLProtocol.reset()
    StubURLProtocol.responder = { request in stub.respond(to: request) }
    let client = GeneratedSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(
        server: server, urlSession: URLSession(configuration: cfg)))
    return GeneratedSearchCollectionsViewModel(
      libraryID: Self.library, client: client, cache: cache, cacheHost: Self.host,
      coverWarmer: warmer.map { probe in { await probe.warm($0) } },
      sessionOrder: store, random: SplitMix64(seed: 21), now: { now })
  }
}

/// A gate a stub can park callers on until the test lets them through.
final class TestGate: @unchecked Sendable {
  private let lock = NSLock()
  private var opened: DispatchSemaphore?

  var isHeld: Bool { lock.withLock { opened != nil } }

  func hold() { lock.withLock { opened = DispatchSemaphore(value: 0) } }

  func release() {
    let semaphore = lock.withLock {
      defer { opened = nil }
      return opened
    }
    semaphore?.signal()
  }

  /// Blocks the calling (URL loading) thread while held; every waiter
  /// passes once released.
  func pass() {
    guard let semaphore = lock.withLock({ opened }) else { return }
    semaphore.wait()
    semaphore.signal()
  }
}

/// Serves the given cards (cover id per card; nil → an empty filtered page).
/// `hold()` parks every response until `release()`.
final class CachedCardsStub: @unchecked Sendable {
  static let day = "2026-10-07"
  private let lock = NSLock()
  private var _covers: [String: String?]
  private let gate = TestGate()
  private var _served = 0

  init(covers: [String: String?]) {
    _covers = covers
  }

  var served: Int { lock.withLock { _served } }

  /// What the server answers from now on, e.g. after it stops returning a
  /// photo the user trashed.
  var covers: [String: String?] {
    get { lock.withLock { _covers } }
    set { lock.withLock { _covers = newValue } }
  }
  func hold() { gate.hold() }
  func release() { gate.release() }

  func respond(to request: URLRequest) -> StubResponse {
    gate.pass()
    lock.withLock { _served += 1 }
    let url = request.url!
    guard url.path.hasSuffix("/assets") else {
      let cards = covers.keys.sorted().map {
        #"{"id":"\#($0)","theme":"t","title":"\#($0)","result_count":1,"#
          + #""generated_for":"\#(Self.day)"}"#
      }
      return .http(
        status: 200, body: Data(#"{"results":[\#(cards.joined(separator: ","))]}"#.utf8))
    }
    let id = url.pathComponents.dropLast().last ?? ""
    let results = (covers[id] ?? nil).map {
      #"{"id":"\#($0)","folder_id":"lib","abs_path":"/p/\#($0).dng","filename":"x"}"#
    }
    return .http(
      status: 200,
      body: Data(
        #"{"total":1,"snapshot":true,"results":[\#(results ?? "")]}"#.utf8))
  }
}

/// Records each cover it is asked to warm; `hold()` keeps the warm pending.
final class CoverWarmerProbe: @unchecked Sendable {
  private let succeeds: Bool
  /// Runs inside the warm, i.e. while a refresh is in flight, with the
  /// 1-based number of this warm call.
  private let duringWarm: (@Sendable (Int) async -> Void)?
  private let lock = NSLock()
  private let gate = TestGate()
  private var _warmed: [String] = []

  init(succeeds: Bool = true, duringWarm: (@Sendable (Int) async -> Void)? = nil) {
    self.succeeds = succeeds
    self.duringWarm = duringWarm
  }

  var warmed: [String] { lock.withLock { _warmed } }
  func hold() { gate.hold() }
  func release() { gate.release() }

  func warm(_ cover: SearchAsset) async -> Bool {
    let call = lock.withLock {
      _warmed.append(cover.id)
      return _warmed.count
    }
    await duringWarm?(call)
    while gate.isHeld {
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return succeeds
  }
}
