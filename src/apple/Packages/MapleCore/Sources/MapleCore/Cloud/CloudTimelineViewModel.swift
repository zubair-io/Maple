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
  private let searchClient: CloudSearchClient
  private let bucketsCache: CloudBucketsCache
  private let pagesCache: CloudPagesCache

  /// Bumped on every public load — in-flight closures check this and drop
  /// completions for older generations rather than mutating state.
  private var generation: Int = 0
  /// Concurrency cap for /api/search calls (web Timeline uses 2).
  private let semaphore: AsyncSemaphore

  public init(server: URL,
              libraryID: String,
              searchClient: CloudSearchClient,
              bucketsCache: CloudBucketsCache = CloudBucketsCache(),
              pagesCache: CloudPagesCache = CloudPagesCache(),
              maxConcurrentPageFetches: Int = 2) {
    self.server = server
    self.libraryID = libraryID
    self.searchClient = searchClient
    self.bucketsCache = bucketsCache
    self.pagesCache = pagesCache
    self.semaphore = AsyncSemaphore(value: maxConcurrentPageFetches)
  }

  // MARK: - Loaders

  /// Stale-while-revalidate. Reads cached buckets immediately (if any),
  /// kicks off a refetch, swaps in the fresh response. Called on view
  /// appearance and refreshable.
  public func loadBuckets() async {
    let g = bumpGeneration()
    let host = server.host ?? ""
    if let cached = await bucketsCache.read(host: host, libraryID: libraryID) {
      guard g == generation else { return }
      buckets = cached.buckets
    }
    isLoadingBuckets = true
    defer { if g == generation { isLoadingBuckets = false } }
    do {
      let fresh = try await searchClient.buckets(libraryID: libraryID)
      guard g == generation else { return }
      buckets = fresh.buckets
      await bucketsCache.write(host: host, libraryID: libraryID, fresh)
    } catch {
      guard g == generation else { return }
      loadError = error
    }
  }

  /// Stale-while-revalidate per (year, month) bucket. Idempotent — returns
  /// immediately if already in-flight.
  public func loadPage(year: Int, month: Int) async {
    let key = BucketKey(year: year, month: month)
    let g = generation
    let host = server.host ?? ""
    guard !inFlight.contains(key) else { return }

    if let cached = await pagesCache.read(host: host, libraryID: libraryID,
                                          year: year, month: month, page: 1) {
      guard g == generation else { return }
      pagesByBucket[key] = cached.results
    }

    inFlight.insert(key)
    await semaphore.acquire()
    do {
      let fresh = try await searchClient.page(libraryID: libraryID,
                                              year: year, month: month)
      if g == generation {
        pagesByBucket[key] = fresh.results
        await pagesCache.write(host: host, libraryID: libraryID,
                               year: year, month: month, page: 1, fresh)
      }
    } catch {
      if g == generation { loadError = error }
    }
    await semaphore.release()
    inFlight.remove(key)
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

  public init(value: Int) {
    self.value = value
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
