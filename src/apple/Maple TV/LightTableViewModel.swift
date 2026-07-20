// src/apple/Maple TV/LightTableViewModel.swift
//
// Drives the Maple TV Light Table's ambient source pool (#2121 F2): a
// shuffled mix of `flag=pick` and `rating>=4` assets, falling back to
// recent (`captured_desc`) assets when that primary pool is too thin to
// sustain a long-running ambient cycle without repeating quickly.
//
// `SearchParams`' fields all AND together server-side (see that struct's
// `baseItems()`) — there is no way to express "flag=pick OR rating>=4" as
// one `/api/search` query. This issues two concurrent queries (one per
// filter) and merges the results client-side via `mergeDeduped`
// (MapleCloudKit/Cloud/LightTablePool.swift — hoisted there so its
// selection policy is directly `swift test`-able; see that file's
// header), in priority order — picks first, then high-rated — so an
// asset that's both a pick AND rated ≥4 counts once, sourced from picks.
// The `captured_desc` recent query only fires when picks+high-rated
// together don't clear `minimumPoolSize`, so a library with plenty of
// picks/high-rated assets never pays for a third round trip it won't use.
//
// Generation-counter staleness guard mirrors `TVTimelineViewModel`
// exactly (docs/best-practices.md §"Generation counters for async
// state").

import Foundation
import MapleCloudKit
import Observation

@MainActor
@Observable
final class LightTableViewModel {
  // MARK: - Published state

  /// The ambient display pool, shuffled. Empty while loading, or if the
  /// library genuinely has nothing to show.
  private(set) var pool: [SearchAsset] = []
  private(set) var isLoading: Bool = false
  /// Set only when the pool ended up empty AND at least one of the
  /// underlying queries actually failed — a library with zero picks,
  /// zero high-rated, and zero recent assets (a real empty account) is a
  /// normal empty state, not an error, so a query that simply returns
  /// zero matches never sets this.
  private(set) var loadError: Error?

  // MARK: - Dependencies

  let libraryID: String
  private let searchClient: CloudSearchClient

  /// Below this many candidates, `picks ∪ highRated` alone is judged too
  /// thin to sustain a long ambient cycle without repeating quickly — a
  /// recent-assets query layers in as a fallback (brief's suggested
  /// threshold).
  private static let minimumPoolSize = 8
  /// Per-query result cap. The pool feeds a slowly-cycling ambient
  /// display (one new print every few seconds), not a scrollable grid —
  /// a few dozen candidates per source is ample variety without
  /// over-fetching.
  private static let queryLimit = 40

  /// Bumped on every `load()` — in-flight completions check this and
  /// drop results from an older generation rather than mutating
  /// published state.
  private var generation: Int = 0
  /// Cursor into `pool` for `next()`'s cyclic walk — see that method.
  private var cursor: Int = 0
  /// Background stale-while-revalidate refresh, when the pool was served
  /// from `cachedPools`. Cancelled by `cancelRefresh()` on screen disappear.
  private var refreshTask: Task<Void, Never>?

  /// Session-lifetime pool cache, keyed by library. Reopening the Light
  /// Table serves the last pool instantly from here and only revalidates in
  /// the background, instead of re-running the source queries every time.
  /// (Images are separately cached by `TVDecodedImageCache` / `CloudThumbCache`,
  /// so a reopen also re-renders without re-decoding.)
  private static var cachedPools: [String: [SearchAsset]] = [:]

  init(libraryID: String, searchClient: CloudSearchClient) {
    self.libraryID = libraryID
    self.searchClient = searchClient
  }

  // MARK: - Loading

  func load() async {
    generation &+= 1
    let g = generation
    loadError = nil

    // Cached-first: if we already built a pool for this library this session,
    // show it immediately and revalidate in the background — so reopening the
    // Light Table is instant instead of waiting on the source queries again.
    if let cached = Self.cachedPools[libraryID], !cached.isEmpty {
      pool = cached
      cursor = 0
      refreshTask?.cancel()
      refreshTask = Task { [weak self] in await self?.refresh(generation: g) }
      return
    }

    isLoading = true
    defer { if g == generation { isLoading = false } }
    await refresh(generation: g)
  }

