// CloudTimelineViewModelTests.swift
import XCTest
@testable import MapleCore

@MainActor
final class CloudTimelineViewModelTests: XCTestCase {

  func test_loadBuckets_populatesFromNetwork() async {
    let server = URL(string: "https://example.test")!
    let json = """
    {"total":3,"buckets":[
      {"year":2024,"month":7,"count":2},
      {"year":2024,"month":6,"count":1}
    ],"untimed_count":0}
    """
    let session = URLSession.stubbed(response: json)
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-\(UUID()).buckets")
    let cache = CloudBucketsCache(baseDir: dir)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }

    let vm = CloudTimelineViewModel(server: server, libraryID: "lib1",
                                    searchClient: searchClient,
                                    bucketsCache: cache)
    await vm.loadBuckets()

    XCTAssertEqual(vm.buckets.count, 2)
    XCTAssertEqual(vm.buckets[0].count, 2)
  }

  func test_loadPage_populatesPagesByBucket() async {
    let server = URL(string: "https://example.test")!
    let json = """
    {"total":1,"page":1,"limit":200,"results":[
      {"id":"a1","folder_id":"lib1","abs_path":"/x/a.dng","filename":"a.dng",
       "size":1024,"mtime":null,"captured_at":null,"camera":null,"lens":null,
       "iso":null,"aperture":null,"shutter":null,"focal_length":null,
       "rating":null,"flag":null,"color_label":null}
    ]}
    """
    let session = URLSession.stubbed(response: json)
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let dirB = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-\(UUID()).buckets")
    let dirP = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-\(UUID()).pages")
    addTeardownBlock {
      try? FileManager.default.removeItem(at: dirB)
      try? FileManager.default.removeItem(at: dirP)
    }

    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: dirB),
      pagesCache: CloudPagesCache(baseDir: dirP))

    await vm.loadPage(year: 2024, month: 7)
    let key = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)

    XCTAssertEqual(vm.pagesByBucket[key]?.count, 1)
    XCTAssertEqual(vm.pagesByBucket[key]?.first?.id, "a1")
  }

  func test_asyncSemaphore_boundsConcurrency() async {
    let sem = AsyncSemaphore(value: 1)
    let counter = CounterActor()

    async let a: Void = {
      await sem.acquire()
      let observed = await counter.increment()
      try? await Task.sleep(for: .milliseconds(10))
      _ = observed
      await counter.decrement()
      await sem.release()
    }()

    async let b: Void = {
      await sem.acquire()
      let observed = await counter.increment()
      try? await Task.sleep(for: .milliseconds(10))
      _ = observed
      await counter.decrement()
      await sem.release()
    }()

    _ = await (a, b)

    let max = await counter.observedMax
    XCTAssertEqual(max, 1, "semaphore(value:1) should never let two through at once")
  }

  /// Stale-completion guard. Switching libraries (or reloading) bumps
  /// the VM's generation counter; a slow in-flight request from the
  /// previous generation must NOT mutate `pagesByBucket` when it
  /// finally lands. Without this guard, a fast library switch would
  /// flash old assets into the new library's grid.
  func test_loadPage_dropsStaleCompletionAcrossReload() async throws {
    let server = URL(string: "https://example.test")!

    // Two stub responses with distinct asset IDs. The first call
    // (slow) returns asset "old"; the second (fast) returns "new".
    // Because the second loadBuckets bumps the generation, the slow
    // first response must be discarded once it lands.
    let json = """
    {"total":1,"page":0,"limit":200,"results":[
      {"id":"old","folder_id":"lib1","abs_path":"/x/old.dng","filename":"old.dng",
       "size":0,"mtime":null,"captured_at":null,"camera":null,"lens":null,
       "iso":null,"aperture":null,"shutter":null,"focal_length":null,
       "rating":null,"flag":null,"color_label":null}
    ]}
    """
    let session = URLSession.stubbed(response: json,
                                     delay: .milliseconds(150))
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-\(UUID()).stale")
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: dir.appending(path: "b")),
      pagesCache: CloudPagesCache(baseDir: dir.appending(path: "p")))

    // Kick off a slow page load…
    async let slow: Void = vm.loadPage(year: 2024, month: 7)
    // …then bump the generation by reloading buckets before the slow
    // page can finish. By the time the slow loadPage's await resolves,
    // its captured generation is stale and the guard short-circuits.
    try await Task.sleep(for: .milliseconds(20))
    await vm.loadBuckets()
    _ = await slow

    // The slow page response should NOT have been written into
    // pagesByBucket — generation guard fired.
    let key = CloudTimelineViewModel.BucketKey(year: 2024, month: 7)
    XCTAssertNil(vm.pagesByBucket[key],
                 "stale loadPage completion must not populate pagesByBucket after generation bump")
  }

  /// /api/search calls are bounded by an internal AsyncSemaphore. A
  /// burst of N >> cap concurrent loadPage calls must serialize through
  /// the cap — observed by counting the maximum simultaneous in-flight
  /// requests at the URLProtocol layer.
  func test_loadPage_respectsMaxConcurrentPageFetches() async throws {
    let server = URL(string: "https://example.test")!
    let inFlight = ConcurrentRequestTracker()

    let json = """
    {"total":0,"page":0,"limit":200,"results":[]}
    """
    let session = URLSession.stubbed(response: json,
                                     delay: .milliseconds(80),
                                     onRequestStart: { await inFlight.enter() },
                                     onRequestEnd:   { await inFlight.leave() })
    let searchClient = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("VMTests-\(UUID()).cap")
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let vm = CloudTimelineViewModel(
      server: server, libraryID: "lib1",
      searchClient: searchClient,
      bucketsCache: CloudBucketsCache(baseDir: dir.appending(path: "b")),
      pagesCache: CloudPagesCache(baseDir: dir.appending(path: "p")),
      maxConcurrentPageFetches: 2)

    // Fan out 6 distinct buckets concurrently — semaphore should pin
    // observedMax to 2.
    await withTaskGroup(of: Void.self) { group in
      for m in 1...6 {
        group.addTask { await vm.loadPage(year: 2024, month: m) }
      }
    }
    let observed = await inFlight.observedMax
    XCTAssertLessThanOrEqual(observed, 2,
                             "AsyncSemaphore(value: 2) must cap concurrent /api/search requests at 2 (observed \(observed))")
  }
}

/// Tracks the maximum number of overlapping HTTP requests seen during
/// a test — paired with `URLSession.stubbed`'s onRequestStart/end
/// hooks to validate the semaphore cap.
actor ConcurrentRequestTracker {
  private var current = 0
  private(set) var observedMax = 0
  func enter() { current += 1; if current > observedMax { observedMax = current } }
  func leave() { current -= 1 }
}

actor CounterActor {
  private var current = 0
  private(set) var observedMax = 0
  func increment() -> Int {
    current += 1
    if current > observedMax { observedMax = current }
    return current
  }
  func decrement() { current -= 1 }
}
