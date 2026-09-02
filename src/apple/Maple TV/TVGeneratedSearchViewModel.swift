// src/apple/Maple TV/TVGeneratedSearchViewModel.swift
//
// Drives `MemoriesScreen`: the themed collections the server's
// generated-search worker invents daily ("Spooky Nights", "Seven Summers of
// Lake George").
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
// Generation-counter staleness guard mirrors `TVTimelineViewModel`: bump
// before any `await`, re-check after every suspension point, so a library
// switch can't let an older response clobber newer state.

import Foundation
import MapleCloudKit
import Observation

@MainActor
@Observable
final class TVGeneratedSearchViewModel {
  private(set) var collections: [GeneratedSearchCard] = []
  private(set) var isLoading: Bool = false
  /// Non-nil only when a load failed *with nothing to fall back on*. A
  /// refresh that fails after a set has already rendered leaves that set up
  /// and clears this — there is nothing useful to say over a working wall of
  /// memories, and a stale non-nil error would invite a caller to show one.
  private(set) var loadError: Error?
  /// First asset of each collection, keyed by collection id — a card needs a
  /// real `abs_path` to render a cover (the collection carries only an id),
  /// and fetching it here doubles as a preload for the viewer.
  private(set) var covers: [String: SearchAsset] = [:]

  private let libraryID: String
  private let client: GeneratedSearchClient
  private var generation: Int = 0

  init(libraryID: String, client: GeneratedSearchClient) {
    self.libraryID = libraryID
    self.client = client
  }

  /// Load the most recent day that produced anything. Omitting the date is
  /// what keeps a late or empty run showing yesterday's set rather than
  /// blanking the screen.
  func load() async {
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
    covers = covers.filter { loadedIDs.contains($0.key) }

    // One small fetch per collection (there are a handful per day), run
    // concurrently. A failure just leaves that card on its gradient.
    await withTaskGroup(of: (String, SearchAsset?).self) { group in
      for collection in loaded {
        group.addTask { [client] in
          let page = try? await client.assets(collectionID: collection.id, limit: 1)
          return (collection.id, page?.results.first)
        }
      }
      for await (id, asset) in group {
        guard g == generation else { return }
        if let asset { covers[id] = asset }
      }
    }
  }

  /// The FIRST PAGE of one collection's photos, plus the collection's full
  /// size — or an empty page when the fetch fails, in which case the caller
  /// simply doesn't open anything. The grid this opens pages onward from here
  /// (`TVMemoryAssetsViewModel`); a collection is routinely bigger than one
  /// response.
  func firstPage(of collection: GeneratedSearchCard) async -> GeneratedSearchAssetPage {
    (try? await client.assets(collectionID: collection.id))
      ?? GeneratedSearchAssetPage(results: [], total: 0)
  }
}
