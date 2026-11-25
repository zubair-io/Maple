// MapleIdCacheBatchWriteTests.swift — staged id-cache writes reach disk once
// per batch, not once per derived id (#6017).

import XCTest
@testable import MapleCore

final class MapleIdCacheBatchWriteTests: XCTestCase {

    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-id-cache-batch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    private var ownFile: URL { tmpDir.appendingPathComponent(".maple/id-cache-apple.json") }

    func testStagedRowsAreVisibleButNotWrittenUntilFlush() async {
        let store = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        await store.stage(path: "a.dng", mapleId: "01aa", size: 1, mtime: 1)
        await store.stage(path: "b.dng", mapleId: "01bb", size: 2, mtime: 2)

        let staged = await store.lookup(path: "b.dng", size: 2, mtime: 2)
        XCTAssertEqual(staged, "01bb")
        XCTAssertFalse(FileManager.default.fileExists(atPath: ownFile.path))

        await store.flush()
        let reopened = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        let a = await reopened.lookup(path: "a.dng", size: 1, mtime: 1)
        let b = await reopened.lookup(path: "b.dng", size: 2, mtime: 2)
        XCTAssertEqual(a, "01aa")
        XCTAssertEqual(b, "01bb")
    }

    func testStagingPastThresholdWritesWithoutAnExplicitFlush() async {
        let store = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        for index in 0..<MapleIdCacheStore.stageFlushThreshold {
            await store.stage(path: "\(index).dng", mapleId: "01\(index)", size: 1, mtime: 1)
        }

        let reopened = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        let last = MapleIdCacheStore.stageFlushThreshold - 1
        let hit = await reopened.lookup(path: "\(last).dng", size: 1, mtime: 1)
        XCTAssertEqual(hit, "01\(last)")
    }

    func testStagedRowReachesDiskAfterTheFlushDelay() async throws {
        let store = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        await store.stage(path: "a.dng", mapleId: "01aa", size: 1, mtime: 1)
        try await Task.sleep(for: MapleIdCacheStore.stageFlushDelay * 4)

        let reopened = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        let hit = await reopened.lookup(path: "a.dng", size: 1, mtime: 1)
        XCTAssertEqual(hit, "01aa")
    }

    func testRowStagedBeforeFirstLookupStaysVisibleAfterFlush() async {
        let store = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        await store.stage(path: "a.dng", mapleId: "01aa", size: 1, mtime: 1)
        await store.flush()
        let hit = await store.lookup(path: "a.dng", size: 1, mtime: 1)
        XCTAssertEqual(hit, "01aa")
    }

    func testFlushWithNothingStagedWritesNothing() async {
        let store = MapleIdCacheStore(folderURL: tmpDir, writer: "apple")
        await store.flush()
        XCTAssertFalse(FileManager.default.fileExists(atPath: ownFile.path))
    }
}
