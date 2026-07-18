// EditSessionMemoryReleaseTests.swift — cache-teardown surface: the
// `RenderActor.invalidate()` postcondition and the #2037 memory-pressure
// eviction call built on it, `EditSession.releaseTransientMemory()`.
//
// Split out of EditSessionDecodedCacheTests.swift (file-size budget).
// The decoded-cache freshness invariants stay there; this file covers the
// session-level eviction call the memory-pressure fan-out (AppShell) and
// the iOS backgrounding path actually invoke: it must empty the decoded-
// image cache (via `renderActor.invalidate()`), clear the deep-zoom tile
// cache, and be safe when the optional pieces (tile manager, GPU-live
// driver/session) don't exist — the common case for browse-primed
// sessions. Uses the same `_testSeedDecodedCache` /
// `_testDecodedCachePopulated` seams as the decoded-cache tests.

import XCTest
import CoreImage
@testable import MapleCore

@MainActor
final class EditSessionMemoryReleaseTests: XCTestCase {

    // MARK: - Helpers (mirrors EditSessionDecodedCacheTests — small enough
    // to duplicate rather than grow a shared-utils file)

    /// Synthesise a temp `.dng` so `AssetRef(url:)` has a real file path to
    /// key against. Bytes don't matter — these tests never invoke the Rust
    /// FFI; cache fields are seeded directly via `_testSeedDecodedCache`.
    private func makeAsset() throws -> (asset: AssetRef, dir: URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("memory-release.dng")
        try Data([0x44, 0x4E, 0x47]).write(to: url)
        return (AssetRef(url: url), dir)
    }

    private func makeDecoded(_ size: CGSize = CGSize(width: 100, height: 100)) -> CIImage {
        CIImage(color: .gray)
            .cropped(to: CGRect(x: 0, y: 0, width: size.width, height: size.height))
    }

    private func writeSidecar(at url: URL, content: String = "<x:xmpmeta/>") throws {
        try content.write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: - invalidate() postcondition

    /// `invalidate()` MUST clear every cache field — otherwise a follow-up
    /// populated-check would still claim "we have a cache" with stale data
    /// behind it. The `decodedBakedModel` freshness key (#950, replacing
    /// `decodedSidecarMtime`) must be among the fields cleared. Lives here
    /// (not in the decoded-cache freshness suite) because it's the exact
    /// postcondition `releaseTransientMemory()` below builds on.
    func testInvalidateClearsAllCacheFields() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }
        try writeSidecar(at: sidecarURL)

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100),
            decodedAtModel: AdjustmentModel.default
        )
        let populated = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertTrue(populated)
        let atModel = await session.renderActor._testDecodedAtModel
        XCTAssertNotNil(atModel)

        await session.renderActor.invalidate()

        let populatedAfter = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertFalse(populatedAfter,
            "invalidate must clear decodedImage")
        let atModelAfter = await session.renderActor._testDecodedAtModel
        XCTAssertNil(atModelAfter,
            "invalidate must clear decodedAtModel")
        // After invalidate the cache is empty: `_testDecodedCachePopulated`
        // is false because `decodedForAssetID`/`decodedImage` were cleared,
        // and `decodedBakedModel` is nil. Re-seed afresh and confirm
        // freshness depends only on the new seed (proving the prior baked
        // capture didn't linger).
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100)
        )
        let freshAgain = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshAgain)
    }

    // MARK: - #2037: memory-pressure eviction

    /// `EditSession.releaseTransientMemory()` must empty the decoded-image
    /// cache — the same postcondition `invalidate()` already guarantees
    /// (`testInvalidateClearsAllCacheFields` in the decoded-cache suite),
    /// exercised through the higher-level session API the memory-pressure
    /// fan-out actually calls.
    func testReleaseTransientMemoryEmptiesDecodedCache() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100),
            decodedAtModel: AdjustmentModel.default
        )
        let populatedBefore = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertTrue(populatedBefore, "precondition: decoded cache populated before eviction")

        await session.releaseTransientMemory()

        let populatedAfter = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertFalse(populatedAfter,
            "releaseTransientMemory must empty the decoded-image cache (#2037)")
        let atModelAfter = await session.renderActor._testDecodedAtModel
        XCTAssertNil(atModelAfter, "releaseTransientMemory must clear decodedAtModel too")
    }

    /// The deep-zoom tile cache is a second re-derivable buffer
    /// `releaseTransientMemory()` must free — mirrors
    /// `testTileManagerClearEmptiesCache` (`DeepZoomTileRenderingTests`) but
    /// through the session-level eviction call.
    func testReleaseTransientMemoryClearsTileManager() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        let session = EditSession(asset: asset)
        let tileManager = session.ensureTileManager()
        // Seed directly via the test-only synchronous insert — `update(...)`
        // would enqueue a real FFI fetch against the fake `.dng` bytes
        // `makeAsset()` writes, which isn't a real RAW.
        let key = TileKey(
            urlHash: TileManager.urlHash(asset.primaryURL!),
            sidecarMtime: .distantPast,
            viewTransformVersion: TileManager.viewTransformVersion,
            zoomBucket: 1,
            tileX: 0,
            tileY: 0
        )
        await tileManager.testInsertTile(key: key, image: makeDecoded())
        let countBefore = await tileManager.testCachedTileCount()
        XCTAssertEqual(countBefore, 1, "precondition: tile cache populated")

        await session.releaseTransientMemory()

        let countAfter = await tileManager.testCachedTileCount()
        XCTAssertEqual(countAfter, 0,
            "releaseTransientMemory must clear the session's deep-zoom tile cache (#2037)")
    }

    /// The common case: a browse-primed session that never zoomed in (no
    /// `tileManager`) and never opened a GPU-live session must not crash or
    /// hang — `releaseTransientMemory()` no-ops on the absent pieces.
    func testReleaseTransientMemoryIsSafeWithNoTileManagerOrGpuSession() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset, decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100))

        await session.releaseTransientMemory()

        let populatedAfter = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertFalse(populatedAfter)
    }
}
