// TopShelfCacheTests.swift
//
// `TopShelfCache` and `TopShelfBuilder` are the testable half of Maple TV's
// Top Shelf; the extension's provider is platform glue over them. Same split,
// and the same reason, as `LightTablePool` vs `LightTableViewModel` — there
// is no Xcode test bundle for Maple TV or its extensions, so anything worth
// asserting has to live where `swift test` can reach it.

import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import MapleCloudKit

final class TopShelfCacheTests: XCTestCase {
  private var directory: URL!
  private var cache: TopShelfCache!

  override func setUpWithError() throws {
    directory = URL(filePath: NSTemporaryDirectory())
      .appending(path: "topshelf-\(UUID().uuidString)", directoryHint: .isDirectory)
    cache = TopShelfCache(directory: directory)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  // MARK: - Manifest round-trip

  func test_write_thenLoad_preservesEveryField() async throws {
    let entries = [
      TopShelfEntry(id: "a", title: "Spooky Nights", subtitle: "12 photos", imageFileName: "a.jpg"),
      TopShelfEntry(id: "b", title: "Lake George", subtitle: nil, imageFileName: "b.jpg"),
    ]
    try await cache.write(
      entries: entries, images: ["a": Data([0x01]), "b": Data([0x02])],
      isFallback: false)

    let manifest = await cache.loadManifest()
    let loaded = try XCTUnwrap(manifest)
    XCTAssertEqual(loaded.entries, entries)
    XCTAssertFalse(loaded.isFallback)
    XCTAssertEqual(loaded.version, TopShelfManifest.currentVersion)
  }

  func test_write_storesImagesUnderTheEntrysFileName() async throws {
    let entry = TopShelfEntry(id: "a", title: "T", subtitle: nil, imageFileName: "a.jpg")
    try await cache.write(entries: [entry], images: ["a": Data([0xAB])], isFallback: false)

    XCTAssertEqual(try Data(contentsOf: cache.imageURL(for: entry)), Data([0xAB]))
  }

  func test_write_sweepsImagesTheNewManifestNoLongerReferences() async throws {
    let old = TopShelfEntry(id: "old", title: "Old", subtitle: nil, imageFileName: "old.jpg")
    try await cache.write(entries: [old], images: ["old": Data([0x01])], isFallback: false)

    let new = TopShelfEntry(id: "new", title: "New", subtitle: nil, imageFileName: "new.jpg")
    try await cache.write(entries: [new], images: ["new": Data([0x02])], isFallback: false)

    // Without the sweep this directory would gain a cover per memory per day,
    // forever — nothing else prunes it.
    XCTAssertFalse(FileManager.default.fileExists(atPath: cache.imageURL(for: old).path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: cache.imageURL(for: new).path))
  }

  func test_loadManifest_isNilWhenAbsentOrUnreadable() async throws {
    let absent = await cache.loadManifest()
    XCTAssertNil(absent, "no cache written yet")

    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data("not json".utf8).write(to: directory.appending(path: "manifest.json"))
    let invalid = await cache.loadManifest()
    XCTAssertNil(invalid, "garbage must read as absent, not crash")
  }

  func test_loadManifest_isNilForAnUnknownVersion() async throws {
    // A newer app writing a shape this build can't read must degrade to
    // "refresh me", not to a wrong render.
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let future = """
      {"version":\(TopShelfManifest.currentVersion + 1),"generatedAt":"2026-09-02T00:00:00Z",\
      "entries":[],"isFallback":false}
      """
    try Data(future.utf8).write(to: directory.appending(path: "manifest.json"))

    let loaded = await cache.loadManifest()
    XCTAssertNil(loaded)
  }

  // MARK: - Freshness

  func test_isStale_treatsAMissingManifestAsStale() {
    XCTAssertTrue(cache.isStale(nil), "a first run must refresh")
  }

  func test_isStale_isFalseInsideTheWindowAndTrueOutsideIt() {
    let built = Date()
    let manifest = TopShelfManifest(generatedAt: built, entries: [], isFallback: false)

    let justInside = built.addingTimeInterval(TopShelfCache.freshnessWindow - 60)
    let justOutside = built.addingTimeInterval(TopShelfCache.freshnessWindow + 60)

    XCTAssertFalse(cache.isStale(manifest, now: justInside))
    XCTAssertTrue(cache.isStale(manifest, now: justOutside))
  }

  // MARK: - File naming

  func test_imageFileName_neverEscapesTheCacheDirectory() {
    // Collection ids are server-generated; a "/" or ".." in one must not
    // become a path that writes outside the container.
    let name = TopShelfCache.imageFileName(forEntryID: "../../etc/passwd")

    XCTAssertFalse(name.contains("/"))
    XCTAssertFalse(name.contains(".."))
    XCTAssertTrue(name.hasSuffix(".jpg"))
  }

  func test_imageFileName_isStableForTheSameID() {
    XCTAssertEqual(
      TopShelfCache.imageFileName(forEntryID: "abc123"),
      TopShelfCache.imageFileName(forEntryID: "abc123")
    )
  }
  func test_scopesSeparateLibrariesAndServers() {
    let server = URL(string: "https://maple.local")!
    let first = TopShelfCache.scopeDirectory(in: directory, server: server, libraryID: "one")
    XCTAssertNotEqual(
      first, TopShelfCache.scopeDirectory(in: directory, server: server, libraryID: "two"))
    XCTAssertNotEqual(
      first,
      TopShelfCache.scopeDirectory(
        in: directory, server: URL(string: "https://other.local")!, libraryID: "one"))
    XCTAssertNotEqual(
      TopShelfCache.imageFileName(forEntryID: "a/b"),
      TopShelfCache.imageFileName(forEntryID: "a-b"))
  }

  func test_writePublishesOnlyDownloadedImages() async throws {
    let entries = [
      TopShelfEntry(id: "yes", title: "Downloaded", subtitle: nil, imageFileName: "yes.jpg"),
      TopShelfEntry(id: "no", title: "Failed", subtitle: nil, imageFileName: "no.jpg"),
    ]
    try await cache.write(entries: entries, images: ["yes": Data([1])], isFallback: false)
    let loaded = await cache.loadManifest()
    XCTAssertEqual(loaded?.entries, [entries[0]])
    try await cache.write(entries: entries, images: [:], isFallback: false)
    let retained = await cache.loadManifest()
    XCTAssertEqual(retained, loaded)
  }

  func test_writeRejectsPathsOutsideCache() async throws {
    let entry = TopShelfEntry(id: "x", title: "Invalid", subtitle: nil, imageFileName: "../x.jpg")
    do {
      try await cache.write(entries: [entry], images: ["x": Data([1])], isFallback: false)
      XCTFail("Path traversal must be rejected")
    } catch {
      XCTAssertEqual((error as? CocoaError)?.code, .fileWriteInvalidFileName)
    }
  }

  func test_previewConversionRejectsInvalidImage() {
    XCTAssertNil(TopShelfRefresher.jpeg(Data([0, 1, 2])))
  }

  func test_previewConversionWritesDecodableJPEG() throws {
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: 16, height: 16,
        bitsPerComponent: 8, bytesPerRow: 64, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
    let image = try XCTUnwrap(context.makeImage())
    let png = NSMutableData()
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithData(
        png, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    let jpeg = try XCTUnwrap(TopShelfRefresher.jpeg(png as Data))
    let source = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil))
    XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
    XCTAssertNotNil(CGImageSourceCreateImageAtIndex(source, 0, nil))
  }

}
