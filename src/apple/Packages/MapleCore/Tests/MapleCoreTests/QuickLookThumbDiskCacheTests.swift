// src/apple/Packages/MapleCore/Tests/MapleCoreTests/QuickLookThumbDiskCacheTests.swift
//
// Tests for QuickLookThumbDiskCache (Phase 6 item 4). Every test
// creates a tmp dir + a fresh `UserDefaults(suiteName:)` instance so
// the real App Group container is never touched.
import XCTest
@testable import MapleCore

final class QuickLookThumbDiskCacheTests: XCTestCase {

    // MARK: - Test rig

    private func makeTmpDir(_ name: String = UUID().uuidString) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("QuickLookThumbDiskCacheTests-\(name)", isDirectory: true)
        try? FileManager.default.removeItem(at: url)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func makeDefaults(_ name: String = UUID().uuidString) -> UserDefaults {
        let suite = "QuickLookThumbDiskCacheTests-\(name)"
        let d = UserDefaults(suiteName: suite)!
        d.removePersistentDomain(forName: suite)
        return d
    }

    private func makeCache(
        container: URL? = nil,
        defaults: UserDefaults? = nil,
        ttl: TimeInterval = 7 * 24 * 60 * 60,
        sizeCap: Int64 = 200 * 1024 * 1024,
        etagDictCap: Int = 1024
    ) throws -> QuickLookThumbDiskCache {
        let dir = try container ?? makeTmpDir()
        let defs = defaults ?? makeDefaults()
        return QuickLookThumbDiskCache(
            containerURL: dir,
            defaults: defs,
            ttl: ttl,
            sizeCap: sizeCap,
            etagDictCap: etagDictCap
        )
    }

    /// Records how many times the fetch closure is invoked and the
    /// `If-None-Match` value it received.
    private actor FetchRecorder {
        var calls: [String?] = []
        func record(_ ifNoneMatch: String?) { calls.append(ifNoneMatch) }
        func count() -> Int { calls.count }
        func ifNoneMatchAt(_ i: Int) -> String? { calls[i] }
    }

    // MARK: - 1. Cache miss → fetch → write → next read = no second network

