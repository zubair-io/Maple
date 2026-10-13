// GeneratedSearchCollectionsViewModel.swift
//
// Drives the tvOS `MemoriesScreen` and the iPhone Search tab's idle-page
// cards: the themed collections the server's generated-search worker invents
// daily ("Spooky Nights", "Seven Summers of Lake George").
//
// Two behaviours are deliberate:
//
//   * A failed load IS surfaced (`loadError`), because memories now own a
//     whole screen. As a shelf above the Timeline they didn't: a red banner
//     over a working photo grid was worse than a missing row. A screen that
//     silently says "No memories yet" when the request actually failed just
//     lies to the viewer, so the screen distinguishes the two.
//   * Assets for a collection come from `/api/generated-searches/:id/assets`,
//     never from a locally-composed search. The server applies
//     `excludeHiddenPeople` and the screenshot exclusion when IT runs the
//     stored query; a client that rebuilt the query would drop both, on a
//     television, unattended.
//   * Cards show in a shuffled order that holds for the session
//     (`ForYouOrder`, #4594), never the server's.
//   * A load renders the library's cached set first (`ForYouCache`, #4595)
//     and revalidates behind it. A card's cover changes only when the server
//     names a different first photo, and only once that photo's thumbnail is
//     decoded (`coverWarmer`), so a cover never blanks or flickers.
//
// Generation-counter staleness guard: bump
// before any `await`, re-check after every suspension point, so a library
// switch can't let an older response clobber newer state.

import Foundation
import Observation

@MainActor
@Observable
public final class GeneratedSearchCollectionsViewModel {
  public private(set) var collections: [GeneratedSearchCard] = []
  public private(set) var isLoading: Bool = false
  /// Non-nil only when a load failed *with nothing to fall back on*. A
  /// refresh that fails after a set has already rendered leaves that set up
  /// and clears this — there is nothing useful to say over a working wall of
  /// memories, and a stale non-nil error would invite a caller to show one.
  public private(set) var loadError: Error?
  /// First page of each collection, keyed by collection id. The cover needs
  /// a real `abs_path` (the collection carries only an id), and the server's
  /// cost is the query, not the page size — so the cover fetch takes a whole
  /// page and opening the collection reuses it instead of re-running the
  /// query.
  public private(set) var firstPages: [String: GeneratedSearchAssetPage] = [:]

  /// First photo of each collection's filtered snapshot page — the card's cover.
  /// An empty page has no cover, so the card shows its placeholder.
  public var covers: [String: SearchAsset] {
    firstPages.compactMapValues(\.results.first)
  }

  public let libraryID: String
  /// Enough to fill the first screens of a 3-column grid; the rest pages in.
  nonisolated static let firstPageSize = 30
  private let client: GeneratedSearchClient
  private let sessionOrder: ForYouSessionOrder
  private var random: AnyRandomNumberGenerator
  private let cache: ForYouCache?
  private let coverWarmer: (@Sendable (SearchAsset) async -> Void)?
  private var generation: Int = 0

  /// - Parameters:
  ///   - cache: Where the rendered set persists between visits and launches;
  ///     nil keeps it in memory only.
  ///   - coverWarmer: Fetches and decodes a new cover's thumbnail into the
  ///     surface's decoded-image cache, so the card swaps straight from the
  ///     old picture to the new one.
  public init(
    libraryID: String,
    client: GeneratedSearchClient,
    cache: ForYouCache? = nil,
    coverWarmer: (@Sendable (SearchAsset) async -> Void)? = nil,
    sessionOrder: ForYouSessionOrder = .shared,
    random: some RandomNumberGenerator = SystemRandomNumberGenerator()
  ) {
    self.libraryID = libraryID
    self.client = client
    self.cache = cache
    self.coverWarmer = coverWarmer
    self.sessionOrder = sessionOrder
    self.random = AnyRandomNumberGenerator(random)
  }

