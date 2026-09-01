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
  /// Non-nil when the last `load()` failed. Only meaningful alongside an
  /// empty `collections` — a failure after something already rendered leaves
  /// the loaded set up rather than replacing it with an error.
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
      loadError = error
      return
    }
    guard g == generation else { return }
    loadError = nil
    collections = loaded

    // One small fetch per collection (there are a handful per day), run
    // concurrently. A failure just leaves that card on its gradient.
    await withTaskGroup(of: (String, SearchAsset?).self) { group in
      for collection in loaded {
        group.addTask { [client] in
          let assets = try? await client.assets(collectionID: collection.id, limit: 1)
          return (collection.id, assets?.first)
        }
      }
      for await (id, asset) in group {
        guard g == generation else { return }
        if let asset { covers[id] = asset }
      }
    }
  }

  /// The photos in one collection, or `[]` when the fetch fails — the caller
  /// simply doesn't open a viewer over an empty set.
  func assets(for collection: GeneratedSearchCard) async -> [SearchAsset] {
    (try? await client.assets(collectionID: collection.id)) ?? []
  }
}
