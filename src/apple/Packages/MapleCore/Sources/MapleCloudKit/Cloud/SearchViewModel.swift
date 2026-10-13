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
  /// Serves a generated-search collection's rows after `offset`.
  public typealias CollectionPager =
    @MainActor (_ offset: Int, _ limit: Int) async throws -> GeneratedSearchAssetPage

  // MARK: - Published state

  public private(set) var results: [SearchAsset] = []
  public private(set) var facets: SearchFacets?
  public private(set) var total: Int = 0
  /// `total` is a free-text window with hits left past it; a deeper page widens it (#4514).
  public private(set) var moreBeyondTotal: Bool = false
  /// The window stopped at the server's 5,000-hit cap with matches left (#4514).
  public private(set) var cappedAtTotal: Bool = false
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
  public var params: SearchParams {
    didSet {
      guard oldValue.ownerID != params.ownerID else { return }
      generation &+= 1
      debounceTask?.cancel()
      results = []
      facets = nil
      total = 0
      moreBeyondTotal = false
      cappedAtTotal = false
      page = 0
      nextCursor = nil
      appliedDates = nil
      isLoading = false
      isLoadingMore = false
      loadError = nil
    }
  }
  public let ownerFilter: AssetOwnerFilterModel

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
  /// Set while the results are a generated-search collection (#4410); any
  /// submit clears it.
  private var collectionPager: CollectionPager?
  /// True from showing a collection's snapshot until its live first page
  /// lands. Pagination waits: offsets only mean something against the live
  /// order.
  private var isRefreshingCollection = false
  private var liveFirstPageGeneration: Int?
  private var pendingLiveFirstPage: (() async -> GeneratedSearchAssetPage?)?

  /// In-memory result cache so re-issuing an identical query serves from
  /// memory (session-scoped, like the web cache). Pages key on the params,
  /// page index and the rank pin they continue (#4542); facets on `FacetKey`.
  private var pageCache: [PageKey: SearchResponse] = [:]
  /// The ranking the pages held came from (#4542); sent with each further page.
  private var rankPin: String?
  private var facetCache: [FacetKey: SearchFacets] = [:]

  private struct PageKey: Hashable {
    let params: SearchParams
    let page: Int
    let rankPin: String?
  }

  /// Facets are cached per query and window step (#4514): every page within a
  /// step of the server's window ladder, the first included, shares one key.
  private struct FacetKey: Hashable {
    let params: SearchParams
    let step: Int
  }

  private func facetKey(_ params: SearchParams, page listPage: Int) -> FacetKey {
    let hasText = !params.placeQuery.trimmingCharacters(in: .whitespaces).isEmpty
    let step = hasText ? Self.windowStep(reaching: (listPage + 1) * limit) : 0
    return FacetKey(params: params, step: step)
  }

  public init(
    server: URL,
    libraryID: String? = nil,
    searchClient: CloudSearchClient,
    limit: Int = 100,
    currentUserID: String? = nil
  ) {
    self.server = server
    self.libraryID = libraryID
    self.searchClient = searchClient
    self.ownerFilter = AssetOwnerFilterModel(
      searchClient: searchClient, currentUserID: currentUserID)
    self.limit = limit
    self.params = SearchParams(libraryID: libraryID)
  }

  /// True while more pages remain for the current result set.
  public var canLoadMore: Bool { results.count < total || moreBeyondTotal }

  /// True when `total` is a lower bound on the matches, so a count reads "N+".
  public var totalIsLowerBound: Bool { moreBeyondTotal || cappedAtTotal }

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
  /// Which matches the facet rows count (#4431); `.all` until facets load.
  public var facetScope: FacetScope { facets?.scope ?? .all }

  // MARK: - Loaders

  /// Debounced text-input handler. Coalesces rapid keystrokes into one
  /// request 250 ms after the last change (matches the web search box).
  public func queryChanged() {
    debounceTask?.cancel()
    debounceTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 250_000_000)
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
    collectionPager = nil
    isRefreshingCollection = false
    pendingLiveFirstPage = nil
    generation &+= 1
    let g = generation
    page = 0
    isLoadingMore = false
    nextCursor = nil
    rankPin = nil
    lastSubmittedParams = params
    let requested = params
    let pageKey = PageKey(params: requested, page: 0, rankPin: nil)

    // Serve an identical query (results + facets) from the in-memory cache —
    // no spinner, no network round-trip. Only short-circuit when BOTH are
    // cached so a prior facet failure still triggers a refetch.
    if let cachedPage = pageCache[pageKey],
      let cachedFacets = facetCache[facetKey(requested, page: 0)]
    {
      loadError = nil
      results = cachedPage.results
      nextCursor = cachedPage.nextCursor
      rankPin = cachedPage.rankPin
      // Must be refreshed here too, not only on the network path: leaving the
      // previous query's value behind makes the chip claim a date filter this
      // query does not carry — the false filter state the chip exists to
      // prevent (#2960).
      appliedDates = cachedPage.dateFilter
      total = cachedPage.seekExhausted ? cachedPage.results.count : cachedPage.total
      moreBeyondTotal = cachedPage.more ?? false
      cappedAtTotal = cachedPage.capped ?? false
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
    async let facetResp = searchClient.facets(requested, page: 0, limit: limit)
    do {
      let resp = try await searchClient.search(requested, page: 0, limit: limit)
      guard g == generation else {
        _ = try? await facetResp
        return
      }
      pageCache[pageKey] = resp
      results = resp.results
      nextCursor = resp.nextCursor
      rankPin = resp.rankPin
      appliedDates = resp.dateFilter
      // An exhausted seek chain means the rows we hold ARE the result set —
      // see `SearchResponse.seekExhausted`. Believing a stale cached `total`
      // instead would keep `canLoadMore` true and drop `loadMore()` back to
      // deep page-based SKIP pagination.
      total = resp.seekExhausted ? resp.results.count : resp.total
      moreBeyondTotal = resp.more ?? false
      cappedAtTotal = resp.capped ?? false
      // Results publish before facets: the facet aggregation is the slower
      // request and only feeds the filter panel, so it must not hold the grid.
      isLoading = false
      let facetsResult = try? await facetResp
      guard g == generation else { return }
      if let facetsResult {
        facetCache[facetKey(requested, page: 0)] = facetsResult
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
      moreBeyondTotal = false
      cappedAtTotal = false
      // Keep the last good facets (mirrors the web client): an aggregation
      // hiccup shouldn't blank the People / Places pickers, and nothing is
      // scheduled to refill them — `loadFacetsIfNeeded()` treats non-nil
      // facets as loaded, so clearing here would strand the panel empty
      // until the next successful search (#2879).
    }
  }

  /// Show a generated-search collection's already-fetched first page as the
  /// results — no request — with `params` set to its stored query so the
  /// field and chips describe it. `nextPage` serves the rest of the
  /// collection; an edit to the query or filters runs a normal search.
  public func showCollection(
    params seed: SearchParams,
    firstPage: GeneratedSearchAssetPage,
    nextPage: @escaping CollectionPager,
    liveFirstPage: (() async -> GeneratedSearchAssetPage?)? = nil
  ) {
    debounceTask?.cancel()
    generation &+= 1
    params = seed
    lastSubmittedParams = seed
    collectionPager = nextPage
    results = firstPage.results
    total = firstPage.total
    moreBeyondTotal = firstPage.more
    cappedAtTotal = firstPage.capped
    page = 0
    nextCursor = nil
    appliedDates = nil
    isLoading = false
    isLoadingMore = false
    loadError = nil
    // The panel's People / Places rows belong to the previous query;
    // `loadFacetsIfNeeded()` refetches them for the card's when it opens.
    facets = nil

    isRefreshingCollection = liveFirstPage != nil
    pendingLiveFirstPage = liveFirstPage
    guard liveFirstPage != nil else { return }
    Task { [weak self] in await self?.applyLiveFirstPage() }
  }

  /// Swap the snapshot for the live first page. The guard on pagination stays
  /// up until a live page actually arrives; a failure leaves the snapshot in
  /// place for `loadMore()` to retry.
  private func applyLiveFirstPage() async {
    let g = generation
    guard let load = pendingLiveFirstPage, liveFirstPageGeneration != g else { return }
    liveFirstPageGeneration = g
    let live = await load()
    // A refresh for an older generation must release its claim without
    // touching the newer collection's.
    if liveFirstPageGeneration == g { liveFirstPageGeneration = nil }
    guard g == generation, let live else { return }
    results = live.results
    total = live.total
    moreBeyondTotal = live.more
    cappedAtTotal = live.capped
    // Still the stored preview: the server's engine is loading (#4514). Keep
    // the live page pending so the next `loadMore()` asks again.
    guard !live.isPending else { return }
    pendingLiveFirstPage = nil
    isRefreshingCollection = false
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
    let key = facetKey(requested, page: page)
    if let cached = facetCache[key] {
      facets = cached
      return
    }
    let g = generation
    isLoadingFacets = true
    defer { isLoadingFacets = false }
    // Best-effort: a facet failure is not a search failure, so it must not
    // raise the error banner over the (perfectly fine) Recents list.
    guard let loaded = try? await searchClient.facets(requested, page: page, limit: limit)
    else { return }
    guard g == generation else {
      // A reset superseded this load; the panel may already be open on the
      // new params, so fetch those now rather than leaving it empty.
      isLoadingFacets = false
      await loadFacetsIfNeeded()
      return
    }
    facetCache[key] = loaded
    facets = loaded
  }

  /// A deeper page widened a free-text search's ranked window (#4514):
  /// refetch the facets for that window, keeping the current ones on screen
  /// until the new ones land.
  private func refreshFacetsForWindow(page windowPage: Int, generation g: Int) async {
    let requested = params
    let key = facetKey(requested, page: windowPage)
    if let cached = facetCache[key] {
      facets = cached
      return
    }
    guard let loaded = try? await searchClient.facets(requested, page: windowPage, limit: limit),
      g == generation
    else { return }
    facetCache[key] = loaded
    facets = loaded
  }

  /// Whether a page that just landed widened the window a free-text total counts.
  private func widensWindow(_ response: SearchResponse, over previousTotal: Int) -> Bool {
    !params.placeQuery.trimmingCharacters(in: .whitespaces).isEmpty
      && !response.results.isEmpty && response.total != previousTotal
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
    // A snapshot always has a live page pending, whatever its total says, so a
    // one-page collection whose reload failed still heals here.
    if isRefreshingCollection {
      await applyLiveFirstPage()
      return
    }
    guard canLoadMore, !isLoading, !isLoadingMore else { return }
    let g = generation
    isLoadingMore = true
    // A fresh submit resets this flag; an older completion must never clear
    // the flag belonging to the new owner's pagination request.
    defer { if g == generation { isLoadingMore = false } }

    if let collectionPager {
      do {
        let more = try await collectionPager(results.count, limit)
        guard g == generation else { return }
        page += 1
        results.append(contentsOf: more.results)
        total = more.results.isEmpty ? results.count : more.total
        moreBeyondTotal = !more.results.isEmpty && more.more
        cappedAtTotal = more.capped
      } catch {
        if Self.isCancellation(error) { return }
        guard g == generation else { return }
        loadError = error
      }
      return
    }

    let next = page + 1
    let requested = params
    let pageKey = PageKey(params: requested, page: next, rankPin: rankPin)
    // Seek past the last row we hold when the server minted a cursor; the
    // page index still advances so it can key the cache and cover the
    // skip-pagination fallback (see `nextCursor`).
    let seek = nextCursor

    let previousTotal = total
    if let cached = pageCache[pageKey] {
      guard g == generation else { return }
      page = next
      results.append(contentsOf: cached.results)
      nextCursor = cached.nextCursor
      rankPin = cached.rankPin
      total = cached.seekExhausted ? results.count : cached.total
      moreBeyondTotal = !cached.results.isEmpty && (cached.more ?? false)
      cappedAtTotal = cached.capped ?? false
      if widensWindow(cached, over: previousTotal) {
        Task { [weak self] in await self?.refreshFacetsForWindow(page: next, generation: g) }
      }
      return
    }

    do {
      let resp = try await searchClient.search(
        requested, page: next, limit: limit, cursor: seek, rankPin: rankPin)
      guard g == generation else { return }
      pageCache[pageKey] = resp
      page = next
      results.append(contentsOf: resp.results)
      nextCursor = resp.nextCursor
      rankPin = resp.rankPin
      total = resp.seekExhausted ? results.count : resp.total
      moreBeyondTotal = !resp.results.isEmpty && (resp.more ?? false)
      cappedAtTotal = resp.capped ?? false
      if widensWindow(resp, over: previousTotal) {
        Task { [weak self] in await self?.refreshFacetsForWindow(page: next, generation: g) }
      }
    } catch {
      if Self.isCancellation(error) { return }
      guard g == generation else { return }
      // The engine that ranked the pages held is gone: another engine's next
      // page would repeat and skip rows, so start the search over (#4542).
      if error as? SearchPagingError == .rankEngineChanged {
        pageCache = pageCache.filter { $0.key.params != requested }
        await submit()
        return
      }
      loadError = error
    }
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

  /// Drop every filter without running a search: the text field was just
  /// cleared, so the page shows Recents and nothing should be fetched.
  public func resetFilters() {
    let keptSort = params.sort
    var fresh = SearchParams(libraryID: libraryID)
    fresh.sort = keptSort
    debounceTask?.cancel()
    generation &+= 1
    collectionPager = nil
    params = fresh
    lastSubmittedParams = fresh
    results = []
    total = 0
    moreBeyondTotal = false
    cappedAtTotal = false
    page = 0
    nextCursor = nil
    appliedDates = nil
    isLoading = false
    isLoadingMore = false
    loadError = nil
    // The panel's People / Places rows were scoped to the dropped filters;
    // `loadFacetsIfNeeded()` refetches the unfiltered set when it opens.
    facets = nil
  }

  /// Stages a preview's state; see `SearchViewModel+Preview.swift`.
  func _stagePreview(loading: Bool, results assets: [SearchAsset]) {
    isLoading = loading
    results = assets
    total = assets.count
  }

  // MARK: - Test-only internal setters

  /// Internal (module-visible) write path so the test target can seed
  /// `results` and `total` without breaking out of `private(set)`.
  /// Equivalent to what the test extension tried to do, but expressed at
  /// the module level where the private setter is accessible.
  /// Called exclusively from `SearchViewModelTests`.
  func _testSetResults(_ assets: [SearchAsset]) {
    results = assets
    total = assets.count
  }

  func _testSeedForLoadMore(results: [SearchAsset], total: Int) {
    self.results = results
    self.total = total
  }
}
