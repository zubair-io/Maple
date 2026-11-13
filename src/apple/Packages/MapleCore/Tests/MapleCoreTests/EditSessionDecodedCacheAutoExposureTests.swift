// EditSessionDecodedCacheAutoExposureTests.swift — #1387 companion to
// EditSessionDecodedCacheTests.swift (split out to stay under the 600-line
// hard budget, CONTRIBUTING.md § "File-size budget" — same rationale as the
// run-stage sibling test files).
//
// Covers the `autoExposure` axis of the decoded-image cache identity:
// `auto_exposure` is itself a decode-baked field (like `profile`, #871), and
// `EditorState.applyAuto` can flip it on the LIVE model without waiting for
// the debounced sidecar write, so a mismatch must be treated as a cache MISS
// exactly like a profile mismatch — see `RenderActor.decodedAutoExposure`.

import XCTest
import CoreImage
@testable import MapleCore

@MainActor
final class EditSessionDecodedCacheAutoExposureTests: XCTestCase {

    /// #1387: `auto_exposure` is itself a decode-baked field with the same
    /// staleness/identity story as `profile` (#871) — `EditorState.applyAuto`
    /// can flip it on the LIVE model (on `Profile.neutral`) without waiting
    /// for the debounced sidecar write, so the `autoExposure` param must
    /// route through `sharedDecode` to a DISTINCT decode and the cache must
    /// re-key on it, mirroring `EditSessionDecodedCacheTests
    /// .testSharedDecodeReKeysOnProfile871` but holding `profile` fixed at
    /// `.neutral` and toggling `autoExposure` instead. Fixture-gated on a
    /// real RAW (the FFI must actually develop AE).
    func testSharedDecodeReKeysOnAutoExposure1387() async throws {
        let fixturePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("test-fixtures/raws/test_0003.CR2")
        guard FileManager.default.fileExists(atPath: fixturePath.path) else {
            throw XCTSkip("test_0003.CR2 fixture not present; skipping")
        }
        let asset = AssetRef(url: fixturePath)
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        let identity: @Sendable (CIImage, AssetRef) async -> CIImage = { img, _ in img }

        // Full-res decode (target nil) so a single cache slot is written.
        // `profile` is held at `.neutral` throughout — raw-ffi only forces
        // AE off internally for `.auto`, so Neutral is the profile where
        // `autoExposure` alone must drive the decode.
        guard let aeOn = await actor.sharedDecode(
            asset: asset, target: nil, profile: .neutral, autoExposure: .on, normalize: identity
        ) else { throw XCTSkip("AE-On decode nil") }
        let snapOn = await actor.snapshot(forAsset: asset)
        XCTAssertEqual(snapOn.autoExposure, .on,
                       "cache must record the AE-On decode's autoExposure")

        guard let aeOff = await actor.sharedDecode(
            asset: asset, target: nil, profile: .neutral, autoExposure: .off, normalize: identity
        ) else { throw XCTSkip("AE-Off decode nil") }
        let snapOff = await actor.snapshot(forAsset: asset)
        XCTAssertEqual(snapOff.autoExposure, .off,
                       "an AE-Off decode after an AE-On one must RE-KEY the cache to Off "
                       + "(not serve the cached AE-On buffer) — #1387")

        // The capture decode (#5377) applies auto exposure in its creative
        // stage, so the two decodes differ in the gain they carry, not in
        // their pixels.
        XCTAssertEqual(snapOff.aeGain, 1.0, "the AE-Off decode carries no exposure gain")
        XCTAssertGreaterThan(
            snapOn.aeGain, 1.05,
            "the AE-On decode must carry its gain — equal means the autoExposure param "
            + "didn't route to a distinct decode / cache served the wrong buffer")
        XCTAssertFalse(snapOn.wbFrame?.creative === snapOff.wbFrame?.creative)
        _ = (aeOn, aeOff)
    }
}
