// src/apple/Maple TV/TVMemoryAssetsViewModel.swift
//
// Paging for one memory's photo grid (`MemoryDetailScreen`).
//
// A memory can hold far more photos than one response should carry, and the
// grid used to show a single page of 50 while the card it was opened from
// advertised the collection's real `result_count` — so a "212 photos" memory
// opened onto 50 and stopped, with nothing to say it had been truncated.
// `/api/generated-searches/:id/assets` returns the collection's full `total`
// alongside every page, so the grid pages with `offset` until it holds that
// many.
//
// Seeded rather than self-loading: `MemoriesScreen` has to fetch the first
// page anyway to decide whether the memory is worth opening at all (an empty
// one opens nothing), so re-fetching page 0 here would be a second round trip
// for rows already in hand.
//
// Generation-counter staleness guard mirrors `TVTimelineViewModel`: bump
// before any `await`, re-check after every suspension point, so a superseded
// page can't append itself on top of newer state.

import Foundation
import MapleCloudKit
import Observation

@MainActor
@Observable
final class TVMemoryAssetsViewModel {
  private(set) var assets: [SearchAsset]
  private(set) var isLoadingMore: Bool = false
  /// Set when the server returns an empty page before `total` is reached —
  /// see `loadMore()`. Stops the grid asking again.
  private var exhausted: Bool = false

  /// Size of the whole collection, from the server. `assets.count` catches up
  /// to it one page at a time.
  private let total: Int
  private let collectionID: String
  private let client: GeneratedSearchClient
  private let pageSize: Int
  private var generation: Int = 0

  init(
    collectionID: String,
    firstPage: [SearchAsset],
    total: Int,
    client: GeneratedSearchClient,
    pageSize: Int = 100
  ) {
    self.collectionID = collectionID
    self.assets = firstPage
    // A server that reported fewer rows than it actually sent would otherwise
    // leave `canLoadMore` permanently false-negative; trust the larger of the
    // two so the grid never claims to hold more than it shows.
    self.total = max(total, firstPage.count)
    self.client = client
    self.pageSize = pageSize
  }

  var canLoadMore: Bool { !exhausted && assets.count < total }

  /// Fetch the next page. A no-op when everything is loaded or a page is
  /// already in flight — the grid calls this from `onAppear` on several cells
  /// at once as a row scrolls into view.
  func loadMore() async {
    guard canLoadMore, !isLoadingMore else { return }
    generation &+= 1
    let g = generation
    let offset = assets.count
    isLoadingMore = true
    defer { if g == generation { isLoadingMore = false } }

    guard let page = try? await client.assets(
      collectionID: collectionID,
      limit: pageSize,
      offset: offset
    ) else { return }
    guard g == generation else { return }
    // An empty page means the collection shrank under us (the query is
    // re-derived server-side on every call). Appending nothing and leaving
    // `canLoadMore` true would spin `onAppear` forever, so clamp the target
    // to what we actually hold.
    guard !page.results.isEmpty else {
      exhausted = true
      return
    }
    assets.append(contentsOf: page.results)
  }
}
