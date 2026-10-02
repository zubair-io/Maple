// CloudCacheTests.swift — round-trip + eviction tests for the three caches.
import CryptoKit
import XCTest

@testable import MapleCloudKit
@testable import MapleCore

@MainActor
final class CloudCacheTests: XCTestCase {

  // MARK: BucketsCache

  func test_bucketsCache_roundTrip() async {
    let dir = makeTempDir("buckets")
    let cache = CloudBucketsCache(baseDir: dir)
    let buckets = TimelineBuckets(
      total: 7,
      buckets: [TimelineBucket(year: 2024, month: 7, count: 7)],
      untimed_count: 0)
    await cache.write(host: "x", libraryID: "lib1", buckets)
    let read = await cache.read(host: "x", libraryID: "lib1")
    XCTAssertEqual(read?.total, 7)
    XCTAssertEqual(read?.buckets.first?.year, 2024)
  }

  func test_bucketsCache_missReturnsNil() async {
    let dir = makeTempDir("buckets-miss")
    let cache = CloudBucketsCache(baseDir: dir)
    let read = await cache.read(host: "x", libraryID: "absent")
    XCTAssertNil(read)
  }

  // MARK: PagesCache

  func test_pagesCache_roundTrip() async {
    let dir = makeTempDir("pages")
    let cache = CloudPagesCache(baseDir: dir)
    let resp = SearchResponse(
      total: 1, page: 1, limit: 200,
      results: [
        SearchAsset(
          id: "a1", folder_id: "lib1", abs_path: "/p/a.dng", filename: "a.dng",
          size: 1024, mtime: nil, captured_at: nil, camera: nil, lens: nil,
          iso: nil, aperture: nil, shutter: nil, focal_length: nil,
          rating: 4, flag: nil, color_label: nil)
      ])
    await cache.write(host: "x", libraryID: "lib1", year: 2024, month: 7, page: 1, resp)
    let read = await cache.read(host: "x", libraryID: "lib1", year: 2024, month: 7, page: 1)
    XCTAssertEqual(read?.results.first?.id, "a1")
  }

  // MARK: ThumbCache

  func test_ownerCacheScopesDoNotLeakBetweenAllOwnersMembersOrFolders() async {
    let dir = makeTempDir("owner-isolation")
    let buckets = CloudBucketsCache(baseDir: dir.appendingPathComponent("buckets"))
    let pages = CloudPagesCache(baseDir: dir.appendingPathComponent("pages"))
    let scopes: [(String?, String?)] = [
      (nil, nil), ("member-a", nil), ("member-b", nil),
      ("member-a", "2026/"),
    ]
    for (index, scope) in scopes.enumerated() {
      let (owner, folder) = scope
      await buckets.write(
        host: "host", libraryID: "library", pathPrefix: folder, ownerID: owner,
        TimelineBuckets(total: index, buckets: [], untimed_count: 0))
      await pages.write(
        host: "host", libraryID: "library", pathPrefix: folder, ownerID: owner,
        year: 2026, month: 1, page: 0,
        SearchResponse(total: index, page: 0, limit: 200, results: []))
    }
    for (index, scope) in scopes.enumerated() {
      let (owner, folder) = scope
      let cachedBuckets = await buckets.read(
        host: "host", libraryID: "library", pathPrefix: folder, ownerID: owner)
      let cachedPage = await pages.read(
        host: "host", libraryID: "library", pathPrefix: folder, ownerID: owner,
        year: 2026, month: 1, page: 0)
      XCTAssertEqual(cachedBuckets?.total, index)
      XCTAssertEqual(cachedPage?.total, index)
    }
    // Empty/nil ownership still reads the shipped unfiltered file layout.
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath:
          dir.appendingPathComponent("buckets/host/library/_root.json").path))
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath:
          dir.appendingPathComponent("pages/host/library/_root/2026-01-p0.json").path))
    let legacy = await buckets.read(host: "host", libraryID: "library", ownerID: "")
    XCTAssertEqual(legacy?.total, 0)
    await buckets.clear(host: "host", libraryID: "library", ownerID: "member-a")
    let cleared = await buckets.read(host: "host", libraryID: "library", ownerID: "member-a")
    let other = await buckets.read(host: "host", libraryID: "library", ownerID: "member-b")
    XCTAssertNil(cleared)
    XCTAssertEqual(other?.total, 2)
    await pages.clearLibrary(host: "host", libraryID: "library")
    let remaining = await pages.read(
      host: "host", libraryID: "library", ownerID: "member-b",
      year: 2026, month: 1, page: 0)
    XCTAssertNil(remaining)
  }

  func test_thumbCache_roundTrip() async {
    let dir = makeTempDir("thumbs")
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    let bytes = Data(repeating: 0xAB, count: 256)
    await cache.put(host: "x", absPath: "/photos/a.dng", bytes)
    let got = await cache.get(host: "x", absPath: "/photos/a.dng")
    XCTAssertEqual(got, bytes)
  }

  func test_thumbCache_evictsOldestPastCap() async throws {
    let dir = makeTempDir("thumbs-evict")
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 600)
    // Three 256-byte entries. With cap=600 the directory holds 768B
    // after the third put — eviction must drop the oldest until the
    // total is back under 600.
    let a = Data(repeating: 0x01, count: 256)
    let b = Data(repeating: 0x02, count: 256)
    let c = Data(repeating: 0x03, count: 256)
    await cache.put(host: "x", absPath: "/a", a)
    await cache.put(host: "x", absPath: "/b", b)
    await cache.put(host: "x", absPath: "/c", c)
    // Set explicit mtimes so LRU ordering is deterministic — the
    // previous version slept 50ms between puts hoping the file system
    // would assign distinct timestamps, which on slow CI / coarse
    // mtime resolution made the assertion flaky.
    let now = Date()
    setMtime(at: dir, host: "x", absPath: "/a", mtime: now.addingTimeInterval(-30))
    setMtime(at: dir, host: "x", absPath: "/b", mtime: now.addingTimeInterval(-20))
    setMtime(at: dir, host: "x", absPath: "/c", mtime: now.addingTimeInterval(-10))
    await cache.evictIfNeeded()

    let aBytes = await cache.get(host: "x", absPath: "/a")
    let cBytes = await cache.get(host: "x", absPath: "/c")
    XCTAssertNil(aBytes)
    XCTAssertNotNil(cBytes)
  }

  // MARK: helpers

  private func makeTempDir(_ tag: String) -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent(
        "CloudCacheTests-\(tag)-\(UUID().uuidString)",
        isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }

  /// Resolves the same SHA256-of-path layout that `CloudThumbCache`
  /// uses internally so the test can stamp deterministic mtimes on the
  /// files it just wrote — without depending on the OS scheduler to
  /// space puts apart.
  private func setMtime(at base: URL, host: String, absPath: String, mtime: Date) {
    let digest = SHA256.hash(data: Data(absPath.utf8))
      .map { String(format: "%02x", $0) }.joined()
    let url =
      base
      .appendingPathComponent(host, isDirectory: true)
      .appendingPathComponent(String(digest.prefix(2)), isDirectory: true)
      .appendingPathComponent("\(digest).avif")
    try? FileManager.default.setAttributes(
      [.modificationDate: mtime],
      ofItemAtPath: url.path)
  }
}
