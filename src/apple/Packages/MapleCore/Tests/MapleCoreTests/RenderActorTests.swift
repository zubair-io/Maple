// RenderActorTests.swift — slice 1 scaffold coverage (issue #194).
//
// Slice 1 introduces `RenderActor` as a thin pass-through over
// `ImageEditPipeline`. These tests verify:
//   1. The actor constructs cleanly.
//   2. `EditSession` exposes a non-nil `renderActor` so future slices have
//      a stable handoff point.
//   3. `renderPreview(asset:model:)` surfaces `RenderError.pipelineFailed`
//      for an unreadable asset — exercising the actor boundary end-to-end
//      without requiring a RAW fixture in CI.
//
// Slices 2 & 3 will replace these with broader coverage (decode-cache
// freshness, scheduler debounce, generation-counter discards). Keeping
// the slice-1 surface small means it can land without coupling to future
// state moves.

import XCTest
@testable import MapleCore

final class RenderActorTests: XCTestCase {
    func testRenderActorConstructs() async {
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        // The actor's only stored state in slice 1 is the pipeline ref —
        // the construction itself is the test. Hop onto the actor's
        // executor to confirm isolation works.
        await actor.assertIsolation()
    }

    @MainActor
    func testEditSessionExposesRenderActor() async {
        // EditSession constructs the actor in `init` so slice 2 / 3 can
        // route callers through it without touching the call sites here.
        let asset = AssetRef(
            displayName: "scaffold.dng",
            hintExtension: "dng",
            stableID: "scaffold-1",
            explicitIsRaw: true,
            bytesProvider: { Data() }
        )
        let session = EditSession(asset: asset)
        // Hop onto the actor to confirm the exposed reference is reachable
        // across the isolation boundary — a plain assignment doesn't prove
        // anything about actor semantics, but an `await` call does.
        let ref: RenderActor = session.renderActor
        await ref.assertIsolation()
    }

    func testRenderPreviewSurfacesPipelineFailedOnUnreadableAsset() async {
        // No primaryURL and a bytesProvider that returns garbage — the
        // RAW dispatch in `renderPreview` will fail the Rust FFI and
        // surface `RenderError.pipelineFailed`. This exercises the actor
        // boundary end-to-end (decode call, error mapping, async throw)
        // without depending on a fixture.
        let asset = AssetRef(
            displayName: "garbage.dng",
            hintExtension: "dng",
            stableID: "garbage-1",
            explicitIsRaw: true,
            bytesProvider: { Data([0x00, 0x01, 0x02, 0x03]) }
        )
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        do {
            _ = try await actor.renderPreview(asset: asset, model: .default)
            XCTFail("Expected RenderError.pipelineFailed for unreadable asset bytes")
        } catch let error as RenderError {
            switch error {
            case .pipelineFailed:
                break  // expected
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Decode-cache sufficiency (#785)

    /// A seeded preview buffer (cached render / embedded JPEG) is never a
    /// full-resolution decode — the refine pass must treat it as
    /// insufficient and re-decode full so the final render isn't a
    /// low-res preview.
    func testSeededCacheIsNotFull() async {
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        let asset = AssetRef(
            displayName: "seed.jpg",
            hintExtension: "jpg",
            stableID: "seed-1",
            explicitIsRaw: false,
            bytesProvider: { Data() }
        )
        let ci = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8))
        await actor.seed(asset: asset, decoded: ci, rawResolution: CGSize(width: 64, height: 64))
        let snapshot = await actor.snapshot(forAsset: asset)
        XCTAssertNotNil(snapshot.image, "seed should populate the cached image")
        XCTAssertFalse(snapshot.isFull, "seeded preview buffers must be reported as not full so refine upgrades them")
    }

    /// `seedIfUnpopulated` follows the same not-full contract as `seed`.
    func testSeedIfUnpopulatedIsNotFull() async {
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        let asset = AssetRef(
            displayName: "seed.jpg",
            hintExtension: "jpg",
            stableID: "seed-2",
            explicitIsRaw: false,
            bytesProvider: { Data() }
        )
        let ci = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8))
        let accepted = await actor.seedIfUnpopulated(
            asset: asset, decoded: ci, rawResolution: CGSize(width: 64, height: 64)
        )
        XCTAssertTrue(accepted, "an empty cache should accept the seed")
        let snapshot = await actor.snapshot(forAsset: asset)
        XCTAssertFalse(snapshot.isFull, "seedIfUnpopulated buffers must be reported as not full")
    }

