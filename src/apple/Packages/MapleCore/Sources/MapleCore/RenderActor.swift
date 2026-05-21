// RenderActor.swift — actor boundary for the per-image render pipeline.
//
// Slice 2 of 3 — issue #194. This file now owns the decoded-image cache
// and the FFI decode coalescers. EditSession still owns the two-phase
// scheduler, the publish layer (`renderedPreview`), and asset-switch
// identity; slice 3 moves the scheduler in.
//
// Surface today (slice 2):
//
//   • `init(pipeline:)` — accepts the shared `ImageEditPipeline` actor.
//
//   • `renderPreview(asset:model:)` — thin pass-through preserved from
//     slice 1 so the slice-1 actor-boundary tests keep working. No
//     cache, no scheduling, no generation guard.
//
//   • `sharedDecode(asset:normalize:)` — single-flight Rust FFI decode
//     per asset. Replaces the same-named method on EditSession. Writes
//     the actor's `decodedImage` / `decodedForAssetID` /
//     `decodedSidecarMtime` / `decodedAtModel` / `decodedRawResolution`
//     fields, returns the normalised CIImage. The `normalize` closure
//     hops back to the caller's actor (MainActor in production) to apply
//     `decodedForNativeCanvas` — see the rationale at its call site.
//
//   • `coalescedRefineDecode(asset:target:decode:)` — register-before-
//     await for refine peers. Same shape and semantics as the prior
//     EditSession method, just moved.
//
//   • `renderForExport(asset:model:asShot:)` — full-quality export
//     bypass of the preview cache. Moved verbatim from EditSession.
//
//   • `invalidate()` — drop every cached field. EditSession's public
//     `invalidateDecodedCache()` forwards here.
//
//   • `snapshot(forAsset:)` — one-await accessor for render-path
//     consumers that need to read `(image, decodedAtModel,
//     decodedRawResolution, isFresh)` atomically. The freshness check
//     is computed against the live sidecar mtime so the actor doesn't
//     need to know about EditSession.
//
//   • `seed(...)` / `seedIfUnpopulated(...)` — seed the cache from a
//     non-Rust source (cached preview, embedded JPEG). Hydration uses
//     `seedIfUnpopulated` so the populated-check and the cache write
//     happen in a single actor entry — without atomicity, a background
//     Rust decode landing between the check and the seed would let
//     hydration overwrite the high-quality buffer with the inferior
//     preview.
//
//   • `_testSeedDecodedCache(...)` / `_testDecodedCachePopulated(forAsset:)`
//     — test hooks mirroring the prior EditSession surface so the
//     `EditSessionDecodedCacheTests` suite continues to exercise the
//     freshness state machine without paying the Rust FFI cost.
//
// What slice 2 deliberately does NOT move (per the planning brief):
//
//   • The two-phase scheduler (`_scheduleRender`, `_scheduleRefine`,
//     `refineVisibleRegion`, `decodeAndRender`, `renderFull`) — still
//     on EditSession in `EditSession+Render.swift`. Slice 3 moves it.
//
//   • `persistCurrentPreviewToCache` — reads `renderedPreview` /
//     `previewSize` from EditSession, has no coupling to the decoded-
//     image cache. Stays on EditSession.
//
//   • Sidecar parse + mtime helpers — pure static functions; left on
//     EditSession as `static` so both the actor and EditSession can
//     call them without a circular import.

import Foundation
import CoreImage

