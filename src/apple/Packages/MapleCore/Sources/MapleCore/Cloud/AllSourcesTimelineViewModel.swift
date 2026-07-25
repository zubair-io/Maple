// AllSourcesTimelineViewModel.swift
//
// #2273 — the aggregating half of the unified cross-source Timeline (#2270).
// `CloudTimelineViewModel` merges ONE cloud library with PhotoKit; this VM
// generalizes that to EVERY library on EVERY connected Maple Cloud server,
// unioned with PhotoKit, deduped across devices — via the same N-way
// `MergedTimelineSource.merge(localStreams:cloudStreams:)` the single-library
// VM already uses (one-element streams there; N here).
//
// Fan-out shape: per (server, library), not per server. A server-wide
// "all libraries" buckets/search endpoint isn't known to exist today — if
// one shows up later it's a pure optimization behind this same public API,
// not a requirement to ship this VM. Per-(server,library) is always correct.
//
// Caching: reuses `CloudBucketsCache`/`CloudPagesCache` exactly as the
// single-library VM does — both are already keyed on (host, libraryID), so
// fanning the same calls out over many (host, libraryID) pairs can't
// collide. No new cache is introduced.

import Foundation
import Observation

@MainActor
@Observable
public final class AllSourcesTimelineViewModel {
  // MARK: - Types

  public struct BucketKey: Hashable, Sendable {
    public let year: Int
    public let month: Int
    public init(year: Int, month: Int) {
      self.year = year; self.month = month
    }
  }

  /// One connected Maple Cloud server plus the libraries on it to fan the
  /// Timeline out over. Built by the caller (AppShell) from
  /// `CloudServerRegistry.shared.servers` × each server's `/api/folders`
  /// response — the same auth/session bootstrap `loadCloudFoldersFor`
  /// already does for the sidebar.
  public struct ServerSource: Sendable {
    public let server: URL
    public let libraryIDs: [String]
    public let searchClient: CloudSearchClient
    /// One `CloudThumbClient` per server — `/api/fs/thumb` isn't scoped to
    /// a library, so a single client covers every library on this server.
    public let thumbClient: CloudThumbClient

    public init(server: URL, libraryIDs: [String],
                searchClient: CloudSearchClient, thumbClient: CloudThumbClient) {
      self.server = server
      self.libraryIDs = libraryIDs
      self.searchClient = searchClient
      self.thumbClient = thumbClient
    }
  }

  // MARK: - Public state

  /// Month sections — the union of every source's cloud buckets AND the
  /// PhotoKit local month buckets. Count is a best-effort SUM of every
  /// distinct (server, library)'s count (they're normally disjoint
  /// populations) maxed against the PhotoKit local count — same
  /// under-reporting caveat `CloudTimelineViewModel.recomputeBuckets`
  /// documents: the true deduped union isn't known until a month's pages
  /// load and merge.
  public private(set) var buckets: [TimelineBucket] = []
  public private(set) var pagesByBucket: [BucketKey: [SearchAsset]] = [:]
  public private(set) var mergedPagesByBucket: [BucketKey: [MergedTimelineCell]] = [:]
  public private(set) var inFlight: Set<BucketKey> = []
  public private(set) var loadError: Error?
  public private(set) var isLoadingBuckets: Bool = false

  /// Host (`URL.cacheHostKey`) → `CloudThumbClient`, one per connected
  /// server. The view layer builds a multi-host `ThumbnailProvider` from
  /// this — a single fixed thumb client (the single-library VM's model)
  /// can't serve a grid whose cells span several different servers.
  public let thumbClientsByHost: [String: CloudThumbClient]

  // MARK: - Dependencies

  private let sources: [ServerSource]
  private let bucketsCache: CloudBucketsCache
  private let pagesCache: CloudPagesCache
  /// See `CloudTimelineViewModel.photoKitMerge` — same role, same adapter
  /// type. Non-nil when PhotoKit access is granted; the account-wide
  /// Timeline doesn't gate this on a configured backup destination the
  /// way the single-library merge does; that gate is about which ONE
  /// library PhotoKit backs up TO, which has no meaning for a view that
  /// already spans every library.
  private let photoKitMerge: PhotoKitMergeAdapter?
  private let semaphore: BoundedAsyncSemaphore

  private var generation: Int = 0

