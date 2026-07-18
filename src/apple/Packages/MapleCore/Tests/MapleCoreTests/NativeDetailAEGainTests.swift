// NativeDetailAEGainTests.swift — Apple-side consumer tests for the tile
// AE-gain contract (raw-core #1167 / Apple #2070).
//
// Two tiers, matching the DeepZoomTileRenderingTests convention:
//   - "no fixture" tier: RenderActor's DecodedSnapshot/seed plumbing for
//     `aeGain` — pure Swift, no RAW decode, runs anywhere.
//   - "fixture" tier: gated on `test-fixtures/raws/test_0002.dng`. Skips
//     (not fails) when the gitignored fixture is absent.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

final class NativeDetailAEGainTests: XCTestCase {

    // MARK: - DecodedSnapshot / seed plumbing (no fixture needed)

    /// An asset the cache has never seen reports the no-op gain — mirrors
    /// `snapshot(forAsset:)`'s existing `wbFrame == nil` / `iso == 0`
    /// defaults for an unpopulated cache.
    func testSnapshotDefaultsAeGainToOneForUnseenAsset() async {
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        let asset = AssetRef(
            displayName: "unseen.dng", hintExtension: "dng",
            stableID: "aegain-unseen", explicitIsRaw: true,
            bytesProvider: { Data() }
        )
        let snapshot = await actor.snapshot(forAsset: asset)
        XCTAssertEqual(snapshot.aeGain, 1.0, "an unpopulated cache must report the no-op gain")
    }

