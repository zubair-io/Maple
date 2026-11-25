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

  func testVersionedEntriesAreSeparateFromEachOtherAndFromTheUnversionedOne() async {
    let cache = CloudThumbCache(baseDir: dir, maxBytes: 1024 * 1024)
    await cache.put(host: "x", absPath: "/a", version: "v1", Data([1]))

    let sameVersion = await cache.get(host: "x", absPath: "/a", version: "v1")
    let editedElsewhere = await cache.get(host: "x", absPath: "/a", version: "v2")
    let unversioned = await cache.get(host: "x", absPath: "/a")
    XCTAssertEqual(sameVersion, Data([1]))
    XCTAssertNil(editedElsewhere)
    XCTAssertNil(unversioned)
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
