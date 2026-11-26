// CloudThumbCacheAccessTests.swift — cloud thumbnail hits read off the actor
// and refresh LRU recency at most once per interval; versioned thumbs (#6017).

import CryptoKit
import XCTest

@testable import MapleCloudKit

final class CloudThumbCacheAccessTests: XCTestCase {

  private var dir: URL!

  override func setUpWithError() throws {
    dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("cloud-thumb-access-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  func testRecentHitLeavesRecencyAlone() async throws {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    await cache.put(host: "x", absPath: "/a", Data([1, 2, 3]))
    let recent = Date().addingTimeInterval(-60)
    try setMtime(recent, absPath: "/a")

    let hit = await cache.get(host: "x", absPath: "/a")
    XCTAssertEqual(hit, Data([1, 2, 3]))
    let after = try mtime(absPath: "/a")
    XCTAssertEqual(after.timeIntervalSince1970, recent.timeIntervalSince1970, accuracy: 1)
  }

  func testStaleHitRefreshesRecency() async throws {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    await cache.put(host: "x", absPath: "/a", Data([1]))
    try setMtime(Date().addingTimeInterval(-2 * CloudThumbCache.lruTouchInterval), absPath: "/a")

    let hit = await cache.get(host: "x", absPath: "/a")
    XCTAssertNotNil(hit)
    let refreshed = try mtime(absPath: "/a")
    XCTAssertLessThan(Date().timeIntervalSince(refreshed), 60)
  }

  func testEntryAnswersItsOwnVersionAndACallerThatNamesNone() async {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    await cache.put(host: "x", absPath: "/a", version: "v1", Data([1]))

    let sameVersion = await cache.get(host: "x", absPath: "/a", version: "v1")
    let editedElsewhere = await cache.get(host: "x", absPath: "/a", version: "v2")
    let anyRendering = await cache.get(host: "x", absPath: "/a")
    XCTAssertEqual(sameVersion, Data([1]))
    XCTAssertNil(editedElsewhere, "another version is a miss, so the edit is fetched")
    XCTAssertEqual(anyRendering, Data([1]), "the editor seed asks without a version")
  }

  func testNewerRenderingReplacesTheOlderOneInPlace() async throws {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    await cache.put(host: "x", absPath: "/a", version: "v1", Data([1]))
    await cache.put(host: "x", absPath: "/a", version: "v2", Data([2]))

    let older = await cache.get(host: "x", absPath: "/a", version: "v1")
    let newer = await cache.get(host: "x", absPath: "/a", version: "v2")
    let anyRendering = await cache.get(host: "x", absPath: "/a")
    XCTAssertNil(older)
    XCTAssertEqual(newer, Data([2]))
    XCTAssertEqual(anyRendering, Data([2]), "a caller naming no version never goes back")
    let files = try FileManager.default.contentsOfDirectory(
      atPath: fileURL(absPath: "/a").deletingLastPathComponent().path)
    XCTAssertEqual(files.count, 1, "one file per path: no rendering is left behind")
  }

  func testEntryStoredWithoutAVersionIsAMissForAVersionedCaller() async {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    await cache.put(host: "x", absPath: "/a", Data([1]))

    let versioned = await cache.get(host: "x", absPath: "/a", version: "v1")
    XCTAssertNil(versioned, "its rendering is unknown, so it is fetched once under the version")

    await cache.put(host: "x", absPath: "/a", version: "v1", Data([2]))
    let anyRendering = await cache.get(host: "x", absPath: "/a")
    XCTAssertEqual(anyRendering, Data([2]))
  }

  func testFailedFetchFallsBackToTheStoredRendering() async {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    await cache.put(host: "x", absPath: "/a", Data([1]))

    let offline = await cache.bytes(host: "x", absPath: "/a", version: "v2") {
      throw URLError(.notConnectedToInternet)
    }
    let neverStored = await cache.bytes(host: "x", absPath: "/b", version: "v2") {
      throw URLError(.notConnectedToInternet)
    }
    XCTAssertEqual(offline, Data([1]), "an older thumbnail beats a placeholder")
    XCTAssertNil(neverStored)
  }

  func testServerErrorStaysAMissSoTheCallerRetries() async {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    await cache.put(host: "x", absPath: "/a", Data([1]))

    let serverError = await cache.bytes(host: "x", absPath: "/a", version: "v2") {
      throw URLError(.badServerResponse)
    }
    let cancelled = await cache.bytes(host: "x", absPath: "/a", version: "v2") {
      throw CancellationError()
    }
    XCTAssertNil(serverError, "the stored rendering would hide the new one for the session")
    XCTAssertNil(cancelled)
  }

  func testFetchedBytesAreStoredUnderTheRequestedVersion() async {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    await cache.put(host: "x", absPath: "/a", version: "v1", Data([1]))
    let fetches = FetchCount()

    let fetched = await cache.bytes(host: "x", absPath: "/a", version: "v2") {
      await fetches.record()
      return Data([2])
    }
    let again = await cache.bytes(host: "x", absPath: "/a", version: "v2") {
      await fetches.record()
      return Data([3])
    }
    let count = await fetches.count
    XCTAssertEqual(fetched, Data([2]))
    XCTAssertEqual(again, Data([2]), "the second view is a cache hit")
    XCTAssertEqual(count, 1)
  }

  func testAVersionTooLongToRecordIsServedLikeNoVersion() async {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    let unstorable = String(repeating: "v", count: 200)
    await cache.put(host: "x", absPath: "/a", version: unstorable, Data([1]))

    let hit = await cache.get(host: "x", absPath: "/a", version: unstorable)
    XCTAssertEqual(hit, Data([1]), "a miss here would fetch the thumbnail on every view")
  }

  func testReplacingAnEntryCountsOnlyTheBytesItAdds() async throws {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    // Measuring the empty cache first settles the running total, so the
    // launch-time scan does not run concurrently with the writes below.
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    await cache.evictIfNeeded()

    for round in 0..<10 {
      await cache.put(host: "x", absPath: "/a", version: "v\(round)", Data(count: 400))
    }

    let tracked = await cache.approxTotal
    XCTAssertEqual(tracked, 400, "ten renderings of one path leave one 400-byte entry")
  }

  func testThumbURLCarriesTheVersionAsAQueryItem() throws {
    let base = try XCTUnwrap(URL(string: "https://maple.example/api/thumb/photos/2024/a%231.dng"))
    let versioned = CloudThumbClient.versioned(base, "k3j9")
    XCTAssertEqual(versioned.absoluteString, "https://maple.example/api/thumb/photos/2024/a%231.dng?v=k3j9")
  }

  func testMissReturnsNil() async {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    let miss = await cache.get(host: "x", absPath: "/missing")
    XCTAssertNil(miss)
  }

  private actor FetchCount {
    private(set) var count = 0
    func record() { count += 1 }
  }

  private func fileURL(absPath: String) -> URL {
    let digest = SHA256.hash(data: Data(absPath.utf8)).map { String(format: "%02x", $0) }.joined()
    return dir.appendingPathComponent("x", isDirectory: true)
      .appendingPathComponent(String(digest.prefix(2)), isDirectory: true)
      .appendingPathComponent("\(digest).avif")
  }

  private func setMtime(_ date: Date, absPath: String) throws {
    try FileManager.default.setAttributes(
      [.modificationDate: date], ofItemAtPath: fileURL(absPath: absPath).path)
  }

  private func mtime(absPath: String) throws -> Date {
    let attributes = try FileManager.default.attributesOfItem(atPath: fileURL(absPath: absPath).path)
    return try XCTUnwrap(attributes[.modificationDate] as? Date)
  }
}
