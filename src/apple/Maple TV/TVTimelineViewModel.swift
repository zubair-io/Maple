// src/apple/Maple TV/TVTimelineViewModel.swift
//
// Drives the Maple TV Timeline screen: a flat, newest-first feed of the
// library's photos (no day/location grouping — that grouping moved to a
// per-focused-photo header instead). One `/api/search` call sorted
// `captured_desc` over the whole library, paginated as the Siri Remote
// focus engine nears the end of the loaded set — the same continuous feed
// the phone shows, rather than the old per-month bucket paging that only
// loaded each month's first page and so diverged from the phone's timeline.
//
// Generation-counter staleness guard mirrors `SearchViewModel`
// (MapleCloudKit/Cloud/SearchViewModel.swift): bump `generation` before any
// `await`, then `guard g == generation else { return }` after every
// suspension point, so a rapid library switch / re-load can't have an older
// in-flight response clobber newer state.
//
// TV-native (not `CloudTimelineViewModel` from MapleCore) because that VM
// carries a PhotoKit-merge dependency; the Maple TV target links
// `MapleCloudKit` only (no MapleCore, no RawPipeline — see
// `MapleCloudKitPortabilityTests`).

import Foundation
import MapleCloudKit
import Observation

@MainActor
@Observable
final class TVTimelineViewModel {
  // MARK: - Published state

  /// The whole feed loaded so far, newest capture first (the server sorts
  /// `captured_desc`; we append pages in order).
  private(set) var assets: [SearchAsset] = []
  private(set) var isLoading: Bool = false
  private(set) var isLoadingMore: Bool = false
  private(set) var loadError: Error?
  /// Server's total match count, so `canLoadMore` knows when to stop.
  private(set) var total: Int = 0

  // MARK: - Dependencies

  let server: URL
  let libraryID: String
  private let searchClient: CloudSearchClient
  private let pageSize: Int

  /// Zero-indexed page of the last successfully appended page.
  private var page: Int = 0
  /// Bumped on every `load()` — in-flight page fetches check this and drop
  /// completions from an older generation rather than mutating state.
  private var generation: Int = 0

  init(server: URL,
       libraryID: String,
       searchClient: CloudSearchClient,
       pageSize: Int = 120) {
    self.server = server
    self.libraryID = libraryID
    self.searchClient = searchClient
    self.pageSize = pageSize
  }

  /// True while more pages remain for the current feed.
  var canLoadMore: Bool { assets.count < total }

  /// The whole-library, newest-first feed: no query, no filters, just
  /// `sort=captured_desc` and `hasCapturedAt=true` so undated assets don't
  /// sort to the top of a "latest photos" list.
  private func feedParams() -> SearchParams {
    var params = SearchParams(libraryID: libraryID)
    params.sort = .capturedDesc
    params.hasCapturedAt = true
    return params
  }

  // MARK: - Loaders

  /// Fresh load from page 0. Called on Timeline appearance and on library
  /// switch (the caller gives this screen a fresh identity per library, so
  /// a plain `.task` re-runs `load()` against a viewModel scoped to the new
  /// library — see `TimelineScreen`).
  func load() async {
    generation &+= 1
    let g = generation
    loadError = nil
    isLoading = true
    defer { if g == generation { isLoading = false } }

    page = 0
    do {
      let resp = try await searchClient.search(feedParams(), page: 0, limit: pageSize)
      guard g == generation else { return }
      assets = resp.results
      total = resp.total
    } catch {
      guard g == generation else { return }
      assets = []
      total = 0
      loadError = error
    }
  }

  /// Fetch and append the next page as the focus engine approaches the end
  /// of the loaded feed. No-ops when a load is already in flight or there's
  /// nothing more to fetch.
  func loadMore() async {
    guard canLoadMore, !isLoading, !isLoadingMore else { return }
    let g = generation
    isLoadingMore = true
    defer { isLoadingMore = false }

    let next = page + 1
    do {
      let resp = try await searchClient.search(feedParams(), page: next, limit: pageSize)
      guard g == generation else { return }
      page = next
      assets.append(contentsOf: resp.results)
      total = resp.total
    } catch {
      guard g == generation else { return }
      // Keep what's already loaded — a failed page shouldn't blank the feed.
    }
  }
}
