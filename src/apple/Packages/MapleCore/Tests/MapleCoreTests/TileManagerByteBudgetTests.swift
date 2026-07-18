// TileManagerByteBudgetTests.swift — #2061f: byte-budget LRU eviction
// for the deep-zoom tile cache. `TileManager.entries` used to be an
// unbounded dictionary ("No LRU. No byte budget." per the original
// header) — dead behind `EditSession.deepZoomEnabled = false` today,
// but a footgun for re-enablement. These tests drive the eviction
// logic directly through the test-only entry points, without needing
// a real RAW fixture.
//
// Synthetic tiles are built via `CIImage(color:).cropped(to:)` — a
// lazily-rasterized generator image, so a 4096×2048 "64MB" tile costs
// no real backing-store allocation at construction time. `byteCost` is
// estimated by `TileManager.testInsertTile` from the image's `.extent`
// at the pipeline's assumed 8 bytes/pixel (`.RGBAh`), matching the
// production `fetch()` path's real `MapleImageData.bytesPerPixel`.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

final class TileManagerByteBudgetTests: XCTestCase {

    /// 4096×2048 px at the assumed 8 bytes/pixel RGBAh tile format =
    /// 64 MB — four of these exactly fill the 256 MB budget.
    private func makeSyntheticTile() -> CIImage {
        CIImage(color: CIColor(red: 1, green: 0, blue: 0, alpha: 1))
            .cropped(to: CGRect(x: 0, y: 0, width: 4096, height: 2048))
    }

    private func makeKey(urlHash: String = "budget-test-hash", tileX: UInt32) -> TileKey {
        TileKey(
            urlHash: urlHash,
            sidecarMtime: .distantPast,
            viewTransformVersion: TileManager.viewTransformVersion,
            zoomBucket: 1,
            tileX: tileX,
            tileY: 0
        )
    }

    /// Inserting a 5th 64MB tile past the 256MB budget (4 tiles) must
    /// evict the least-recently-touched entry (the first inserted, since
    /// none were re-touched) and keep the running total at or under
    /// `byteBudget`.
    func testInsertPastBudgetEvictsLeastRecentlyUsed() async {
        let mgr = TileManager(rawCache: RawImageCache())
        let tile = makeSyntheticTile()
        let keys = (0..<5).map { makeKey(tileX: UInt32($0)) }
        for key in keys {
            await mgr.testInsertTile(key: key, image: tile)
        }

        let totalBytes = await mgr.testTotalCachedBytes()
        XCTAssertLessThanOrEqual(totalBytes, TileManager.byteBudget,
            "total resident bytes must never exceed the budget")

        let count = await mgr.testCachedTileCount()
        XCTAssertEqual(count, 4,
            "budget holds exactly 4 tiles at 64MB each; the 5th insert evicts one")

        let hasOldest = await mgr.testHasTile(key: keys[0])
        XCTAssertFalse(hasOldest,
            "the first-inserted, never-touched tile must be the one evicted")
        let hasNewest = await mgr.testHasTile(key: keys[4])
        XCTAssertTrue(hasNewest, "the most recently inserted tile must survive")
    }

    /// Reading a tile via `update(...)` touches it (moves it to the back
    /// of the LRU order) — so a tile inserted first but read most
    /// recently survives eviction ahead of a tile that was inserted
    /// later but never read. Confirms LRU is touch-order, not
    /// insert-order.
    func testTouchOnReadProtectsFromEviction() async throws {
        let mgr = TileManager(rawCache: RawImageCache())
        let tile = makeSyntheticTile()
        let url = URL(fileURLWithPath: "/tmp/touch_budget_test.dng")
        let asset = AssetRef(url: url)
        let urlHash = TileManager.urlHash(url)

        let k0 = makeKey(urlHash: urlHash, tileX: 0)
        let k1 = makeKey(urlHash: urlHash, tileX: 1)
        let k2 = makeKey(urlHash: urlHash, tileX: 2)
        let k3 = makeKey(urlHash: urlHash, tileX: 3)
        let k4 = makeKey(urlHash: urlHash, tileX: 4)

        // Four 64MB tiles exactly fill the 256MB budget — no eviction yet.
        await mgr.testInsertTile(key: k0, image: tile)
        await mgr.testInsertTile(key: k1, image: tile)
        await mgr.testInsertTile(key: k2, image: tile)
        await mgr.testInsertTile(key: k3, image: tile)

        // Touch k0 (the oldest) via a real cache-hit read through
        // `update(...)`, which covers tileX=0 only.
        let tileSize = CGFloat(TileManager.tileSizeSourcePx)
        _ = try await mgr.update(
            asset: asset,
            viewportSourceRect: CGRect(x: 0, y: 0, width: tileSize, height: tileSize),
            zoom: 1.0,
            totalSourceSize: CGSize(width: tileSize * 5, height: tileSize)
        )

        // Insert a 5th tile — this must evict the new least-recently-used
        // entry. Without the touch that would be k0; with it, k1 (never
        // touched) is evicted instead.
        await mgr.testInsertTile(key: k4, image: tile)

        let hasK0 = await mgr.testHasTile(key: k0)
        let hasK1 = await mgr.testHasTile(key: k1)
        XCTAssertTrue(hasK0, "k0 was touched via update() and must survive eviction")
        XCTAssertFalse(hasK1, "k1 was never touched and must be evicted as the new least-recently-used")

        let totalBytes = await mgr.testTotalCachedBytes()
        XCTAssertLessThanOrEqual(totalBytes, TileManager.byteBudget)
    }

    /// Re-inserting the same key (a tile re-render, e.g. after a sidecar
    /// edit bumps `sidecarMtime` in a *different* key — but if a caller
    /// ever re-stores the identical key) must not double-count its byte
    /// cost in the running total.
    func testReinsertingSameKeyDoesNotDoubleCountBytes() async {
        let mgr = TileManager(rawCache: RawImageCache())
        let tile = makeSyntheticTile()
        let key = makeKey(tileX: 0)

        await mgr.testInsertTile(key: key, image: tile)
        let afterFirst = await mgr.testTotalCachedBytes()

        await mgr.testInsertTile(key: key, image: tile)
        let afterSecond = await mgr.testTotalCachedBytes()

        XCTAssertEqual(afterFirst, afterSecond,
            "re-inserting the same key must replace, not add to, its byte cost")
        let count = await mgr.testCachedTileCount()
        XCTAssertEqual(count, 1)
    }

    /// `clear()` must reset the byte total along with the entry dictionary
    /// — otherwise a stale `totalBytes` would wrongly trigger eviction (or
    /// mask headroom) on the next insert.
    func testClearResetsByteTotal() async {
        let mgr = TileManager(rawCache: RawImageCache())
        let tile = makeSyntheticTile()
        await mgr.testInsertTile(key: makeKey(tileX: 0), image: tile)
        let before = await mgr.testTotalCachedBytes()
        XCTAssertGreaterThan(before, 0)

        await mgr.clear()

        let after = await mgr.testTotalCachedBytes()
        XCTAssertEqual(after, 0)
    }
}
