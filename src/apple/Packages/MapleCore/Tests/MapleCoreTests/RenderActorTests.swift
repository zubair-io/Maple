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
            sidecarMtime: nil, isFull: true
        )
        var isFull = await actor._testDecodedIsFull()
        XCTAssertTrue(isFull, "test seed with isFull: true should report full")
        await actor.invalidate()
        isFull = await actor._testDecodedIsFull()
        XCTAssertFalse(isFull, "invalidate must clear the fullness flag")
        let snapshot = await actor.snapshot(forAsset: asset)
        XCTAssertNil(snapshot.image, "invalidate must clear the cached image")
    }
}

// MARK: - Test helper

extension RenderActor {
    /// No-op call that forces a hop onto the actor's executor — the test
    /// uses this to confirm `RenderActor` is reachable as an actor type
    /// without needing to expose any of the production methods.
    func assertIsolation() {}
}