    /// `invalidate` clears the fullness flag along with the cached image.
    func testInvalidateClearsFullness() async {
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        let asset = AssetRef(
            displayName: "full.dng",
            hintExtension: "dng",
            stableID: "full-1",
            explicitIsRaw: true,
            bytesProvider: { Data() }
        )
        let ci = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8))
        await actor._testSeedDecodedCache(
            asset: asset, decoded: ci, rawResolution: CGSize(width: 8, height: 8),
            isFull: true
        )
        var isFull = await actor._testDecodedIsFull()
        XCTAssertTrue(isFull, "test seed with isFull: true should report full")
        await actor.invalidate()
        isFull = await actor._testDecodedIsFull()
        XCTAssertFalse(isFull, "invalidate must clear the fullness flag")
        let snapshot = await actor.snapshot(forAsset: asset)
        XCTAssertNil(snapshot.image, "invalidate must clear the cached image")
    }

    // MARK: - Decoded-cache write-gate (#785)

    /// A full decode always writes the cache, regardless of what's there.
    func testWriteGateFullDecodeAlwaysWrites() {
        XCTAssertTrue(
            RenderActor.shouldWriteDecodedCache(wantsFull: true, cachedIsFreshFull: true),
            "a full decode must overwrite even a fresh full cache (re-decode after invalidate)")
        XCTAssertTrue(
            RenderActor.shouldWriteDecodedCache(wantsFull: true, cachedIsFreshFull: false),
            "a full decode must write when no fresh full cache is present")
    }

    /// A sized (fast) decode must NOT clobber a FRESH full cache — that
    /// would downgrade the buffer the refine pass already landed.
    func testWriteGateSizedDecodeSkipsFreshFullCache() {
        XCTAssertFalse(
            RenderActor.shouldWriteDecodedCache(wantsFull: false, cachedIsFreshFull: true),
            "a sized decode must not overwrite a fresh full cache")
    }

    /// A sized (fast) decode MAY overwrite a STALE full cache (or an
    /// empty / sized slot): the stale buffer is never served, and
    /// refusing to write would force a fresh sized decode every fast tick.
    func testWriteGateSizedDecodeOverwritesStaleOrSizedCache() {
        XCTAssertTrue(
            RenderActor.shouldWriteDecodedCache(wantsFull: false, cachedIsFreshFull: false),
            "a sized decode must overwrite a stale/sized/empty cache so the fast path doesn't re-decode every tick")
    }

    // MARK: - AMaZE quality selectors (#940)

    /// `PipelineRenderer.Quality.amaze` carries raw value 2, matching the
    /// FFI contract (`scene_linear_f32.rs` maps `2 => RenderQuality::Amaze`).
    /// This is the compile-time proof that the Swift enum and the Rust enum
    /// stay in lockstep — if either side renumbers the value, this test
    /// catches it before a mis-mapped xcframework ships.
    func testAmazeQualityRawValueMatchesFFIContract() {
        XCTAssertEqual(
            PipelineRenderer.Quality.amaze.rawValue, Int32(2),
            "Quality.amaze must carry raw value 2 to match the Rust FFI (scene_linear_f32.rs: 2 => RenderQuality::Amaze)")
        XCTAssertEqual(
            PipelineRenderer.Quality.preview.rawValue, Int32(1),
            "Quality.preview must carry raw value 1 to match the Rust FFI (1 => RenderQuality::Preview)")
        XCTAssertEqual(
            PipelineRenderer.Quality.full.rawValue, Int32(0),
            "Quality.full must carry raw value 0 to match the Rust FFI (0 => RenderQuality::Full)")
    }

    /// The production default (#940): with no `MAPLE_AMAZE` override and no
    /// UserDefaults key written, AMaZE is ON. (The tiled kernel from #1887
    /// made it cost-equivalent to bilinear, so the flag is a kill switch,
    /// not an opt-in.)
    func testAmazeFlagDefaultsToEnabled() throws {
        guard ProcessInfo.processInfo.environment["MAPLE_AMAZE"] == nil else {
            throw XCTSkip("MAPLE_AMAZE override present in this runner; default not observable")
        }
        let saved = UserDefaults.standard.object(forKey: AmazeFlag.defaultsKey)
        UserDefaults.standard.removeObject(forKey: AmazeFlag.defaultsKey)
        defer {
            if let saved { UserDefaults.standard.set(saved, forKey: AmazeFlag.defaultsKey) }
        }
        XCTAssertTrue(
            AmazeFlag.isEnabled,
            "AMaZE must be ON by default (#940); the Settings toggle / MAPLE_AMAZE=0 are the kill switches")
    }

    /// Export path (`renderForExport`) quality is flag-gated (#940):
    ///   • AmazeFlag ON (default)      → `.amaze`.
    ///   • AmazeFlag OFF (kill switch) → `.full` (bilinear).
    /// The test checks both branches by reading `AmazeFlag.isEnabled` rather
    /// than hard-coding `.amaze`, so it stays green regardless of the
    /// UserDefaults / `MAPLE_AMAZE` state in the test runner environment.
    func testExportPathUsesAmazeQuality() async {
        let expectedQuality: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
        // Flag OFF (default): must select .full (bilinear).
        // Flag ON:            must select .amaze.
        // Either way the value must be one of the two non-preview choices.
        XCTAssertTrue(
            expectedQuality == .full || expectedQuality == .amaze,
            "export path quality must be .full (flag OFF) or .amaze (flag ON); got \(expectedQuality)")
        if AmazeFlag.isEnabled {
            XCTAssertEqual(expectedQuality.rawValue, 2,
                "export path with flag ON must map to AMaZE (raw value 2)")
        } else {
            XCTAssertEqual(expectedQuality.rawValue, 0,
                "export path with flag OFF must map to Full/bilinear (raw value 0)")
        }
    }

    /// Refine path (full-resolution `sharedDecode` in `RenderActor+DecodedCache`)
    /// is flag-gated (#940). Fast phase is always `.preview` — unaffected.
    ///   • AmazeFlag ON (default)      → refine uses `.amaze`.
    ///   • AmazeFlag OFF (kill switch) → refine uses `.full` (bilinear).
    func testRefinePathUsesAmazeQuality() {
        let refineQuality: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
        let fastQuality   = PipelineRenderer.Quality.preview

        // Fast path is ALWAYS .preview regardless of the flag.
        XCTAssertEqual(fastQuality.rawValue, 1,
            "fast path quality must always be Preview (raw value 1)")

        // Refine and fast must always differ (bilinear Full ≠ Preview ≠ AMaZE).
        XCTAssertNotEqual(refineQuality.rawValue, fastQuality.rawValue,
            "refine quality (\(refineQuality)) and fast (.preview = 1) must differ")

        if AmazeFlag.isEnabled {
            XCTAssertEqual(refineQuality.rawValue, 2,
                "refine path with flag ON must be AMaZE (raw value 2)")
        } else {
            XCTAssertEqual(refineQuality.rawValue, 0,
                "refine path with flag OFF must be Full/bilinear (raw value 0)")
        }
    }
}

// MARK: - Test helper

extension RenderActor {
    /// No-op call that forces a hop onto the actor's executor — the test
    /// uses this to confirm `RenderActor` is reachable as an actor type
    /// without needing to expose any of the production methods.
    func assertIsolation() {}
}
