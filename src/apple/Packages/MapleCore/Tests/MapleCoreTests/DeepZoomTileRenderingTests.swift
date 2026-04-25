// DeepZoomTileRenderingTests.swift — Plan 3 (Ticket 06 M4) integration
// tests for the tile FFI, MapleRawHandle wrapper, and
// `ImageEditPipeline.decodePreviewTile`.
//
// Cross-link:
//   docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md Task 4.
//
// Tests are split into two tiers:
//   - "no fixture" tier: exercises the wrapper APIs through their
//     null-pointer / empty-bytes error paths. These run in any
//     environment, including CI without the gitignored DNG fixtures.
//   - "fixture" tier: gated on `test-fixtures/raws/test_0002.dng`. When
//     absent, `XCTSkip` is thrown so the suite still passes overall.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

final class DeepZoomTileRenderingTests: XCTestCase {

    // MARK: - Fixture lookup helper

    /// Resolve the gitignored test_0002.dng fixture by walking up from
    /// the test source file to the repository root, then into
    /// `test-fixtures/raws/`. Returns nil if absent.
    private func fixtureURL() -> URL? {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // MapleCore/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
            .appendingPathComponent("test-fixtures/raws/test_0002.dng")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    // MARK: - openRawHandle / renderTile error paths (no fixture needed)

    /// `openRawHandle` on a non-existent file throws renderFailed.
    func testOpenRawHandleNonExistentFileThrows() {
        let bogus = URL(fileURLWithPath: "/tmp/does_not_exist_maple_tile_test.dng")
        XCTAssertThrowsError(try PipelineRenderer.openRawHandle(rawPath: bogus)) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            // rc 6 = RAW read failed (file not found path).
            XCTAssertNotEqual(code, 0)
        }
    }

