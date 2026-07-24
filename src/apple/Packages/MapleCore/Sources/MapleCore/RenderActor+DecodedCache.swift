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
// never joins an in-flight sized fast task. `quality` (#2143) is the axis
// that now actually distinguishes a refine sized decode from a fast one —
// see `sharedDecode`'s doc comment.

import Foundation
import CoreImage

extension RenderActor {
    // MARK: - Single-flight decode (slice 2)

    /// Single-flight decode. `target` drives the downsample (#785):
    ///   • `nil`  — full-resolution decode. No production caller passes
    ///              this today (see the #1637/#2143 note on the sized
    ///              branch below) — kept for a hypothetical future
    ///              nil-target caller.
    ///   • sized  — downsampled decode bounded to `target`. RAW routes
    ///              through the sized scene-linear FFI (`maxLongEdge`);
    ///              non-RAW routes through the ImageIO thumbnail decode.
    ///              The full-res bitmap is never allocated just because a
    ///              caller's target happens to approach native (#785).
    ///
    /// `quality` (#2143) is the axis that now actually distinguishes fast
    /// from refine for RAW: fast always requests `.preview` (half-res);
    /// refine escalates to `.full`/`.amaze` when its target needs more
    /// detail than `.preview` can deliver — see `ImageEditPipeline.
    /// refineDecodeQuality`. It is part of the in-flight-task join identity
    /// alongside `target`'s fullness and `profile`, so a quality-escalated
    /// caller never joins (and silently downgrades to) an in-flight
    /// lower-quality task for the same asset.
    ///
    /// A `nil`-target caller never joins an in-flight sized task — that
    /// would hand back a low-res buffer. The cache's `decodedIsFull` flag is
    /// set so `snapshot(forAsset:)` can tell the refine pass whether the
    /// cached decode is sufficient.
    func sharedDecode(
        asset: AssetRef,
        target: CGSize? = nil,
        profile: Profile = .auto,
        autoExposure: AutoExposureMode = .on,
        quality: PipelineRenderer.Quality = .preview,
        normalize: @escaping @Sendable (CIImage, AssetRef) async -> CIImage
    ) async -> CIImage? {
        // Videos are selectable for metadata editing (#1638) but have no still
        // frame to decode. No-op the decode rather than feeding container bytes
        // to libraw (RAW path) or CGImageSource (non-RAW path) — both would fail
        // or produce garbage. `AssetRef.isRaw` already returns false for video;
        // this is the single chokepoint all open/render dispatch funnels
        // through, so guarding here covers every entry point.
        //
        // Same treatment for stub images (eip/braw/afphoto/ai) and audio
        // (mp3/wav/m4a/aac, #1835) — metadata-only, no pixels to decode.
        if asset.isVideo || asset.isStub || asset.isAudio {
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
        // #1387: the decode buffer is also auto_exposure-dependent for RAW
        // — `auto_exposure` is itself a decode-baked field, and
        // `EditorState.applyAuto` can flip it on the live model (Neutral
        // profile) without waiting for the debounced sidecar write. Same
        // treatment as `decodeProfile` immediately above.
        let decodeAutoExposure: AutoExposureMode? = asset.isRaw ? autoExposure : nil
        // Reuse an in-flight task only when it already satisfies the
        // caller's fullness requirement AND was launched for the same
        // profile + autoExposure + quality. A fast (sized) caller can join
        // any (same-identity) task; a refine (full) caller must NOT join a
        // sized task. #2143: quality must match too — a refine call
        // escalated to `.full`/`.amaze` must not join an in-flight
        // `.preview` fast task (or vice versa), which would silently hand
        // back the wrong-quality buffer.
        if let existing = decodeTask, decodeTaskAssetID == asset.id,
           decodeTaskProfile == decodeProfile,
           decodeTaskAutoExposure == decodeAutoExposure,
           decodeTaskQuality == quality,
           (!wantsFull || decodeTaskIsFull) {
            // #951: JOIN an in-flight, identity-compatible decode. Do NOT create
            // or flip a cancel flag here — same-asset slider ticks during a cold
            // open share this one decode and its flag; nobody cancels until a
            // genuinely different decode supersedes it (the replace path below).
            guard let (decoded, _, _, _, _) = await existing.value else { return nil }
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
        let task: Task<(CIImage, [Float]?, UInt32, WbSliderFrame?, Float)?, Never> = Task.detached(priority: .userInitiated) { [pipeline, cancelFlag, self] in
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
                return (nonRawImage, [Float]?.none, UInt32(0), WbSliderFrame?.none, Float(1.0))
            }
            let asset = dispatchAsset
            let sidecar: URL? = {
                guard let url = asset.sidecarURL,
                      FileManager.default.fileExists(atPath: url.path)
                else { return nil }
                return url
            }()
            // RAW fast phase AND refine both route through the sized scene-
            // linear FFI (`maxLongEdge`) so the Rust decoder never allocates
            // a full-sensor-resolution buffer just because the viewport
            // asked for one (#785/#1637). What used to distinguish refine
            // from fast — a `nil` target routing to the unsized full/AMaZE
            // decode below — stopped happening once `ImageEditPipeline.
            // decodeTarget` started always returning a bounded target
            // (#1637): every caller here passes a sized target now, fast
            // AND refine alike. `quality` is what actually carries that
            // distinction post-#2143: fast always requests `.preview`
            // (half-res); refine's caller (`EditSession.decodeAndRender`)
            // escalates to `.full`/`.amaze` via `ImageEditPipeline.
            // refineDecodeQuality` whenever the requested target exceeds
            // what `.preview` can deliver (roughly native/2) — see that
            // function's doc comment for the upscale-then-downscale waste
            // this removes. Below that threshold `.preview` already decodes
            // exactly the requested target, so quality stays `.preview` and
            // this call is bit-identical to pre-#2143 behaviour.
            if let decodeTarget {
                let sizedResult = await mapleStageAsync("rust FFI scene-linear sized decode") {
                    await pipeline.decodeSceneLinearSized(
                        asset: asset, targetSize: decodeTarget, xmpPath: sidecar,
                        quality: quality,
                        profileOverride: decodeProfile, autoExposureOverride: decodeAutoExposure,
                        cancel: cancelFlag
                    )
                }
                guard let sizedResult else { return nil }
                return (
                    sizedResult.image, sizedResult.noiseProfile, sizedResult.iso,
                    sizedResult.wbFrame, sizedResult.aeGain
                )
            }
            // #940 — legacy full-resolution branch: `target == nil` no
            // longer occurs from any production call site (see above), but
            // stays as the correct behaviour for a hypothetical future nil-
            // target caller (e.g. a `renderFull()`-style path) — AMaZE when
            // AmazeFlag is enabled, otherwise bilinear Full.
            let refineQuality: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
            let refineResult = await mapleStageAsync("rust FFI scene-linear decode") {
                await pipeline.decodeSceneLinear(
                    asset: asset, quality: refineQuality, xmpPath: sidecar,
                    profileOverride: decodeProfile, autoExposureOverride: decodeAutoExposure,
                    cancel: cancelFlag
                )
            }
            guard let refineResult else { return nil }
            return (
                refineResult.image, refineResult.noiseProfile, refineResult.iso,
                refineResult.wbFrame, refineResult.aeGain
            )
        }
        decodeTask = task
        decodeTaskAssetID = asset.id
        decodeTaskIsFull = wantsFull
        decodeTaskProfile = decodeProfile
        decodeTaskAutoExposure = decodeAutoExposure
        decodeTaskQuality = quality

        let decodeResult = await task.value
        editSessionSignposter.endInterval("decode", decodeState)

        guard let (decoded, decodeNoiseProfile, decodeISO, decodeWbFrame, decodeAeGain) = decodeResult else {
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
        // A sized fast decode must NOT clobber a cache that already COVERS
        // it — a fresh cache at least as large, same asset/profile/baked
        // model. Downgrading resolution silently is the bug (#785); the
        // read-side coverage check in `decodeAndRender` re-evaluates against
        // whatever the CURRENT cache holds, so an overwrite that DOES happen
        // is never served below the size it was decoded at. But letting the
        // write through anyway would defeat #2039's whole point: a fast tick
        // completing after a bigger refine-covering decode would evict the
        // buffer refine was about to reuse, forcing a redundant re-decode on
        // every fast/refine alternation at the same zoom. So the gate keys on
        // COVERAGE (this decode's resolution vs. what's already cached), not
        // on `decodedIsFull` alone — `decodedIsFull` is only ever true for a
        // literal full decode (nothing currently requests one through this
        // path, #2039), so keying solely on it made every sized decode write
        // unconditionally.
        //
        // Profile MUST gate the coverage claim too: a same-or-larger cache
        // for a DIFFERENT profile does not already have this decode's data
        // (#871 — Auto vs Neutral develop different buffers at any size), so
        // a profile mismatch always allows the write. Skipping this check
        // would wedge a profile switch to a smaller target in a permanent
        // loop — the new-profile decode is discarded as "already covered" by
        // the stale old-profile buffer, the read side detects the profile
        // mismatch and re-decodes, and the write gate discards it again.
        // AutoExposure gates the same way (#1387) — same reasoning, same
        // hazard, since `auto_exposure` is also a live-override-owned
        // decode-baked field.
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
        let newRawResolution = decoded.extent.size
        let sameAssetCached = (decodedForAssetID == asset.id) && (decodedImage != nil)
        let cachedCoversNewDecode = Self.cacheCoversNewDecode(
            sameAsset: sameAssetCached,
            sameProfile: decodedProfile == decodeProfile,
            sameAutoExposure: decodedAutoExposure == decodeAutoExposure,
            sameBakedModel: decodedBakedModel == currentBaked,
            cachedRawResolution: decodedRawResolution,
            newRawResolution: newRawResolution
        )
        let shouldWrite = Self.shouldWriteDecodedCache(
            wantsFull: wantsFull, cachedCoversNewDecode: cachedCoversNewDecode
        )
        if shouldWrite {
            decodedImage = normalized
            decodedRawResolution = newRawResolution
            decodedForAssetID = asset.id
            decodedAtModel = EditSession.parseSidecarModel(for: asset)
            decodedBakedModel = currentBaked
            decodedSidecarMtime = currentMtime
            decodedIsFull = wantsFull
            decodedProfile = decodeProfile  // #871 — buffer is profile-keyed
            decodedAutoExposure = decodeAutoExposure  // #1387 — buffer is autoExposure-keyed too
            // PR #1709 review fix 4: store noise profile + ISO alongside the
            // decoded buffer so processSceneLinear can forward them to the NR
            // stage without a re-decode. Written only on the same shouldWrite
            // path as the image itself — a fast decode that doesn't clobber a
            // covering cache also doesn't update the noise profile/ISO.
            decodedNoiseProfile = decodeNoiseProfile
            decodedISO = decodeISO
            // #1781: the slider-frame export rides the same write gate as
            // the buffer it describes.
            decodedWbFrame = decodeWbFrame
            // #1167/#2070: the AE-gain export rides the same write gate —
            // `NativeDetailRenderer` needs the gain of the buffer actually
            // on screen, not a stale one from a superseded decode.
            decodedAeGain = decodeAeGain
            // #2049: identity bump — any real write means the uploaded GPU
            // buffer (if any) is now potentially stale even at unchanged dims.
            decodeGeneration &+= 1
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

    // MARK: - Refine-sufficiency predicate (pure, testable, #2039)

    /// Whether a cached decode is sufficient for the REFINE phase: either a
    /// genuine full-resolution decode, or a sized decode whose extent already
    /// COVERS the requested `targetSize` (holds every pixel the request
    /// needs, so reuse can never publish below the requested quality — the
    /// #785 invariant, preserved via coverage rather than exact fullness). A
    /// `nil` target (the `renderFull()` export-prep path) has no bound to
    /// check coverage against, so only `isFull` can satisfy it.
    nonisolated static func refineCacheSufficient(
        isFull: Bool, rawResolution: CGSize, targetSize: CGSize?
    ) -> Bool {
        if isFull { return true }
        guard let targetSize else { return false }
        return rawResolution.width >= targetSize.width - 0.5
            && rawResolution.height >= targetSize.height - 0.5
    }

    // MARK: - Write-gate coverage predicate (pure, testable, #2039/#871)

    /// Whether the EXISTING cache already covers what a just-completed
    /// decode would offer — same asset, same profile (#871), same baked
    /// model (#950), and a resolution at least as large as the new decode's.
    /// All four must hold: profile and baked-model mismatches mean the
    /// cached pixels are DIFFERENT content, not merely a smaller version of
    /// the same content, so a mismatch on either always yields `false`
    /// (permit the write) regardless of resolution. Skipping the profile
    /// check here would wedge a profile switch to a smaller target in a
    /// permanent loop: the new-profile decode gets discarded as "already
    /// covered" by the stale old-profile buffer, the read-side profile
    /// check (`decodeAndRender`'s `profileMatches`) detects the mismatch and
    /// re-decodes, and the write gate discards the result again forever.
    nonisolated static func cacheCoversNewDecode(
        sameAsset: Bool,
        sameProfile: Bool,
        sameAutoExposure: Bool = true,
        sameBakedModel: Bool,
        cachedRawResolution: CGSize,
        newRawResolution: CGSize
    ) -> Bool {
        sameAsset && sameProfile && sameAutoExposure && sameBakedModel
            && cachedRawResolution.width >= newRawResolution.width - 0.5
            && cachedRawResolution.height >= newRawResolution.height - 0.5
    }

    // MARK: - Write-gate predicate (pure, testable)

    /// Decide whether a just-completed decode may write the decoded-image
    /// cache. A full decode always wins. A sized (fast) decode writes unless
    /// the cache ALREADY COVERS it — same asset, same profile, same baked
    /// model, and a resolution at least as large as this decode's (#2039)
    /// — in which case writing would only downgrade or needlessly re-store
    /// an equivalent buffer. `cachedCoversNewDecode` is never served past its
    /// own coverage claim: the read-side coverage check in `decodeAndRender`
    /// re-evaluates against whatever IS in the cache, so a write that DOES
    /// go through is always safe to serve at its own size (#785).
    nonisolated static func shouldWriteDecodedCache(
        wantsFull: Bool, cachedCoversNewDecode: Bool
    ) -> Bool {
        wantsFull || !cachedCoversNewDecode
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
        decodeTaskAutoExposure = nil
        refineDecodeTasks.removeAll()
        decodedAtModel = nil
        decodedProfile = nil
        decodedAutoExposure = nil
        decodedNoiseProfile = nil
        decodedISO = 0
        decodedWbFrame = nil
        decodedAeGain = 1.0
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
            autoExposure: decodedAutoExposure,
            noiseProfile: decodedNoiseProfile,
            iso: decodedISO,
            wbFrame: decodedWbFrame,
            aeGain: decodedAeGain,
            decodeGeneration: decodeGeneration
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
    /// `autoExposure` (#1387) gets the identical treatment for the identical
    /// reason: it's owned by `decodedAutoExposure` / the live override, not
    /// the sidecar, so it's normalised out here too.
    nonisolated static func bakedModel(for asset: AssetRef) -> AdjustmentModel? {
        guard EditSession.sidecarMtime(for: asset) != nil else { return nil }
        var m = RawCoreBridge.stripAppleGPUStages(
            EditSession.parseSidecarModel(for: asset)
        )
        m.profile = AdjustmentModel().profile  // #871 owns profile freshness
        m.autoExposure = AdjustmentModel().autoExposure  // #1387 owns autoExposure freshness
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
        // Seeded buffers likewise carry no known auto-exposure state
        // (#1387) — same reasoning as `decodedProfile` above.
        self.decodedAutoExposure = nil
        // Seeded preview buffers carry no slider-frame export (#1781); a
        // stale frame from a previous decode must not describe them.
        self.decodedWbFrame = nil
        // Seeded preview buffers carry no AE-gain export (#1167/#2070); 1.0
        // is the correct no-op gain for a buffer with no explicit export
        // (matches `MapleSceneLinearImageData.aeGain`'s default).
        self.decodedAeGain = 1.0
        // #2049: a seed is a cache WRITE — bump identity so a GPU-live
        // session uploaded from the previous buffer knows to re-upload.
        self.decodeGeneration &+= 1
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
        self.decodedAutoExposure = nil  // #1387 — see `seed(...)`
        self.decodedWbFrame = nil  // #1781 — see `seed(...)`
        self.decodedAeGain = 1.0  // #1167/#2070 — see `seed(...)`
        self.decodeGeneration &+= 1  // #2049 — see `seed(...)`
        return true
    }
}
