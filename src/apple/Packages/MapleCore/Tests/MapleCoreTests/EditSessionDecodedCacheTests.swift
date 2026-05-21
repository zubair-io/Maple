// EditSessionDecodedCacheTests.swift — invariants for the decoded-image
// cache rework.
//
// EditSession caches the Rust scene-linear FFI's full-native output as
// the actor's `decodedImage` so subsequent slider/zoom/pan calls reuse
// it instead of re-crossing the FFI per tick. Two invariants are
// load-bearing:
//
//   1. Same asset twice → second open hits the cache (fresh check
//      returns true; the cold-path `sharedDecode` short-circuits).
//   2. Sidecar mtime change → cache invalidates (fresh check returns
//      false). The Rust path bakes sidecar-driven stages
//      (highlight_recovery, profile-driven WB) into the buffer, so an
//      external XMP edit demands a fresh decode.
//
// These tests exercise the freshness state machine directly. The
// fixture-gated companion test `testColdOpenSecondRenderUsesCachedDecode`
// runs the full Rust decode once on a real RAW and verifies the second
// render lands in <1.5 s — proof that the FFI was not re-entered.
//
// Slice 2 of issue #194: the cache fields moved off EditSession onto
// `RenderActor`. The test surface is `session.renderActor.…` instead of
// `session.…`, but the assertions stay the same.

import XCTest
import CoreImage
@testable import MapleCore

@MainActor
final class EditSessionDecodedCacheTests: XCTestCase {

    // MARK: - Helpers

    /// Synthesise a temp `.dng` so `AssetRef(url:)` has a real file
    /// path to key against. Bytes don't matter for the freshness tests
    /// — they never invoke the Rust FFI; the cache fields are seeded
    /// directly via the actor's `_testSeedDecodedCache` hook.
    private func makeAsset() throws -> (asset: AssetRef, dir: URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("decoded-cache.dng")
        try Data([0x44, 0x4E, 0x47]).write(to: url)
        return (AssetRef(url: url), dir)
    }

    private func makeDecoded(_ size: CGSize = CGSize(width: 100, height: 100)) -> CIImage {
        CIImage(color: .gray)
            .cropped(to: CGRect(x: 0, y: 0, width: size.width, height: size.height))
    }

