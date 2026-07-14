// MapleIdCacheTests.swift — MapleIdCacheStore + LocalIdCacheStorage (#1995).
//
// Covers: cache-validity (stale on size/mtime mismatch, fresh on match),
// atomic-write round-trip, and the multi-writer union scenario (two
// producers writing their own `id-cache-<writer>.json` files over the same
// folder, a reader seeing the union of both).
//
// Real files in a temp directory throughout — no mocks for the storage
// layer, matching this codebase's "no mocks for the sidecar layer" spirit:
// the cache format IS the cross-process contract, so round-tripping real
// JSON on real disk is what actually proves it.

import XCTest
@testable import MapleCore

final class MapleIdCacheTests: XCTestCase {

    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-id-cache-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Validity

    func testLookupMissesOnEmptyCache() async {
        let store = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        let hit = await store.lookup(path: "a.dng", size: 100, mtime: 123.0)
        XCTAssertNil(hit)
    }

    func testRecordThenLookupHitsWithMatchingSizeAndMtime() async {
        let store = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        await store.record(path: "a.dng", mapleId: "01aabbcc", size: 100, mtime: 123.0)
        let hit = await store.lookup(path: "a.dng", size: 100, mtime: 123.0)
        XCTAssertEqual(hit, "01aabbcc")
    }

    func testLookupMissesOnSizeMismatch() async {
        let store = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        await store.record(path: "a.dng", mapleId: "01aabbcc", size: 100, mtime: 123.0)
        // Same mtime, different size — a file replaced at the same path
        // must not silently keep yielding the old id.
        let hit = await store.lookup(path: "a.dng", size: 200, mtime: 123.0)
        XCTAssertNil(hit)
    }

    func testLookupMissesOnMtimeMismatch() async {
        let store = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        await store.record(path: "a.dng", mapleId: "01aabbcc", size: 100, mtime: 123.0)
        let hit = await store.lookup(path: "a.dng", size: 100, mtime: 456.0)
        XCTAssertNil(hit)
    }

    func testRecordOverwritesPriorEntryForSamePath() async {
        let store = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        await store.record(path: "a.dng", mapleId: "01aaaaaa", size: 100, mtime: 123.0)
        await store.record(path: "a.dng", mapleId: "01bbbbbb", size: 200, mtime: 456.0)

        let staleHit = await store.lookup(path: "a.dng", size: 100, mtime: 123.0)
        XCTAssertNil(staleHit, "stale row must not linger")
        let freshHit = await store.lookup(path: "a.dng", size: 200, mtime: 456.0)
        XCTAssertEqual(freshHit, "01bbbbbb")
    }

    // MARK: - Persistence round-trip (a fresh store instance = a fresh process)

    func testEntryPersistsAcrossStoreInstances() async {
        let writer1 = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        await writer1.record(path: "a.dng", mapleId: "01aabbcc", size: 100, mtime: 123.0)

        // A DIFFERENT instance over the SAME folder — the entry can only
        // come from disk, proving the write was actually persisted (not
        // just cached in the first instance's memory).
        let reader = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        let hit = await reader.lookup(path: "a.dng", size: 100, mtime: 123.0)
        XCTAssertEqual(hit, "01aabbcc")
    }

