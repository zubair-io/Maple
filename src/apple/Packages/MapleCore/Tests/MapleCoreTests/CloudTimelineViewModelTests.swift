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
