// CloudTimelineViewModel.swift
//
// Drives CloudTimelineView. Fetches buckets once on library open, then
// per-month pages on demand as cells scroll into view. Stale-guarded
// against rapid library / server switches, in-flight bounded so a fast
// scroll doesn't fan out hundreds of concurrent requests against a
// single server.

import Foundation
import Observation

@MainActor
@Observable
public final class CloudTimelineViewModel {
  // MARK: - Public state

  /// The month sections the timeline renders. This is the UNION of the
  /// cloud's buckets and the PhotoKit local month buckets (see
  /// `recomputeBuckets()`) — NOT the cloud feed alone. A month present in
  /// either stream gets a section, which is what makes the timeline show
  /// "the merge of both" rather than just whichever stream the server knows
  /// about. Spec: §12 (union of two streams), §4 (PhotoKit aggregates,
  /// on-device, never blocking on the network).
  public private(set) var buckets: [TimelineBucket] = []
  /// Last-known cloud half of the union, kept separately so a PhotoKit
  /// warm-up (which may discover local-only months) can re-union without a
  /// network refetch. Populated by `loadBuckets()` from cache then network.
  private var cloudBuckets: [TimelineBucket] = []
  public private(set) var pagesByBucket: [BucketKey: [SearchAsset]] = [:]
  /// Per-month merged cells. Populated by `loadPage(...)` when
  /// `photoKitMerge` is non-nil. Nil for months that haven't been
  /// loaded yet OR when merge isn't active — consumers fall back to
  /// `pagesByBucket` in that case.
  public private(set) var mergedPagesByBucket: [BucketKey: [MergedTimelineCell]] = [:]
  public private(set) var inFlight: Set<BucketKey> = []
  public private(set) var loadError: Error?
  public private(set) var isLoadingBuckets: Bool = false

  public struct BucketKey: Hashable, Sendable {
    public let year: Int
    public let month: Int
    public init(year: Int, month: Int) {
      self.year = year; self.month = month
    }
  }

  // MARK: - Dependencies

  public let server: URL
  public let libraryID: String
  /// Optional sub-folder prefix, RELATIVE to the library root (the server
  /// anchors it against `fileinfo.path`). When set, both
  /// `/api/search/buckets` and `/api/search` are scoped to assets under
  /// that directory — drives the "filter Timeline by folder" UX. nil means
  /// the whole library (scoped by `libraryID` alone). Same value is
  /// included in the cache key so two scopes don't pollute each other's
  /// on-disk cache. Build it with `CloudSearchClient.relativePathPrefix`.
  public let pathPrefix: String?
  private let searchClient: CloudSearchClient
  private let bucketsCache: CloudBucketsCache
  private let pagesCache: CloudPagesCache
  /// When non-nil, `loadPage` builds a merged Photos+Cloud result for
  /// the bucket and stores it in `mergedPagesByBucket`. Set by AppShell
  /// when the active cloud library is the configured backup destination
  /// and PhotoKit access is granted.
  public let photoKitMerge: PhotoKitMergeAdapter?

  /// Bumped on every public load — in-flight closures check this and drop
  /// completions for older generations rather than mutating state.
  private var generation: Int = 0
  /// Concurrency cap for /api/search calls (web Timeline uses 2).
  ///
  /// `BoundedAsyncSemaphore` (MapleCloudKit) — NOT the module-local
  /// `AsyncSemaphore` this used to declare. That type had a permit-handoff
  /// race (#2111): `release()` decremented `current` before resuming a
  /// waiter, who then incremented `current` again on resume; an `acquire()`
  /// interleaved in that window could see `current < value` and over-admit
  /// past the cap (trace-confirmed cap 2 → 3 concurrent /api/search calls).
  /// `BoundedAsyncSemaphore` hands the permit to the waiter directly instead
  /// of decrementing-then-resuming-then-incrementing, closing the window.
  /// See `BoundedAsyncSemaphore.swift` for the full writeup and
  /// `BoundedAsyncSemaphoreTests.swift` for the stress-test coverage.
  private let semaphore: BoundedAsyncSemaphore