  /// Per-(server, library) bucket counts, keyed `"<host>::<libraryID>"` so
  /// a stale-while-revalidate re-fetch of one source overwrites only its
  /// own contribution before `recomputeBuckets()` re-sums the total —
  /// otherwise repeat fetches would double-count.
  private var bucketCountsBySource: [String: [BucketKey: Int]] = [:]
  /// abs_path → host, populated as pages load. Lets `host(for:)` and
  /// `server(for:)` route a merged cell's cloud-side `ImageRef` (id
  /// `"fs:<abs_path>"`) back to the server that actually owns it — needed
  /// because a `MergedTimelineCell` doesn't carry provenance itself.
  private var hostByAbsPath: [String: String] = [:]
  private var serverByHost: [String: URL] = [:]
  /// The per-(server, library) `ImageRef` streams last used to build a
  /// bucket's merge, kept so `remergeLoadedBuckets()` (PhotoKit warm-up)
  /// can re-run `MergedTimelineSource.merge` without re-fetching — and,
  /// crucially, WITHOUT collapsing the streams into one flat array first:
  /// cross-library dedup only fires *across* distinct streams (see
  /// `MergedTimelineSource.merge`'s doc), so flattening here would silently
  /// stop deduping an asset backed up to two libraries.
  private var cloudStreamsByBucket: [BucketKey: [[ImageRef]]] = [:]

  // MARK: - Init

  public init(sources: [ServerSource],
              bucketsCache: CloudBucketsCache = CloudBucketsCache(),
              pagesCache: CloudPagesCache = CloudPagesCache(),
              maxConcurrentPageFetches: Int = 2,
              photoKitMerge: PhotoKitMergeAdapter? = nil) {
    self.sources = sources
    self.bucketsCache = bucketsCache
    self.pagesCache = pagesCache
    self.photoKitMerge = photoKitMerge
    self.semaphore = BoundedAsyncSemaphore(value: maxConcurrentPageFetches)

    var clientsByHost: [String: CloudThumbClient] = [:]
    var serverByHost: [String: URL] = [:]
    for source in sources {
      let host = source.server.cacheHostKey
      clientsByHost[host] = source.thumbClient
      serverByHost[host] = source.server
    }
    self.thumbClientsByHost = clientsByHost
    self.serverByHost = serverByHost

    if let photoKitMerge {
      _ = photoKitMerge.addOnWarmedUp { [weak self] in
        self?.remergeLoadedBuckets()
      }
      // Seed from PhotoKit's own disk cache synchronously — same
      // instant-local-history rationale as `CloudTimelineViewModel.init`.
      recomputeBuckets()
    }
  }

  // MARK: - Routing

  /// Cache-host key for a merged cell's cloud side — `ThumbnailProvider`
  /// uses this to pick the right per-server `CloudThumbClient`. Only
  /// meaningful for `.cloudOnly`/`.synced` cells (the ones that actually
  /// resolve to a cloud thumb fetch); `.localOnly` never consults it.
  public func host(for cell: MergedTimelineCell) -> String {
    switch cell {
    case .synced(_, let cloudRef), .cloudOnly(let cloudRef):
      return hostByAbsPath[Self.absPath(fromCloudID: cloudRef.id)] ?? ""
    case .localOnly:
      return ""
    }
  }

  /// The server that owns `asset`, resolved from the abs_path → host
  /// mapping recorded when its page loaded. `nil` only if the asset was
  /// never routed through `applyMergedPage` (shouldn't happen for an asset
  /// the view is showing) — callers should treat that as "can't open."
  public func server(for asset: SearchAsset) -> URL? {
    hostByAbsPath[asset.abs_path].flatMap { serverByHost[$0] }
  }

  private static func absPath(fromCloudID id: String) -> String {
    id.hasPrefix("fs:") ? String(id.dropFirst(3)) : id
  }

  // MARK: - Buckets

  private func recomputeBuckets() {
    // `PhotoKitMergeAdapter.localBuckets()` returns its OWN nested
    // `BucketKey` type (year/month, structurally identical to this VM's)
    // — remap rather than share the type, since the two adapters have no
    // dependency on each other.
    let localBuckets = (photoKitMerge?.localBuckets() ?? []).map {
      (key: BucketKey(year: $0.key.year, month: $0.key.month), count: $0.count)
    }
    buckets = Self.unionBuckets(
      perSourceCounts: Array(bucketCountsBySource.values),
      localBuckets: localBuckets)
  }