  /// Load the most recent day that produced anything. Omitting the date is
  /// what keeps a late or empty run showing yesterday's set rather than
  /// blanking the screen. An empty screen first shows the cached set, before
  /// any request goes out.
  public func load() async {
    generation += 1
    let g = generation
    isLoading = true
    defer { if g == generation { isLoading = false } }

    if collections.isEmpty, let cached = await cache?.read(libraryID: libraryID) {
      guard g == generation else { return }
      if collections.isEmpty { show(cached) }
    }

    let loaded: [GeneratedSearchCard]
    do {
      loaded = try await client.collections(libraryID: libraryID)
    } catch {
      guard g == generation else { return }
      // Only an empty screen becomes an error state — see `loadError`.
      loadError = collections.isEmpty ? error : nil
      return
    }
    guard g == generation else { return }
    loadError = nil
    collections = arrangeForSession(loaded)
    // Drop covers for collections that just fell out of the set. A reload
    // replaces `collections` wholesale, so without this the map only ever
    // grows — every day's retired collections stay resident for the life of
    // the screen. Pruning rather than clearing keeps the covers that survived
    // the reload on screen instead of blanking every card for a beat.
    let loadedIDs = Set(loaded.map(\.id))
    firstPages = firstPages.filter { loadedIDs.contains($0.key) }

    // One snapshot fetch per collection (there are a handful per day), run
    // concurrently. A failure keeps whatever the card already shows.
    let shownCoverIDs = covers.mapValues(\.id)
    await withTaskGroup(of: (String, GeneratedSearchAssetPage?).self) { group in
      for collection in loaded {
        let shownCoverID = shownCoverIDs[collection.id]
        group.addTask { [client, coverWarmer] in
          let page = try? await client.assets(
            collectionID: collection.id, limit: Self.firstPageSize, snapshot: true)
          if let cover = page?.results.first, cover.id != shownCoverID {
            await coverWarmer?(cover)
          }
          return (collection.id, page)
        }
      }
      for await (id, page) in group {
        guard g == generation else { return }
        if let page { firstPages[id] = page }
      }
    }
    guard g == generation else { return }
    await cache?.write(
      ForYouSnapshot(collections: collections, firstPages: firstPages), libraryID: libraryID)
  }

  private func show(_ cached: ForYouSnapshot) {
    collections = arrangeForSession(cached.collections)
    let ids = Set(cached.collections.map(\.id))
    firstPages = cached.firstPages.filter { ids.contains($0.key) }
  }

  /// `loaded` in this session's order for the library, recorded so the next
  /// load — on this view model or a new one — keeps it.
  private func arrangeForSession(_ loaded: [GeneratedSearchCard]) -> [GeneratedSearchCard] {
    let day = ForYouOrder.day(of: loaded)
    let order = ForYouOrder.arrange(
      loaded.map(\.id), keeping: sessionOrder.order(for: libraryID, day: day), using: &random)
    sessionOrder.record(order, day: day, for: libraryID)
    let byID = Dictionary(loaded.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return order.compactMap { byID[$0] }
  }

  /// The FIRST PAGE of one collection's photos, plus the collection's full
  /// size — the page `load()` already fetched when there is one, else a
  /// fresh fetch, else an empty page (the caller then doesn't open
  /// anything). The grid this opens pages onward from here; a collection is
  /// routinely bigger than one response.
  public func firstPage(of collection: GeneratedSearchCard) async -> GeneratedSearchAssetPage {
    if let cached = firstPages[collection.id] { return cached }
    return (try? await client.assets(collectionID: collection.id))
      ?? GeneratedSearchAssetPage(results: [], total: 0)
  }

  /// The live first page that replaces a snapshot once the collection is
  /// open. The request omits the snapshot flag, so it is always the real query.
  public func liveFirstPage(of collectionID: String) async -> GeneratedSearchAssetPage? {
    try? await client.assets(collectionID: collectionID, limit: Self.firstPageSize)
  }

  /// The next page of a collection after `offset` rows, through the same
  /// endpoint as the first so the order (newest first) stays consistent.
  public func page(
    of collectionID: String, offset: Int, limit: Int
  ) async throws -> GeneratedSearchAssetPage {
    try await client.assets(collectionID: collectionID, limit: limit, offset: offset)
  }
}
