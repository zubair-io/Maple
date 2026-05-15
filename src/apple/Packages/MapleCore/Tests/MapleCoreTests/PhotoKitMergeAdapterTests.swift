// PhotoKitMergeAdapterTests.swift
//
// Disk-round-trip + invalidate + observer behavior. We can't exercise
// the actual PhotoKit walk in a test environment (PHPhotoLibrary
// authorization isn't grantable from XCTest), so `warmUp()` runs
// against an empty/.notDetermined library and produces empty buckets.
// That's still useful: it lets us assert observers fire once, warmUp
// is idempotent, and the disk-cache load path is wired correctly.

import XCTest
@testable import MapleCore

@MainActor
final class PhotoKitMergeAdapterTests: XCTestCase {

    // MARK: - Helpers

    /// Temp file path the test owns end-to-end. Cleaned up in teardown.
    private func makeTempCacheURL(file: StaticString = #file) -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("PhotoKitMergeAdapterTests-\(UUID()).json")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func sampleRef(_ id: String, year: Int = 2024, month: Int = 3) -> ImageRef {
        var c = DateComponents(); c.year = year; c.month = month; c.day = 15
        c.timeZone = TimeZone(secondsFromGMT: 0)
        return ImageRef(
            id: id,
            displayName: id,
            url: nil,
            captureDate: Calendar(identifier: .gregorian).date(from: c))
    }

    // MARK: - Disk round-trip

    func test_init_loadsFromDiskWhenCachePresent() throws {
        let url = makeTempCacheURL()
        let key = PhotoKitMergeAdapter.BucketKey(year: 2024, month: 3)
        let refs = [sampleRef("P1"), sampleRef("P2")]
        let seed: [PhotoKitMergeAdapter.BucketKey: [ImageRef]] = [key: refs]

        // Write a fixture using the adapter's own encoder, then init from it.
        let data = try PhotoKitMergeAdapter.encodeBuckets(seed)
        try data.write(to: url)

        let adapter = PhotoKitMergeAdapter(diskCacheURL: url)
        let loaded = adapter.assetsForMonth(year: 2024, month: 3)
        XCTAssertEqual(loaded.count, 2)
        XCTAssertEqual(Set(loaded.map(\.id)), Set(["P1", "P2"]))
    }

    func test_init_missingFile_emptyCacheNoError() {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("absent-\(UUID()).json")
        // Don't create the file. Init should silently produce an empty cache.
        let adapter = PhotoKitMergeAdapter(diskCacheURL: url)
        XCTAssertEqual(adapter.assetsForMonth(year: 2024, month: 3).count, 0)
        XCTAssertFalse(adapter.hasFreshData)
    }

    func test_init_corruptFile_emptyCacheNoCrash() throws {
        let url = makeTempCacheURL()
        try Data("not json".utf8).write(to: url)

        let adapter = PhotoKitMergeAdapter(diskCacheURL: url)
        // Adapter should swallow + log; tests just need to confirm no crash
        // and that subsequent reads return empty.
        XCTAssertEqual(adapter.assetsForMonth(year: 2024, month: 3).count, 0)
    }

    func test_init_schemaMismatch_discardsCache() throws {
        let url = makeTempCacheURL()
        // Hand-crafted envelope with a deliberately bogus version. Matches
        // the wire shape (top-level { version, buckets }) so JSON parses,
        // but the version check fails.
        let json = """
        {
          "version": 999,
          "buckets": [{"year": 2024, "month": 3, "refs": []}]
        }
        """
        try Data(json.utf8).write(to: url)

        let adapter = PhotoKitMergeAdapter(diskCacheURL: url)
        XCTAssertEqual(adapter.assetsForMonth(year: 2024, month: 3).count, 0)
    }

    // MARK: - Invalidate

    func test_invalidate_clearsMemoryAndDisk() throws {
        let url = makeTempCacheURL()
        let key = PhotoKitMergeAdapter.BucketKey(year: 2024, month: 3)
        let seed: [PhotoKitMergeAdapter.BucketKey: [ImageRef]] = [key: [sampleRef("P1")]]
        try PhotoKitMergeAdapter.encodeBuckets(seed).write(to: url)

        let adapter = PhotoKitMergeAdapter(diskCacheURL: url)
        XCTAssertEqual(adapter.assetsForMonth(year: 2024, month: 3).count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))

        adapter.invalidate()
        XCTAssertEqual(adapter.assetsForMonth(year: 2024, month: 3).count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertFalse(adapter.hasFreshData)
    }

    // MARK: - Observer hook

    func test_addOnWarmedUp_firesAfterWarmUp() async {
        let adapter = PhotoKitMergeAdapter(diskCacheURL: nil)
        var fired = 0
        _ = adapter.addOnWarmedUp { fired += 1 }
        await adapter.warmUp()
        XCTAssertEqual(fired, 1)
        XCTAssertTrue(adapter.hasFreshData)
    }

    func test_addOnWarmedUp_multipleObservers_allFire() async {
        let adapter = PhotoKitMergeAdapter(diskCacheURL: nil)
        var firedA = 0
        var firedB = 0
        _ = adapter.addOnWarmedUp { firedA += 1 }
        _ = adapter.addOnWarmedUp { firedB += 1 }
        await adapter.warmUp()
        XCTAssertEqual(firedA, 1)
        XCTAssertEqual(firedB, 1)
    }

    func test_removeOnWarmedUp_droppedObserverDoesNotFire() async {
        let adapter = PhotoKitMergeAdapter(diskCacheURL: nil)
        var firedA = 0
        var firedB = 0
        let tokenA = adapter.addOnWarmedUp { firedA += 1 }
        _ = adapter.addOnWarmedUp { firedB += 1 }
        adapter.removeOnWarmedUp(tokenA)
        await adapter.warmUp()
        XCTAssertEqual(firedA, 0, "removed observer must not be called")
        XCTAssertEqual(firedB, 1)
    }

    // MARK: - warmUp coalescing

    func test_warmUp_idempotentAcrossConcurrentCallers() async {
        let adapter = PhotoKitMergeAdapter(diskCacheURL: nil)
        var fired = 0
        _ = adapter.addOnWarmedUp { fired += 1 }
        // Fire two warmUps concurrently; both should resolve without each
        // doing its own rebuild. We can't measure the rebuild count directly
        // (buildFromPhotoKit is private + thread-bound), so the observable
        // signal is: the single observer is called exactly once per
        // distinct warmUp generation, not once per concurrent caller.
        async let a: Void = adapter.warmUp()
        async let b: Void = adapter.warmUp()
        _ = await (a, b)
        XCTAssertEqual(fired, 1, "concurrent warmUp() must share one rebuild + one observer fire")
    }

    func test_warmUp_repeatableAfterCompletion() async {
        let adapter = PhotoKitMergeAdapter(diskCacheURL: nil)
        var fired = 0
        _ = adapter.addOnWarmedUp { fired += 1 }
        await adapter.warmUp()
        await adapter.warmUp()
        XCTAssertEqual(fired, 2, "warmUp() after the prior task completes runs a fresh rebuild")
    }
}
