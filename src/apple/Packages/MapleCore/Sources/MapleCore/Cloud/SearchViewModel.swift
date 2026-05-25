// SearchViewModel.swift
//
// Drives the native cloud search view (CloudSearchView). Owns the mutable
// SearchParams the filter UI binds to, fires debounced /api/search +
// /api/search/facets requests, and paginates results as the grid scrolls.
//
// Stale-guarded with a generation counter (docs/best-practices.md
// §"Generation counters for async state") so a rapid query/filter change
// can't have an older in-flight response overwrite the newer state.

import Foundation
import Observation

@MainActor
@Observable
public final class SearchViewModel {
  // MARK: - Published state

  public private(set) var results: [SearchAsset] = []
  public private(set) var facets: SearchFacets?
  public private(set) var total: Int = 0
  public private(set) var isLoading: Bool = false
  public private(set) var isLoadingMore: Bool = false
  public private(set) var loadError: Error?
  public private(set) var page: Int = 0

  /// Mutable search parameters. Filter controls bind to fields here, then
  /// call `submit()`; the text box calls `queryChanged()` (debounced).
  public var params: SearchParams

  // MARK: - Dependencies

  public nonisolated let server: URL
  public let libraryID: String
  private let searchClient: CloudSearchClient
  private let limit: Int

  /// Bumped on every fresh `submit()` — in-flight closures check this and
  /// drop results from an older generation.
  private var generation: Int = 0
  /// Pending debounced search; cancelled when a newer keystroke arrives.
  private var debounceTask: Task<Void, Never>?

  public init(server: URL,
              libraryID: String,
              searchClient: CloudSearchClient,
              limit: Int = 100) {
    self.server = server
    self.libraryID = libraryID
    self.searchClient = searchClient
    self.limit = limit
    self.params = SearchParams(libraryID: libraryID)
  }

  /// True while more pages remain for the current result set.
  public var canLoadMore: Bool { results.count < total }

  /// True when any structured filter is set (drives the "filters" dot).
  public var hasActiveFilters: Bool { params.hasActiveFilters }

  // MARK: - Loaders

  /// Debounced text-input handler. Coalesces rapid keystrokes into one
  /// request 250 ms after the last change (matches the web search box).
  public func queryChanged() {
    debounceTask?.cancel()
    debounceTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(250))
      guard !Task.isCancelled else { return }
      await self?.submit()
    }
  }

  /// Run a fresh search from page 0 (results + facets), cancelling any
  /// pending debounce. Filter controls call this immediately on change.
  public func submit() async {
    debounceTask?.cancel()
    generation &+= 1
    let g = generation
    isLoading = true
    loadError = nil
    page = 0
    defer { if g == generation { isLoading = false } }

    // Results and facets run concurrently against the actor. A facet
    // failure must not blank the results, so it's awaited best-effort. The
    // child task is awaited in both branches so it isn't implicitly
    // cancelled mid-flight when `search` throws.
    async let facetResp = searchClient.facets(params)
    do {
      let resp = try await searchClient.search(params, page: 0, limit: limit)
      let facetsResult = try? await facetResp
      guard g == generation else { return }
      results = resp.results
      total = resp.total
      if let facetsResult { facets = facetsResult }
    } catch {
      _ = try? await facetResp
      guard g == generation else { return }
      loadError = error
      results = []
      total = 0
    }
  }

  /// Fetch the next page and append. No-ops when a load is already in
  /// flight or there's nothing more to fetch.
  public func loadMore() async {
    guard canLoadMore, !isLoading, !isLoadingMore else { return }
    let g = generation
    isLoadingMore = true
    defer { if g == generation { isLoadingMore = false } }

    let next = page + 1
    do {
      let resp = try await searchClient.search(params, page: next, limit: limit)
      guard g == generation else { return }
      page = next
      results.append(contentsOf: resp.results)
      total = resp.total
    } catch {
      guard g == generation else { return }
      loadError = error
    }
  }

  /// Reset every structured filter (keeping the free-text query + sort)
  /// and re-run the search.
  public func clearFilters() {
    let keptQuery = params.q
    let keptSort = params.sort
    var fresh = SearchParams(libraryID: libraryID)
    fresh.q = keptQuery
    fresh.sort = keptSort
    params = fresh
    Task { await submit() }
  }

  // MARK: - Preview

  public enum PreviewState: Sendable {
    case empty
    case loading
    case loaded
  }

  /// Sample VM for SwiftUI `#Preview` blocks. Points at an unreachable
  /// server so any live request fails fast, then stages the requested
  /// case directly.
  public static func preview(_ state: PreviewState = .loaded) -> SearchViewModel {
    let server = URL(string: "https://preview.maple.invalid")!
    let vm = SearchViewModel(
      server: server,
      libraryID: "preview-library",
      searchClient: CloudSearchClient.preview(server: server))
    switch state {
    case .empty:
      break
    case .loading:
      vm.isLoading = true
    case .loaded:
      vm.total = 2
      vm.results = [
        SearchAsset(id: "fs:/photos/IMG_0001.dng", folder_id: "lib",
                    abs_path: "/photos/IMG_0001.dng", filename: "IMG_0001.dng",
                    rating: 4),
        SearchAsset(id: "fs:/photos/IMG_0002.dng", folder_id: "lib",
                    abs_path: "/photos/IMG_0002.dng", filename: "IMG_0002.dng"),
      ]
    }
    return vm
  }
}
