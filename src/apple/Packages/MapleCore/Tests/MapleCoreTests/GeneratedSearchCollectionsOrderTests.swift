// GeneratedSearchCollectionsOrderTests.swift
//
// For You cards show in a shuffled order that holds for the session (#4594):
// shuffled on a library's first load, stable across reloads and new view
// models, survivors keep their places and new cards land at random.

import XCTest

@testable import MapleCloudKit

@MainActor
final class GeneratedSearchCollectionsOrderTests: XCTestCase {
  private static let serverOrder = ["a", "b", "c", "d", "e", "f"]

  func test_firstLoad_shufflesWithTheInjectedGenerator() async {
    let stub = ForYouCardsStub(ids: Self.serverOrder)
    let first = makeVM(stub, store: ForYouSessionOrder(), seed: 7)
    let again = makeVM(stub, store: ForYouSessionOrder(), seed: 7)

    await first.load()
    await again.load()

    let shown = first.collections.map(\.id)
    XCTAssertEqual(Set(shown), Set(Self.serverOrder))
    XCTAssertNotEqual(shown, Self.serverOrder, "the server's order must not lead")
    XCTAssertEqual(again.collections.map(\.id), shown, "a seeded generator is deterministic")
  }

  func test_reload_keepsTheOrder() async {
    let stub = ForYouCardsStub(ids: Self.serverOrder)
    let vm = makeVM(stub, store: ForYouSessionOrder(), seed: 3)

    await vm.load()
    let shown = vm.collections.map(\.id)
    await vm.load()
    await vm.load()

    XCTAssertEqual(vm.collections.map(\.id), shown)
  }

  func test_newViewModelForTheSameLibrary_keepsTheSessionOrder() async {
    let stub = ForYouCardsStub(ids: Self.serverOrder)
    let store = ForYouSessionOrder()
    let first = makeVM(stub, store: store, seed: 11)
    await first.load()

    let returning = makeVM(stub, store: store, seed: 99)
    await returning.load()

    XCTAssertEqual(returning.collections.map(\.id), first.collections.map(\.id))
  }

  func test_newCards_slotInWithoutMovingSurvivors() async {
    let stub = ForYouCardsStub(ids: Self.serverOrder)
    let vm = makeVM(stub, store: ForYouSessionOrder(), seed: 5)
    await vm.load()
    let before = vm.collections.map(\.id)

    stub.ids = ["a", "b", "d", "e", "f", "g", "h"]
    await vm.load()
    let after = vm.collections.map(\.id)

    XCTAssertEqual(Set(after), Set(stub.ids))
    XCTAssertEqual(
      after.filter { before.contains($0) }, before.filter { $0 != "c" },
      "survivors keep their relative order")
  }

  func test_aNewDaysSet_reshuffles() async {
    let stub = ForYouCardsStub(ids: Self.serverOrder)
    let store = ForYouSessionOrder()
    let vm = makeVM(stub, store: store, seed: 13)
    await vm.load()
    let firstDay = vm.collections.map(\.id)

    stub.day = "2026-10-08"
    await vm.load()

    XCTAssertEqual(Set(vm.collections.map(\.id)), Set(Self.serverOrder))
    XCTAssertNotEqual(vm.collections.map(\.id), firstDay, "a new day is a fresh shuffle")
  }

  func test_arrange_insertsNewcomersAroundUntouchedSurvivors() {
    var random = SplitMix64(seed: 1)
    let order = ForYouOrder.arrange(
      ["x", "a", "y", "b", "c"], keeping: ["c", "gone", "a", "b"], using: &random)

    XCTAssertEqual(order.filter { ["a", "b", "c"].contains($0) }, ["c", "a", "b"])
    XCTAssertEqual(Set(order), ["x", "a", "y", "b", "c"])
  }

  private func makeVM(
    _ stub: ForYouCardsStub, store: ForYouSessionOrder, seed: UInt64
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
      libraryID: "lib-order", client: client, sessionOrder: store,
      random: SplitMix64(seed: seed))
  }
}

/// Deterministic generator for order tests.
struct SplitMix64: RandomNumberGenerator {
  private var state: UInt64

  init(seed: UInt64) {
    state = seed
  }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}

/// Serves a configurable set of cards for one day, each with a one-photo
/// first page. The responder runs off the main actor.
final class ForYouCardsStub: @unchecked Sendable {
  private let lock = NSLock()
  private var _ids: [String]
  private var _day = "2026-10-07"

  init(ids: [String]) {
    _ids = ids
  }

  var ids: [String] {
    get { lock.withLock { _ids } }
    set { lock.withLock { _ids = newValue } }
  }

  var day: String {
    get { lock.withLock { _day } }
    set { lock.withLock { _day = newValue } }
  }

  func respond(to request: URLRequest) -> StubResponse {
    let url = request.url!
    guard url.path.hasSuffix("/assets") else {
      let (ids, day) = lock.withLock { (_ids, _day) }
      let cards = ids.map {
        #"{"id":"\#($0)","theme":"t","title":"\#($0)","result_count":1,"generated_for":"\#(day)"}"#
      }
      return .http(
        status: 200, body: Data(#"{"results":[\#(cards.joined(separator: ","))]}"#.utf8))
    }
    let id = url.pathComponents.dropLast().last ?? ""
    let asset =
      #"{"id":"fs:/p/\#(id).dng","folder_id":"lib","abs_path":"/p/\#(id).dng","#
      + #""filename":"\#(id).dng"}"#
    return .http(
      status: 200, body: Data(#"{"total":1,"snapshot":true,"results":[\#(asset)]}"#.utf8))
  }
}