  public init(server: URL,
              libraryID: String,
              pathPrefix: String? = nil,
              searchClient: CloudSearchClient,
              bucketsCache: CloudBucketsCache = CloudBucketsCache(),
              pagesCache: CloudPagesCache = CloudPagesCache(),
              maxConcurrentPageFetches: Int = 2,
              photoKitMerge: PhotoKitMergeAdapter? = nil) {
    self.server = server
    self.libraryID = libraryID
    self.pathPrefix = pathPrefix
    self.searchClient = searchClient
    self.bucketsCache = bucketsCache
    self.pagesCache = pagesCache
    self.semaphore = BoundedAsyncSemaphore(value: maxConcurrentPageFetches)
    self.photoKitMerge = photoKitMerge

    // When the adapter's background warm-up completes, re-merge buckets
    // that were loaded against the stale (or empty) cache. Without this,
    // the first-launch user has to scroll to fresh months to see local
    // PhotoKit cells appear — already-visible months stay cloud-only
    // until they're re-rendered. The callback fires on MainActor and the
    // VM is MainActor-isolated, so the synchronous re-merge is safe.
    //
    // Token-based registration lets future callers share a single adapter
    // instance across multiple VMs without stomping on each other's
    // callbacks; we don't unsubscribe explicitly because the adapter's
    // lifetime is bounded by the VM (AppShell rebuilds both together).
    if let photoKitMerge {
      _ = photoKitMerge.addOnWarmedUp { [weak self] in
        self?.remergeLoadedBuckets()
      }
      // Seed the section list from PhotoKit synchronously. The adapter
      // loaded its on-disk month-bucket cache in its own init, so this
      // paints the local half of the timeline within one frame of launch
      // — no /api/search/buckets round-trip required. `loadBuckets()`
      // unions the cloud half in when (and if) the network answers; until
      // then the user still sees their full local history offline.
      recomputeBuckets()
    }
  }

  /// Rebuild the public `buckets` union from the last-known `cloudBuckets`
  /// plus the PhotoKit local month buckets. A month present in either stream
  /// gets a section. The displayed count is a best-effort header estimate —
  /// `max(cloudCount, localCount)` — and is NOT the true union size: when the
  /// two streams hold different photos (local not-yet-uploaded + cloud-only
  /// from another device) the real union is larger, so this can under-report.
  /// The deduped union size isn't known until that month's page loads and the
  /// merge runs; `max` is the cheap estimate that's at least never zero for a
  /// month that has photos in either stream. Sorted year/month descending to
  /// match the cloud feed's ordering.
  private func recomputeBuckets() {
    var counts: [BucketKey: Int] = [:]
    for b in cloudBuckets {
      counts[BucketKey(year: b.year, month: b.month)] = b.count
    }
    if let merge = photoKitMerge {
      for local in merge.localBuckets() {
        let k = BucketKey(year: local.key.year, month: local.key.month)
        counts[k] = max(counts[k] ?? 0, local.count)
      }
    }
    buckets = counts
      .map { TimelineBucket(year: $0.key.year, month: $0.key.month, count: $0.value) }
      .sorted { ($0.year, $0.month) > ($1.year, $1.month) }
  }

  /// Re-build `mergedPagesByBucket` for every bucket we've already fetched a
  /// cloud page for, and re-union the section list. Triggered when the
  /// PhotoKit cache warms up so already-loaded months pick up their local
  /// cells in place instead of waiting for the user to scroll away and back.
  ///
  /// Deliberately scoped to months that ALREADY have a cloud page — it does
  /// NOT eagerly merge every local month. Months newly added to the union by
  /// `recomputeBuckets()` (local-only / not-yet-backed-up) get their cells
  /// lazily from `loadPage(...)` when their section appears, so warm-up on a
  /// large library doesn't do O(library) synchronous merge work on the
  /// MainActor.
  private func remergeLoadedBuckets() {
    guard let merge = photoKitMerge else { return }
    // Warm-up may have discovered months the cloud doesn't have (local-only)
    // — re-union so they gain sections; their cells fill in via loadPage.
    recomputeBuckets()
    // Re-merge only the months we've already fetched a cloud page for, so
    // synced / local cells appear without the user scrolling away and back.
    for (key, results) in pagesByBucket {
      let localRefs = merge.assetsForMonth(year: key.year, month: key.month)
      let cloudRefs = results.map { Self.searchAssetToImageRef($0) }
      mergedPagesByBucket[key] = MergedTimelineSource.merge(local: localRefs, cloud: cloudRefs)
    }
  }

  // MARK: - Loaders

