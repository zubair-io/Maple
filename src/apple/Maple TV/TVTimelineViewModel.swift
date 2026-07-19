// src/apple/Maple TV/TVTimelineViewModel.swift
//
// Drives the Maple TV Timeline screen. Fetches the library's year/month
// buckets once, then per-month pages on demand as the Siri Remote focus
// engine scrolls, sub-grouping each loaded month's `SearchAsset`s into
// calendar-DAY sections — the server aggregates by month
// (`/api/search/buckets`), but the design shows day headers, so the day
// grouping happens client-side over whatever months are currently loaded.
//
// Generation-counter staleness guard mirrors `SearchViewModel`
// (MapleCloudKit/Cloud/SearchViewModel.swift) exactly: bump `generation`
// before any `await`, then `guard g == generation else { return }` after
// every suspension point, so a rapid library switch / re-load can't have
// an older in-flight response clobber newer state.
//
// TV-native (not `CloudTimelineViewModel` from MapleCore) because that VM
// carries a PhotoKit-merge dependency; the Maple TV target links
// `MapleCloudKit` only (no MapleCore, no RawPipeline — see
// `MapleCloudKitPortabilityTests`). Built entirely on the portable
// `CloudSearchClient` / `CloudBucketsCache` / `CloudPagesCache` /
// `SearchAsset` primitives D1/D2 already established.

import Foundation
import MapleCloudKit
import Observation

@MainActor
@Observable
final class TVTimelineViewModel {
  // MARK: - Published state

  /// Every currently-loaded day section, newest first. Recomputed from
  /// `assetsByMonth` whenever a month finishes loading.
  private(set) var days: [TimelineDay] = []
  private(set) var isLoading: Bool = false
  private(set) var loadError: Error?

  // MARK: - Dependencies

  let server: URL
  let libraryID: String
  private let searchClient: CloudSearchClient
  private let bucketsCache: CloudBucketsCache
  private let pagesCache: CloudPagesCache

  /// How many of the most recent months `load()` seeds eagerly, so the
  /// first screen isn't just a single (possibly sparse) month. Further
  /// months come from `loadMore(around:)` as the focus engine scrolls.
  private static let initialMonthCount = 2
  /// How many additional (older) months `loadMore(around:)` fetches per
  /// call once the focus nears the end of loaded content.
  private static let pageAheadMonthCount = 2

  /// Year/month buckets, sorted newest-first. Populated by `load()`;
  /// server order isn't guaranteed, so this is always re-sorted after a
  /// fetch rather than trusted as-is (mirrors `CloudTimelineViewModel`).
  private var buckets: [TimelineBucket] = []
  private var assetsByMonth: [MonthKey: [SearchAsset]] = [:]
  private var loadedMonths: Set<MonthKey> = []
  private var monthsInFlight: Set<MonthKey> = []

  private struct MonthKey: Hashable {
    let year: Int
    let month: Int
  }

  /// Bumped on every `load()` — in-flight closures (buckets fetch, page
  /// fetches) check this and drop completions from an older generation
  /// rather than mutating published state.
  private var generation: Int = 0
  /// Concurrency cap for `/api/search` page fetches (mirrors
  /// `CloudTimelineViewModel`'s default of 2 — a fast scroll shouldn't
  /// fan out unboundedly against a single server).
  private let semaphore: TVAsyncSemaphore

  init(server: URL,
       libraryID: String,
       searchClient: CloudSearchClient,
       bucketsCache: CloudBucketsCache = .init(),
       pagesCache: CloudPagesCache = .init(),
       maxConcurrentPageFetches: Int = 2) {
    self.server = server
    self.libraryID = libraryID
    self.searchClient = searchClient
    self.bucketsCache = bucketsCache
    self.pagesCache = pagesCache
    self.semaphore = TVAsyncSemaphore(value: maxConcurrentPageFetches)
  }

  // MARK: - Loaders

  /// Fresh load from scratch: buckets, then the first `initialMonthCount`
  /// months' first pages (bounded, concurrent). Called on Timeline
  /// appearance and on library switch.
  func load() async {
    generation &+= 1
    let g = generation
    loadError = nil
    isLoading = true
    defer { if g == generation { isLoading = false } }

    buckets = []
    assetsByMonth = [:]
    loadedMonths = []
    days = []

    await loadBuckets(generation: g)
    guard g == generation else { return }

    let leadingMonths = Array(buckets.prefix(Self.initialMonthCount))
    await withTaskGroup(of: Void.self) { group in
      for bucket in leadingMonths {
        group.addTask { [weak self] in
          await self?.loadMonth(year: bucket.year, month: bucket.month, generation: g)
        }
      }
    }
  }

