// RenderActor+TestHooks.swift — the `_test…` seed/inspector surface.
//
// Owns the test-only hooks the package test target uses to seed the
// decoded-image cache directly and to inspect scheduler/cache state
// (`_testSeedDecodedCache`, the `_testDecoded…` inspectors, and the
// `_testRenderTaskInFlight` / `_testRefineTaskInFlight` scheduler
// inspectors). Split out of `RenderActor.swift` under the #785 file-size
// budget; `internal` so the package test target reaches them, and actor
// isolation is preserved because the extension stays on the actor
// in-module (same shape as `RenderActor+DecodedCache.swift`).

import Foundation
import CoreImage

extension RenderActor {
    // MARK: - Test hooks

    /// Seed the decoded-image cache directly for tests. `bakedModel` is the
    /// stripped model the buffer is treated as having been decoded from
    /// (#950) — pass it explicitly to drive freshness assertions, or leave
    /// it `nil` to capture the asset's current on-disk sidecar (production
    /// parity, matching `seed(...)`).
    internal func _testSeedDecodedCache(
        asset: AssetRef,
        decoded: CIImage,
        rawResolution: CGSize,
        bakedModel: AdjustmentModel? = nil,
        decodedAtModel: AdjustmentModel? = nil,
        isFull: Bool = true,
        profile: Profile? = nil,
        aeGain: Float = 1.0
    ) {
        self.decodedImage = decoded
        self.decodedRawResolution = rawResolution
        self.decodedForAssetID = asset.id
        self.decodedBakedModel = bakedModel ?? Self.bakedModel(for: asset)
        // Capture the live mtime as the fast-path gate ONLY when the baked
        // model came from disk (production parity). An explicit override may
        // intentionally diverge from the on-disk sidecar, so disable the
        // fast path (nil mtime ⇒ always parse-and-compare) to keep the
        // override authoritative (#950).
        self.decodedSidecarMtime = (bakedModel == nil)
            ? EditSession.sidecarMtime(for: asset) : nil
        self.decodedAtModel = decodedAtModel
        self.decodedIsFull = isFull
        self.decodedProfile = profile
        // #1167/#2070 — defaults to 1.0 (the no-op gain), same as a
        // production seed; pass explicitly to test the AE-gain plumbing.
        self.decodedAeGain = aeGain
        // Mirror the production write path (#2049): every cache write —
        // seeded or real — bumps the identity generation.
        self.decodeGeneration &+= 1
    }

    internal func _testDecodedIsFull() -> Bool { decodedIsFull }

    internal func _testDecodeGeneration() -> UInt64 { decodeGeneration }

    internal func _testDecodedCachePopulated(forAsset asset: AssetRef) -> Bool {
        decodedImage != nil && decodedForAssetID == asset.id
    }

    internal func _testDecodedCacheIsFresh(forAsset asset: AssetRef) -> Bool {
        snapshot(forAsset: asset).isFresh
    }

    internal var _testDecodedAtModel: AdjustmentModel? { decodedAtModel }

    /// Test inspector — true when a render task is currently in flight
    /// (not yet completed, not cancelled). Used by
    /// `RenderActorSchedulerTests` to assert cancel-previous semantics.
    internal func _testRenderTaskInFlight() -> Bool {
        guard let task = renderTask else { return false }
        return !task.isCancelled
    }

    internal func _testRefineTaskInFlight() -> Bool {
        guard let task = refineTask else { return false }
        return !task.isCancelled
    }
}
