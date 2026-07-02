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
        profile: Profile = .auto,
        normalize: @escaping @Sendable (CIImage, AssetRef) async -> CIImage
    ) async -> CIImage? {
        // Videos are selectable for metadata editing (#1638) but have no still
        // frame to decode. No-op the decode rather than feeding container bytes
        // to libraw (RAW path) or CGImageSource (non-RAW path) — both would fail
        // or produce garbage. `AssetRef.isRaw` already returns false for video;
        // this is the single chokepoint all open/render dispatch funnels
        // through, so guarding here covers every entry point.
        if asset.isVideo {
            return nil
        }
        let wantsFull = (target == nil)
        // #871: the decode buffer is profile-dependent for RAW (Auto
        // develops auto_exposure Off; Neutral keeps it On). Pass the live
        // profile into the scene-linear decode as an override so its
        // AE-Off-when-Auto decision tracks the user's current selection,
        // and make it part of the decode-cache + in-flight-task identity so
        // a profile toggle re-decodes instead of serving the wrong buffer.
        // Non-RAW has no Auto Profile cube, so no override / no keying.
        let decodeProfile: Profile? = asset.isRaw ? profile : nil
        // Reuse an in-flight task only when it already satisfies the
        // caller's fullness requirement AND was launched for the same
        // profile. A fast (sized) caller can join any (same-profile) task;
        // a refine (full) caller must NOT join a sized task.
        if let existing = decodeTask, decodeTaskAssetID == asset.id,
           decodeTaskProfile == decodeProfile,
           (!wantsFull || decodeTaskIsFull) {
            // #951: JOIN an in-flight, identity-compatible decode. Do NOT create
            // or flip a cancel flag here — same-asset slider ticks during a cold
            // open share this one decode and its flag; nobody cancels until a
            // genuinely different decode supersedes it (the replace path below).
            guard let (decoded, _, _) = await existing.value else { return nil }
            if decodedAtModel == nil {
                decodedAtModel = EditSession.parseSidecarModel(for: asset)
            }
            return await normalize(decoded, asset)
        }
        // #951: a DIFFERENT-identity decode is superseding the in-flight one
        // (different asset / profile / fullness) — abandon it. Flip its flag so
        // the Rust worker unwinds mid-stage instead of running to completion,
        // then drop our reference (the in-flight Task still holds its own).
        decodeCancelFlag?.requestCancel()
        decodeCancelFlag = nil
        decodeTask = nil
        decodeTaskAssetID = nil

        let decodeSignpostID = editSessionSignposter.makeSignpostID()
        let decodeState = editSessionSignposter.beginInterval("decode", id: decodeSignpostID)

        let extensionIsRaw = asset.isRaw
        let needsSniff = asset.primaryURL == nil
            && asset.hintExtension == nil
            && asset.explicitIsRaw == nil
        let decodeTarget = target
        // #951: a fresh cancel flag for THIS decode. Captured strongly by the
        // detached Task below (`[pipeline, cancelFlag]`) so it outlives the
        // synchronous FFI call the worker runs even if the actor's stored
        // reference is replaced/cleared meanwhile — no use-after-free on the
        // Rust side. Stored on the actor so the replace path / invalidate /
        // cancelAll can flip it to abandon this decode.
        let cancelFlag = CancelFlag()
        decodeCancelFlag = cancelFlag
        let task: Task<(CIImage, [Float]?, UInt32)?, Never> = Task.detached(priority: .userInitiated) { [pipeline, cancelFlag, self] in
            var dispatchAsset = asset
            var dispatchIsRaw = extensionIsRaw
            if needsSniff, let provider = asset.bytesProvider {
                if let bytes = try? await provider() {
                    if let detected = AssetRef.detectIsRaw(bytes: bytes) {
                        dispatchIsRaw = detected
                        // Surface the AUTHORITATIVE content sniff so the GPU
                        // live path tags `inputShape` from the same signal the
                        // decode uses, not the RAW-defaulting `AssetRef.isRaw`
                        // (#1553). Only a definitive sniff is recorded — an
                        // unrecognised signature leaves `resolvedIsRaw` nil so
                        // callers fall back to `AssetRef.isRaw`.
                        await self.recordResolvedIsRaw(asset.id, detected)
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
                // full-res decode (#785). Non-RAW has no noise profile.
                let nonRawImage = await mapleStageAsync("ImageIO non-RAW decode") {
                    await pipeline.decodeSceneLinearNonRaw(
                        asset: dispatchAsset, targetSize: decodeTarget
                    )
                }
                guard let nonRawImage else { return nil }
                return (nonRawImage, nil, 0)
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
                let sizedResult = await mapleStageAsync("rust FFI scene-linear sized decode") {
                    await pipeline.decodeSceneLinearSized(
                        asset: asset, targetSize: decodeTarget, xmpPath: sidecar,
                        profileOverride: decodeProfile, cancel: cancelFlag
                    )
                }
                guard let sizedResult else { return nil }
                return (sizedResult.image, sizedResult.noiseProfile, sizedResult.iso)
            }
            // #940 — refine pass (full-resolution): use AMaZE when AmazeFlag
            // is enabled, otherwise bilinear Full (the production default).
            // Fast phase routes through `decodeSceneLinearSized` above with
            // quality: .preview (half-res bilinear). Only the full decode
            // (wantsFull == true, decodeTarget == nil) lands here, so the
            // AMaZE path never fires on a per-slider-tick fast decode.
            let refineQuality: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
            let refineResult = await mapleStageAsync("rust FFI scene-linear decode") {
                await pipeline.decodeSceneLinear(
                    asset: asset, quality: refineQuality, xmpPath: sidecar,
                    profileOverride: decodeProfile, cancel: cancelFlag
                )
            }
            guard let refineResult else { return nil }
            return (refineResult.image, refineResult.noiseProfile, refineResult.iso)
        }
        decodeTask = task
        decodeTaskAssetID = asset.id
        decodeTaskIsFull = wantsFull
        decodeTaskProfile = decodeProfile

        let decodeResult = await task.value
        editSessionSignposter.endInterval("decode", decodeState)

        guard let (decoded, decodeNoiseProfile, decodeISO) = decodeResult else {
            if decodeTaskAssetID == asset.id {
                decodeTask = nil
                decodeTaskAssetID = nil
            }
            // #951: clear our cancel flag only if it's still the live one (a
            // superseding decode may have replaced it). `===` identity, not the
            // asset id, because a same-asset successor would share the id.
            if decodeCancelFlag === cancelFlag { decodeCancelFlag = nil }
            return nil
        }

        let normalized = await normalize(decoded, asset)
        // A sized fast decode must NOT clobber a full-resolution cache
        // that a concurrent refine already landed — but only while that
        // full cache is still FRESH. A STALE full cache (sidecar mtime
        // changed) is never served (`snapshot.isFresh` is false, so the
        // render path re-decodes), and refusing to overwrite it would
        // strand it there and force a fresh sized decode on every fast
        // tick. So a sized decode may overwrite a stale full cache; it
        // may not overwrite a fresh one. Full decodes always write. The
        // fullness flag drives refine's re-decode decision (#785).
        //
        // Capture the live baked model (stripped sidecar model) once and
        // reuse it for the stored `decodedBakedModel` so the write-gate and
        // the value written can't disagree across a concurrent sidecar edit
        // (TOCTOU). #950 — the in-memory decode cache keys on the baked
        // model, not sidecar mtime: a STRIPPED-field edit (re-applied live
        // per tick) must not invalidate it, only a baked-field edit may.
        // The mtime is captured alongside as a fast-path gate for the
        // per-tick freshness check (see `snapshot`); read it FIRST so a
        // write landing mid-capture can only make a future check do an extra
        // parse, never serve stale.
        let currentMtime = EditSession.sidecarMtime(for: asset)
        let currentBaked = Self.bakedModel(for: asset)
        let sameAssetCached = (decodedForAssetID == asset.id) && (decodedImage != nil)
        let cachedIsFreshFull = sameAssetCached
            && decodedIsFull
            && (decodedBakedModel == currentBaked)
        let shouldWrite = Self.shouldWriteDecodedCache(
            wantsFull: wantsFull, cachedIsFreshFull: cachedIsFreshFull
        )
        if shouldWrite {
            decodedImage = normalized
            decodedRawResolution = decoded.extent.size
            decodedForAssetID = asset.id
            decodedAtModel = EditSession.parseSidecarModel(for: asset)
            decodedBakedModel = currentBaked
            decodedSidecarMtime = currentMtime
            decodedIsFull = wantsFull
            decodedProfile = decodeProfile  // #871 — buffer is profile-keyed
            // PR #1709 review fix 4: store noise profile + ISO alongside the
            // decoded buffer so processSceneLinear can forward them to the NR
            // stage without a re-decode. Written only on the same shouldWrite
            // path as the image itself — a fast decode that doesn't clobber a
            // fresh full cache also doesn't update the noise profile/ISO.
            decodedNoiseProfile = decodeNoiseProfile
            decodedISO = decodeISO
        }
        if decodeTaskAssetID == asset.id {
            decodeTask = nil
            decodeTaskAssetID = nil
        }
        // #951: clear our cancel flag iff still the live one (see failure path).
        if decodeCancelFlag === cancelFlag { decodeCancelFlag = nil }
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

    // MARK: - Write-gate predicate (pure, testable)

    /// Decide whether a just-completed decode may write the decoded-image
    /// cache. A full decode always wins. A sized (fast) decode writes
    /// unless a FRESH full cache for the same asset is already present —
    /// it must not downgrade a fresh full buffer, but it MAY overwrite a
    /// stale one (which is never served anyway) so the fast path isn't
    /// forced to re-decode every tick (#785).
    nonisolated static func shouldWriteDecodedCache(
        wantsFull: Bool, cachedIsFreshFull: Bool
    ) -> Bool {
        wantsFull || !cachedIsFreshFull
    }

    // MARK: - Cache lifecycle (slice 2)

    public func invalidate() {
        decodedImage = nil
        decodedRawResolution = .zero
        decodedForAssetID = nil
        decodedBakedModel = nil
        decodedSidecarMtime = nil
        decodedIsFull = false
        // #951: abandon any in-flight cold decode — flip its flag so the Rust
        // worker unwinds, then drop our reference (the in-flight Task keeps its
        // own across the FFI call).
        decodeCancelFlag?.requestCancel()
        decodeCancelFlag = nil
        decodeTask = nil
        decodeTaskAssetID = nil
        decodeTaskIsFull = false
        decodeTaskProfile = nil
        refineDecodeTasks.removeAll()
        decodedAtModel = nil
        decodedProfile = nil
        decodedNoiseProfile = nil
        decodedISO = 0
    }

    public func snapshot(forAsset asset: AssetRef) -> DecodedSnapshot {
        // #950 — freshness is keyed on the baked model (stripped sidecar
        // model), not sidecar mtime. The decode reads the on-disk sidecar,
        // so the buffer stays valid as long as the sidecar's *baked* (KEPT)
        // fields are unchanged; a STRIPPED-field edit (re-applied live per
        // tick) bumps mtime but not the baked model, so the cache stays
        // fresh — the win.
        //
        // This runs on every slider tick, and recomputing the baked model is
        // a synchronous XMP parse + model alloc. To keep the per-tick hot
        // path allocation-free (CLAUDE.md § Performance invariants), gate the
        // parse behind a cheap mtime stat: an UNCHANGED mtime proves the file
        // is byte-identical ⇒ the baked model is unchanged ⇒ skip the parse.
        // Only when the mtime actually moved (a save landed) — or the fast
        // path is disabled (`decodedSidecarMtime == nil`: no sidecar at
        // decode time, or a divergent test seed) — do we parse and compare
        // the authoritative baked model. mtime can only make us do MORE work
        // (parse on a same-baked save), never serve a stale buffer.
        let assetMatches = (decodedForAssetID == asset.id)
        let isFresh: Bool
        if !assetMatches {
            isFresh = false
        } else if let mt = decodedSidecarMtime,
                  EditSession.sidecarMtime(for: asset) == mt {
            // File untouched since decode → baked model unchanged.
            isFresh = true
        } else {
            isFresh = (Self.bakedModel(for: asset) == decodedBakedModel)
        }
        return DecodedSnapshot(
            image: decodedImage,
            decodedAtModel: decodedAtModel,
            rawResolution: decodedRawResolution,
            isFresh: isFresh,
            isFull: decodedIsFull,
            profile: decodedProfile,
            noiseProfile: decodedNoiseProfile,
            iso: decodedISO
        )
    }

    // MARK: - Baked-model freshness key (#950)

    /// The model the in-memory decode is keyed on: the asset's on-disk
    /// sidecar model with the Apple-GPU (live-re-applied) stages stripped.
    /// `nil` when no sidecar is on disk — the FFI then decodes from
    /// `AdjustmentModel::default()`, whose stripped form is itself a fixed
    /// default. We represent that "no sidecar" case as `nil` (rather than
    /// `stripAppleGPUStages(.default)`) so a sidecar appearing/disappearing
    /// is detected even when its baked fields happen to equal the defaults
    /// — the decode call shape differs (xmp_path null vs a temp XMP), and
    /// distinguishing the two preserves the old mtime key's nil-vs-present
    /// semantics for the edges the existing tests cover.
    ///
    /// `profile` is deliberately normalised OUT of this key: profile
    /// freshness is already owned by `decodedProfile` / `profileMatches`
    /// (#871), and the decode's profile comes from the LIVE override, not
    /// the sidecar. Leaving the sidecar's profile in the key would re-decode
    /// ~750 ms after a profile toggle — when the debounced autosave finally
    /// lands the new profile in the sidecar and this recompute stops
    /// matching the stored value — even though the #871 path already
    /// produced the correct buffer at toggle time. That is exactly the
    /// wasteful re-decode #950 removes, just on the profile axis.
    /// `stripAppleGPUStages` does NOT strip `profile`, so we reset it here.
    nonisolated static func bakedModel(for asset: AssetRef) -> AdjustmentModel? {
        guard EditSession.sidecarMtime(for: asset) != nil else { return nil }
        var m = RawCoreBridge.stripAppleGPUStages(
            EditSession.parseSidecarModel(for: asset)
        )
        m.profile = AdjustmentModel().profile  // #871 owns profile freshness
        return m
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
        self.decodedSidecarMtime = EditSession.sidecarMtime(for: asset)  // #950 fast-path gate
        self.decodedBakedModel = Self.bakedModel(for: asset)  // #950
        self.decodedAtModel = decodedAtModel
        // Seeded buffers (cached rendered preview / embedded JPEG) are
        // low-resolution display previews, never a full decode — refine
        // must upgrade them (#785).
        self.decodedIsFull = false
        // Seeded buffers carry no Auto/Neutral develop distinction; mark
        // the profile unknown so the first real render re-decodes for RAW
        // Auto rather than reusing an AE-On preview under the Auto cube.
        self.decodedProfile = nil
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
        self.decodedSidecarMtime = EditSession.sidecarMtime(for: asset)  // #950 fast-path gate
        self.decodedBakedModel = Self.bakedModel(for: asset)  // #950
        self.decodedAtModel = decodedAtModel
        self.decodedIsFull = false
        self.decodedProfile = nil  // #871 — see `seed(...)`
        return true
    }
}
