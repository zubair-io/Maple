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
    func testEditSessionExposesRenderActor() {
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
        // `renderActor` is package-internal — the type-checker requiring
        // a hop confirms it's an actor reference, not a placeholder.
        let ref: RenderActor = session.renderActor
        _ = ref
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
}

// MARK: - Test helper

extension RenderActor {
    /// No-op call that forces a hop onto the actor's executor — the test
    /// uses this to confirm `RenderActor` is reachable as an actor type
    /// without needing to expose any of the production methods.
    func assertIsolation() {}
}