    func testCacheMissThenDiskHitOnSecondRead() async throws {
        let container = try makeTmpDir()
        let defaults = makeDefaults()
        let cache = try makeCache(container: container, defaults: defaults)

        let bytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x01])
        let etag = "\"v1\""
        let recorder = FetchRecorder()
        let assetID = "650a1b2c3d4e5f6071829304"

        let fetch: @Sendable (String?) async throws -> RemoteCatalog.ThumbFetchResult = { inm in
            await recorder.record(inm)
            return .ok(data: bytes, etag: etag)
        }

        let first = try await cache.fetch(assetID: assetID, using: fetch)
        XCTAssertEqual(first, bytes)
        let countAfterFirst = await recorder.count()
        XCTAssertEqual(countAfterFirst, 1)
        let inmFirst = await recorder.ifNoneMatchAt(0)
        XCTAssertNil(inmFirst, "first call has no cached ETag — no If-None-Match")

        // Second read: should serve from disk via the 304-revalidation
        // path. The fetch IS called (we still revalidate) — but it
        // gets the ETag back, replies notModified, and the cache reads
        // bytes from disk.
        let fetch2: @Sendable (String?) async throws -> RemoteCatalog.ThumbFetchResult = { inm in
            await recorder.record(inm)
            XCTAssertEqual(inm, etag, "second fetch should send our stored ETag")
            return .notModified
        }
        let second = try await cache.fetch(assetID: assetID, using: fetch2)
        XCTAssertEqual(second, bytes)

        // The disk file must exist. We don't poke at internal hashing —
        // just verify one .avif landed for that assetID.
        let entryCount = await cache._entryCountForTesting()
        XCTAssertEqual(entryCount, 1)
    }

    // MARK: - 2. Disk hit + matching ETag → returns bytes without re-decoding

    func testDiskHitWith304PreservesBytes() async throws {
        let container = try makeTmpDir()
        let cache = try makeCache(container: container)
        let bytes = Data(repeating: 0xAB, count: 4096)
        let etag = "\"abc\""
        let id = "deadbeefdeadbeefdeadbeef"

        // Seed.
        _ = try await cache.fetch(assetID: id) { _ in .ok(data: bytes, etag: etag) }

        // Second hit returns notModified — fetch must NOT supply new bytes.
        let got = try await cache.fetch(assetID: id) { inm in
            XCTAssertEqual(inm, etag)
            return .notModified
        }
        XCTAssertEqual(got, bytes)
    }

    // MARK: - 3. ETag changes → new file written; old file orphaned/evictable

    func testNewETagCreatesNewEntryAndOrphansOld() async throws {
        let container = try makeTmpDir()
        let cache = try makeCache(container: container)
        let id = "abcdef0123456789abcdef01"
        let v1 = Data([0x01, 0x02])
        let v2 = Data([0x03, 0x04, 0x05])

        _ = try await cache.fetch(assetID: id) { _ in .ok(data: v1, etag: "\"v1\"") }
        let countV1 = await cache._entryCountForTesting()
        XCTAssertEqual(countV1, 1)

        // Server replies with new etag + new bytes — the disk cache must
        // write a new file (so the old key stays valid for any concurrent
        // reader) and update the pointer.
        let got = try await cache.fetch(assetID: id) { inm in
            XCTAssertEqual(inm, "\"v1\"")
            return .ok(data: v2, etag: "\"v2\"")
        }
        XCTAssertEqual(got, v2)
        let countV2 = await cache._entryCountForTesting()
        XCTAssertEqual(countV2, 2, "old v1 file stays as an orphan until sweep evicts it")

        // The pointer now resolves to v2 — next read sends "v2" as If-None-Match.
        var observedINM: String?
        _ = try await cache.fetch(assetID: id) { inm in
            observedINM = inm
            return .notModified
        }
        XCTAssertEqual(observedINM, "\"v2\"")
    }

    // MARK: - 4. TTL > 7 days → evicted on next sweep

    func testTTLEvictionOnSweep() async throws {
        let container = try makeTmpDir()
        // Short TTL so the test doesn't have to time-travel files.
        let cache = try makeCache(container: container, ttl: 0.01)
        let id = "aaaaaaaaaaaaaaaaaaaaaaaa"
        _ = try await cache.fetch(assetID: id) { _ in .ok(data: Data([0x10]), etag: "\"a\"") }
        let preCount = await cache._entryCountForTesting()
        XCTAssertEqual(preCount, 1)

        // Wait past TTL.
        try await Task.sleep(nanoseconds: 50_000_000)

        await cache._runSweepForTesting()
        let postCount = await cache._entryCountForTesting()
        XCTAssertEqual(postCount, 0, "ttl sweep should have unlinked the stale entry")
    }

    // MARK: - 5. Size cap → oldest-by-mtime evicted on write

    func testSizeCapEvictsOldestByMtime() async throws {
        let container = try makeTmpDir()
        // Cap small enough that 2 entries fit but 3 don't.
        let payload = Data(repeating: 0xCD, count: 1024) // 1 KiB
        let cache = try makeCache(container: container, sizeCap: 2 * 1024 + 256)

        // Write three entries in order, each with a distinct assetID +
        // etag pair. Use tiny sleeps to make the mtime ordering
        // deterministic (filesystems usually have ≥ ms resolution).
        let ids = [
            "111111111111111111111111",
            "222222222222222222222222",
            "333333333333333333333333",
        ]
        for (i, id) in ids.enumerated() {
            _ = try await cache.fetch(assetID: id) { _ in
                .ok(data: payload, etag: "\"e\(i)\"")
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        // After writing the third, the cap was exceeded — the first
        // (oldest mtime) should have been evicted.
        let count = await cache._entryCountForTesting()
        XCTAssertLessThanOrEqual(count, 2, "size cap should hold us to ≤ 2 entries")

        let total = await cache._totalSizeForTesting()
        XCTAssertLessThanOrEqual(total, 2 * 1024 + 256,
                                 "total bytes must respect the cap")
    }

    // MARK: - 5b. Overwrite with same etag → no spurious eviction of OTHER entries

    func testSameETagOverwriteDoesNotEvictOtherEntries() async throws {
        let container = try makeTmpDir()
        // Cap fits exactly two 1 KiB payloads with a tiny slack. If the
        // overwrite path double-counts the existing file's bytes, the
        // sweep will think `current + incoming` (2048 + 1024 = 3072)
        // exceeds the cap (2304) and evict the OTHER (newer) entry to
        // make room.
        let payload = Data(repeating: 0xCD, count: 1024)
        let cap: Int64 = 2 * 1024 + 256
        let cache = try makeCache(container: container, sizeCap: cap)

        let idA = "aaaaaaaaaaaaaaaaaaaaaaa1"
        let idB = "bbbbbbbbbbbbbbbbbbbbbbb2"
        let etagA = "\"stableA\""
        let etagB = "\"stableB\""

        // Seed B first, then A — so B is the oldest-by-mtime entry.
        // We're going to refresh A and ensure B (the unrelated, older
        // entry) survives.
        _ = try await cache.fetch(assetID: idB) { _ in .ok(data: payload, etag: etagB) }
        try await Task.sleep(nanoseconds: 20_000_000)
        _ = try await cache.fetch(assetID: idA) { _ in .ok(data: payload, etag: etagA) }
        let countAfterSeed = await cache._entryCountForTesting()
        XCTAssertEqual(countAfterSeed, 2)

        // Server replies 200 to A with the SAME etag — the cache
        // refreshes A's disk file. With double-counting, the eviction
        // sweep treats us as 3072 bytes vs a 2304 cap and evicts the
        // oldest-by-mtime entry — that's B, which is completely
        // unrelated to the write we just made.
        _ = try await cache.fetch(assetID: idA) { inm in
            XCTAssertEqual(inm, etagA)
            return .ok(data: payload, etag: etagA)
        }
        let countAfterRefresh = await cache._entryCountForTesting()
        XCTAssertEqual(countAfterRefresh, 2,
                       "same-etag refresh of A must not evict B")

        let total = await cache._totalSizeForTesting()
        XCTAssertEqual(total, 2 * 1024)
    }

    // MARK: - 6. lastKnownETag dict cap → FIFO eviction

    func testETagDictFIFOEviction() async throws {
        let container = try makeTmpDir()
        let defaults = makeDefaults()
        let cap = 3
        let cache = try makeCache(container: container, defaults: defaults, etagDictCap: cap)

        let ids = [
            "aaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbb",
            "cccccccccccccccccccccccc",
            "dddddddddddddddddddddddd",
        ]
        for (i, id) in ids.enumerated() {
            _ = try await cache.fetch(assetID: id) { _ in
                .ok(data: Data([UInt8(i)]), etag: "\"e\(i)\"")
            }
        }

        let dictCount = await cache._etagDictCountForTesting()
        XCTAssertEqual(dictCount, cap, "dict must respect cap=\(cap)")

        // The OLDEST (first inserted) entry should be gone — its pointer
        // is missing, so a subsequent fetch sends no If-None-Match.
        var observedINM: String? = "sentinel"
        _ = try await cache.fetch(assetID: ids[0]) { inm in
            observedINM = inm
            return .ok(data: Data([0xFF]), etag: "\"e0-new\"")
        }
        XCTAssertNil(observedINM,
                     "the oldest ID's pointer should have been FIFO-evicted")
    }

    // MARK: - 7. assetID shape validation rejects path-traversal

    func testFetchRejectsPathTraversalAssetID() async throws {
        let container = try makeTmpDir()
        let cache = try makeCache(container: container)
        do {
            _ = try await cache.fetch(assetID: "../../etc/passwd") { _ in
                XCTFail("fetch closure must not run for invalid assetID")
                return .ok(data: Data(), etag: nil)
            }
            XCTFail("expected InvalidAssetIDError")
        } catch let err as InvalidAssetIDError {
            XCTAssertEqual(err.assetID, "../../etc/passwd")
        }
    }

    func testFetchRejectsSlashInAssetID() async throws {
        let container = try makeTmpDir()
        let cache = try makeCache(container: container)
        do {
            _ = try await cache.fetch(assetID: "foo/bar") { _ in
                XCTFail("fetch closure must not run for invalid assetID")
                return .ok(data: Data(), etag: nil)
            }
            XCTFail("expected InvalidAssetIDError")
        } catch let err as InvalidAssetIDError {
            XCTAssertEqual(err.assetID, "foo/bar")
        }
    }

    func testFetchRejectsTooShortAssetID() async throws {
        let container = try makeTmpDir()
        let cache = try makeCache(container: container)
        do {
            _ = try await cache.fetch(assetID: "abc") { _ in
                XCTFail("fetch closure must not run for invalid assetID")
                return .ok(data: Data(), etag: nil)
            }
            XCTFail("expected InvalidAssetIDError")
        } catch let err as InvalidAssetIDError {
            XCTAssertEqual(err.assetID, "abc")
        }
    }

    // MARK: - 7b. Oversize response bypasses size cap entirely

    /// A response body strictly larger than `sizeCap` must NOT be
    /// written to disk. Under the old behaviour, eviction would wipe
    /// every other entry trying to make room and then write the
    /// oversize file, leaving the cache permanently over its
    /// documented hard cap. Bytes are still returned to the caller.
    func testOversizeResponseSkipsCaching() async throws {
        let container = try makeTmpDir()
        // 1 KiB cap, 2 KiB payload — payload alone exceeds the cap.
        let cap: Int64 = 1024
        let cache = try makeCache(container: container, sizeCap: cap)

        // Seed with a small entry that should NOT be evicted by the
        // oversize write.
        let small = Data(repeating: 0x11, count: 256)
        let smallID = "ffffffffffffffffffffffff"
        _ = try await cache.fetch(assetID: smallID) { _ in .ok(data: small, etag: "\"small\"") }
        let preCount = await cache._entryCountForTesting()
        XCTAssertEqual(preCount, 1)

        // Oversize response — 2 KiB body against 1 KiB cap.
        let bigPayload = Data(repeating: 0x22, count: 2 * 1024)
        let bigID = "abcdef0123456789abcdef02"
        let got = try await cache.fetch(assetID: bigID) { _ in
            .ok(data: bigPayload, etag: "\"big\"")
        }
        XCTAssertEqual(got, bigPayload, "caller still receives the bytes")

        // The oversize entry must not be on disk; the small entry must survive.
        let postCount = await cache._entryCountForTesting()
        XCTAssertEqual(postCount, 1,
                       "oversize response must not land on disk; small entry must survive")
        let total = await cache._totalSizeForTesting()
        XCTAssertLessThanOrEqual(total, cap,
                                 "total bytes must respect the cap (was \(total), cap \(cap))")
    }

    // MARK: - 7c. Concurrent ETag pointer writes from two cache instances

    /// Spawns 100 concurrent `fetch` calls with distinct assetIDs from
    /// TWO cache instances on the same directory (simulating two
    /// processes — the host app and the QL extension — sharing the
    /// App Group container). Every pointer must survive the storm —
    /// the previous UserDefaults-dict implementation did
    /// read-modify-write on a single shared blob with no inter-process
    /// coordination, so a concurrent write from the other instance
    /// would clobber the entry just added.
    func testConcurrentETagPointerWritesAllSurvive() async throws {
        let container = try makeTmpDir()
        let defaults = makeDefaults()
        let cacheA = try makeCache(container: container, defaults: defaults)
        let cacheB = try makeCache(container: container, defaults: defaults)

        // 100 distinct assetIDs, each 24 hex chars (Mongo ObjectID shape).
        // Split into two halves so each cache instance writes its own
        // assetIDs — distinct IDs map to distinct pointer files under
        // the per-asset layout, so all 100 must survive.
        var ids: [String] = []
        for i in 0..<100 {
            ids.append(String(format: "%024x", i + 1))
        }

        await withTaskGroup(of: Void.self) { group in
            for (i, id) in ids.enumerated() {
                let cache = (i % 2 == 0) ? cacheA : cacheB
                let etag = "\"e\(i)\""
                let bytes = Data([UInt8(i & 0xFF)])
                group.addTask {
                    _ = try? await cache.fetch(assetID: id) { _ in
                        .ok(data: bytes, etag: etag)
                    }
                }
            }
        }

        // Every pointer must round-trip via the public API: the next
        // fetch call must observe the stored ETag as If-None-Match.
        // We supply bytes on any 200 (in case the pointer is missing
        // and the cache decides to unconditionally refetch) so the
        // outer call doesn't throw — we only care WHICH path it took.
        var observed: Set<String> = []
        for (i, id) in ids.enumerated() {
            let expected = "\"e\(i)\""
            _ = try? await cacheA.fetch(assetID: id) { inm in
                if inm == expected { observed.insert(id) }
                return .ok(data: Data([0xFF]), etag: expected)
            }
        }
        XCTAssertEqual(observed.count, ids.count,
                       "every concurrent pointer write must survive (got \(observed.count)/\(ids.count))")
    }

    // MARK: - 8. No-etag responses pass through without polluting cache

    func testResponseWithoutETagNotCached() async throws {
        let container = try makeTmpDir()
        let cache = try makeCache(container: container)
        let id = "feedfacefeedfacefeedface"
        let bytes = Data([0x99])
        _ = try await cache.fetch(assetID: id) { _ in .ok(data: bytes, etag: nil) }

        let count = await cache._entryCountForTesting()
        XCTAssertEqual(count, 0)
        let dictCount = await cache._etagDictCountForTesting()
        XCTAssertEqual(dictCount, 0)
    }
}