  /// Fetch more months as the focus engine approaches the end of the
  /// currently-loaded content. `around` anchors the request to the month
  /// containing that day; the next not-yet-loaded month(s) AFTER it in
  /// the (newest-first) bucket order — i.e. chronologically OLDER — are
  /// fetched. A no-op when `around`'s month can't be located in `buckets`
  /// or every subsequent month is already loaded/in flight.
  func loadMore(around day: TimelineDay) async {
    let g = generation
    let comps = Calendar.current.dateComponents([.year, .month], from: day.date)
    guard let year = comps.year, let month = comps.month,
          let anchorIndex = buckets.firstIndex(where: { $0.year == year && $0.month == month })
    else { return }

    let candidates = buckets[anchorIndex...]
      .filter { !loadedMonths.contains(MonthKey(year: $0.year, month: $0.month)) }
      .prefix(Self.pageAheadMonthCount)
    guard !candidates.isEmpty else { return }

    await withTaskGroup(of: Void.self) { group in
      for bucket in candidates {
        group.addTask { [weak self] in
          await self?.loadMonth(year: bucket.year, month: bucket.month, generation: g)
        }
      }
    }
  }

  // MARK: - Bucket / month loading

  /// Stale-while-revalidate: reads cached buckets immediately (if any),
  /// then refetches and swaps in the fresh response. A network failure
  /// only surfaces `loadError` when there's no cached data to fall back
  /// on — an offline reopen should still show the last-known timeline.
  private func loadBuckets(generation g: Int) async {
    let host = server.cacheHostKey
    if let cached = await bucketsCache.read(host: host, libraryID: libraryID) {
      guard g == generation else { return }
      buckets = Self.sortedDescending(cached.buckets)
    }
    do {
      let fresh = try await searchClient.buckets(libraryID: libraryID)
      guard g == generation else { return }
      buckets = Self.sortedDescending(fresh.buckets)
      await bucketsCache.write(host: host, libraryID: libraryID, fresh)
    } catch {
      guard g == generation else { return }
      if buckets.isEmpty { loadError = error }
    }
  }

  /// Stale-while-revalidate per (year, month). Idempotent — a month
  /// that's already loaded or already in flight is skipped. The
  /// in-flight guard/insert is synchronous (no `await` between check and
  /// insert) so two near-simultaneous callers can't both pass it.
  private func loadMonth(year: Int, month: Int, generation g: Int) async {
    let key = MonthKey(year: year, month: month)
    guard !loadedMonths.contains(key), !monthsInFlight.contains(key) else { return }
    monthsInFlight.insert(key)

    var acquired = false
    let sem = semaphore
    defer {
      // Fire-and-forget release — `defer` can't `await`, and the
      // detached release must not be cancelled by our caller's
      // cancellation.
      if acquired { Task.detached { await sem.release() } }
      monthsInFlight.remove(key)
    }

    let host = server.cacheHostKey

    if let cached = await pagesCache.read(host: host, libraryID: libraryID, year: year, month: month, page: 0) {
      guard g == generation else { return }
      assetsByMonth[key] = cached.results
      loadedMonths.insert(key)
      recomputeDays()
    }

    await semaphore.acquire()
    acquired = true

    do {
      let fresh = try await searchClient.page(libraryID: libraryID, year: year, month: month, page: 0)
      guard g == generation else { return }
      assetsByMonth[key] = fresh.results
      loadedMonths.insert(key)
      await pagesCache.write(host: host, libraryID: libraryID, year: year, month: month, page: 0, fresh)
      recomputeDays()
    } catch {
      guard g == generation else { return }
      loadError = error
    }
  }

  /// Day grouping is the pure `groupByDay(_:calendar:)` function from
  /// MapleCloudKit (`Cloud/TimelineGrouping.swift`) — hoisted there so
  /// `swift test` can cover the real algorithm directly (D3 review),
  /// instead of a local copy here.
  private func recomputeDays() {
    days = groupByDay(assetsByMonth.values.flatMap { $0 })
  }

  private static func sortedDescending(_ buckets: [TimelineBucket]) -> [TimelineBucket] {
    buckets.sorted { ($0.year, $0.month) > ($1.year, $1.month) }
  }
}

// MARK: - AsyncSemaphore

/// Simple counting semaphore for bounded concurrency, scoped to this
/// file so the Maple TV target doesn't need to link MapleCore for the
/// ~30-line helper (MapleCore's `AsyncSemaphore`, used by
/// `CloudTimelineViewModel`, is unreachable here by design — see the
/// file header). Same shape/behavior as that helper.
private actor TVAsyncSemaphore {
  private let value: Int
  private var current: Int = 0
  private var waiters: [CheckedContinuation<Void, Never>] = []

  /// Clamps `value` to at least 1 — a misconfigured 0 (or negative) cap
  /// would make `acquire()` suspend forever since `current < value` is
  /// never true.
  init(value: Int) {
    self.value = max(1, value)
  }

  func acquire() async {
    if current < value {
      current += 1
      return
    }
    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
      waiters.append(cont)
    }
    current += 1
  }

  func release() {
    current -= 1
    if let waiter = waiters.first {
      waiters.removeFirst()
      waiter.resume()
    }
  }
}
