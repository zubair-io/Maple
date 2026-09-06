import XCTest

@testable import MapleCore

final class MaskRasterStoreTests: XCTestCase {
    private func tempDir() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func testGeneratesOnMissAndCachesToDisk() async throws {
        let store = MaskRasterStore(directory: tempDir())
        var calls = 0
        let (w, h, bytes) = try await store.raster(for: "abc123", model: "test/1") {
            calls += 1
            return (2, 2, [255, 0, 0, 255])
        }
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(w, 2)
        XCTAssertEqual(h, 2)
        XCTAssertEqual(bytes, [255, 0, 0, 255])
        let cachedPath = await store.cachedPath(digest: "abc123")
        XCTAssertTrue(FileManager.default.fileExists(atPath: cachedPath.path))
    }

    func testSecondCallForTheSameDigestDoesNotRegenerate() async throws {
        let store = MaskRasterStore(directory: tempDir())
        var calls = 0
        let gen: () async throws -> (width: Int, height: Int, bytes: [UInt8]) = {
            calls += 1
            return (2, 2, [10, 20, 30, 40])
        }
        _ = try await store.raster(for: "same", model: "test/1", generate: gen)
        _ = try await store.raster(for: "same", model: "test/1", generate: gen)
        XCTAssertEqual(calls, 1)
    }

    func testDifferentDigestsCacheIndependently() async throws {
        let store = MaskRasterStore(directory: tempDir())
        let a = try await store.raster(for: "a", model: "test/1") { (1, 1, [1]) }
        let b = try await store.raster(for: "b", model: "test/1") { (1, 1, [2]) }
        XCTAssertEqual(a.bytes, [1])
        XCTAssertEqual(b.bytes, [2])
    }

    func testAGenerateFailureIsNotCachedAndRetriesOnNextCall() async throws {
        let store = MaskRasterStore(directory: tempDir())
        struct Boom: Error {}
        var calls = 0
        do {
            _ = try await store.raster(for: "flaky", model: "test/1") {
                calls += 1
                throw Boom()
            }
            XCTFail("expected throw")
        } catch is Boom {}
        XCTAssertEqual(calls, 1)
        _ = try? await store.raster(for: "flaky", model: "test/1") {
            calls += 1
            return (1, 1, [255])
        }
        XCTAssertEqual(calls, 2, "a failed generate must not be cached")
    }

    /// Actor reentrancy: two callers missing the cache for the same digest
    /// at the same time must share one generate (#3284 review).
    func testConcurrentMissesForTheSameDigestGenerateOnce() async throws {
        let store = MaskRasterStore(directory: tempDir())
        let counter = Counter()
        let gen: @Sendable () async throws -> (width: Int, height: Int, bytes: [UInt8]) = {
            await counter.bump()
            try await Task.sleep(nanoseconds: 50_000_000)
            return (1, 1, [7])
        }
        async let a = store.raster(for: "shared", model: "test/1", generate: gen)
        async let b = store.raster(for: "shared", model: "test/1", generate: gen)
        let (ra, rb) = try await (a, b)
        XCTAssertEqual(ra.bytes, [7])
        XCTAssertEqual(rb.bytes, [7])
        let calls = await counter.value
        XCTAssertEqual(calls, 1, "the second miss must join the in-flight generate")
    }

    func testNoTempFileIsLeftBesideTheCachedPNG() async throws {
        let dir = tempDir()
        let store = MaskRasterStore(directory: dir)
        _ = try await store.raster(for: "clean", model: "test/1") { (1, 1, [9]) }
        let entries = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        XCTAssertEqual(entries, ["clean.png"])
    }
}

private actor Counter {
    private(set) var value = 0
    func bump() { value += 1 }
}
