// RenderActor+DecodedCache.swift — decoded-image cache + FFI decode
// coalescers for the per-image render pipeline (slice 2 of issue #194).
//
// Split out of `RenderActor.swift` to keep that file under the file-size
// budget (#785 CI gate). These methods are an `extension RenderActor`, so
// they remain actor-isolated and mutate the stored cache properties
// declared in the main actor body (`decodedImage`, `decodeTask`,
// `refineDecodeTasks`, …) — those are `internal` (not `private`) precisely
// so this extension can reach them across files within the module.
//
// This file owns:
//   • `sharedDecode(asset:target:normalize:)`        — single-flight decode
//   • `coalescedRefineDecode(asset:target:decode:)`  — refine coalescer
//   • `invalidate()`                                  — cache teardown
//   • `snapshot(forAsset:)`                           — cache read
//   • `seed(...)` / `seedIfUnpopulated(...)`          — cache priming
//
// `target` drives the fast-phase downsample (#785): a sized decode never
// poisons the full-resolution refine cache, and a refine (full) caller
// never joins an in-flight sized fast task.

import Foundation
import CoreImage

extension RenderActor {
    // MARK: - Single-flight decode (slice 2)

    /// Single-flight decode. `target` drives the downsample (#785):
    ///   • `nil`  — full-resolution decode. Used by the refine pass and
    ///              export so the final render is never lower quality.
    ///   • sized  — downsampled fast-phase decode. RAW routes through the
    ///              sized scene-linear FFI (`maxLongEdge`); non-RAW routes
    ///              through the ImageIO thumbnail decode. The full-res
    ///              bitmap is never allocated for the viewport phase.
    ///
    /// A `nil`-target (refine) caller never joins an in-flight sized fast
    /// task — that would hand back a low-res buffer. The cache's
    /// `decodedIsFull` flag is set so `snapshot(forAsset:)` can tell the
    /// refine pass whether the cached decode is sufficient.
    func sharedDecode(
        asset: AssetRef,
        target: CGSize? = nil,
        normalize: @escaping @Sendable (CIImage, AssetRef) async -> CIImage
    ) async -> CIImage? {
        let wantsFull = (target == nil)
        // Reuse an in-flight task only when it already satisfies the
        // caller's fullness requirement. A fast (sized) caller can join
        // any task; a refine (full) caller must NOT join a sized task.
        if let existing = decodeTask, decodeTaskAssetID == asset.id,
           (!wantsFull || decodeTaskIsFull) {
            guard let decoded = await existing.value else { return nil }
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
        let decodeTarget = target
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
                // Fast phase passes a viewport `target` so ImageIO decodes
                // a downsampled thumbnail; refine passes `nil` for the
                // full-res decode (#785).
                return await mapleStageAsync("ImageIO non-RAW decode") {
                    await pipeline.decodeSceneLinearNonRaw(
                        asset: dispatchAsset, targetSize: decodeTarget
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
            // RAW fast phase routes through the sized scene-linear FFI
            // (`maxLongEdge`) so the Rust decoder never allocates a
            // full-sensor-resolution buffer for the viewport (#785). Only
            // the size differs from the refine path — `quality: .preview`
            // is unchanged, so refine output is bit-identical to today.
            // Refine / export (`decodeTarget == nil`) keep the unsized
            // full-resolution decode.
            if let decodeTarget {
                let decoded = await mapleStageAsync("rust FFI scene-linear sized decode") {
                    await pipeline.decodeSceneLinearSized(
                        asset: asset, targetSize: decodeTarget, xmpPath: sidecar
                    )
                }
                guard let decoded else { return nil }
                return decoded
            }
            let decoded = await mapleStageAsync("rust FFI scene-linear decode") {
                await pipeline.decodeSceneLinear(asset: asset, xmpPath: sidecar)
            }
            guard let decoded else { return nil }
            return decoded
        }
        decodeTask = task
        decodeTaskAssetID = asset.id
        decodeTaskIsFull = wantsFull

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
        // A sized fast decode must NOT clobber a full-resolution cache
        // that a concurrent refine already landed — only write the cache
        // when this decode is at least as good as what's there (full
        // beats sized; a sized decode only fills an empty / sized slot
        // for the same asset). The fullness flag drives refine's
        // re-decode decision (#785).
        let sameAssetCached = (decodedForAssetID == asset.id) && (decodedImage != nil)
        let shouldWrite = wantsFull || !(sameAssetCached && decodedIsFull)
        if shouldWrite {
            decodedImage = normalized
            decodedRawResolution = decoded.extent.size
            decodedForAssetID = asset.id
            decodedAtModel = EditSession.parseSidecarModel(for: asset)
            decodedSidecarMtime = EditSession.sidecarMtime(for: asset)
            decodedIsFull = wantsFull
        }
        if decodeTaskAssetID == asset.id {
            decodeTask = nil
            decodeTaskAssetID = nil
        }
        return normalized
    }

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

    // MARK: - Cache lifecycle (slice 2)

    public func invalidate() {
        decodedImage = nil
        decodedRawResolution = .zero
        decodedForAssetID = nil
        decodedSidecarMtime = nil
        decodedIsFull = false
        decodeTask = nil
        decodeTaskAssetID = nil
        decodeTaskIsFull = false
        refineDecodeTasks.removeAll()
        decodedAtModel = nil
    }

    public func snapshot(forAsset asset: AssetRef) -> DecodedSnapshot {
        let isFresh = (decodedForAssetID == asset.id)
            && (EditSession.sidecarMtime(for: asset) == decodedSidecarMtime)
        return DecodedSnapshot(
            image: decodedImage,
            decodedAtModel: decodedAtModel,
            rawResolution: decodedRawResolution,
            isFresh: isFresh,
            isFull: decodedIsFull
        )
    }

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
        // Seeded buffers (cached rendered preview / embedded JPEG) are
        // low-resolution display previews, never a full decode — refine
        // must upgrade them (#785).
        self.decodedIsFull = false
    }

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
        self.decodedIsFull = false
        return true
    }
}
