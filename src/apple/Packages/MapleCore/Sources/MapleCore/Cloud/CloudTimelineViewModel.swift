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

  public private(set) var buckets: [TimelineBucket] = []
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
  /// Optional anchored prefix on `abs_path`. When set, both
  /// `/api/search/buckets` and `/api/search` are scoped to assets whose
  /// path starts with this string — drives the "filter Timeline by
  /// folder" UX. Same value is included in the cache key so two
  /// scopes don't pollute each other's on-disk cache.
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
  private let semaphore: AsyncSemaphore

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
    self.semaphore = AsyncSemaphore(value: maxConcurrentPageFetches)
    self.photoKitMerge = photoKitMerge

    // When the adapter's background warm-up completes, re-merge buckets
    // that were loaded against the stale (or empty) cache. Without this,
    // the first-launch user has to scroll to fresh months to see local
    // PhotoKit cells appear — already-visible months stay cloud-only
    // until they're re-rendered. The callback fires on MainActor and the
    // VM is MainActor-isolated, so the synchronous re-merge is safe.
    photoKitMerge?.onWarmedUp = { [weak self] in
      self?.remergeLoadedBuckets()
    }
  }

  /// Re-build `mergedPagesByBucket` for every bucket we've already fetched
  /// from the server. Triggered when the PhotoKit cache warms up so the
  /// timeline updates in place instead of waiting for the user to scroll
  /// away and back.
  private func remergeLoadedBuckets() {
    guard let merge = photoKitMerge else { return }
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
      buckets = cached.buckets
    }
    isLoadingBuckets = true
    defer { if g == generation { isLoadingBuckets = false } }
    do {
      let fresh = try await searchClient.buckets(libraryID: libraryID, pathPrefix: pathPrefix)
      guard g == generation else { return }
      buckets = fresh.buckets
      await bucketsCache.write(host: host, libraryID: libraryID, pathPrefix: pathPrefix, fresh)
    } catch {
      guard g == generation else { return }
      loadError = error
    }
  }

  /// Stale-while-revalidate per (year, month) bucket. Idempotent — returns
  /// immediately if already in-flight. Cleanup (semaphore release +
  /// inFlight removal) runs in `defer` so cancellation at any await
  /// point doesn't strand the bucket key permanently in `inFlight`
  /// (which would make that month section unrecoverable).
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

    await semaphore.acquire()
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
  /// that `MergedTimelineSource.merge` operates on. The `phassetLink`
  /// field is populated from the first `phasset_links` entry so the
  /// merge logic can detect cloud assets that were ingested from PhotoKit.
  private static func searchAssetToImageRef(_ a: SearchAsset) -> ImageRef {
    let captured: Date? = a.captured_at.flatMap {
      ISO8601DateFormatter().date(from: $0)
    }
    return ImageRef(
      id: "fs:\(a.abs_path)",
      displayName: a.filename,
      url: nil,
      captureDate: captured,
      phassetLink: a.phasset_links?.first?.phasset_local_id)
  }

  // MARK: - Helpers

  private func bumpGeneration() -> Int {
    generation &+= 1
    return generation
  }
}

// MARK: - AsyncSemaphore

/// Simple counting semaphore for bounded concurrency. Enough for the
/// Timeline's in-flight cap; the full-fledged variant lives in third-
/// party packages but pulling one in for a 30-line helper is overkill.
public actor AsyncSemaphore {
  private let value: Int
  private var current: Int
  private var waiters: [CheckedContinuation<Void, Never>] = []

  /// Clamps `value` to at least 1. Without this, a misconfigured caller
  /// could pass 0 (or negative) and `acquire()` would suspend forever
  /// because `current < value` is never true — Timeline page loads
  /// would deadlock with no error path. 1 is the smallest meaningful
  /// concurrency cap; anything lower is a programming mistake we
  /// recover from rather than propagate.
  public init(value: Int) {
    self.value = max(1, value)
    self.current = 0
  }

  public func acquire() async {
    if current < value {
      current += 1
      return
    }
    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
      waiters.append(cont)
    }
    current += 1
  }

  public func release() {
    current -= 1
    if let waiter = waiters.first {
      waiters.removeFirst()
      waiter.resume()
    }
  }
}