    func testWritesOwnCacheFileAtExpectedPath() async {
        let store = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        await store.record(path: "a.dng", mapleId: "01aabbcc", size: 100, mtime: 123.0)

        let expectedURL = tmpDir.appendingPathComponent(".maple/id-cache-apple.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: expectedURL.path))
    }

    // MARK: - Multi-writer union (#1995's core requirement)

    func testUnionAcrossTwoWriters() async {
        let apple = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        let web = MapleIdCacheStore(folderURL: tmpDir, writer: "web")

        await apple.record(path: "a.dng", mapleId: "01-from-apple", size: 100, mtime: 123.0)
        await web.record(path: "b.dng", mapleId: "01-from-web", size: 200, mtime: 456.0)

        // A THIRD store instance (a fresh reader, e.g. a later browse
        // session) must see BOTH producers' entries — this is the whole
        // point of the union: Apple's write becomes visible to a Web-style
        // reader and vice versa without either writing the other's file.
        let reader = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        let hitA = await reader.lookup(path: "a.dng", size: 100, mtime: 123.0)
        XCTAssertEqual(hitA, "01-from-apple")
        let hitB = await reader.lookup(path: "b.dng", size: 200, mtime: 456.0)
        XCTAssertEqual(hitB, "01-from-web")
    }

    func testEachWriterOnlyTouchesItsOwnFile() async {
        let apple = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        let web = MapleIdCacheStore(folderURL: tmpDir, writer: "web")

        await apple.record(path: "a.dng", mapleId: "01-from-apple", size: 100, mtime: 123.0)
        await web.record(path: "b.dng", mapleId: "01-from-web", size: 200, mtime: 456.0)

        let appleFile = try? Data(contentsOf: tmpDir.appendingPathComponent(".maple/id-cache-apple.json"))
        let webFile = try? Data(contentsOf: tmpDir.appendingPathComponent(".maple/id-cache-web.json"))
        XCTAssertNotNil(appleFile)
        XCTAssertNotNil(webFile)

        let appleText = String(data: appleFile!, encoding: .utf8) ?? ""
        let webText = String(data: webFile!, encoding: .utf8) ?? ""
        XCTAssertTrue(appleText.contains("01-from-apple"))
        XCTAssertFalse(appleText.contains("01-from-web"), "apple's file must not contain web's rows")
        XCTAssertTrue(webText.contains("01-from-web"))
        XCTAssertFalse(webText.contains("01-from-apple"), "web's file must not contain apple's rows")
    }

    func testConflictingEntryAcrossWritersPrefersGreaterMtime() async {
        let apple = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        let web = MapleIdCacheStore(folderURL: tmpDir, writer: "web")

        // Same path key, both producers wrote a (still individually valid)
        // row for it, but Web's is the more recent observation.
        await apple.record(path: "a.dng", mapleId: "01-older", size: 100, mtime: 100.0)
        await web.record(path: "a.dng", mapleId: "01-newer", size: 100, mtime: 200.0)

        let reader = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        let hit = await reader.lookup(path: "a.dng", size: 100, mtime: 200.0)
        XCTAssertEqual(hit, "01-newer")
    }

    /// [Caught in review on #2003] `loadEntries` used to build its
    /// dictionary via `Dictionary(uniqueKeysWithValues:)`, which TRAPS at
    /// runtime on a decodable-but-malformed cache file containing more than
    /// one row for the same `path` (hand-edited, or corrupted mid-write on
    /// a flaky SMB share). The storage contract already treats an
    /// unreadable/corrupt file as a cache miss rather than a crash — this
    /// proves a duplicate-path file degrades the same way instead of
    /// taking down the browse session, resolving the duplicate via the same
    /// greater-`mtime`-wins rule `loadUnionFromStorage` already uses across
    /// files.
    func testDuplicatePathEntriesInOneCacheFileDoNotCrashAndPreferGreaterMtime() async throws {
        let mapleDir = tmpDir.appendingPathComponent(".maple")
        try FileManager.default.createDirectory(at: mapleDir, withIntermediateDirectories: true)
        let file = MapleIdCacheFile(entries: [
            MapleIdCacheEntry(path: "a.dng", mapleId: "01-older", size: 100, mtime: 100.0),
            MapleIdCacheEntry(path: "a.dng", mapleId: "01-newer", size: 100, mtime: 200.0),
        ])
        let data = try JSONEncoder().encode(file)
        try data.write(to: mapleDir.appendingPathComponent("id-cache-apple.json"))

        let reader = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        let hit = await reader.lookup(path: "a.dng", size: 100, mtime: 200.0)
        XCTAssertEqual(hit, "01-newer")
    }

    func testRecordAfterUnionAlreadyLoadedIsImmediatelyVisible() async {
        let apple = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        // Force the union to load (empty at this point).
        _ = await apple.lookup(path: "a.dng", size: 100, mtime: 123.0)
        // Now record — must be visible on the SAME instance without
        // requiring a fresh store (the in-memory union cache must be kept
        // in sync by `record`, not just the on-disk file).
        await apple.record(path: "a.dng", mapleId: "01aabbcc", size: 100, mtime: 123.0)
        let hit = await apple.lookup(path: "a.dng", size: 100, mtime: 123.0)
        XCTAssertEqual(hit, "01aabbcc")
    }
}
