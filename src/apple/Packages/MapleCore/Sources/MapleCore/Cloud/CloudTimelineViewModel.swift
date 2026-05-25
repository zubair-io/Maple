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
    //
    // Token-based registration lets future callers share a single adapter
    // instance across multiple VMs without stomping on each other's
    // callbacks; we don't unsubscribe explicitly because the adapter's
    // lifetime is bounded by the VM (AppShell rebuilds both together).
    if let photoKitMerge {
      _ = photoKitMerge.addOnWarmedUp { [weak self] in
        self?.remergeLoadedBuckets()
      }
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
  private static func searchAssetToImageRef(_ a: SearchAsset) -> ImageRef {
    let captured: Date? = a.captured_at.flatMap {
      Self.iso8601.date(from: $0)
    }
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

  /// Process-wide ISO 8601 formatter. `searchAssetToImageRef` is called
  /// once per cloud asset on every `loadPage` AND again on every
  /// `remergeLoadedBuckets` pass — at hundreds of assets per month
  /// section the allocate-and-tear-down cost shows up under scroll.
  /// ISO8601DateFormatter is documented thread-safe so a single shared
  /// instance is fine; matches the `monthFormatter` / `calendar` pattern
  /// in `CloudTimelineMonthSection`.
  private static let iso8601: ISO8601DateFormatter = ISO8601DateFormatter()

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