/// Per-session actor boundary for the render pipeline. Owns the decoded-
/// image cache (slice 2) plus its single-flight and per-target coalescers.
public actor RenderActor {
    /// Shared GPU pipeline (Metal kernels + `CIContext`). Constructed by
    /// `EditSession` and handed in — keeping a single `ImageEditPipeline`
    /// per session preserves the current GPU-resource lifetime.
    private let pipeline: ImageEditPipeline

    // MARK: - Decoded-image cache state (moved from EditSession in slice 2)

    /// Cached decode for the current asset. Populated by `sharedDecode`
    /// or `seed(...)`; consumed by `snapshot(forAsset:)` on the hot
    /// render path. The MainActor scheduler reads this through the
    /// snapshot accessor — direct access from outside the actor is not
    /// permitted (actor isolation enforces this at compile time).
    private var decodedImage: CIImage?

    /// Underlying pixel resolution of `decodedImage` before the
    /// `decodedForNativeCanvas` upscale. See the matching doc on
    /// EditSession (pre-move) for the load-bearing detail about why
    /// `.extent.size` of the cached buffer is not the same thing.
    private var decodedRawResolution: CGSize = .zero
    private var decodedForAssetID: AssetRef.ID?
    private var decodedSidecarMtime: Date?
    private var decodedAtModel: AdjustmentModel?

    /// Single-flight Rust FFI decode handle for the current asset.
    private var decodeTask: Task<CIImage?, Never>?
    private var decodeTaskAssetID: AssetRef.ID?

    /// Refine-decode coalescer — see the doc on the prior EditSession
    /// field for the architectural detail. Kept here so the test suite
    /// `EditSessionRefineCoalesceTests` continues to verify the
    /// register-before-await semantics, and as a safety net for any
    /// future re-introduction of a sized refine path.
    private var refineDecodeTasks: [RefineDecodeKey: RefineDecodeSlot] = [:]
    private var refineDecodeSlotCounter: UInt64 = 0

    /// Slot value paired with a `Task<CIImage?, Never>` so cleanup at
    /// task completion can match its own insertion. See the prior
    /// EditSession definition for the rationale.
    struct RefineDecodeSlot {
        let id: UInt64
        let task: Task<CIImage?, Never>
    }

    /// Composite key for the refine-decode coalescer dictionary.
    struct RefineDecodeKey: Hashable {
        let assetID: AssetRef.ID
        let widthPx: Int
        let heightPx: Int

        init(assetID: AssetRef.ID, target: CGSize) {
            self.assetID = assetID
            self.widthPx = Int(target.width.rounded())
            self.heightPx = Int(target.height.rounded())
        }
    }

    /// Atomic-ish snapshot consumed by the hot render path. One `await`
    /// per render request, rather than 3-4 round-trips against
    /// individual actor properties (each of which would race the others
    /// across the isolation boundary). `isFresh` is computed against
    /// the live sidecar mtime so the snapshot reflects the same
    /// freshness contract as `decodedCacheIsFreshForCurrentAsset`.
    public struct DecodedSnapshot: Sendable {
        public let image: CIImage?
        public let decodedAtModel: AdjustmentModel?
        public let rawResolution: CGSize
        public let isFresh: Bool
    }

    public init(pipeline: ImageEditPipeline) {
        self.pipeline = pipeline
    }

    // MARK: - Slice 1 surface (preserved)

    /// Render a preview CIImage for `asset` against `model`.
    ///
    /// Thin pass-through preserved from slice 1 — see commit history for
    /// the original rationale. Slice 2 does not route the EditSession
    /// scheduler through this method; it stays for the
    /// `RenderActorTests` boundary check until slice 3 takes ownership.
    public func renderPreview(
        asset: AssetRef,
        model: AdjustmentModel
    ) async throws -> CIImage {
        if !asset.isRaw {
            try Task.checkCancellation()
            guard let decoded = await pipeline.decodeSceneLinearNonRaw(
                asset: asset, targetSize: nil
            ) else {
                throw RenderError.pipelineFailed
            }
            try Task.checkCancellation()
            return pipeline.processSceneLinearNonRaw(
                decoded: decoded, model: model, targetSize: nil
            )
        }

        let sidecar: URL? = {
            guard let url = asset.sidecarURL,
                  FileManager.default.fileExists(atPath: url.path)
            else { return nil }
            return url
        }()
        try Task.checkCancellation()
        guard let decoded = await pipeline.decodeSceneLinear(
            asset: asset, quality: .preview, xmpPath: sidecar
        ) else {
            throw RenderError.pipelineFailed
        }
        try Task.checkCancellation()
        return pipeline.processSceneLinear(
            decoded: decoded,
            model: model,
            targetSize: nil,
            asShot: nil,
            decodedAtModel: nil
        )
    }

    // MARK: - Export

    /// Bake the current model against a fresh full-quality decode for
    /// export. Bypasses the preview-quality decoded-image cache. Moved
    /// verbatim from `EditSession+Decode.renderForExport()` — see that
    /// commit history for the design.
    public func renderForExport(
        asset: AssetRef,
        model: AdjustmentModel,
        asShot: ImageEditPipeline.AsShotWB?
    ) async throws -> CIImage {
        let pipeline = self.pipeline
        let m = model

        if !asset.isRaw {
            guard let decoded = await pipeline.decodeSceneLinearNonRaw(
                asset: asset, targetSize: nil
            ) else {
                throw RenderError.pipelineFailed
            }
            return await Task.detached(priority: .userInitiated) {
                pipeline.processSceneLinearNonRaw(
                    decoded: decoded, model: m, targetSize: nil
                )
            }.value
        }

        let sidecar: URL? = {
            guard let url = asset.sidecarURL,
                  FileManager.default.fileExists(atPath: url.path)
            else { return nil }
            return url
        }()
        guard let decoded = await pipeline.decodeSceneLinear(
            asset: asset, quality: .full, xmpPath: sidecar
        ) else {
            throw RenderError.pipelineFailed
        }
        let exportDecodedAtModel = EditSession.parseSidecarModel(for: asset)
        return await Task.detached(priority: .userInitiated) {
            pipeline.processSceneLinear(
                decoded: decoded,
                model: m,
                targetSize: nil,
                asShot: asShot,
                decodedAtModel: exportDecodedAtModel
            )
        }.value
    }

    // MARK: - Single-flight decode (moved from EditSession)

    /// Decode `asset` through the Rust FFI at most once even if multiple
    /// concurrent callers race in. Writes the actor's decode cache on
    /// completion. The `normalize` closure runs the post-decode
    /// `decodedForNativeCanvas` step — it's an injected callback so the
    /// caller (MainActor `EditSession`) can keep its `nativeImageSize`
    /// side-effects in MainActor isolation rather than racing them on
    /// the actor's executor (see the planning-brief option (b) for
    /// rationale).
    ///
    /// `normalize` is called for the freshly-decoded CIImage AND for
    /// the piggy-backed result from a peer task — the cached buffer the
    /// actor publishes is always the normalised one.
    func sharedDecode(
        asset: AssetRef,
        normalize: @escaping @Sendable (CIImage, AssetRef) async -> CIImage
    ) async -> CIImage? {
        // Piggy-back: a peer caller is already running the FFI for the
        // same asset. Await its raw decode then normalise locally — the
        // peer may not have published yet, so we don't rely on the
        // actor cache having been written.
        if let existing = decodeTask, decodeTaskAssetID == asset.id {
            guard let decoded = await existing.value else { return nil }
            // Asset-switch guard: if the caller's session moved to a
            // different asset while we were piggy-backing, return the
            // raw decode without re-publishing — the caller's identity
            // check will drop it. We don't have a `self.asset` on the
            // actor; the caller passes the asset they want, so an
            // asset-switch must be observed by the caller's identity
            // check after this returns.
            if decodedAtModel == nil {
                decodedAtModel = EditSession.parseSidecarModel(for: asset)
            }
            return await normalize(decoded, asset)
        }
        decodeTask = nil
        decodeTaskAssetID = nil

        let decodeSignpostID = editSessionSignposter.makeSignpostID()
        let decodeState = editSessionSignposter.beginInterval("decode", id: decodeSignpostID)

        let extensionIsRaw = asset.isRaw
        let needsSniff = asset.primaryURL == nil
            && asset.hintExtension == nil
            && asset.explicitIsRaw == nil
        let task: Task<CIImage?, Never> = Task.detached(priority: .userInitiated) { [pipeline] in
            var dispatchAsset = asset
            var dispatchIsRaw = extensionIsRaw
            if needsSniff, let provider = asset.bytesProvider {
                if let bytes = try? await provider() {
                    if let detected = AssetRef.detectIsRaw(bytes: bytes) {
                        dispatchIsRaw = detected
                    }
                    let cachedBytes = bytes
                    let displayName = asset.displayName
                    let hint: String? = {
                        if dispatchIsRaw { return asset.hintExtension }
                        if bytes.count >= 4 {
                            if bytes[0] == 0xFF, bytes[1] == 0xD8 { return "jpg" }
                            if bytes[0] == 0x89, bytes[1] == 0x50 { return "png" }
                            if bytes.count >= 8 {
                                if bytes[4] == 0x66, bytes[5] == 0x74,
                                   bytes[6] == 0x79, bytes[7] == 0x70 {
                                    return "heic"
                                }
                            }
                        }
                        return asset.hintExtension
                    }()
                    dispatchAsset = AssetRef(
                        displayName: displayName,
                        hintExtension: hint,
                        stableID: asset.stableID,
                        explicitIsRaw: dispatchIsRaw,
                        bytesProvider: { cachedBytes }
                    )
                }
            }

            if !dispatchIsRaw {
                return await mapleStageAsync("ImageIO non-RAW decode") {
                    await pipeline.decodeSceneLinearNonRaw(
                        asset: dispatchAsset, targetSize: nil
                    )
                }
            }
            let asset = dispatchAsset
            let sidecar: URL? = {
                guard let url = asset.sidecarURL,
                      FileManager.default.fileExists(atPath: url.path)
                else { return nil }
                return url
            }()
            let decoded = await mapleStageAsync("rust FFI scene-linear decode") {
                await pipeline.decodeSceneLinear(asset: asset, xmpPath: sidecar)
            }
            guard let decoded else { return nil }
            return decoded
        }
        decodeTask = task
        decodeTaskAssetID = asset.id

        let decoded = await task.value
        editSessionSignposter.endInterval("decode", decodeState)

        guard let decoded else {
            if decodeTaskAssetID == asset.id {
                decodeTask = nil
                decodeTaskAssetID = nil
            }
            return nil
        }

        let normalized = await normalize(decoded, asset)
        decodedImage = normalized
        decodedRawResolution = decoded.extent.size
        decodedForAssetID = asset.id
        decodedAtModel = EditSession.parseSidecarModel(for: asset)
        decodedSidecarMtime = EditSession.sidecarMtime(for: asset)
        if decodeTaskAssetID == asset.id {
            decodeTask = nil
            decodeTaskAssetID = nil
        }
        return normalized
    }

    /// Coalesce concurrent refine decodes by `(asset, target)`.
    ///
    /// Register-before-await ordering matters: we synchronously install
    /// the task in `refineDecodeTasks` BEFORE the first `await` so a
    /// sibling caller arriving during the closure's body sees the in-
    /// flight task and joins. Same race fix applied to `sharedDecode`.
    @discardableResult
    public func coalescedRefineDecode(
        asset: AssetRef,
        target: CGSize,
        decode: @escaping @Sendable () async -> CIImage?
    ) async -> CIImage? {
        let key = RefineDecodeKey(assetID: asset.id, target: target)
        if let existing = refineDecodeTasks[key] {
            editSessionLogger.debug(
                "coalescedRefineDecode joined in-flight task for \(target.width, format: .fixed(precision: 0))x\(target.height, format: .fixed(precision: 0))"
            )
            return await existing.task.value
        }
        refineDecodeSlotCounter &+= 1
        let slotID = refineDecodeSlotCounter
        let task = Task<CIImage?, Never>.detached(priority: .userInitiated) {
            await decode()
        }
        refineDecodeTasks[key] = RefineDecodeSlot(id: slotID, task: task)
        let result = await task.value
        if refineDecodeTasks[key]?.id == slotID {
            refineDecodeTasks[key] = nil
        }
        return result
    }

    // MARK: - Cache lifecycle

    /// Drop every cached field. EditSession's public
    /// `invalidateDecodedCache()` forwards here. In-flight tasks are
    /// NOT cancelled — their detached work runs to completion and the
    /// result is dropped by the caller's gen check upstream.
    public func invalidate() {
        decodedImage = nil
        decodedRawResolution = .zero
        decodedForAssetID = nil
        decodedSidecarMtime = nil
        decodeTask = nil
        decodeTaskAssetID = nil
        refineDecodeTasks.removeAll()
        decodedAtModel = nil
    }

    /// Snapshot the cache for `asset`. Returns the cached buffer iff it
    /// matches the requested asset and the live sidecar mtime equals
    /// the captured mtime. The caller threads the result into the hot
    /// render path; freshness can flip false even with a non-nil image
    /// (the live mtime moved), so always honour the `isFresh` flag.
    public func snapshot(forAsset asset: AssetRef) -> DecodedSnapshot {
        let isFresh = (decodedForAssetID == asset.id)
            && (EditSession.sidecarMtime(for: asset) == decodedSidecarMtime)
        return DecodedSnapshot(
            image: decodedImage,
            decodedAtModel: decodedAtModel,
            rawResolution: decodedRawResolution,
            isFresh: isFresh
        )
    }

    // MARK: - Hydration interop (slice 2 plan item 5)

    /// Seed the cache from a non-Rust source (cached preview, embedded
    /// JPEG). EditSession's seed methods stay on MainActor (they own
    /// the `renderedPreview` write); they call here for the cache-only
    /// fields. `rawResolution` is the buffer's pre-normalise extent;
    /// `sidecarMtime` defaults to the current live mtime so the seed
    /// behaves like a real cold decode against the on-disk sidecar.
    public func seed(
        asset: AssetRef,
        decoded: CIImage,
        rawResolution: CGSize,
        decodedAtModel: AdjustmentModel? = nil
    ) {
        self.decodedImage = decoded
        self.decodedRawResolution = rawResolution
        self.decodedForAssetID = asset.id
        self.decodedSidecarMtime = EditSession.sidecarMtime(for: asset)
        self.decodedAtModel = decodedAtModel
    }

    /// Atomic populated-check + seed. Returns `true` iff the seed was
    /// accepted (the cache was empty for this asset and got written),
    /// `false` iff a higher-quality decode already populated the cache.
    ///
    /// Slice-2 callers (cached-preview / embedded-JPEG seed paths) use
    /// this to avoid a TOCTOU race against the background Rust decode:
    /// without atomicity, a check-then-write across two actor hops can
    /// be interleaved with the Rust task's seed-on-completion and the
    /// inferior preview buffer overwrites the high-quality decode. One
    /// actor entry collapses the window to zero.
    public func seedIfUnpopulated(
        asset: AssetRef,
        decoded: CIImage,
        rawResolution: CGSize,
        decodedAtModel: AdjustmentModel? = nil
    ) -> Bool {
        if decodedImage != nil && decodedForAssetID == asset.id {
            return false
        }
        self.decodedImage = decoded
        self.decodedRawResolution = rawResolution
        self.decodedForAssetID = asset.id
        self.decodedSidecarMtime = EditSession.sidecarMtime(for: asset)
        self.decodedAtModel = decodedAtModel
        return true
    }

    // MARK: - Test hooks

    /// Test hook — manually populate the cache fields with a synthetic
    /// CIImage. NOT for production use; the seed methods above are the
    /// real path.
    internal func _testSeedDecodedCache(
        asset: AssetRef,
        decoded: CIImage,
        rawResolution: CGSize,
        sidecarMtime: Date?,
        decodedAtModel: AdjustmentModel? = nil
    ) {
        self.decodedImage = decoded
        self.decodedRawResolution = rawResolution
        self.decodedForAssetID = asset.id
        self.decodedSidecarMtime = sidecarMtime
        self.decodedAtModel = decodedAtModel
    }

    /// Test inspector — true when `decodedImage` has been populated for
    /// the requested asset.
    internal func _testDecodedCachePopulated(forAsset asset: AssetRef) -> Bool {
        decodedImage != nil && decodedForAssetID == asset.id
    }

    /// Test inspector — exposes the freshness state machine for the
    /// `EditSessionDecodedCacheTests` mtime-change assertions.
    internal func _testDecodedCacheIsFresh(forAsset asset: AssetRef) -> Bool {
        snapshot(forAsset: asset).isFresh
    }

    /// Test inspector — read the `decodedAtModel` field for the
    /// `testInvalidateClearsAllCacheFields` post-invalidate assertion.
    internal var _testDecodedAtModel: AdjustmentModel? { decodedAtModel }
}