  /// Pure union: SUMS every distinct (server, library)'s bucket counts
  /// (they're normally disjoint populations, so summing is the right
  /// combinator — unlike `CloudTimelineViewModel`'s single-cloud-source
  /// case, there's no double-counting risk from summing distinct sources),
  /// then folds in the PhotoKit local counts via `max` per month — same
  /// "at least one non-zero side wins, real union deferred to merge time"
  /// estimate `CloudTimelineViewModel.recomputeBuckets` documents. Result
  /// is sorted year/month descending, matching the cloud feed's ordering.
  /// Extracted as a pure static function (no instance state) so the
  /// union math is unit-testable without a network stack.
  static func unionBuckets(
    perSourceCounts: [[BucketKey: Int]],
    localBuckets: [(key: BucketKey, count: Int)]
  ) -> [TimelineBucket] {
    var counts: [BucketKey: Int] = [:]
    for perSource in perSourceCounts {
      for (key, count) in perSource {
        counts[key, default: 0] += count
      }
    }
    for local in localBuckets {
      counts[local.key] = max(counts[local.key] ?? 0, local.count)
    }
    return counts
      .map { TimelineBucket(year: $0.key.year, month: $0.key.month, count: $0.value) }
      .sorted { ($0.year, $0.month) > ($1.year, $1.month) }
  }

  private func remergeLoadedBuckets() {
    guard let merge = photoKitMerge else { return }
    recomputeBuckets()
    for (key, cloudStreams) in cloudStreamsByBucket {
      let localRefs = merge.assetsForMonth(year: key.year, month: key.month)
      mergedPagesByBucket[key] = MergedTimelineSource.merge(
        localStreams: [localRefs], cloudStreams: cloudStreams)
    }
  }

  /// Stale-while-revalidate across every (server, library): seed from each
  /// source's on-disk bucket cache sequentially (cheap, and keeps the
  /// generation guard simple), then fan fresh `/api/search/buckets` calls
  /// out concurrently.
  public func loadBuckets() async {
    let g = bumpGeneration()
    loadError = nil

    for source in sources {
      let host = source.server.cacheHostKey
      for libraryID in source.libraryIDs {
        guard let cached = await bucketsCache.read(host: host, libraryID: libraryID) else { continue }
        guard g == generation else { return }
        bucketCountsBySource["\(host)::\(libraryID)"] = Self.countsByKey(cached.buckets)
        recomputeBuckets()
      }
    }

    isLoadingBuckets = true
    defer { if g == generation { isLoadingBuckets = false } }

    let fetchTargets = sources.flatMap { source in source.libraryIDs.map { (source, $0) } }
    let results = await withTaskGroup(
      of: (host: String, libraryID: String, buckets: TimelineBuckets?).self
    ) { group in
      for (source, libraryID) in fetchTargets {
        group.addTask {
          let buckets = try? await source.searchClient.buckets(libraryID: libraryID)
          return (source.server.cacheHostKey, libraryID, buckets)
        }
      }
      var out: [(host: String, libraryID: String, buckets: TimelineBuckets?)] = []
      for await result in group { out.append(result) }
      return out
    }

    guard g == generation else { return }
    var anySucceeded = false
    for (host, libraryID, maybeBuckets) in results {
      guard let fresh = maybeBuckets else { continue }
      anySucceeded = true
      bucketCountsBySource["\(host)::\(libraryID)"] = Self.countsByKey(fresh.buckets)
      await bucketsCache.write(host: host, libraryID: libraryID, fresh)
    }
    recomputeBuckets()
    // Only surface an error banner when EVERY source failed — a partial
    // outage (one server down, others fine) should still show a Timeline,
    // not an error, same as the single-library VM's offline-keeps-PhotoKit
    // behavior.
    if !fetchTargets.isEmpty, !anySucceeded {
      loadError = NSError(
        domain: "AllSourcesTimelineViewModel", code: -1,
        userInfo: [NSLocalizedDescriptionKey: "Failed to load any connected library's timeline buckets."])
    }
  }

  private static func countsByKey(_ buckets: [TimelineBucket]) -> [BucketKey: Int] {
    Dictionary(uniqueKeysWithValues: buckets.map { (BucketKey(year: $0.year, month: $0.month), $0.count) })
  }

  // MARK: - Pages