  /// Stale-while-revalidate. Reads cached buckets immediately (if any),
  /// kicks off a refetch, swaps in the fresh response. Called on view
  /// appearance and refreshable.
  public func loadBuckets() async {
    let g = bumpGeneration()
    // hostKey includes the port when present so two servers sharing a
    // hostname but on different ports (e.g. localhost:3000 vs :3001)
    // don't collide in the on-disk caches. Plain `server.host` drops
    // the port entirely.
    let host = server.cacheHostKey
    // Clear any stale error from a previous load so an offline-then-
    // online retry doesn't leave the banner up.
    loadError = nil
    if let cached = await bucketsCache.read(host: host, libraryID: libraryID, pathPrefix: pathPrefix) {
      guard g == generation else { return }
      cloudBuckets = cached.buckets
      recomputeBuckets()
    }
    isLoadingBuckets = true
    defer { if g == generation { isLoadingBuckets = false } }
    do {
      let fresh = try await searchClient.buckets(libraryID: libraryID, pathPrefix: pathPrefix)
      guard g == generation else { return }
      cloudBuckets = fresh.buckets
      recomputeBuckets()
      await bucketsCache.write(host: host, libraryID: libraryID, pathPrefix: pathPrefix, fresh)
    } catch {
      guard g == generation else { return }
      // Network failure must NOT empty the timeline — the PhotoKit half
      // (seeded in init / from the cache read above) stays. Surface the
      // error for the banner but leave `buckets` intact so the user keeps
      // their local history offline.
      loadError = error
    }
  }

  /// Stale-while-revalidate per (year, month) bucket. Idempotent — returns
  /// immediately if already in-flight. Cleanup (semaphore release +
  /// inFlight removal) runs in `defer` so cancellation at any await
  /// point doesn't strand the bucket key permanently in `inFlight`
  /// (which would make that month section unrecoverable).
  ///
  /// `semaphore.acquire()` (#2112) throws `CancellationError` if this
  /// task is cancelled while queued behind `maxConcurrentPageFetches` —
  /// treated as a quiet no-op below, same as every other cancellation
  /// point in this method (the generation guards).
  public func loadPage(year: Int, month: Int) async {
    let key = BucketKey(year: year, month: month)
    let g = generation
    let host = server.cacheHostKey

    // Guard + insert MUST be synchronous (no `await` between them) so
    // two near-simultaneous onAppears can't both pass the guard before
    // either inserts. Previously the cache `await` between them allowed
    // 2x bandwidth on a fast scroll-then-reverse.
    guard !inFlight.contains(key) else { return }
    inFlight.insert(key)

    var acquired = false
    let sem = self.semaphore
    defer {
      // Fire-and-forget release — defer can't await. The detached Task
      // will not be cancelled by our caller's cancellation.
      if acquired {
        Task.detached { await sem.release() }
      }
      inFlight.remove(key)
    }

    // Render the PhotoKit-local cells for this month IMMEDIATELY, before any
    // cloud read. This is what makes a month with local photos paint
    // instantly (and stay visible if the cloud page is empty, errors, or
    // we're offline) instead of waiting on — or being blanked by — the
    // network. The cache/network reads below re-merge with the cloud
    // results when they arrive. Only seed when there's local content and we
    // haven't already produced a (richer) merge for this bucket.
    if let merge = photoKitMerge, g == generation {
      let localRefs = merge.assetsForMonth(year: year, month: month)
      if !localRefs.isEmpty, mergedPagesByBucket[key] == nil {
        // Cheap local-only seed: map straight to `.localOnly` cells rather
        // than calling `merge(local:cloud:)`, which would build lookup maps
        // and re-sort the whole month on the MainActor before any await.
        // `assetsForMonth` is already capture-date descending (PhotoKit fetch
        // order, preserved through the disk cache), so the order matches what
        // the full merge would produce. The cache/network reads below run the
        // real merge once cloud rows arrive.
        mergedPagesByBucket[key] = localRefs.map { MergedTimelineCell.localOnly($0) }
      }
    }

    // Server pagination is zero-indexed — page 0 is the first page. Same
    // index used as the cache key so a hit/miss compares like-for-like.
    if let cached = await pagesCache.read(host: host, libraryID: libraryID,
                                          pathPrefix: pathPrefix,
                                          year: year, month: month, page: 0) {
      guard g == generation else { return }
      pagesByBucket[key] = cached.results
      if let merge = photoKitMerge, g == generation {
        let localRefs = merge.assetsForMonth(year: year, month: month)
        let cloudRefs = cached.results.map { Self.searchAssetToImageRef($0) }
        mergedPagesByBucket[key] = MergedTimelineSource.merge(local: localRefs, cloud: cloudRefs)
      }
    }

    do {
      try await semaphore.acquire()
    } catch {
      // `BoundedAsyncSemaphore.acquire()` only ever throws
      // `CancellationError` (the view went away, or the generation moved
      // on, while we were queued behind the concurrency cap) — the plain
      // `catch` is a defensive fallback for that same quiet no-op since
      // the compiler can't statically narrow a generic `throws` to one
      // error type. No `loadError`, nothing to clean up beyond the
      // `defer` (which already runs unconditionally; `acquired` stays
      // false since we never got a permit to release).
      return
    }
    acquired = true

    do {
      let fresh = try await searchClient.page(libraryID: libraryID,
                                              year: year, month: month,
                                              page: 0,
                                              pathPrefix: pathPrefix)
      if g == generation {
        pagesByBucket[key] = fresh.results
        await pagesCache.write(host: host, libraryID: libraryID,
                               pathPrefix: pathPrefix,
                               year: year, month: month, page: 0, fresh)
        if let merge = photoKitMerge, g == generation {
          let localRefs = merge.assetsForMonth(year: year, month: month)
          let cloudRefs = fresh.results.map { Self.searchAssetToImageRef($0) }
          mergedPagesByBucket[key] = MergedTimelineSource.merge(local: localRefs, cloud: cloudRefs)
        }
      }
    } catch {
      if g == generation { loadError = error }
    }
  }

