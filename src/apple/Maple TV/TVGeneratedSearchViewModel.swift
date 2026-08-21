// src/apple/Maple TV/TVGeneratedSearchViewModel.swift
//
// Drives the collections shelf above the Timeline grid: the themed
// collections the server's generated-search worker invents daily
// ("Spooky Nights", "Seven Summers of Lake George").
//
// Two behaviours are deliberate:
//
//   * A failure is NOT surfaced as an error state. The shelf is an extra
//     above the real feed — if collections can't load, the Timeline below is
//     still perfectly usable, and a red banner over a working grid would be
//     worse than no shelf at all.
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
  /// First asset of each collection, keyed by collection id — the shelf needs
  /// a real `abs_path` to render a cover (the card carries only an id), and
  /// fetching it here doubles as a preload for the viewer.
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
  /// blanking the shelf.
  func load() async {
    generation += 1
    let g = generation
    isLoading = true
    defer { if g == generation { isLoading = false } }

    let loaded = (try? await client.collections(libraryID: libraryID)) ?? []
    guard g == generation else { return }
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
