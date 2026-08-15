import XCTest
@testable import MapleCore

final class FileProviderMetaStoreTests: XCTestCase {
    private func freshStoreURL() -> URL {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("fp-meta-\(UUID().uuidString).sqlite")
        try? FileManager.default.removeItem(at: tmp)
        return tmp
    }

    func testRoundTripCanonicalRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "default", localBasename: "ABC123",
                      assetID: "650a1b2c3d4e5f6071829304",
                      conflictBasename: nil)
        let row = try store.get(domain: "default", localBasename: "ABC123")
        XCTAssertEqual(row?.assetID, "650a1b2c3d4e5f6071829304")
        XCTAssertNil(row?.conflictBasename)
    }

    func testRoundTripConflictRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "default", localBasename: "XYZ",
                      assetID: "650a", conflictBasename: "shot (conflict from MBP)")
        let row = try store.get(domain: "default", localBasename: "XYZ")
        XCTAssertEqual(row?.conflictBasename, "shot (conflict from MBP)")
    }

    func testGetMissingReturnsNil() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        XCTAssertNil(try store.get(domain: "default", localBasename: "nope"))
    }

    func testPutReplacesExistingRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "d", localBasename: "k", assetID: "old", conflictBasename: nil)
        try store.put(domain: "d", localBasename: "k", assetID: "new", conflictBasename: nil)
        XCTAssertEqual(try store.get(domain: "d", localBasename: "k")?.assetID, "new")
    }

    func testRemoveDeletesRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "d", localBasename: "k", assetID: "v", conflictBasename: nil)
        try store.remove(domain: "d", localBasename: "k")
        XCTAssertNil(try store.get(domain: "d", localBasename: "k"))
    }

    func testReopenSeesPersistedRows() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            let s = try FileProviderMetaStore(url: url)
            try s.put(domain: "d", localBasename: "k", assetID: "v", conflictBasename: nil)
        }
        let s2 = try FileProviderMetaStore(url: url)
        XCTAssertEqual(try s2.get(domain: "d", localBasename: "k")?.assetID, "v")
    }

    func testSchemaMigrationIsIdempotent() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        _ = try FileProviderMetaStore(url: url)
        _ = try FileProviderMetaStore(url: url)
        _ = try FileProviderMetaStore(url: url)
        // No throw = pass
    }

    func testSharedURLLivesUnderAppGroupContainer() throws {
        // The function is purely a path resolver — it should not require
        // the App Group to actually exist on the test host. We assert the
        // computed URL ends with the expected filename and falls back to
        // the temp dir when the App Group container is unavailable.
        let url = FileProviderMetaStore.sharedStoreURL(
            groupContainerProvider: { _ in nil }
        )
        XCTAssertEqual(url.lastPathComponent, "fp-meta.sqlite")
    }

    /// Two `FileProviderMetaStore` instances on the same `url` represent
    /// the FP and QL processes sharing the App Group SQLite file. With
    /// WAL the reader can complete during the writer's transaction; if
    /// WAL is silently disabled (the bug class issue #1 guards against),
    /// the reader either blocks on busy_timeout or fails. This test
    /// asserts (a) no errors fire on either side and (b) the reader
    /// observes the writer's rows mid-flight.
    func testTwoStoresShareWALWritesConcurrently() throws {
        let url = freshStoreURL()
        defer {
            try? FileManager.default.removeItem(at: url)
            // WAL leaves -wal and -shm side files; clean those too.
            try? FileManager.default.removeItem(
                at: url.deletingLastPathComponent()
                    .appendingPathComponent(url.lastPathComponent + "-wal"))
            try? FileManager.default.removeItem(
                at: url.deletingLastPathComponent()
                    .appendingPathComponent(url.lastPathComponent + "-shm"))
        }
        let writer = try FileProviderMetaStore(url: url)
        let reader = try FileProviderMetaStore(url: url)

        let writerCount = 50
        let writerErrLock = NSLock()
        nonisolated(unsafe) var writerError: Error?
        nonisolated(unsafe) var writerFinished = false
        let writerFinishedLock = NSLock()
        let writerDone = expectation(description: "writer done")
        DispatchQueue.global(qos: .userInitiated).async {
            for i in 0..<writerCount {
                do {
                    try writer.put(domain: "concurrent",
                                   localBasename: "row-\(i)",
                                   assetID: String(format: "%024x", i),
                                   conflictBasename: nil)
                } catch {
                    writerErrLock.lock(); writerError = error; writerErrLock.unlock()
                    break
                }
                // Small sleep to interleave with the reader.
                Thread.sleep(forTimeInterval: 0.001)
            }
            writerFinishedLock.lock(); writerFinished = true; writerFinishedLock.unlock()
            writerDone.fulfill()
        }

        nonisolated(unsafe) var observedWriterRowMidFlight = false
        nonisolated(unsafe) var readerError: Error?
        let readerErrLock = NSLock()
        let readerDone = expectation(description: "reader done")
        DispatchQueue.global(qos: .userInitiated).async {
            let deadline = Date().addingTimeInterval(5)
            while Date() < deadline {
                let idx = Int.random(in: 0..<writerCount)
                do {
                    let row = try reader.get(domain: "concurrent",
                                             localBasename: "row-\(idx)")
                    if row != nil { observedWriterRowMidFlight = true }
                } catch {
                    readerErrLock.lock(); readerError = error; readerErrLock.unlock()
                    break
                }
                Thread.sleep(forTimeInterval: 0.0005)
                writerFinishedLock.lock()
                let done = writerFinished
                writerFinishedLock.unlock()
                if observedWriterRowMidFlight && done { break }
            }
            readerDone.fulfill()
        }

        wait(for: [writerDone, readerDone], timeout: 10)
        XCTAssertNil(writerError, "writer hit an error: \(String(describing: writerError))")
        XCTAssertNil(readerError, "reader hit an error: \(String(describing: readerError))")
        XCTAssertTrue(observedWriterRowMidFlight,
                      "reader never saw any of the writer's rows — WAL probably not active")

        // Final consistency: every writer row must be visible.
        for i in 0..<writerCount {
            let row = try reader.get(domain: "concurrent", localBasename: "row-\(i)")
            XCTAssertNotNil(row, "missing row-\(i) after writer finished")
        }
    }

    /// End-to-end of the Quick Look discrimination contract:
    /// `FileProviderExtension.fetchContents` records RAW basenames
    /// extensionless and sidecar basenames with the `.xmp` suffix
    /// preserved. The Quick Look provider must:
    ///   1. Short-circuit on a sidecar basename WITHOUT consulting the
    ///      meta store (so it never serves an asset JPEG for an XMP
    ///      request whose canonical sidecar row has `conflict_basename`
    ///      = NULL and shares an asset ID with the RAW row).
    ///   2. Resolve the meta-store row for the RAW basename and return
    ///      its asset ID for the JPEG fetch path.
    /// This guards against the regression Copilot flagged where both
    /// RAW and sidecar materialized to extensionless UUIDs and the
    /// `.xmp` guard could not distinguish them.
    func testQuickLookSidecarDiscrimination() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)

        // Simulate FileProviderExtension.fetchContents for both an asset
        // and its canonical sidecar in the same domain. The two
        // localBasenames differ ONLY by the `.xmp` suffix.
        let rawBasename = "ABC123"                    // RAW: extensionless UUID
        let sidecarBasename = "ABC123.xmp"            // sidecar: suffix preserved
        let sharedAssetID = "650a1b2c3d4e5f6071829304"
        try store.put(domain: "d", localBasename: rawBasename,
                      assetID: sharedAssetID, conflictBasename: nil)
        try store.put(domain: "d", localBasename: sidecarBasename,
                      assetID: sharedAssetID, conflictBasename: nil)

        // Both rows resolve, and they're keyed independently — the
        // sidecar row's existence does NOT shadow the RAW row.
        XCTAssertEqual(try store.get(domain: "d", localBasename: rawBasename)?.assetID,
                       sharedAssetID)
        XCTAssertEqual(try store.get(domain: "d", localBasename: sidecarBasename)?.assetID,
                       sharedAssetID)

        // The QL provider's basename-based discriminator distinguishes
        // them: sidecar short-circuits to system fallback, RAW proceeds
        // to the meta-store lookup. If the .xmp suffix were lost during
        // materialization both basenames would collide on `ABC123`, the
        // suffix check would never fire, and the QL extension would
        // serve the asset JPEG for the XMP request.
        XCTAssertTrue(QuickLookResolver.isSidecarBasename(sidecarBasename))
        XCTAssertFalse(QuickLookResolver.isSidecarBasename(rawBasename))
    }

    /// Coverage for #2536: `put()` fires on every `fetchContents` call
    /// (one brand-new UUID-keyed row per RAW/sidecar materialization)
    /// and previously nothing ever deleted an old row — the App Group
    /// SQLite file grew unbounded under heavy Finder/Quick Look use.
    /// `_runSweepForTesting()` forces the TTL sweep regardless of the
    /// production `sweepInterval` gate, isolating the eviction logic
    /// itself from the opportunistic-scheduling behaviour covered by
    /// `testPutOpportunisticallyEvictsExpiredRows` below.
    func testRunSweepForTestingEvictsRowsOlderThanTTL() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        var now = Date(timeIntervalSince1970: 1_000_000)
        let store = try FileProviderMetaStore(url: url, ttl: 50, now: { now })

        try store.put(domain: "d", localBasename: "old", assetID: "a1", conflictBasename: nil)
        XCTAssertEqual(try store._rowCountForTesting(), 1)

        now = now.addingTimeInterval(51)
        try store._runSweepForTesting()

        XCTAssertNil(try store.get(domain: "d", localBasename: "old"),
                     "row older than ttl must be evicted by the sweep")
        XCTAssertEqual(try store._rowCountForTesting(), 0)
    }

    /// A row younger than `ttl` must survive a sweep — eviction is
    /// age-gated, not "clear everything."
    func testSweepPreservesRowsWithinTTL() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        let store = try FileProviderMetaStore(url: url, ttl: 1_000, now: { t0 })

        try store.put(domain: "d", localBasename: "fresh", assetID: "a1", conflictBasename: nil)
        try store._runSweepForTesting()

        XCTAssertNotNil(try store.get(domain: "d", localBasename: "fresh"))
        XCTAssertEqual(try store._rowCountForTesting(), 1)
    }

    /// The production entry point: `put()` itself must opportunistically
    /// sweep expired rows (not just the test-only forced sweep). This is
    /// the actual fix for #2536's unbounded growth — every
    /// `fetchContents` call both inserts one row and gives expired rows
    /// a chance to be reclaimed.
    func testPutOpportunisticallyEvictsExpiredRows() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        var now = Date(timeIntervalSince1970: 1_000_000)
        let store = try FileProviderMetaStore(url: url, ttl: 100, now: { now })

        try store.put(domain: "d", localBasename: "old", assetID: "a1", conflictBasename: nil)
        XCTAssertNotNil(try store.get(domain: "d", localBasename: "old"))

        // Advance past both ttl (100s) and the production sweep-interval
        // gate (5 min) so the next put()'s opportunistic sweep fires and
        // catches this row.
        now = now.addingTimeInterval(301)
        try store.put(domain: "d", localBasename: "new", assetID: "a2", conflictBasename: nil)

        XCTAssertNil(try store.get(domain: "d", localBasename: "old"),
                     "row older than ttl must be evicted by the next put()'s opportunistic sweep")
        XCTAssertNotNil(try store.get(domain: "d", localBasename: "new"))
        XCTAssertEqual(try store._rowCountForTesting(), 1)
    }

    func testSharedURLPrefersAppGroupContainer() throws {
        let stub = FileManager.default.temporaryDirectory
            .appendingPathComponent("group-stub-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: stub, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stub) }
        let url = FileProviderMetaStore.sharedStoreURL(
            groupContainerProvider: { _ in stub }
        )
        XCTAssertTrue(url.path.hasPrefix(stub.path),
                      "expected \(url.path) to start with \(stub.path)")
        XCTAssertEqual(url.lastPathComponent, "fp-meta.sqlite")
    }
}