  // MARK: - Conversion

  /// Convert a `SearchAsset` (cloud wire DTO) into the `ImageRef` shape
  /// that `MergedTimelineSource.merge` operates on.
  ///
  /// The cloud row may have been backed up from multiple devices — every
  /// device that's uploaded the same content adds another entry to
  /// `phasset_links`. The merge needs to see ALL of them so that any device
  /// viewing the library can match against its own local PhotoKit assets,
  /// not just the one that uploaded first.
  ///
  /// Both `phassetLink` (legacy: the [0] phid) and `cloudIdentifier`
  /// (legacy: first non-nil cloud id across all links — links[0] may
  /// have no cloud id when an older device uploaded first) are populated
  /// to keep older single-link callers working; `allPhassetLinks` /
  /// `allCloudIdentifiers` carry the full arrays used by
  /// `MergedTimelineSource.findLocalMatch`.
  ///
  /// Not `private` — `AllSourcesTimelineViewModel` (#2273) is a second
  /// real caller that fans the same conversion out over many (server,
  /// library) cloud streams instead of one, so this is shared rather than
  /// duplicated.
  static func searchAssetToImageRef(_ a: SearchAsset) -> ImageRef {
    // `parseTimelineISO8601` (MapleCloudKit, visible here via the module's
    // @_exported re-export) tries a fractional-seconds formatter first, then
    // whole-seconds. A bare `ISO8601DateFormatter()` — the previous code —
    // silently returned nil for every real server `captured_at`, which are
    // Mongo Dates serialized via JS `toISOString()` and so always carry
    // millisecond precision ("2022-09-10T11:32:07.000Z"). That dropped the
    // capture date off every cloud asset (#2108; same class of bug as the TV
    // Timeline's D7 fix). The whole-seconds-only fixtures the tests used
    // parsed fine under the old formatter, so `swift test` never caught it.
    let captured: Date? = a.captured_at.flatMap(parseTimelineISO8601)
    let links = a.phasset_links ?? []
    let allPHIDs: [String]? = links.isEmpty
      ? nil
      : links.map { $0.phasset_local_id }
    // First non-nil cloud id across every link, NOT just links[0]. A row
    // with [0] missing a cloud id but [1] having one (e.g. an older device
    // uploaded first, a newer one came along later) must still expose the
    // cloud id through the legacy `cloudIdentifier` field for callers that
    // don't yet walk `allCloudIdentifiers`.
    let allCloudIDs: [String] = links.compactMap { $0.phasset_cloud_id }
    return ImageRef(
      id: "fs:\(a.abs_path)",
      displayName: a.filename,
      url: nil,
      captureDate: captured,
      phassetLink: links.first?.phasset_local_id,
      cloudIdentifier: allCloudIDs.first,
      allPhassetLinks: allPHIDs,
      allCloudIdentifiers: allCloudIDs.isEmpty ? nil : allCloudIDs)
  }

  // MARK: - Helpers

  private func bumpGeneration() -> Int {
    generation &+= 1
    return generation
  }

  // MARK: - Preview

  public enum PreviewState: Sendable {
    case empty
    case loading
    case loaded
  }

  /// Sample timeline VM for SwiftUI `#Preview` blocks. Builds against
  /// preview clients pointed at an unreachable URL, then mutates the
  /// published state directly to stage the requested case. Issue #139.
  public static func preview(_ state: PreviewState = .loaded) -> CloudTimelineViewModel {
    let server = URL(string: "https://preview.maple.invalid")!
    let vm = CloudTimelineViewModel(
      server: server,
      libraryID: "preview-library",
      searchClient: CloudSearchClient.preview(server: server)
    )
    switch state {
    case .empty:
      break
    case .loading:
      vm.isLoadingBuckets = true
    case .loaded:
      vm.buckets = [
        TimelineBucket(year: 2024, month: 6, count: 84),
        TimelineBucket(year: 2024, month: 5, count: 51),
        TimelineBucket(year: 2024, month: 4, count: 22),
      ]
    }
    return vm
  }
}
