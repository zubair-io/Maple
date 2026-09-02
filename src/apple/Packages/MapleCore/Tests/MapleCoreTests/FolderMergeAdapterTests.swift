// FolderMergeAdapterTests.swift — #2274 (unified Timeline Phase 2).
//
// Real temp folders, real `FilesystemSource` opens, an isolated
// `UserDefaults(suiteName:)` standing in for `SavedFolderStore`'s real
// `.standard` list (via `FolderMergeAdapter`'s injectable `defaults:`
// parameter — the same seam `SavedFolderStore.load(from:)` itself already
// exposes, threaded one level up specifically so this adapter is testable
// without touching the developer machine's actual saved-folders list).
//
// Deterministic captureDate coverage seeds `LibraryIndexStore` directly
// (matching `syncFingerprintCache`'s freshness contract: entry present,
// size/mtime unchanged, `dateTimeOriginal` non-nil) rather than stubbing a
// fingerprint provider — `FolderMergeAdapter.rebuild()` constructs its own
// `FilesystemSource` instances internally, so there's no seam to inject a
// stub provider into them the way `FilesystemSourceCaptureDateTests` can
// for a directly-constructed source. Real EXIF-string-to-captureDate
// wiring itself is that file's job, not this one's.

import XCTest
@testable import MapleCore

@MainActor
final class FolderMergeAdapterTests: XCTestCase {
    private var tmpDirs: [URL] = []
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUpWithError() throws {
        suiteName = "FolderMergeAdapterTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDownWithError() throws {
        for url in tmpDirs { try? FileManager.default.removeItem(at: url) }
        tmpDirs = []
        defaults.removePersistentDomain(forName: suiteName)
    }

    // MARK: - Helpers

    private func makeFolder(fileNames: [String]) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("FolderMergeAdapterTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        tmpDirs.append(url)
        for name in fileNames {
            try Data("pixels".utf8).write(to: url.appendingPathComponent(name))
        }
        return url
    }