  /// Cancels a background revalidation (call from the screen's `.onDisappear`).
  func cancelRefresh() {
    refreshTask?.cancel()
    refreshTask = nil
  }

  /// Fetches the source queries, merges them into the pool, and updates the
  /// session cache. Runs either inline (cold open) or in the background
  /// (stale-while-revalidate after a cache hit).
  private func refresh(generation g: Int) async {
    // Built as `let`s (via an immediately-invoked mutation) rather than `var`s
    // mutated in place — the params feed concurrent `async let` fetches, and
    // capturing a mutable `var` across concurrently-executing code is a
    // Swift 6 mode error. Every source excludes screenshots AND any asset
    // showing a soft-hidden person (`excludeHiddenPeople`) — the Light Table
    // runs unattended in a living room, so someone the operator deliberately
    // hid must not resurface here. Hidden *images* need no flag: the server
    // filters those out by default.
    let picksParams: SearchParams = {
      var params = SearchParams(libraryID: libraryID)
      params.flag = .pick
      params.sort = .capturedDesc
      params.isScreenshot = false
      params.excludeHiddenPeople = true
      return params
    }()

    let highRatedParams: SearchParams = {
      var params = SearchParams(libraryID: libraryID)
      params.rating = 4
      params.sort = .rating
      params.isScreenshot = false
      params.excludeHiddenPeople = true
      return params
    }()

    // Photos with people (any detected face) from the last year, so the
    // ambient mix leans toward recent shots of people. (`scope=people` is
    // "has a face" server-side; strictly-named-only would need a server
    // filter — see the note in the PR.)
    let peopleParams: SearchParams = {
      var params = SearchParams(libraryID: libraryID)
      params.scope = "people"
      params.sort = .capturedDesc
      params.isScreenshot = false
      params.from = Self.oneYearAgoString()
      return params
    }()

    async let picksResult = fetchOrEmpty(picksParams)
    async let highRatedResult = fetchOrEmpty(highRatedParams)
    async let peopleResult = fetchOrEmpty(peopleParams)

    let (picks, picksError) = await picksResult
    let (highRated, highRatedError) = await highRatedResult
    let (people, peopleError) = await peopleResult
    guard g == generation else { return }

    var merged = mergeDeduped(mergeDeduped(picks, highRated), people)
    var recentError: Error?

    if merged.count < Self.minimumPoolSize {
      var recentParams = SearchParams(libraryID: libraryID)
      recentParams.sort = .capturedDesc
      recentParams.isScreenshot = false
      recentParams.excludeHiddenPeople = true
      let (recent, error) = await fetchOrEmpty(recentParams)
      guard g == generation else { return }
      merged = mergeDeduped(merged, recent)
      recentError = error
    }

    guard g == generation else { return }
    if merged.isEmpty, let firstError = picksError ?? highRatedError ?? peopleError ?? recentError {
      loadError = firstError
    }
    if !merged.isEmpty {
      Self.cachedPools[libraryID] = merged
    }
    pool = merged.shuffled()
    cursor = 0
  }

  private func fetchOrEmpty(_ params: SearchParams) async -> (assets: [SearchAsset], error: Error?) {
    do {
      let response = try await searchClient.search(params, page: 0, limit: Self.queryLimit)
      return (response.results, nil)
    } catch {
      return ([], error)
    }
  }

  /// `yyyy-MM-dd` one year before today (UTC) — the `from` bound for the
  /// last-year people source. `nil` only if date math fails (never in
  /// practice), which just omits the bound.
  private static func oneYearAgoString() -> String? {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC") ?? cal.timeZone
    guard let date = cal.date(byAdding: .year, value: -1, to: Date()) else { return nil }
    let formatter = DateFormatter()
    formatter.calendar = cal
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = cal.timeZone
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
  }

  // MARK: - Cyclic walk

  /// Returns the next asset in the ambient cycle, wrapping around (and
  /// re-shuffling) once every asset in the pool has been shown, so a
  /// long-running, uninteracted-with Light Table doesn't just replay the
  /// exact same order forever. `nil` when the pool is empty.
  func next() -> SearchAsset? {
    guard !pool.isEmpty else { return nil }
    if cursor >= pool.count {
      pool.shuffle()
      cursor = 0
    }
    defer { cursor += 1 }
    return pool[cursor]
  }
}
