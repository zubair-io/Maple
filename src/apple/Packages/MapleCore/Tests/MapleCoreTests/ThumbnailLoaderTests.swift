// ThumbnailLoaderTests.swift — cache round-trip for `ThumbnailDiskCache`.
//
// We can't exercise the FFI path deterministically in a unit test (needs a
// real RAW fixture), so the coverage here is:
//   1. `storeThumbnailData` → `thumbnailData` round-trips bytes through disk.
//   2. `configure(folderURL:)` creates the expected .maple/thumbs layout.
//   3. The cache-miss path returns nil when no file exists.

import XCTest
import CoreImage
@testable import MapleCore

final class ThumbnailLoaderTests: XCTestCase {

    private var tmp: URL!

    override func setUp() async throws {
        tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("maple-thumb-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tmp, withIntermediateDirectories: true
        )
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tmp)
    }

    // MARK: - Disk layout

    func testConfigureCreatesMapleThumbsDirectory() async {
        let cache = ThumbnailDiskCache()
        await cache.configure(folderURL: tmp)
        let dir = tmp.appendingPathComponent(".maple/thumbs")
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path),
                      "`.maple/thumbs` directory should be created")
    }

    // MARK: - Data round-trip

    func testStoreAndFetchRoundTripsData() async {
        let cache = ThumbnailDiskCache()
        await cache.configure(folderURL: tmp)

        let fakeAsset = tmp.appendingPathComponent("IMG_0001.dng")
        let payload = Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0])  // JPEG-ish

        await cache.storeThumbnailData(payload, for: fakeAsset)

        // Re-read from memory.
        let hot = await cache.thumbnailData(for: fakeAsset)
        XCTAssertEqual(hot, payload, "memory cache should return stored bytes")

        // Drop the in-memory copy by using a fresh cache on the same dir.
        let coldCache = ThumbnailDiskCache()
        await coldCache.configure(folderURL: tmp)
        let cold = await coldCache.thumbnailData(for: fakeAsset)
        XCTAssertEqual(cold, payload, "disk cache should re-hydrate bytes")
    }

    // MARK: - Cache miss

    func testMissReturnsNil() async {
        let cache = ThumbnailDiskCache()
        await cache.configure(folderURL: tmp)
        let miss = await cache.thumbnailData(
            for: tmp.appendingPathComponent("not_indexed.dng")
        )
        XCTAssertNil(miss)
    }

    // MARK: - Constants

    func testSpecConstantsMatchSpec() {
        // Spec § 03 (thumbnail AVIF migration): 256 px long edge, AVIF q=0.5.
        XCTAssertEqual(ThumbnailDiskCache.defaultThumbSize.width, 256)
        XCTAssertEqual(ThumbnailEncoder.quality, 0.5)
    }
}
