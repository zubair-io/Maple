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

  /// First asset of each collection — the card's cover.
  public var covers: [String: SearchAsset] {
    firstPages.compactMapValues(\.results.first)
  }

  public let libraryID: String
  /// Enough to fill the first screens of a 3-column grid; the rest pages in.
  nonisolated static let firstPageSize = 30
  private let client: GeneratedSearchClient
  private var generation: Int = 0

  public init(libraryID: String, client: GeneratedSearchClient) {
    self.libraryID = libraryID
    self.client = client
  }

  /// Load the most recent day that produced anything. Omitting the date is
  /// what keeps a late or empty run showing yesterday's set rather than
  /// blanking the screen.
  public func load() async {
    generation += 1
    let g = generation
    isLoading = true
    defer { if g == generation { isLoading = false } }

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
    collections = loaded
    // Drop covers for collections that just fell out of the set. A reload
    // replaces `collections` wholesale, so without this the map only ever
    // grows — every day's retired collections stay resident for the life of
    // the screen. Pruning rather than clearing keeps the covers that survived
    // the reload on screen instead of blanking every card for a beat.
    let loadedIDs = Set(loaded.map(\.id))
    firstPages = firstPages.filter { loadedIDs.contains($0.key) }

    // One fetch per collection (there are a handful per day), run
    // concurrently. A failure just leaves that card on its gradient.
    await withTaskGroup(of: (String, GeneratedSearchAssetPage?).self) { group in
      for collection in loaded {
        group.addTask { [client] in
          (
            collection.id,
            try? await client.assets(collectionID: collection.id, limit: Self.firstPageSize)
          )
        }
      }
      for await (id, page) in group {
        guard g == generation else { return }
        if let page { firstPages[id] = page }
      }
    }
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

  /// The next page of a collection after `offset` rows, through the same
  /// endpoint as the first so the order (newest first) stays consistent.
  public func page(
    of collectionID: String, offset: Int, limit: Int
  ) async throws -> GeneratedSearchAssetPage {
    try await client.assets(collectionID: collectionID, limit: limit, offset: offset)
  }
}