  /// Stale-while-revalidate per (year, month), fanned across every
  /// (server, library). Idempotent via `inFlight`, same contract as
  /// `CloudTimelineViewModel.loadPage`.
  public func loadPage(year: Int, month: Int) async {
    let key = BucketKey(year: year, month: month)
    let g = generation

    guard !inFlight.contains(key) else { return }
    inFlight.insert(key)
    defer { inFlight.remove(key) }

    // Seed PhotoKit-local cells immediately, same rationale as the
    // single-library VM: paint local history before any network round trip.
    if let merge = photoKitMerge, g == generation {
      let localRefs = merge.assetsForMonth(year: year, month: month)
      if !localRefs.isEmpty, mergedPagesByBucket[key] == nil {
        mergedPagesByBucket[key] = localRefs.map { .localOnly($0) }
      }
    }

    var cachedPerSource: [(host: String, assets: [SearchAsset])] = []
    for source in sources {
      let host = source.server.cacheHostKey
      for libraryID in source.libraryIDs {
        if let cached = await pagesCache.read(
          host: host, libraryID: libraryID, year: year, month: month, page: 0) {
          cachedPerSource.append((host, cached.results))
        }
      }
    }
    guard g == generation else { return }
    if !cachedPerSource.isEmpty {
      applyMergedPage(key: key, perSource: cachedPerSource)
    }

    let fetchTargets = sources.flatMap { source in source.libraryIDs.map { (source, $0) } }
    let sem = semaphore
    let freshResults: [(host: String, libraryID: String, response: SearchResponse)] = await withTaskGroup(
      of: (host: String, libraryID: String, response: SearchResponse?).self
    ) { group in
      for (source, libraryID) in fetchTargets {
        group.addTask {
          await Self.fetchPage(source: source, libraryID: libraryID, year: year, month: month, semaphore: sem)
        }
      }
      var out: [(host: String, libraryID: String, response: SearchResponse)] = []
      for await result in group {
        if let response = result.response {
          out.append((result.host, result.libraryID, response))
        }
      }
      return out
    }

    guard g == generation else { return }
    for (host, libraryID, response) in freshResults {
      await pagesCache.write(
        host: host, libraryID: libraryID, year: year, month: month, page: 0, response)
    }
    if !freshResults.isEmpty {
      applyMergedPage(key: key, perSource: freshResults.map { (host: $0.host, assets: $0.response.results) })
    } else if mergedPagesByBucket[key] == nil {
      // Nothing cached, nothing fetched (every source offline/errored), and
      // no PhotoKit content either — resolve to empty rather than leaving
      // the section spinning forever. Mirrors the single-library VM's own
      // limit here: it can't distinguish "every source is down" from
      // "genuinely empty month" past this point either.
      pagesByBucket[key] = []
      cloudStreamsByBucket[key] = []
      mergedPagesByBucket[key] = []
    }
  }

  /// One (server, library) page fetch: acquire the shared concurrency
  /// permit, fetch, release. `nonisolated` + `static` so the task group's
  /// child tasks run truly concurrently rather than hopping onto the
  /// MainActor for each call — the method touches no VM state, only the
  /// Sendable `semaphore` actor and the (also Sendable) `source`.
  nonisolated private static func fetchPage(
    source: ServerSource, libraryID: String, year: Int, month: Int, semaphore: BoundedAsyncSemaphore
  ) async -> (host: String, libraryID: String, response: SearchResponse?) {
    let host = source.server.cacheHostKey
    do {
      try await semaphore.acquire()
    } catch {
      return (host, libraryID, nil)
    }
    defer { Task.detached { await semaphore.release() } }
    do {
      let response = try await source.searchClient.page(libraryID: libraryID, year: year, month: month)
      return (host, libraryID, response)
    } catch {
      return (host, libraryID, nil)
    }
  }

  /// Records provenance (`hostByAbsPath`), stores the flat asset list for
  /// `absPathMap`-style tap routing, and re-runs the N-way merge — keeping
  /// each (server, library)'s results as its OWN cloud stream so
  /// cross-library dedup keeps working (see `cloudStreamsByBucket`'s doc).
  private func applyMergedPage(key: BucketKey, perSource: [(host: String, assets: [SearchAsset])]) {
    var allAssets: [SearchAsset] = []
    var cloudStreams: [[ImageRef]] = []
    allAssets.reserveCapacity(perSource.reduce(0) { $0 + $1.assets.count })
    for (host, assets) in perSource {
      for asset in assets { hostByAbsPath[asset.abs_path] = host }
      allAssets.append(contentsOf: assets)
      cloudStreams.append(assets.map { CloudTimelineViewModel.searchAssetToImageRef($0) })
    }
    pagesByBucket[key] = allAssets
    cloudStreamsByBucket[key] = cloudStreams
    let localRefs = photoKitMerge?.assetsForMonth(year: key.year, month: key.month) ?? []
    mergedPagesByBucket[key] = MergedTimelineSource.merge(localStreams: [localRefs], cloudStreams: cloudStreams)
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

  /// Sample VM for SwiftUI `#Preview` blocks — no real `ServerSource`s (an
  /// empty array), so any load is a no-op; the requested state is staged by
  /// mutating the published properties directly, same pattern as
  /// `CloudTimelineViewModel.preview(_:)`.
  public static func preview(_ state: PreviewState = .loaded) -> AllSourcesTimelineViewModel {
    let vm = AllSourcesTimelineViewModel(sources: [])
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