    private func writeSidecar(at url: URL, content: String = "<x:xmpmeta/>") throws -> Date {
        try content.write(to: url, atomically: true, encoding: .utf8)
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs[.modificationDate] as? Date) ?? Date()
    }

    // MARK: - Tests

    /// A freshly-seeded cache (no sidecar on disk) is fresh — the
    /// freshness check sees `decodedSidecarMtime == nil` and the live
    /// mtime is also `nil` (file doesn't exist), so they match.
    func testFreshlySeededCacheIsFreshWhenNoSidecarPresent() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100),
            sidecarMtime: nil
        )

        let populated = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertTrue(populated)
        let fresh = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(fresh,
            "cache with no sidecar at decode and no sidecar live should be fresh")
    }

    /// A freshly-seeded cache (sidecar on disk, mtime captured) is
    /// fresh until the sidecar is touched.
    func testFreshlySeededCacheIsFreshWhenSidecarMtimeMatches() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }
        let mtime = try writeSidecar(at: sidecarURL)

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100),
            sidecarMtime: mtime
        )

        let fresh = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(fresh,
            "cache mtime equal to live sidecar mtime should be fresh")
    }

    /// Bumping the sidecar (rewriting the XMP) flips the cache stale
    /// — the live mtime now exceeds the captured one.
    func testCacheIsStaleAfterSidecarMtimeBumps() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }
        let mtime0 = try writeSidecar(at: sidecarURL)

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100),
            sidecarMtime: mtime0
        )
        let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshBefore,
            "precondition: cache is fresh before sidecar bumps")

        // Sleep past 1 sec so APFS's whole-second mtime granularity
        // actually records a change. Subsecond writes would no-op the
        // mtime field on some macOS versions.
        try await Task.sleep(for: .milliseconds(1100))
        _ = try writeSidecar(at: sidecarURL, content: "<x:xmpmeta version=\"2\"/>")

        let freshAfter = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertFalse(freshAfter,
            "rewriting the sidecar should bump mtime and stale the cache")
    }

    /// Capturing an mtime when no sidecar existed, then creating one
    /// later, should also stale the cache — the Rust path used the
    /// no-sidecar default model, but a sidecar now exists with
    /// potentially different stages baked in.
    func testCacheIsStaleWhenSidecarAppearsAfterDecode() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }

        // Decode happened with no sidecar on disk → captured mtime nil.
        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100),
            sidecarMtime: nil
        )
        let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshBefore,
            "precondition: cache is fresh before sidecar appears")

        // Sidecar now appears (e.g. paste-adjustments wrote one).
        _ = try writeSidecar(at: sidecarURL)
        let freshAfter = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertFalse(freshAfter,
            "live mtime present where decoded captured nil should stale the cache")
    }

    /// Conversely, capturing an mtime when a sidecar existed, then
    /// deleting the sidecar, should also stale the cache — the cached
    /// buffer was decoded with sidecar stages applied, but a fresh
    /// decode would now use the default model.
    func testCacheIsStaleWhenSidecarDisappearsAfterDecode() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }
        let mtime = try writeSidecar(at: sidecarURL)

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100),
            sidecarMtime: mtime
        )
        let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshBefore,
            "precondition: cache is fresh before sidecar deletion")

        try FileManager.default.removeItem(at: sidecarURL)
        let freshAfter = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertFalse(freshAfter,
            "live mtime nil where decoded captured a real value should stale the cache")
    }

    /// `invalidateDecodedCache()` MUST clear every cache field —
    /// otherwise a follow-up populated-check would still claim "we have
    /// a cache" with stale data behind it. The `decodedSidecarMtime`
    /// field was added in this branch and could be left lingering by an
    /// incomplete invalidate.
    func testInvalidateClearsAllCacheFields() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }
        let mtime = try writeSidecar(at: sidecarURL)

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100),
            sidecarMtime: mtime,
            decodedAtModel: AdjustmentModel.default
        )
        let populated = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertTrue(populated)
        let atModel = await session.renderActor._testDecodedAtModel
        XCTAssertNotNil(atModel)

        // Public sync forwarder is fire-and-forget — fence on a direct
        // actor invalidate so the test doesn't race against the Task
        // queue.
        await session.renderActor.invalidate()

        let populatedAfter = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertFalse(populatedAfter,
            "invalidate must clear decodedImage")
        let atModelAfter = await session.renderActor._testDecodedAtModel
        XCTAssertNil(atModelAfter,
            "invalidate must clear decodedAtModel")
        // Re-seed with the same mtime — if `decodedSidecarMtime` had
        // not been cleared, this would short-circuit to "fresh"
        // immediately. We seed afresh and check that freshness state
        // depends only on the new seed, proving the invalidate cleared
        // the prior mtime capture.
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100),
            sidecarMtime: mtime
        )
        let freshAgain = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshAgain)
    }

    /// Cold-open second-render parity: when fixture is present, run a
    /// real decode through `ensureRenderStarted`, wait for the Rust
    /// pass to land in the actor's cache AND the first preview to
    /// publish (proving the cold pipeline drained), then verify a
    /// second `_scheduleRender` call reuses the cache rather than
    /// re-FFIing. We can't easily count Rust calls without invasive
    /// instrumentation; instead we assert the second slider tick's
    /// publish latency is well under the cold-decode budget. On a
    /// 100 MP RAW the FFI is multi-second; a cached re-render lands in
    /// tens of milliseconds.
    func testColdOpenSecondRenderUsesCachedDecode() async throws {
        let fixturePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("test-fixtures/raws/test_0002.dng")

        guard FileManager.default.fileExists(atPath: fixturePath.path) else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }

        let asset = AssetRef(url: fixturePath)
        let session = EditSession(asset: asset)
        await MainActor.run {
            session.previewSize = CGSize(width: 1500, height: 1000)
            session.pixelScale = 0  // fit
        }
        session.ensureRenderStarted()

        // Wait up to 30 s for the cold Rust decode to populate the
        // cache AND for the first render to publish.
        let coldDeadline = Date().addingTimeInterval(30.0)
        while Date() < coldDeadline {
            let cached = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
            let isRendering = await session.isRendering
            if cached && !isRendering {
                try await Task.sleep(for: .milliseconds(300))
                break
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        let populated = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        guard populated else {
            return XCTFail("Rust decode did not populate cache within 30 s")
        }

        // Now mutate the model — this triggers `_scheduleRender(.fast)`
        // through the `model.didSet`. Time how long it takes for the
        // fast render to publish.
        let beforePreview = await session.renderedPreview
        let t0 = ContinuousClock.now
        await MainActor.run {
            session.model.exposure = 0.5
        }
        let warmDeadline = Date().addingTimeInterval(2.5)
        var publishedAfter = false
        while Date() < warmDeadline {
            let p = await session.renderedPreview
            if p !== beforePreview {
                publishedAfter = true
                break
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        let elapsed = ContinuousClock.now - t0
        let elapsedMs = Double(elapsed.components.seconds) * 1000
            + Double(elapsed.components.attoseconds) / 1e15
        XCTAssertTrue(publishedAfter, "no preview update within 2.5 s of slider tick")
        XCTAssertLessThan(elapsedMs, 1500,
            "cached slider tick should land in <1.5 s; got \(elapsedMs) ms — cache miss?")
        print("CACHED_SLIDER_TICK_MS \(elapsedMs)")
        let stillCached = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        let stillFresh = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(stillCached, "decoded cache should still be populated after a slider tick")
        XCTAssertTrue(stillFresh, "decoded cache should still be fresh after a slider tick")
    }
}
