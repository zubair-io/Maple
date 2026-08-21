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
  /// Opaque seek cursor for the next page (#2129), or nil when the server
  /// has none for this query — an unseekable sort (`name` / `rating`), a
  /// relevance-ranked `placeQuery`, or a server predating the field.
  /// `loadMore()` falls back to `page + 1` then, so both modes coexist.
  public private(set) var nextCursor: String?
  /// The capture-date window the server applied, so a window it inferred from
  /// the query text can be shown rather than silently narrowing the results
  /// while the filter panel shows nothing (#2956).
  public private(set) var appliedDates: AppliedDateFilter?

  /// Mutable search parameters. Filter controls bind to fields here, then
  /// call `submit()`; the text box calls `queryChanged()` (debounced).
  public var params: SearchParams

  // MARK: - Dependencies

  public nonisolated let server: URL
  public let libraryID: String?
  private let searchClient: CloudSearchClient
  private let limit: Int

  /// Bumped on every fresh `submit()` — in-flight closures check this and
  /// drop results from an older generation.
  private var generation: Int = 0
  /// Pending debounced search; cancelled when a newer keystroke arrives.
  private var debounceTask: Task<Void, Never>?
  /// True while a facets-only load is in flight, so repeat calls to
  /// `loadFacetsIfNeeded()` (view appear + filter sheet presented) collapse
  /// into a single request.
  private var isLoadingFacets: Bool = false
  /// The params last sent to the server. Lets `submitIfChanged()` skip a
  /// redundant round-trip when nothing actually changed (e.g. the filter
  /// popover closes without an edit).
  private var lastSubmittedParams: SearchParams?

  /// In-memory result cache so re-issuing an identical query (clear-then-
  /// reapply, popover round-trips, toggling a sort back) serves from memory
  /// instead of re-hitting the network — mirrors the web search cache.
  /// Pages key on the full param set + page index; facets on the param set
  /// alone. Lives for the VM's lifetime (session-scoped, like the web cache).
  private var pageCache: [PageKey: SearchResponse] = [:]
  private var facetCache: [SearchParams: SearchFacets] = [:]

  private struct PageKey: Hashable {
    let params: SearchParams
    let page: Int
  }

  public init(server: URL,
              libraryID: String? = nil,
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

  /// True when any unified filter (date range / people / places) is set.
  /// A filters-only search (empty text, filters set) must still fetch —
  /// UI layers that gate their fetch on non-empty text OR on this.
  public var hasUnifiedFilters: Bool { params.hasUnifiedFilters }

  /// Badge count for the "Filters" control (date range = 1, + one per
  /// selected person / place).
  public var unifiedFilterCount: Int { params.unifiedFilterCount }

  /// Facet rows for the filter panel's PEOPLE section ([] until the first
  /// facets response, or on servers predating the field).
  public var peopleFacets: [ValueFacet] { facets?.people ?? [] }

  /// Facet rows for the filter panel's PLACES section.
  public var placeFacets: [ValueFacet] { facets?.places ?? [] }

  /// Live "Show N results" count for the current filter set — the facets
  /// total when one is loaded, else the result-list total.
  public var facetTotal: Int { facets?.total ?? total }

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

  /// Cancel a pending debounced search without issuing one. The text box
  /// calls this when the query is edited down to empty: otherwise a
  /// debounce scheduled by the previous non-empty keystroke would still
  /// fire ~250 ms later and run an (empty) all-library `submit()` behind
  /// the idle UI — a wasted round-trip that also leaves stale results
  /// cached under the empty-query state.
  public func cancelPendingDebounce() {
    debounceTask?.cancel()
    debounceTask = nil
  }

  /// Run a fresh search from page 0 (results + facets), cancelling any
  /// pending debounce. Filter controls call this immediately on change.
  public func submit() async {
    debounceTask?.cancel()
    generation &+= 1
    let g = generation
    page = 0
    nextCursor = nil
    lastSubmittedParams = params
    let requested = params
    let pageKey = PageKey(params: requested, page: 0)

    // Serve an identical query (results + facets) from the in-memory cache —
    // no spinner, no network round-trip. Only short-circuit when BOTH are
    // cached so a prior facet failure still triggers a refetch.
    if let cachedPage = pageCache[pageKey], let cachedFacets = facetCache[requested] {
      loadError = nil
      results = cachedPage.results
      nextCursor = cachedPage.nextCursor
      // Must be refreshed here too, not only on the network path: leaving the
      // previous query's value behind makes the chip claim a date filter this
      // query does not carry — the false filter state the chip exists to
      // prevent (#2960).
      appliedDates = cachedPage.dateFilter
      total = cachedPage.seekExhausted ? cachedPage.results.count : cachedPage.total
      facets = cachedFacets
      return
    }

    isLoading = true
    loadError = nil
    defer { if g == generation { isLoading = false } }

    // Results and facets run concurrently against the actor. A facet
    // failure must not blank the results, so it's awaited best-effort. The
    // child task is awaited in both branches so it isn't implicitly
    // cancelled mid-flight when `search` throws.
    async let facetResp = searchClient.facets(requested)
    do {
      let resp = try await searchClient.search(requested, page: 0, limit: limit)
      let facetsResult = try? await facetResp
      guard g == generation else { return }
      pageCache[pageKey] = resp
      results = resp.results
      nextCursor = resp.nextCursor
      appliedDates = resp.dateFilter
      // An exhausted seek chain means the rows we hold ARE the result set —
      // see `SearchResponse.seekExhausted`. Believing a stale cached `total`
      // instead would keep `canLoadMore` true and drop `loadMore()` back to
      // deep page-based SKIP pagination.
      total = resp.seekExhausted ? resp.results.count : resp.total
      if let facetsResult {
        facetCache[requested] = facetsResult
        facets = facetsResult
      }
    } catch {
      _ = try? await facetResp
      // A debounced keystroke cancels the prior in-flight request — swallow
      // silently and leave the current results in place; the newer search is
      // already on its way. Showing a "cancelled" banner would be wrong.
      if Self.isCancellation(error) { return }
      guard g == generation else { return }
      loadError = error
      results = []
      total = 0
      // Keep the last good facets (mirrors the web client): an aggregation
      // hiccup shouldn't blank the People / Places pickers, and nothing is
      // scheduled to refill them — `loadFacetsIfNeeded()` treats non-nil
      // facets as loaded, so clearing here would strand the panel empty
      // until the next successful search (#2879).
    }
  }

  /// Populate the filter panel's option lists WITHOUT running a result
  /// search. The iPhone Search tab shows recent queries until the user
  /// types, so nothing ever calls `submit()` from a cold, empty search —
  /// which left People / Places empty and made the panel unusable until a
  /// filter was already set, the chicken-and-egg in #2879. Running a full
  /// empty-query `submit()` instead would replace the Recents list with
  /// whole-library results, so this fetches facets alone.
  ///
  /// Idempotent: no-ops once facets are loaded or while a load is in
  /// flight, and drops its response if a `submit()` superseded it.
  public func loadFacetsIfNeeded() async {
    guard facets == nil, !isLoadingFacets else { return }
    let requested = params
    if let cached = facetCache[requested] {
      facets = cached
      return
    }
    let g = generation
    isLoadingFacets = true
    defer { isLoadingFacets = false }
    // Best-effort: a facet failure is not a search failure, so it must not
    // raise the error banner over the (perfectly fine) Recents list.
    guard let loaded = try? await searchClient.facets(requested) else { return }
    guard g == generation else { return }
    facetCache[requested] = loaded
    facets = loaded
  }

  /// Re-run the search only if `params` changed since the last submit.
  /// Used when the filter popover closes to catch typed-but-not-committed
  /// numeric / date fields without firing a redundant request when nothing
  /// changed.
  public func submitIfChanged() async {
    if params != lastSubmittedParams { await submit() }
  }

  /// Fetch the next page and append. No-ops when a load is already in
  /// flight or there's nothing more to fetch.
  public func loadMore() async {
    guard canLoadMore, !isLoading, !isLoadingMore else { return }
    let g = generation
    isLoadingMore = true
    // Cleared unconditionally: if a `submit()` bumps `generation` mid-flight,
    // a generation-guarded reset would leave this stuck `true` and block all
    // further pagination. `submit()` doesn't read `isLoadingMore`, so an
    // unconditional clear is safe.
    defer { isLoadingMore = false }

    let next = page + 1
    let requested = params
    let pageKey = PageKey(params: requested, page: next)
    // Seek past the last row we hold when the server minted a cursor; the
    // page index still advances so it can key the cache and cover the
    // skip-pagination fallback (see `nextCursor`).
    let seek = nextCursor

    if let cached = pageCache[pageKey] {
      guard g == generation else { return }
      page = next
      results.append(contentsOf: cached.results)
      nextCursor = cached.nextCursor
      total = cached.seekExhausted ? results.count : cached.total
      return
    }

    do {
      let resp = try await searchClient.search(requested, page: next, limit: limit, cursor: seek)
      guard g == generation else { return }
      pageCache[pageKey] = resp
      page = next
      results.append(contentsOf: resp.results)
      nextCursor = resp.nextCursor
      total = resp.seekExhausted ? results.count : resp.total
    } catch {
      if Self.isCancellation(error) { return }
      guard g == generation else { return }
      loadError = error
    }
  }

  /// True when `error` is a request/task cancellation (debounce superseded
  /// this search) rather than a genuine network/decode failure.
  private static func isCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    if let urlError = error as? URLError, urlError.code == .cancelled { return true }
    let ns = error as NSError
    return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
  }

  /// Reset every structured filter (keeping the free-text query + sort)
  /// and re-run the search.
  public func clearFilters() {
    let keptQuery = params.q
    let keptPlaceQuery = params.placeQuery
    let keptSort = params.sort
    var fresh = SearchParams(libraryID: libraryID)
    fresh.q = keptQuery
    fresh.placeQuery = keptPlaceQuery
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

  // MARK: - Test-only internal setters

  /// Internal (module-visible) write path so the test target can seed
  /// `results` and `total` without breaking out of `private(set)`.
  /// Equivalent to what the test extension tried to do, but expressed at
  /// the module level where the private setter is accessible.
  /// Called exclusively from `SearchViewModelTests`.
  func _test_setResults(_ assets: [SearchAsset]) {
    results = assets
    total = assets.count
  }

  func _test_seedForLoadMore(results: [SearchAsset], total: Int) {
    self.results = results
    self.total = total
  }
}