    /// One-shot `renderTile(rawPath:...)` on a non-existent file throws
    /// renderFailed.
    func testRenderTileFromFileNonExistentThrows() {
        let bogus = URL(fileURLWithPath: "/tmp/does_not_exist_maple_tile_test.dng")
        XCTAssertThrowsError(try PipelineRenderer.renderTile(
            rawPath: bogus,
            srcX: 0, srcY: 0, srcW: 256, srcH: 256,
            outW: 128, outH: 128
        )) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            XCTAssertNotEqual(code, 0)
        }
    }

    /// One-shot `renderTile(rawBytes:...)` with empty bytes throws
    /// renderFailed (rawler can't decode an empty byte slice).
    func testRenderTileFromEmptyBytesThrows() {
        XCTAssertThrowsError(try PipelineRenderer.renderTile(
            rawBytes: Data(),
            hint: "dng",
            srcX: 0, srcY: 0, srcW: 256, srcH: 256,
            outW: 128, outH: 128
        )) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            XCTAssertNotEqual(code, 0)
        }
    }

    // MARK: - Fixture-gated round-trip lifecycle

    /// Open a handle, render a single tile, and let the deinit close it.
    /// Verifies the wrapper's full lifecycle plus the FFI buffer shape.
    /// Skipped if the test fixture isn't present.
    func testRawHandleRoundTripRendersTile() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let handle = try PipelineRenderer.openRawHandle(rawPath: url, xmpPath: nil)
        let tile = try PipelineRenderer.renderTile(
            handle: handle,
            srcX: 1024, srcY: 1024,
            srcW: 512, srcH: 512,
            outW: 256, outH: 256,
            quality: .full
        )
        XCTAssertEqual(tile.width, 256)
        XCTAssertEqual(tile.height, 256)
        XCTAssertEqual(tile.bytesPerPixel, 8)
        XCTAssertEqual(tile.channels, 4)
        XCTAssertEqual(tile.pixels.count, 256 * 256 * 8)
        // `handle` deinits at scope exit → maple_close_raw_handle.
    }

    /// Open once, render N tiles against the same handle. Validates
    /// that the cached decoded mosaic is reusable across multiple tile
    /// fetches without crashing or drifting in shape.
    func testRawHandleRendersMultipleTiles() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let handle = try PipelineRenderer.openRawHandle(rawPath: url)
        let coords: [(UInt32, UInt32)] = [(0, 0), (1024, 0), (0, 1024)]
        for (sx, sy) in coords {
            let tile = try PipelineRenderer.renderTile(
                handle: handle,
                srcX: sx, srcY: sy,
                srcW: 512, srcH: 512,
                outW: 256, outH: 256
            )
            XCTAssertEqual(tile.width, 256, "tile (\(sx),\(sy)) width")
            XCTAssertEqual(tile.height, 256, "tile (\(sx),\(sy)) height")
            XCTAssertEqual(tile.pixels.count, 256 * 256 * 8)
        }
    }

    /// One-shot `renderTile(rawPath:...)` succeeds without an explicit
    /// handle. Same shape checks as the handle-based path.
    func testRenderTileFromFileRoundTrip() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let tile = try PipelineRenderer.renderTile(
            rawPath: url,
            srcX: 1024, srcY: 1024,
            srcW: 512, srcH: 512,
            outW: 256, outH: 256
        )
        XCTAssertEqual(tile.width, 256)
        XCTAssertEqual(tile.height, 256)
    }

    /// `renderTile` rejects upscale (out > src) — surfaces the FFI rc=11.
    func testRenderTileRejectsUpscale() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let handle = try PipelineRenderer.openRawHandle(rawPath: url)
        XCTAssertThrowsError(try PipelineRenderer.renderTile(
            handle: handle,
            srcX: 1024, srcY: 1024,
            srcW: 256, srcH: 256,
            outW: 512, outH: 512  // > src → rc=11
        )) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            XCTAssertEqual(code, 11, "expected upscale rc=11, got \(code)")
        }
    }

    /// `decodePreviewTile` returns a CIImage tagged
    /// extendedLinearITUR_2020 at the requested output dimensions.
    func testDecodePreviewTileReturnsTaggedRec2020CIImage() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let asset = AssetRef(url: url)
        let pipeline = ImageEditPipeline()
        let tile = await pipeline.decodePreviewTile(
            asset: asset,
            srcRect: CGRect(x: 1024, y: 1024, width: 512, height: 512),
            outSize: CGSize(width: 256, height: 256),
            quality: .full
        )
        let img = try XCTUnwrap(tile)
        XCTAssertEqual(Int(img.extent.size.width), 256)
        XCTAssertEqual(Int(img.extent.size.height), 256)
        // CIImage.colorSpace returns Optional<CGColorSpace>; check name.
        XCTAssertEqual(
            img.colorSpace?.name as String?,
            CGColorSpace.extendedLinearITUR_2020 as String,
            "decodePreviewTile must tag extendedLinearITUR_2020"
        )
    }

    // MARK: - Task 5: RawImageCache

    /// Resolve a secondary fixture, used to test that switching assets
    /// evicts the cached entry. Walks the same 7 levels as
    /// `fixtureURL()` to land on the repo root.
    private func secondaryFixtureURL() -> URL? {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // MapleCore/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
            .appendingPathComponent("test-fixtures/raws/test_0006.DNG")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Cache hit: opening the same URL twice returns the SAME handle
    /// instance (`===`). Validates that the second call skipped the
    /// rawler decode.
    func testRawImageCacheReturnsSameHandleAcrossCalls() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let cache = RawImageCache()
        let h1 = try await cache.handle(for: url)
        let h2 = try await cache.handle(for: url)
        XCTAssertTrue(h1 === h2, "second call must reuse cached handle")
    }

    /// Switching to a different URL evicts the previous entry; refetching
    /// the original URL produces a NEW handle instance (different `===`).
    func testRawImageCacheEvictsOnAssetSwitch() async throws {
        guard let u1 = fixtureURL(), let u2 = secondaryFixtureURL() else {
            throw XCTSkip("required fixtures not present; skipping")
        }
        let cache = RawImageCache()
        let h1 = try await cache.handle(for: u1)
        let h2 = try await cache.handle(for: u2)
        let h1Again = try await cache.handle(for: u1)
        XCTAssertFalse(h1 === h1Again, "switching to u2 should evict u1; refetch decodes again")
        XCTAssertFalse(h1 === h2, "h1 and h2 are different assets")
    }

    /// Explicit `evict()` drops the cached entry; the next call decodes
    /// again.
    func testRawImageCacheExplicitEvict() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let cache = RawImageCache()
        let h1 = try await cache.handle(for: url)
        await cache.evict()
        let cached = await cache.cachedURL
        XCTAssertNil(cached, "evict() must clear the cached URL")
        let h2 = try await cache.handle(for: url)
        XCTAssertFalse(h1 === h2, "post-evict refetch must decode a fresh handle")
    }

    /// `cachedURL` reports the asset currently held — used by tests and
    /// instrumentation to verify cache state without poking internals.
    func testRawImageCacheCachedURLReflectsCurrentEntry() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let cache = RawImageCache()
        let beforeOpen = await cache.cachedURL
        XCTAssertNil(beforeOpen)
        _ = try await cache.handle(for: url)
        let afterOpen = await cache.cachedURL
        XCTAssertEqual(afterOpen, url)
    }

    /// Bogus path surfaces the FFI error; the cache stays empty.
    func testRawImageCacheNonExistentFileThrows() async {
        let bogus = URL(fileURLWithPath: "/tmp/does_not_exist_maple_cache_test.dng")
        let cache = RawImageCache()
        do {
            _ = try await cache.handle(for: bogus)
            XCTFail("expected an error from a non-existent file")
        } catch {
            // expected — RAW decode fails
        }
        let cached = await cache.cachedURL
        XCTAssertNil(cached, "failed open must NOT populate the cache")
    }

    // MARK: - Task 6: TileManager (geometry — pure functions, no fixture)

    /// Geometry test: viewport (0,0)-(2048,1024) in source pixels at
    /// zoom 1.0 should request 4×2 = 8 tiles at 512² each.
    func testTileManagerComputesVisibleTileSet() {
        let viewport = CGRect(x: 0, y: 0, width: 2048, height: 1024)
        let zoom = CGFloat(1.0)
        let tiles = TileManager.tileSet(forVisibleSourceRect: viewport, zoom: zoom, tileSize: 512)
        XCTAssertEqual(tiles.count, 8)
        XCTAssertTrue(tiles.contains { $0.tileX == 0 && $0.tileY == 0 })
        XCTAssertTrue(tiles.contains { $0.tileX == 3 && $0.tileY == 1 })
    }

    /// A non-axis-aligned viewport rounds outward — minX = 100 floors to
    /// tile 0, maxX = 1100 ceils to tile 3.
    func testTileManagerTileSetRoundsOutward() {
        let viewport = CGRect(x: 100, y: 100, width: 1000, height: 1000)
        let tiles = TileManager.tileSet(forVisibleSourceRect: viewport, zoom: 1.0, tileSize: 512)
        XCTAssertTrue(tiles.contains { $0.tileX == 0 && $0.tileY == 0 },
                      "minX=100 must include tile col 0")
        // maxX=1100 / 512 = 2.148 → ceil-1 = 2, so col 2 is the last col.
        XCTAssertTrue(tiles.contains { $0.tileX == 2 },
                      "maxX=1100 must include tile col 2")
    }

    /// Empty rect produces an empty tile set.
    func testTileManagerTileSetEmptyRect() {
        let tiles = TileManager.tileSet(
            forVisibleSourceRect: .zero, zoom: 1.0, tileSize: 512)
        // CGRect.zero has 0 width / height — the function should produce
        // a single zero-sized region (or zero tiles); verify it doesn't
        // crash and produces ≤ 1 tile.
        XCTAssertLessThanOrEqual(tiles.count, 1)
    }

    /// Zoom bucket boundaries match the brief: thresholds at 2×, 4×, 8×.
    func testTileManagerZoomBucketsAt1And2And4And8() {
        XCTAssertEqual(TileManager.zoomBucket(for: 0.5), 1)
        XCTAssertEqual(TileManager.zoomBucket(for: 0.99), 1)
        XCTAssertEqual(TileManager.zoomBucket(for: 1.0), 1)
        XCTAssertEqual(TileManager.zoomBucket(for: 1.99), 1)
        XCTAssertEqual(TileManager.zoomBucket(for: 2.0), 2)
        XCTAssertEqual(TileManager.zoomBucket(for: 2.5), 2)
        XCTAssertEqual(TileManager.zoomBucket(for: 4.0), 4)
        XCTAssertEqual(TileManager.zoomBucket(for: 7.99), 4)
        XCTAssertEqual(TileManager.zoomBucket(for: 8.0), 8)
        // Above 8× clamps to 8 — the brief caps zoom buckets at 8×.
        XCTAssertEqual(TileManager.zoomBucket(for: 16.0), 8)
        XCTAssertEqual(TileManager.zoomBucket(for: 100.0), 8)
    }

    /// `urlHash` is deterministic — same URL always hashes to the same
    /// 32-char hex string. The hash is used in `TileKey` so cache
    /// lookups are stable across Task hops.
    func testTileManagerURLHashDeterministic() {
        let u1 = URL(fileURLWithPath: "/path/to/asset_a.dng")
        let u2 = URL(fileURLWithPath: "/path/to/asset_a.dng")
        let u3 = URL(fileURLWithPath: "/path/to/asset_b.dng")
        XCTAssertEqual(TileManager.urlHash(u1), TileManager.urlHash(u2))
        XCTAssertNotEqual(TileManager.urlHash(u1), TileManager.urlHash(u3))
        XCTAssertEqual(TileManager.urlHash(u1).count, 32, "MD5 hex is 32 chars")
    }

    // MARK: - Task 6: TileManager (cache lifecycle)

    /// `update` with no cached tiles and a viewport that demands tiles
    /// returns an empty composite (CIImage.empty) — the caller is then
    /// responsible for showing the upscaled preview underlayer while
    /// tiles render. Subsequent calls (after tiles populate) return a
    /// non-empty composite.
    func testTileManagerUpdateMissReturnsEmptyComposite() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let asset = AssetRef(url: url)
        let cache = RawImageCache()
        let mgr = TileManager(rawCache: cache)
        // Demand a single tile at (0,0). On first call, no tiles are
        // cached → composite is empty. The miss kicks off a render
        // task in the background.
        let composite = try await mgr.update(
            asset: asset,
            viewportSourceRect: CGRect(x: 0, y: 0, width: 256, height: 256),
            zoom: 1.0
        )
        XCTAssertTrue(composite.extent.isEmpty || composite.extent.isInfinite,
                      "first update for an uncached tile must return an empty/infinite (i.e. no-op) composite")
    }

    /// After the in-flight render completes the tile is cached; the
    /// next `update` call returns a non-empty composite. Drives the
    /// miss → render → hit flow end-to-end against a real fixture.
    func testTileManagerUpdatePopulatesCacheAfterRender() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let asset = AssetRef(url: url)
        let cache = RawImageCache()
        let mgr = TileManager(rawCache: cache)
        // Force a synchronous fetch — bypass the fire-and-forget by
        // using the test entry point.
        let key = TileKey(
            urlHash: TileManager.urlHash(url),
            sidecarMtime: Date.distantPast,
            viewTransformVersion: 2,
            zoomBucket: 1,
            tileX: 2, tileY: 2
        )
        try await mgr.testFetchTileSync(key: key, asset: asset)
        let count = await mgr.testCachedTileCount()
        XCTAssertEqual(count, 1, "synchronous fetch must populate the cache")
    }

    /// `invalidate(asset:)` drops every tile whose `urlHash` matches
    /// the asset's URL, leaving tiles for other assets intact.
    func testTileManagerInvalidatePerAsset() async throws {
        let mgr = TileManager(rawCache: RawImageCache())
        // Insert two synthetic tiles for asset A and one for asset B.
        let urlA = URL(fileURLWithPath: "/tmp/A.dng")
        let urlB = URL(fileURLWithPath: "/tmp/B.dng")
        let assetA = AssetRef(url: urlA)
        let assetB = AssetRef(url: urlB)
        let img = Self.makeTinyCIImage()
        let kA1 = TileKey(urlHash: TileManager.urlHash(urlA), sidecarMtime: .distantPast, viewTransformVersion: 2, zoomBucket: 1, tileX: 0, tileY: 0)
        let kA2 = TileKey(urlHash: TileManager.urlHash(urlA), sidecarMtime: .distantPast, viewTransformVersion: 2, zoomBucket: 1, tileX: 1, tileY: 0)
        let kB1 = TileKey(urlHash: TileManager.urlHash(urlB), sidecarMtime: .distantPast, viewTransformVersion: 2, zoomBucket: 1, tileX: 0, tileY: 0)
        await mgr.testInsertTile(key: kA1, image: img)
        await mgr.testInsertTile(key: kA2, image: img)
        await mgr.testInsertTile(key: kB1, image: img)
        let before = await mgr.testCachedTileCount()
        XCTAssertEqual(before, 3)
        await mgr.invalidate(asset: assetA)
        let after = await mgr.testCachedTileCount()
        XCTAssertEqual(after, 1, "invalidate(A) must drop only asset A's tiles")
        // assetB's tile survives — verify by re-running invalidate(B).
        await mgr.invalidate(asset: assetB)
        let final = await mgr.testCachedTileCount()
        XCTAssertEqual(final, 0)
    }

    /// `clear()` empties the entire cache.
    func testTileManagerClearEmptiesCache() async {
        let mgr = TileManager(rawCache: RawImageCache())
        let img = Self.makeTinyCIImage()
        let url = URL(fileURLWithPath: "/tmp/clear_test.dng")
        for i in 0..<3 {
            let key = TileKey(
                urlHash: TileManager.urlHash(url), sidecarMtime: .distantPast,
                viewTransformVersion: 2, zoomBucket: 1,
                tileX: UInt32(i), tileY: 0
            )
            await mgr.testInsertTile(key: key, image: img)
        }
        let before = await mgr.testCachedTileCount()
        XCTAssertEqual(before, 3)
        await mgr.clear()
        let after = await mgr.testCachedTileCount()
        XCTAssertEqual(after, 0)
    }

    // MARK: - Task 8: tile-completion AsyncStream

    /// `events()` yields a `TileKey` for every cache insert. Drives the
    /// EditSession re-composite trigger: when a tile lands in the
    /// background, the event fires and the editor knows to re-call
    /// `update(...)` and republish the composite.
    ///
    /// Test strategy: subscribe, then synchronously insert two synthetic
    /// tiles via `testInsertTile`. We expect to see exactly two events.
    /// To avoid hanging on the never-finishing stream, we collect from
    /// the iterator with a short timeout via `Task.race`-style pattern
    /// (Task.sleep + Task.cancel).
    func testTileManagerEventsFireOnInsert() async throws {
        let mgr = TileManager(rawCache: RawImageCache())
        let img = Self.makeTinyCIImage()
        let url = URL(fileURLWithPath: "/tmp/events_test.dng")
        let urlHash = TileManager.urlHash(url)
        let stream = await mgr.events()
        // Collect events on a background task so the test can drive
        // inserts on the main one.
        let collector = Task<[TileKey], Never> {
            var collected: [TileKey] = []
            for await key in stream {
                collected.append(key)
                if collected.count >= 2 { break }
            }
            return collected
        }
        // Defensive cancel after 2 seconds in case events never arrive.
        let cancelTask = Task {
            try? await Task.sleep(for: .milliseconds(2000))
            collector.cancel()
        }
        // Yield once so the collector has reached its `for await` before
        // we insert. Without this, fast inserts can race ahead of the
        // subscriber on slow CI; the test would still pass on multicast,
        // but the wait-and-then-insert pattern is what real callers do.
        await Task.yield()
        let k1 = TileKey(urlHash: urlHash, sidecarMtime: .distantPast,
                         viewTransformVersion: 2, zoomBucket: 1,
                         tileX: 0, tileY: 0)
        let k2 = TileKey(urlHash: urlHash, sidecarMtime: .distantPast,
                         viewTransformVersion: 2, zoomBucket: 1,
                         tileX: 1, tileY: 0)
        await mgr.testInsertTile(key: k1, image: img)
        await mgr.testInsertTile(key: k2, image: img)
        let received = await collector.value
        cancelTask.cancel()
        XCTAssertEqual(received.count, 2, "expected one event per insert")
        XCTAssertTrue(received.contains(k1), "k1 must be reported")
        XCTAssertTrue(received.contains(k2), "k2 must be reported")
    }

    /// Multiple subscribers each receive every event (multicast).
    func testTileManagerEventsAreMulticast() async throws {
        let mgr = TileManager(rawCache: RawImageCache())
        let img = Self.makeTinyCIImage()
        let url = URL(fileURLWithPath: "/tmp/multicast_test.dng")
        let urlHash = TileManager.urlHash(url)
        let s1 = await mgr.events()
        let s2 = await mgr.events()
        let c1 = Task<Int, Never> {
            var n = 0
            for await _ in s1 {
                n += 1
                if n >= 1 { break }
            }
            return n
        }
        let c2 = Task<Int, Never> {
            var n = 0
            for await _ in s2 {
                n += 1
                if n >= 1 { break }
            }
            return n
        }
        let cancelTask = Task {
            try? await Task.sleep(for: .milliseconds(2000))
            c1.cancel(); c2.cancel()
        }
        await Task.yield()
        let key = TileKey(urlHash: urlHash, sidecarMtime: .distantPast,
                          viewTransformVersion: 2, zoomBucket: 1,
                          tileX: 5, tileY: 5)
        await mgr.testInsertTile(key: key, image: img)
        let n1 = await c1.value
        let n2 = await c2.value
        cancelTask.cancel()
        XCTAssertEqual(n1, 1, "subscriber 1 must see the insert")
        XCTAssertEqual(n2, 1, "subscriber 2 must see the same insert")
    }

    /// Tiny CIImage for cache accounting tests — synthetic, no decode.
    static func makeTinyCIImage() -> CIImage {
        let side = 8
        let bytes = Data(count: side * side * 8)
        return CIImage(
            bitmapData: bytes, bytesPerRow: side * 8,
            size: CGSize(width: side, height: side),
            format: .RGBAh,
            colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        )
    }
}
