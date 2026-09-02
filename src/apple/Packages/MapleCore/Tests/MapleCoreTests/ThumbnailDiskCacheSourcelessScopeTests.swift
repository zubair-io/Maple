// ThumbnailDiskCacheSourcelessScopeTests.swift — #2763.
//
// Pins that a SOURCELESS thumbnail (PhotoKit / Self-Hosted browse, keyed by
// stable id rather than a filesystem basename) is written to and read from
// a fixed on-disk location independent of `configure(folderURL:)` — the
// LOCAL-folder-scoped `cacheDir` a sourceless asset has no relationship to.
//
// Before the fix, `thumbnailData(forKey:)`/`storeThumbnailData(forKey:)`
// wrote through `cacheDir` anyway. Testing the disk path specifically (not
// just the round-trip through one shared instance) matters here: the
// in-memory tier (`dataMemCache`) would mask the bug entirely within a
// single process, since a same-instance read never touches disk at all.
// These tests use FRESH `ThumbnailDiskCache()` instances (same precedent as
// `ThumbnailDiskCacheKeyTests`'s "writer vs reader path parity" section) so
// a read genuinely exercises the on-disk resolution, memory-cold.

import XCTest
@testable import MapleCore

final class ThumbnailDiskCacheSourcelessScopeTests: XCTestCase {

    private var folderA: URL!
    private var folderB: URL!

    override func setUp() async throws {
        folderA = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("maple-sourceless-scope-a-\(UUID().uuidString)")
        folderB = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("maple-sourceless-scope-b-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folderA, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: folderB, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folderA)
        try? FileManager.default.removeItem(at: folderB)
    }

    /// The bug scenario verbatim: a local-folder browse configures the
    /// cache for `folderA`, THEN a sourceless (PhotoKit/Self-Hosted) thumb
    /// is stored — it must not land under `folderA`'s `.maple/thumbs/`.
    func testStoreDoesNotWriteUnderTheCurrentlyConfiguredLocalFolder() async throws {
        let cache = ThumbnailDiskCache()
        await cache.configure(folderURL: folderA)

        let key = "maple:stable-id-\(UUID().uuidString)"
        defer { removeSourcelessThumbCacheFile(forKey: key) }
        let payload = Data([0x01, 0x02, 0x03])
        await cache.storeThumbnailData(payload, forKey: key)

        let hashed = MapleThumbCacheKey.sha256Prefix16(key)
        let wrongPath = folderA
            .appendingPathComponent(".maple/thumbs")
            .appendingPathComponent("\(hashed).avif")
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: wrongPath.path),
            "a sourceless thumbnail must never land in the configured local folder's .maple/thumbs/"
        )
    }

    /// The actual regression: stored while `folderA` is configured, still
    /// readable — from a FRESH, memory-cold instance — after a LATER
    /// `configure()` call points `cacheDir` at an entirely different
    /// folder (`folderB`), simulating "the app opened a different local
    /// folder since". Before the fix this would have been an unreadable
    /// orphan under `folderA`.
    func testStoredWhileFolderAConfiguredIsStillReadableAfterConfiguringFolderB() async throws {
        let writer = ThumbnailDiskCache()
        await writer.configure(folderURL: folderA)
        let key = "maple:stable-id-\(UUID().uuidString)"
        defer { removeSourcelessThumbCacheFile(forKey: key) }
        let payload = Data([0xAA, 0xBB, 0xCC, 0xDD])
        await writer.storeThumbnailData(payload, forKey: key)

        // Fresh instance (no warm `dataMemCache`), configured for a
        // DIFFERENT folder — mirrors a later session opening folderB.
        let reader = ThumbnailDiskCache()
        await reader.configure(folderURL: folderB)

        let retrieved = await reader.thumbnailData(forKey: key)
        XCTAssertEqual(
            retrieved, payload,
            "a sourceless thumbnail must survive a later configure() call for an unrelated folder"
        )
    }

    /// Two fresh instances that NEVER call `configure(folderURL:)` at all
    /// (no local folder ever opened this session — a pure PhotoKit/Cloud
    /// session) must still round-trip a sourceless thumbnail through disk.
    /// Before the fix this was impossible: `cacheDir` was `nil` until the
    /// first `configure()` call, so `storeThumbnailData(forKey:)` silently
    /// no-opped past its `guard let dir = cacheDir else { return }`.
    func testRoundTripsWithoutEverCallingConfigure() async {
        let writer = ThumbnailDiskCache()
        let key = "maple:stable-id-\(UUID().uuidString)"
        defer { removeSourcelessThumbCacheFile(forKey: key) }
        let payload = Data([0x10, 0x20, 0x30])
        await writer.storeThumbnailData(payload, forKey: key)

        let reader = ThumbnailDiskCache()
        let retrieved = await reader.thumbnailData(forKey: key)
        XCTAssertEqual(retrieved, payload)
    }
}
