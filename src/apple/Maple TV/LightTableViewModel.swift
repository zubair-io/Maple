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

  init(libraryID: String, searchClient: CloudSearchClient) {
    self.libraryID = libraryID
    self.searchClient = searchClient
  }

  // MARK: - Loading

  func load() async {
    generation &+= 1
    let g = generation
    isLoading = true
    loadError = nil
    defer { if g == generation { isLoading = false } }

    // Built as `let`s (via an immediately-invoked mutation) rather than
    // `var`s mutated in place — the two params feed concurrent `async
    // let` fetches below, and capturing a mutable `var` across a
    // concurrently-executing closure is a Swift 6 mode error (caught by
    // this file's own build: "reference to captured var ... in
    // concurrently-executing code").
    let picksParams: SearchParams = {
      var params = SearchParams(libraryID: libraryID)
      params.flag = .pick
      params.sort = .capturedDesc
      return params
    }()

    let highRatedParams: SearchParams = {
      var params = SearchParams(libraryID: libraryID)
      params.rating = 4
      params.sort = .rating
      return params
    }()

    async let picksResult = fetchOrEmpty(picksParams)
    async let highRatedResult = fetchOrEmpty(highRatedParams)

    let (picks, picksError) = await picksResult
    let (highRated, highRatedError) = await highRatedResult
    guard g == generation else { return }

    var merged = mergeDeduped(picks, highRated)
    var recentError: Error?

    if merged.count < Self.minimumPoolSize {
      var recentParams = SearchParams(libraryID: libraryID)
      recentParams.sort = .capturedDesc
      let (recent, error) = await fetchOrEmpty(recentParams)
      guard g == generation else { return }
      merged = mergeDeduped(merged, recent)
      recentError = error
    }

    if merged.isEmpty, let firstError = picksError ?? highRatedError ?? recentError {
      loadError = firstError
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

  /// Non-consuming look at the next `count` assets the cycle will show,
  /// without advancing `cursor` — used to prefetch bytes for upcoming
  /// glide-ins before they're actually due. Deliberately doesn't cross a
  /// wrap boundary (peeking past the end of the current shuffle order
  /// isn't worth simulating the reshuffle it would trigger); a peek near
  /// the tail just returns fewer than `count`.
  func peekUpcoming(count: Int) -> [SearchAsset] {
    guard !pool.isEmpty, cursor < pool.count else { return [] }
    let end = min(cursor + count, pool.count)
    return Array(pool[cursor..<end])
  }
}