    /// `seed(...)` carries no AE-gain export (a seeded preview / embedded
    /// JPEG buffer, same as `wbFrame`) — must default to the no-op gain.
    func testSeedDefaultsAeGainToOne() async {
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        let asset = AssetRef(
            displayName: "seed.dng", hintExtension: "dng",
            stableID: "aegain-seed", explicitIsRaw: true,
            bytesProvider: { Data() }
        )
        let ci = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8))
        await actor.seed(asset: asset, decoded: ci, rawResolution: CGSize(width: 8, height: 8))
        let snapshot = await actor.snapshot(forAsset: asset)
        XCTAssertEqual(snapshot.aeGain, 1.0)
    }

    /// Same contract via `seedIfUnpopulated`.
    func testSeedIfUnpopulatedDefaultsAeGainToOne() async {
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        let asset = AssetRef(
            displayName: "seedif.dng", hintExtension: "dng",
            stableID: "aegain-seedif", explicitIsRaw: true,
            bytesProvider: { Data() }
        )
        let ci = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8))
        let accepted = await actor.seedIfUnpopulated(
            asset: asset, decoded: ci, rawResolution: CGSize(width: 8, height: 8)
        )
        XCTAssertTrue(accepted)
        let snapshot = await actor.snapshot(forAsset: asset)
        XCTAssertEqual(snapshot.aeGain, 1.0)
    }

    /// `_testSeedDecodedCache`'s `aeGain` override rides `snapshot(forAsset:)`
    /// — the seam a `NativeDetailRenderer` / `refineNativeDetail` caller
    /// would use to drive a non-default gain without a real RAW decode.
    func testTestSeedDecodedCacheAeGainOverrideRidesSnapshot() async {
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        let asset = AssetRef(
            displayName: "override.dng", hintExtension: "dng",
            stableID: "aegain-override", explicitIsRaw: true,
            bytesProvider: { Data() }
        )
        let ci = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8))
        await actor._testSeedDecodedCache(
            asset: asset, decoded: ci, rawResolution: CGSize(width: 8, height: 8),
            aeGain: 2.35
        )
        let snapshot = await actor.snapshot(forAsset: asset)
        XCTAssertEqual(snapshot.aeGain, 2.35, accuracy: 0.0001)
    }

    /// `invalidate()` resets the gain back to the no-op default alongside
    /// the rest of the decoded-cache state (mirrors
    /// `RenderActorTests.testInvalidateClearsFullness`).
    func testInvalidateResetsAeGainToOne() async {
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        let asset = AssetRef(
            displayName: "invalidate.dng", hintExtension: "dng",
            stableID: "aegain-invalidate", explicitIsRaw: true,
            bytesProvider: { Data() }
        )
        let ci = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8))
        await actor._testSeedDecodedCache(
            asset: asset, decoded: ci, rawResolution: CGSize(width: 8, height: 8),
            aeGain: 1.8
        )
        var snapshot = await actor.snapshot(forAsset: asset)
        XCTAssertEqual(snapshot.aeGain, 1.8, accuracy: 0.0001)
        await actor.invalidate()
        snapshot = await actor.snapshot(forAsset: asset)
        XCTAssertEqual(snapshot.aeGain, 1.0, "invalidate must reset the gain to the no-op default")
    }

    // MARK: - Fixture lookup helper (mirrors DeepZoomTileRenderingTests)

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

    // MARK: - PipelineRenderer.renderTileF32(aeGain:) FFI binding (fixture-gated)

    /// `aeGain: 1.0` through the NEW `maple_render_handle_scene_linear_tile_ae_f32`
    /// binding must reproduce the existing (pre-#1167) `renderTileF32`
    /// overload bit-for-bit — the same no-op guarantee the Rust side proves
    /// with `tile_ae_gain_one_matches_existing_tile_output` (raw-core PR
    /// #2071), re-verified here from the Swift binding.
    func testRenderTileF32AeGainOneMatchesExistingOverload() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let handle = try PipelineRenderer.openRawHandle(rawPath: url)
        let legacy = try PipelineRenderer.renderTileF32(
            handle: handle,
            srcX: 1024, srcY: 1024, srcW: 512, srcH: 512,
            outW: 256, outH: 256,
            quality: .full
        )
        let gainAware = try PipelineRenderer.renderTileF32(
            handle: handle,
            srcX: 1024, srcY: 1024, srcW: 512, srcH: 512,
            outW: 256, outH: 256,
            quality: .full,
            aeGain: 1.0
        )
        XCTAssertEqual(gainAware.width, legacy.width)
        XCTAssertEqual(gainAware.height, legacy.height)
        XCTAssertEqual(gainAware.bytesPerPixel, legacy.bytesPerPixel)
        XCTAssertEqual(
            gainAware.pixels, legacy.pixels,
            "ae_gain == 1.0 through the new FFI entry must be bit-identical to the "
            + "pre-#1167 renderTileF32 overload"
        )
    }

    /// A non-1.0 gain actually changes the tile's pixels — proves the
    /// scalar reaches the tile develop chain rather than being silently
    /// dropped on the Swift↔C boundary.
    func testRenderTileF32NonUnityGainChangesOutput() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let handle = try PipelineRenderer.openRawHandle(rawPath: url)
        let unity = try PipelineRenderer.renderTileF32(
            handle: handle,
            srcX: 1024, srcY: 1024, srcW: 512, srcH: 512,
            outW: 256, outH: 256,
            quality: .full,
            aeGain: 1.0
        )
        let boosted = try PipelineRenderer.renderTileF32(
            handle: handle,
            srcX: 1024, srcY: 1024, srcW: 512, srcH: 512,
            outW: 256, outH: 256,
            quality: .full,
            aeGain: 2.0
        )
        XCTAssertNotEqual(
            unity.pixels, boosted.pixels,
            "a distinct ae_gain must change the tile's developed pixels"
        )
    }

    // MARK: - EditSession.refineBody gate (fixture-gated, #2070)

    /// The core assertion of #2070: `refineNativeDetail` — gated to
    /// `Profile.auto` only before this PR — must now be reachable for
    /// `Profile.neutral` too. Drives the REAL scheduler path
    /// (`updateTileVisibleRegion` → `pixelScale.didSet` → `_scheduleRefine`
    /// → `refineBody`), exactly as production does, then polls for
    /// `nativeDetailPreview` to publish.
    @MainActor
    func testNeutralProfileReachesNativeDetailPath() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        var neutralModel = AdjustmentModel.default
        neutralModel.profile = .neutral
        let asset = AssetRef(url: url)
        let session = EditSession(asset: asset, model: neutralModel)
        // A sub-region well within the fixture's real 7216x5412 sensor
        // (confirmed via `sips -g pixelWidth -g pixelHeight`) — safe
        // regardless of EXIF orientation, since both dims exceed 2048.
        session.nativeImageSize = CGSize(width: 2048, height: 2048)
        session.updateTileVisibleRegion(
            viewport: CGRect(x: 0, y: 0, width: 400, height: 400),
            zoom: 1.0
        )

        // Full RAW decode of a real fixture (this fixture's own handle
        // open, not a cached one) can take several seconds — generous
        // ceiling to absorb CI scheduling jitter without masking a real
        // hang (a genuine regression here means the branch fell back to
        // the disabled deep-zoom / bounded-refine paths and never
        // publishes at all, so this loop would run out the full deadline
        // either way).
        let deadline = Date().addingTimeInterval(30.0)
        while Date() < deadline {
            if session.nativeDetailPreview != nil { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertNotNil(
            session.nativeDetailPreview,
            "Profile.neutral must reach the native-detail 1:1 path post-#2070 — "
            + "it previously fell back to the bounded whole-image refine"
        )
    }
}