    /// Seeds `folderURL`'s `.maple/index.json` so `syncFingerprintCache`'s
    /// freshness check skips re-reading EXIF for `fileName` and keeps the
    /// `dateTimeOriginal` seeded here — see the file header.
    private func seedCaptureDate(
        _ dateTimeOriginal: String, forFileNamed fileName: String, in folderURL: URL
    ) async throws {
        let fileURL = folderURL.appendingPathComponent(fileName)
        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attrs[.size] as? NSNumber)?.int64Value
        let mtime = attrs[.modificationDate] as? Date
        let indexStore = LibraryIndexStore(folderURL: folderURL)
        try await indexStore.updateFingerprints([
            LibraryIndexStore.FingerprintUpdate(
                name: fileName, size: size, mtime: mtime,
                dateTimeOriginal: dateTimeOriginal, cameraSerial: nil),
        ])
    }

    private func registerSavedFolder(at url: URL, displayName: String) throws {
        let bookmark = try url.bookmarkData(
            options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
        SavedFolderStore.upsert(
            SavedFolder(path: url.path, displayName: displayName, bookmark: bookmark, lastOpened: Date()),
            into: defaults)
    }

    // MARK: - Aggregation across folders

    func testWarmUpBucketsAssetsByTheirCachedCaptureDate() async throws {
        let folder = try makeFolder(fileNames: ["IMG_1.dng"])
        try await seedCaptureDate("2026:03:15 10:00:00", forFileNamed: "IMG_1.dng", in: folder)
        try registerSavedFolder(at: folder, displayName: "A")

        let adapter = FolderMergeAdapter(defaults: defaults)
        await adapter.warmUp()

        let refs = adapter.assetsForMonth(year: 2026, month: 3)
        XCTAssertEqual(refs.map(\.displayName), ["IMG_1"])
        XCTAssertTrue(adapter.hasFreshData)
    }

    /// Two DIFFERENT saved folders both contributing to the SAME month —
    /// `localBuckets()` sums them (folders are mutually disjoint on-disk
    /// locations, so summing — not maxing — is correct; see
    /// `FolderMergeAdapter.localBuckets`'s doc comment).
    func testLocalBucketsSumsAcrossMultipleFolders() async throws {
        let folderA = try makeFolder(fileNames: ["IMG_1.dng", "IMG_2.dng"])
        try await seedCaptureDate("2026:03:01 09:00:00", forFileNamed: "IMG_1.dng", in: folderA)
        try await seedCaptureDate("2026:03:02 09:00:00", forFileNamed: "IMG_2.dng", in: folderA)
        try registerSavedFolder(at: folderA, displayName: "A")

        let folderB = try makeFolder(fileNames: ["IMG_3.dng"])
        try await seedCaptureDate("2026:03:03 09:00:00", forFileNamed: "IMG_3.dng", in: folderB)
        try registerSavedFolder(at: folderB, displayName: "B")

        let adapter = FolderMergeAdapter(defaults: defaults)
        await adapter.warmUp()

        let march = adapter.localBuckets().first { $0.key == FolderMergeAdapter.BucketKey(year: 2026, month: 3) }
        XCTAssertEqual(march?.count, 3, "2 (folder A) + 1 (folder B) = 3")

        let refs = adapter.assetsForMonth(year: 2026, month: 3)
        XCTAssertEqual(Set(refs.map(\.displayName)), ["IMG_1", "IMG_2", "IMG_3"])
    }

    /// An asset with no cached capture date yet buckets under the CURRENT
    /// (year, month) rather than vanishing — same "unknown date still
    /// shows up somewhere" fallback `PhotoKitMergeAdapter.buildFromPhotoKit`
    /// uses for a PHAsset with no `creationDate`.
    func testAssetWithNoCachedCaptureDateBucketsUnderNow() async throws {
        let folder = try makeFolder(fileNames: ["IMG_NODATE.dng"])
        try registerSavedFolder(at: folder, displayName: "A")

        let adapter = FolderMergeAdapter(defaults: defaults)
        await adapter.warmUp()

        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let comps = cal.dateComponents([.year, .month], from: Date())
        let refs = adapter.assetsForMonth(year: comps.year!, month: comps.month!)
        XCTAssertEqual(refs.map(\.displayName), ["IMG_NODATE"])
    }

    // MARK: - Resilience

    /// A folder whose bookmark can't be resolved (stale/revoked) is
    /// skipped — the rest of the saved folders still warm up normally.
    func testAStaleBookmarkedFolderIsSkippedWithoutBreakingOthers() async throws {
        let goodFolder = try makeFolder(fileNames: ["IMG_1.dng"])
        try await seedCaptureDate("2026:03:15 10:00:00", forFileNamed: "IMG_1.dng", in: goodFolder)
        try registerSavedFolder(at: goodFolder, displayName: "Good")

        // Garbage bookmark data — resolution must throw, and `rebuild()`
        // must swallow that and move on to the next folder.
        SavedFolderStore.upsert(
            SavedFolder(path: "/nonexistent", displayName: "Stale",
                       bookmark: Data("not a real bookmark".utf8), lastOpened: Date()),
            into: defaults)

        let adapter = FolderMergeAdapter(defaults: defaults)
        await adapter.warmUp()

        XCTAssertEqual(adapter.assetsForMonth(year: 2026, month: 3).map(\.displayName), ["IMG_1"])
    }

    func testNoSavedFoldersProducesEmptyCacheNoCrash() async {
        let adapter = FolderMergeAdapter(defaults: defaults)
        await adapter.warmUp()

        XCTAssertTrue(adapter.localBuckets().isEmpty)
        XCTAssertTrue(adapter.hasFreshData)
    }

    // MARK: - Invalidate

    func testInvalidateClearsTheCache() async throws {
        let folder = try makeFolder(fileNames: ["IMG_1.dng"])
        try await seedCaptureDate("2026:03:15 10:00:00", forFileNamed: "IMG_1.dng", in: folder)
        try registerSavedFolder(at: folder, displayName: "A")

        let adapter = FolderMergeAdapter(defaults: defaults)
        await adapter.warmUp()
        XCTAssertFalse(adapter.assetsForMonth(year: 2026, month: 3).isEmpty)

        adapter.invalidate()
        XCTAssertTrue(adapter.assetsForMonth(year: 2026, month: 3).isEmpty)
        XCTAssertFalse(adapter.hasFreshData)
    }

    /// `invalidate()` called while a `warmUp()` rebuild is still in flight
    /// (Copilot review, PR #3187) must WIN: the rebuild's `Task.isCancelled`
    /// guard has to stop it from swapping fresh `buckets`/`sources` back in
    /// after the caller already asked for a clean reset, and `invalidate()`
    /// itself has to cancel that rebuild's `warmTask` rather than leaving it
    /// to finish unobserved. Several real saved folders (each a genuine
    /// bookmark-resolve + directory-listing async hop, unlike an in-memory
    /// stub) widen the window between `warmUp()` starting and finishing —
    /// there's no injectable delay seam on this adapter to pin the race
    /// exactly, so this leans on that natural I/O latency plus a `yield()`
    /// to give the rebuild task a real chance to be in flight, the same
    /// spirit as `LibraryRootCacheTests`' "slow fetcher" races.
    func testInvalidateDuringInFlightWarmUpDiscardsTheRebuild() async throws {
        for i in 0..<5 {
            let folder = try makeFolder(fileNames: ["IMG_\(i).dng"])
            try await seedCaptureDate("2026:03:0\(i + 1) 09:00:00", forFileNamed: "IMG_\(i).dng", in: folder)
            try registerSavedFolder(at: folder, displayName: "Folder\(i)")
        }

        let adapter = FolderMergeAdapter(defaults: defaults)
        let warmUpTask = Task { await adapter.warmUp() }
        await Task.yield()
        await Task.yield()
        adapter.invalidate()
        await warmUpTask.value

        XCTAssertTrue(
            adapter.assetsForMonth(year: 2026, month: 3).isEmpty,
            "a rebuild cancelled mid-flight must not repopulate state invalidate() already cleared")
        XCTAssertTrue(adapter.localBuckets().isEmpty)
        XCTAssertFalse(adapter.hasFreshData)
    }

    // MARK: - Observer hook

    func testAddOnWarmedUpFiresAfterWarmUp() async {
        let adapter = FolderMergeAdapter(defaults: defaults)
        var fired = 0
        _ = adapter.addOnWarmedUp { fired += 1 }
        await adapter.warmUp()
        XCTAssertEqual(fired, 1)
    }

    func testRemoveOnWarmedUpDroppedObserverDoesNotFire() async {
        let adapter = FolderMergeAdapter(defaults: defaults)
        var fired = 0
        let token = adapter.addOnWarmedUp { fired += 1 }
        adapter.removeOnWarmedUp(token)
        await adapter.warmUp()
        XCTAssertEqual(fired, 0)
    }

    // MARK: - warmUp coalescing

    func testWarmUpIsIdempotentAcrossConcurrentCallers() async {
        let adapter = FolderMergeAdapter(defaults: defaults)
        var fired = 0
        _ = adapter.addOnWarmedUp { fired += 1 }
        async let a: Void = adapter.warmUp()
        async let b: Void = adapter.warmUp()
        _ = await (a, b)
        XCTAssertEqual(fired, 1, "concurrent warmUp() must share one rebuild + one observer fire")
    }
}
