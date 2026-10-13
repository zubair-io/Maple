// GeneratedSearchCollectionsCacheTests.swift
//
// The For You row renders its cached set before any request (#4595), then
// revalidates: retired collections leave the cache, a cover changes only when
// the server names a different first photo and only once that photo is
// warmed, and the cached order is the order that was shown.

import XCTest

@testable import MapleCloudKit

@MainActor
final class GeneratedSearchCollectionsCacheTests: XCTestCase {
  private var directory: URL!

  override func setUp() async throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("for-you-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: directory)
  }

  func test_cachedCardsAndCovers_showBeforeAnyResponse() async throws {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "old-a", "b": "old-b"]), libraryID: Self.library)
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
      Self.snapshot(["a": "old-a", "gone": "old-gone"]), libraryID: Self.library)
    let stub = CachedCardsStub(covers: ["a": "old-a"])
    let vm = makeVM(stub, cache: cache)

    await vm.load()

    XCTAssertEqual(vm.collections.map(\.id), ["a"])
    XCTAssertNil(vm.firstPages["gone"])
    let stored = await cache.read(libraryID: Self.library)
    XCTAssertEqual(stored?.collections.map(\.id), ["a"])
    XCTAssertEqual(stored.map { Set($0.firstPages.keys) }, ["a"])
  }

  func test_aNewCover_replacesTheOldOnlyOnceWarmed() async throws {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "old-a"]), libraryID: Self.library)
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
    let stored = await cache.read(libraryID: Self.library)
    XCTAssertEqual(stored?.firstPages["a"]?.results.first?.id, "new-a")
  }

  func test_anUnchangedCover_isNeitherWarmedNorReplaced() async {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "old-a"]), libraryID: Self.library)
    let warmer = CoverWarmerProbe()
    let vm = makeVM(CachedCardsStub(covers: ["a": "old-a"]), cache: cache, warmer: warmer)

    await vm.load()

    XCTAssertEqual(vm.covers["a"]?.id, "old-a")
    XCTAssertEqual(warmer.warmed, [])
  }

  func test_aCoverTheServerNoLongerReturns_isDropped() async {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.snapshot(["a": "hidden-a"]), libraryID: Self.library)
    let vm = makeVM(CachedCardsStub(covers: ["a": nil]), cache: cache)

    await vm.load()

    XCTAssertNil(vm.covers["a"], "an empty filtered page leaves the placeholder")
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

    let stored = await cache.read(libraryID: Self.library)
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

  private static let library = "lib-cache"

  private static func snapshot(_ covers: [String: String]) -> ForYouSnapshot {
    let ids = covers.keys.sorted()
    return ForYouSnapshot(
      collections: ids.map {
        GeneratedSearchCard(
          id: $0, theme: "t", title: $0, result_count: 1, generated_for: CachedCardsStub.day)
      },
      firstPages: covers.mapValues {
        GeneratedSearchAssetPage(results: [asset($0)], total: 1, isSnapshot: true)
      })
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

  private func makeVM(
    _ stub: CachedCardsStub, cache: ForYouCache, warmer: CoverWarmerProbe? = nil,
    store: ForYouSessionOrder = ForYouSessionOrder()
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
      libraryID: Self.library, client: client, cache: cache,
      coverWarmer: warmer.map { probe in { await probe.warm($0) } },
      sessionOrder: store, random: SplitMix64(seed: 21))
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
  private let covers: [String: String?]
  private let gate = TestGate()
  private var _served = 0

  init(covers: [String: String?]) {
    self.covers = covers
  }

  var served: Int { lock.withLock { _served } }
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
  private let lock = NSLock()
  private let gate = TestGate()
  private var _warmed: [String] = []

  var warmed: [String] { lock.withLock { _warmed } }
  func hold() { gate.hold() }
  func release() { gate.release() }

  func warm(_ cover: SearchAsset) async {
    lock.withLock { _warmed.append(cover.id) }
    while gate.isHeld {
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
  }
}
