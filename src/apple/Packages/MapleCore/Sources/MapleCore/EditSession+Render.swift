// EditSession+Render.swift — render publish layer (post-slice-3).
//
// History:
//   • Slice 2 of issue #194 — moved the decoded-image cache + the
//     Rust FFI decode + the per-target coalescer onto `RenderActor`.
//   • Slice 3 of issue #194 — moved the scheduler (renderTask /
//     refineTask handles, generation counter, debounce timers, the
//     slider-drag coalescer) onto `RenderActor`.
//
// What remains on EditSession (MainActor):
//   • `_scheduleRender` / `_scheduleRefine` — thin forwarders that build
//     a closure capturing the MainActor state needed by the body of the
//     render pass, then hand it to `renderActor.scheduleRender(...)`.
//     The closure is `@Sendable` and runs on the unstructured Task that
//     the actor spawns; it hops back to MainActor on every state access
//     via `await MainActor.run { ... }`.
//   • `decodeAndRender` / `renderFull` — the
//     actual render-pass bodies. They read MainActor state
//     (`renderedPreview`, `previewSize`, `pixelScale`, `nativeImageSize`,
//     `asShotCCT,Tint`) so they must stay on MainActor. The actor's
//     scheduler invokes them through the closure.
//
// Cancellation contract preserved end-to-end:
//   • `_scheduleRender` → `renderActor.scheduleRender(phase:work:)`
//     cancels the prior render+refine on the actor's executor before
//     spawning the new one. The captured gen-counter is checked inside
//     the render body via `await renderActor.currentGeneration() == gen`.
//   • The fast phase runs immediately (no 50 ms debounce) — the cancel-
//     previous on each schedule is enough to absorb a slider drag.
//   • The refine phase debounces 150 ms (CLAUDE.md § Performance
//     invariants). A continuous slider drag cancels the refine on every
//     tick; only the tail of the drag survives.

import Foundation
import CoreImage

@MainActor
extension EditSession {
    // MARK: - Two-phase scheduler (thin forwarders onto RenderActor)

    /// Two-phase scheduler entry. Cancels the prior render+refine on
    /// the actor, bumps the generation counter, and spawns the new
    /// render closure. Fast phase runs immediately; refine chains
    /// after fast completes.
    ///
    /// Cancellation contract: the body of the closure must run inline
    /// (no `Task { … }` chain) so cancellation propagates from the
    /// actor's task handle through `Task.isCancelled` checks inside
    /// `decodeAndRender`. Spawning a fresh inner Task would sever that
    /// chain — the actor's `renderTask?.cancel()` would no-op against a
    /// stale completed handle while the inner Task ran the full filter
    /// chain anyway. The MainActor isolation of `decodeAndRender` is
    /// satisfied by the closure's own `await` boundary; Swift hops onto
    /// MainActor at the call site.
    func _scheduleRender(phase: RenderPhase) {
        let actor = renderActor
        editSessionLogger.debug(
            "scheduleRender request phase=\(String(describing: phase), privacy: .public)"
        )
        Task {
            await actor.scheduleRender(phase: phase) { [weak self] gen in
                guard let self else { return }
                await self.fastPhaseBody(gen: gen)
                let live = await actor.currentGeneration()
                guard gen == live, !Task.isCancelled else { return }
                // Chain the refine inline so its debounced task is
                // owned by the actor (not by a new outer Task). The
                // actor's `scheduleRefine` cancel-previous still works
                // because the only handle the actor tracks is the
                // refineTask it owns.
                await self._scheduleRefine(gen: gen)
            }
        }
    }

    /// MainActor body of the fast schedule. Runs the fast-phase filter
    /// chain. Pulled out as an `async` method so the closure passed to
    /// `renderActor.scheduleRender` can be a single inline `await` —
    /// preserves cancellation propagation from the actor's task handle.
    private func fastPhaseBody(gen: UInt64) async {
        await decodeAndRender(targetSize: fastTargetSize, phase: .fast, gen: gen)
    }

    /// Kick a refine pass without re-running the fast phase. Used for
    /// pan/zoom (pixelScale changed) and viewport resizes where the
    /// cached decoded CIImage is still valid — we just need a different
    /// `targetSize` downstream.
    ///
    /// Same cancellation contract as `_scheduleRender`: the work runs
    /// inline inside the actor-spawned Task so its cancellation reaches
    /// the heavy filter-chain detached work via `Task.isCancelled`.
    func _scheduleRefine(gen requested: UInt64? = nil) {
        let actor = renderActor
        Task {
            await actor.scheduleRefine { [weak self] genAtSchedule in
                guard let self else { return }
                let gen = requested ?? genAtSchedule
                await self.refineBody(gen: gen)
            }
        }
    }

    /// MainActor body of the refine schedule (runs post-debounce).
    /// `async` rather than spawning an inner Task — see the cancellation
    /// contract on `_scheduleRender`.
    private func refineBody(gen: UInt64) async {
        let live = await renderActor.currentGeneration()
        guard gen == live, !Task.isCancelled else { return }
        // #638: when a crop is applied (tool disarmed, non-identity crop)
        // the fast refine paths below operate on FULL-FRAME source
        // geometry and can't honor the crop: the native-detail patch and the
        // deep-zoom tile composite both crop the full-frame decode to a
        // viewport rect, but `viewportSourceRect` is in CROPPED-image coords
        // (the canvas/zoom now anchor to `effectiveImageSize`). Re-rendering
        // the whole frame through `decodeAndRender(.refine)` is the correct,
        // crop-aware path (it applies `CropImageStage` on the developed
        // output) — a touch slower at deep zoom on a cropped image, but
        // correct. Full-frame (uncropped) renders keep the fast paths.
        let cropApplied = !cropEditingActive && CropImageStage.shouldApply(model.crop)
        // Native visible-region detail is the production 100% path. It uses a
        // stripped-model RAW handle and sends the resulting small scene-linear
        // patch through the same Apple display chain as the CPU canvas. The
        // legacy full-canvas tile compositor remains behind its disabled flag
        // because it publishes scene-linear tiles directly and has open color
        // parity work.
        if !cropApplied,
           asset.isRaw,
           asset.primaryURL != nil,
           // #1167/#2070: the tile develop now accepts the full-image
           // (or sized) decode's exported AE gain as an explicit scalar
           // (`NativeDetailRenderer.render(aeGain:)` →
           // `maple_render_handle_scene_linear_tile_ae_f32`) instead of
           // omitting the auto-exposure stage, so every profile is
           // parity-safe at 1:1 now — not just Auto. (Auto's decode
           // contract still disables AE outright, so its exported gain is
           // always 1.0 and this is a no-op for it; Neutral/ACR-Match
           // previously fell back to the bounded whole-image refine below
           // because a tile that omitted AE entirely would render at the
           // wrong brightness — that gap is what this closes.)
           NativeDetailLOD.shouldRender(
               pixelScale: pixelScale,
               visibleRect: viewportSourceRect
           ),
           await refineNativeDetail(gen: gen) {
            return
        }
        // Plan 3 / Ticket 06 M4 — deep-zoom branch.
        if !cropApplied,
           Self.deepZoomEnabled,
           pixelScale >= 1.0,
           !viewportSourceRect.isEmpty,
           let _ = asset.primaryURL {
            await refineDeepZoom(gen: gen)
            return
        }
        // Short-circuit when refine would render at the same (or smaller)
        // target as the most recent fast pass.
        if let fast = fastTargetSize, let refine = refinedTargetSize,
           refine.width <= fast.width + 1 && refine.height <= fast.height + 1 {
            persistCurrentPreviewToCache()
            return
        }
        // The former visible-region refine branch (crop the cached decode to
        // `viewportSourceRect`, materialise just the patch) was removed in
        // #2058: its `snapshot.isFull` gate was never true in production —
        // no interactive path requests a target-nil decode, so the cache is
        // always a sized decode whose native-coordinate crop wouldn't line
        // up anyway. Its job is covered by `refineNativeDetail` above
        // (RAW + Auto at 1:1) and by this fallback, which since #2039 reuses
        // a covering sized decode instead of re-decoding.
        await decodeAndRender(targetSize: refinedTargetSize, phase: .refine, gen: gen)
    }

    // MARK: - Unified decode + render

    /// Auto Profile (#812) — resolve (and cache) the per-image display-space
    /// CIColorCube for a CPU-path render. In `decodeAndRender`, call only from
    /// the CPU-fallback branches (after `presentViaGpuLive` has declined the
    /// frame): the fit is a cold JPEG-extract + develop the first time per
    /// image (seconds + a multi-GB develop transient on a 100MP RAW), and
    /// when the GPU live present handles the frame it does its own fit —
    /// computing this before attempting the present burns that cost on a
    /// result the GPU path never uses (#2034). `AutoProfileLUT` caches the
    /// baked cube keyed on URL+mtime+quality so slider ticks reuse it. Nil
    /// for non-RAW, `Profile::Neutral`, or fit failure. The editor decode
    /// path develops at `.preview` (RenderActor's sharedDecode +
    /// decodeSceneLinear* default to `.preview`), so the curve is fit at
    /// `.preview` to match the displayed buffer (#844).
    private func autoProfileLUTForCPURender(asset: AssetRef, model m: AdjustmentModel) async -> CIFilter? {
        guard asset.isRaw, m.profile == .auto, let url = asset.primaryURL else { return nil }
        return await AutoProfileLUT.shared.filter(forRawAt: url, profile: m.profile, quality: .preview)
    }

    func decodeAndRender(targetSize: CGSize?, phase: RenderPhase, gen: UInt64? = nil) async {
        // Videos are selectable for metadata editing (#1638) but have no still
        // frame to develop. No-op the render rather than feeding container bytes
        // to a decoder — `AssetRef.isRaw` is already false for video (so libraw
        // is never reached), but the non-RAW path would still hand the .mov to
        // CGImageSource. This is the single body all render phases (fast/refine/
        // renderFull) funnel through, so guarding here covers every entry point.
        //
        // Stub images (eip/braw/afphoto/ai) and audio (mp3/wav/m4a/aac, #1835)
        // get the same treatment: metadata-only, no pixels to develop, no
        // decode attempt of any kind.
        if self.asset.isVideo || self.asset.isStub || self.asset.isAudio {
            isRendering = false
            return
        }
        isRendering = true
        renderPhase = phase
        let asset = self.asset
        // #1781: adopt the decode-exported WB slider frame BEFORE capturing
        // the model + anchor (this snapshot is also the freshness read).
        let snapshot = await renderActor.snapshot(forAsset: asset)
        adoptDecodedWbFrame(snapshot.wbFrame)
        let m = model
        let pipeline = self.pipeline
        // Crop + straighten (#638). Applied as a CoreImage geometry op on the
        // FINAL developed CIImage — the crop is not in the Rust core on Apple,
        // so it rides here on the published preview. The crop applies only
        // when the tool is NOT armed (`!cropEditingActive`): while armed the
        // overlay sits over the full frame and the render shows the uncropped
        // image. `effectiveCrop` already folds in that armed/disarmed gate.
        let crop = effectiveCrop
        let applyCrop = CropImageStage.shouldApply(crop)
        // #2117: the oriented native full-frame size is the resolution-
        // independent reference `CropImageStage.apply` rounds the crop rect
        // against — so the fast (viewport-res) and refine (~2×) phases cut the
        // IDENTICAL normalized region and the cropped image doesn't shift when
        // the sharp refine render replaces the blurry fast one. Same reference
        // the canvas leaf frame uses (`effectiveImageSize` → `croppedSize`).
        let cropNativeSize = nativeImageSize
        // #2049: the crop actually folded into the presented pixels — part of
        // the GPU-live upload identity alongside the decode generation (see
        // `presentViaGpuLive`). A crop CHANGE alters `CropImageStage.apply`'s
        // output at possibly-unchanged dims, so identity must fold it in
        // rather than relying on dims alone.
        let appliedCrop = applyCrop ? crop : Crop.identity
        // #2143: bound every downstream target — the GPU present, the crop-
        // adjusted CPU process target, and the decode request derived from it —
        // to what a `quality: .preview` RAW decode can actually deliver
        // (native/2 per axis, the Rust half-res demosaic ceiling). A target
        // above the ceiling cannot add detail (the decode is ceiling-limited
        // in raw-core regardless of what is requested); it only inflates the
        // prescale output and the published buffer with upscaled-then-
        // downscaled half-res data — at 100% zoom on a 100 MP frame that was
        // a ~432 MB published RGBAf16 buffer carrying 6144-px-worth of true
        // detail. True 1:1 stays `refineNativeDetail`'s job (the tile path).
        // No-op while `nativeImageSize` hasn't seeded (async for
        // bytes-provider assets) or for non-RAW assets (ImageIO decodes are
        // not half-res-capped). The crop-inflation below runs on the capped
        // value by design: its inverse-fraction upscale exists to keep the
        // KEPT region at requested resolution and is already bounded by the
        // source resolution at prescale time.
        let cappedTargetSize = targetSize.map {
            ImageEditPipeline.previewCeilingCapped(
                $0, nativeSize: nativeImageSize, isRaw: asset.isRaw
            )
        }
        // #1617: the GPU live present crops the decoded scene-linear buffer
        // itself (a geometry op before the f32 readback), so it opens the
        // session at the CROPPED dims and needs the un-upscaled canvas target —
        // the cropped buffer already IS the kept region. Capture it before the
        // CPU-path upscale shadows `targetSize` just below. (Derived from the
        // #2143 preview-ceiling-capped value so the GPU path is bounded too.)
        let gpuTargetSize = cappedTargetSize
        // When a crop is applied the chain still develops the FULL frame and
        // `CropImageStage` trims afterward. The incoming `targetSize` is sized
        // for the CROPPED extent (the canvas/zoom anchor to `effectiveImageSize`),
        // so prescaling the full frame to it would render the kept region too
        // soft. Scale the full-frame process target up by the inverse crop
        // fraction so the kept region lands at (about) the requested resolution.
        // Capped so a tiny crop on a 100 MP frame can't request an absurd
        // full-frame target (the source's own resolution is the real ceiling
        // — `prescaleForDisplay` never upscales past it anyway).
        let targetSize: CGSize? = {
            guard applyCrop, let t = cappedTargetSize else { return cappedTargetSize }
            let fracW = max(crop.right - crop.left, CropGeometry.minCropFraction)
            let fracH = max(crop.bottom - crop.top, CropGeometry.minCropFraction)
            let scaleW = CGFloat(min(1.0 / fracW, 8.0))
            let scaleH = CGFloat(min(1.0 / fracH, 8.0))
            return CGSize(width: t.width * scaleW, height: t.height * scaleH)
        }()
        let cached = snapshot.image
        // Fast phase accepts any fresh cache (a downsampled decode is fine
        // for the viewport). Refine defers to `refineCacheSufficient` (#2039):
        // either a genuine full-resolution decode, or a sized cache whose
        // extent already covers this request — a covering cache holds every
        // pixel the request needs, so reusing it can never publish below the
        // requested quality (the #785 invariant, preserved via coverage
        // rather than exact fullness). `targetSize` here is the crop-
        // adjusted local computed just above.
        let cacheSufficient = (phase == .fast) || RenderActor.refineCacheSufficient(
            isFull: snapshot.isFull, rawResolution: snapshot.rawResolution, targetSize: targetSize
        )
        // #871: the decode buffer is profile-dependent for RAW (Auto =
        // auto_exposure Off; Neutral = On). A cache developed for a
        // different profile is a MISS — reusing it would put the Auto
        // curve over an AE-On buffer (the blowout) or render Neutral on an
        // AE-Off buffer. Non-RAW buffers carry `profile == nil` and are
        // profile-agnostic, so they stay fresh. A `nil` profile on a RAW
        // cache (a seeded preview / embedded JPEG) also forces a re-decode
        // so the first real render develops at the correct AE.
        let profileMatches = !asset.isRaw || (snapshot.profile == m.profile)
        let cacheFresh = (cached != nil) && snapshot.isFresh && cacheSufficient
            && profileMatches
        let cachedDecodedAtModel = snapshot.decodedAtModel
        let cachedNoiseProfile = snapshot.noiseProfile
        let cachedISO = snapshot.iso
        let cachedWbFrame = snapshot.wbFrame
        // #1781/#1976: frame as-shot anchor when a frame is present (wbDeltaAnchor).
        let asShot: ImageEditPipeline.AsShotWB? = wbDeltaAnchor
        // Auto Profile (#812) fetch is NOT resolved here. It used to be fetched
        // unconditionally at this point, but that runs a cold per-image FFI fit
        // (seconds + a multi-GB develop transient on a 100MP RAW) even when the
        // wgpu live present below handles the frame and does its own fit — the
        // result was computed and then thrown away on the (default) GPU path.
        // `autoProfileLUTForCPURender` is called instead, once per branch,
        // immediately before the `processSceneLinear` call it feeds, only after
        // `presentViaGpuLive` has declined the frame.
        editSessionLogger.debug(
            "decodeAndRender begin gen=\(gen ?? 0) phase=\(String(describing: phase), privacy: .public) target=\(targetSize?.width ?? 0)x\(targetSize?.height ?? 0) cached=\(cached != nil)"
        )
        let phaseName: StaticString = (phase == .fast) ? "fast" : "refine"
        let phaseSignpostID = editSessionSignposter.makeSignpostID()
        let phaseState = editSessionSignposter.beginInterval(phaseName, id: phaseSignpostID)
        defer { editSessionSignposter.endInterval(phaseName, phaseState) }

        let filterStageName: StaticString = (phase == .fast)
            ? "filter chain (.fast)"
            : "filter chain (.refine)"

        do {
            let image: CIImage
            let isRaw = asset.isRaw
            let assetID = asset.id
            if let cached, cacheFresh {
                // wgpu live present (epic #925, P4b-apple) — runtime-gated parallel
                // path. When it handles the frame (present → CAMetalLayer) we
                // skip the CPU `processSceneLinear` + `renderedPreview` publish.
                // Returns false (CPU fallback) when off / no layer / non-RAW /
                // readback fails. See EditSession+GpuLive.swift.
                //
                // #1617: crop the decoded scene-linear buffer before the GPU
                // readback so the live session opens at the cropped dims and
                // presents the kept region — the GPU path no longer forces the
                // CPU path for cropped frames (#638 lifted). `gpuTargetSize` is
                // the un-upscaled canvas target (the cropped buffer is already
                // the kept region). The CPU fallback below still develops the
                // full frame and trims via `CropImageStage.apply` when the
                // present is declined (flag off / no layer / readback fail).
                let gpuCached = applyCrop ? CropImageStage.apply(crop, to: cached, nativeSize: cropNativeSize) : cached
                if await presentViaGpuLive(
                    decoded: gpuCached, targetSize: gpuTargetSize, gen: gen,
                    decodeGeneration: snapshot.decodeGeneration, appliedCrop: appliedCrop
                ) {
                    isRendering = false
                    return
                }
                // GPU present declined the frame — fetch (and cache) the CPU-path
                // Auto Profile LUT now, immediately before the fallback filter
                // chain that actually uses it.
                let profileLUT = await autoProfileLUTForCPURender(asset: asset, model: m)
                MemoryProbe.sample("after-fit phase=\(phase == .fast ? "fast" : "refine") auto=\(profileLUT != nil)")
                // The fit is a multi-second suspension on a cold image, and the
                // detached render below doesn't inherit cancellation — bail here
                // so a slider tick that cancelled mid-fit can't spawn a stale
                // full filter chain.
                guard !Task.isCancelled else {
                    isRendering = false
                    return
                }
                image = await Task.detached(priority: .userInitiated) {
                    mapleStage(filterStageName) {
                        if !isRaw {
                            return pipeline.processSceneLinearNonRaw(
                                decoded: cached, model: m, targetSize: targetSize,
                                assetID: assetID
                            )
                        }
                        return pipeline.processSceneLinear(
                            decoded: cached, model: m, targetSize: targetSize,
                            asShot: asShot, decodedAtModel: cachedDecodedAtModel,
                            profileLUT: profileLUT,
                            assetID: assetID,
                            noiseProfile: cachedNoiseProfile,
                            iso: cachedISO,
                            wbFrame: cachedWbFrame
                        )
                    }
                }.value
            } else {
                // Both phases decode to their bounded display target so the
                // full-res bitmap is never allocated (#785 fast phase, #1637
                // refine). Refine used to decode full-resolution even when the
                // scheduler handed it a capped `refinedTargetSize`, so a 100 MP
                // RAW allocated the full-sensor demosaic + a full-res GPU
                // texture and jetsam-killed iOS. A nil/degenerate target
                // (including `renderFull()`'s) caps to the fallback long edge
                // rather than fall through to full-res — no interactive path
                // ever allocates a full-sensor decode; genuine full-res lives
                // solely on `renderActor.renderForExport` (#2058).
                let decodeTarget = ImageEditPipeline.decodeTarget(
                    phase: phase, targetSize: targetSize,
                    nativeSize: nativeImageSize, isRaw: isRaw
                )
                let decoded = await renderActor.sharedDecode(
                    asset: asset,
                    target: decodeTarget,
                    profile: m.profile,
                    normalize: { [weak self] image, asset in
                        guard let self else { return image }
                        return await MainActor.run {
                            self.decodedForNativeCanvas(image, asset: asset)
                        }
                    }
                )
                guard !Task.isCancelled else {
                    isRendering = false
                    return
                }
                guard let decoded else {
                    throw RenderError.pipelineFailed
                }
                // #1781: adopt the fresh decode's slider-frame export BEFORE
                // the GPU present (it reads the session's frame + model).
                let freshSnapshot = await renderActor.snapshot(forAsset: asset)
                adoptDecodedWbFrame(freshSnapshot.wbFrame)
                // wgpu live present on the fresh decode (epic #925, P4b-apple) —
                // same runtime-gated parallel path as the cached branch above.
                // #1617: crop the decoded buffer before the GPU readback (as the
                // cached branch) so cropped frames present on the GPU too.
                let gpuDecoded = applyCrop ? CropImageStage.apply(crop, to: decoded, nativeSize: cropNativeSize) : decoded
                if await presentViaGpuLive(
                    decoded: gpuDecoded, targetSize: gpuTargetSize, gen: gen,
                    decodeGeneration: freshSnapshot.decodeGeneration, appliedCrop: appliedCrop
                ) {
                    isRendering = false
                    return
                }
                let freshDecodedAtModel = freshSnapshot.decodedAtModel
                let freshNoiseProfile = freshSnapshot.noiseProfile
                let (freshISO, freshWbFrame) = (freshSnapshot.iso, freshSnapshot.wbFrame)
                let freshAsShot = wbDeltaAnchor
                // GPU present declined the frame — fetch (and cache) the CPU-path
                // Auto Profile LUT now, immediately before the fallback filter
                // chain that actually uses it.
                let profileLUT = await autoProfileLUTForCPURender(asset: asset, model: m)
                MemoryProbe.sample("after-fit phase=\(phase == .fast ? "fast" : "refine") auto=\(profileLUT != nil)")
                // Same bail as the cached branch: the fit suspension may have
                // outlived this generation, and the detached render below
                // doesn't inherit cancellation.
                guard !Task.isCancelled else {
                    isRendering = false
                    return
                }
                let processed = await Task.detached(priority: .userInitiated) {
                    mapleStage(filterStageName) {
                        if !isRaw {
                            return pipeline.processSceneLinearNonRaw(
                                decoded: decoded, model: m, targetSize: targetSize,
                                assetID: assetID
                            )
                        }
                        return pipeline.processSceneLinear(
                            decoded: decoded, model: m, targetSize: targetSize,
                            asShot: freshAsShot, decodedAtModel: freshDecodedAtModel,
                            profileLUT: profileLUT,
                            assetID: assetID,
                            noiseProfile: freshNoiseProfile,
                            iso: freshISO,
                            wbFrame: freshWbFrame
                        )
                    }
                }.value
                image = processed
            }

            // Crop + straighten (#638) — final geometry op on the developed
            // display-domain image. `image` is the full-frame developed
            // CIImage; `CropImageStage.apply` rotates about center by the
            // straighten angle and cuts the axis-aligned crop rect,
            // re-origining the result to (0,0) so framing/zoom anchors the
            // cropped buffer like every other publish. No-op when `applyCrop`
            // is false (identity crop or crop tool armed).
            let displayImage = applyCrop ? CropImageStage.apply(crop, to: image, nativeSize: cropNativeSize) : image

            guard !Task.isCancelled else {
                editSessionLogger.debug("decodeAndRender gen=\(gen ?? 0) cancelled, dropping result")
                isRendering = false
                return
            }
            if let gen {
                let live = await renderActor.currentGeneration()
                if gen != live {
                    editSessionLogger.debug("decodeAndRender gen=\(gen) stale (current=\(live)), dropping result")
                    isRendering = false
                    return
                }
            }
            renderedPreview = displayImage
            previewIsFullRender = true
            previewIsThumbnailSeed = false  // #2040: a real render always supersedes the thumbnail seed
            renderError = nil
            editSessionLogger.debug(
                "decodeAndRender published preview gen=\(gen ?? 0) extent=\(displayImage.extent.width)x\(displayImage.extent.height)"
            )
            // First full-quality frame on screen — the cold-open's fast render
            // lands here. Drop the loading indicator, but only once the
            // background decode has finished (`!isFullQualityDecoding`): the
            // embedded-preview renders that publish WHILE the decode is still in
            // flight must not clear it early, or the indicator would vanish the
            // moment the ~50 ms preview paints. (Terminal failures clear it in
            // the `catch` below so a dead decode can't leave it stuck.) #1201
            if isResolvingFirstFrame && !isFullQualityDecoding {
                isResolvingFirstFrame = false
                editSessionLogger.notice(
                    "loading indicator HIDDEN — first full-quality frame published (gen=\(gen ?? 0))"
                )
            }

            // `!isFullQualityDecoding` mirrors the persist gate (#1881): a
            // refine that ran off the seeded decode would push camera-JPEG-
            // derived pixels to the thumbnail; the decode's completion re-kicks
            // a render, so the thumbnail still refreshes from real pixels.
            if phase == .refine, !isFullQualityDecoding {
                // Use the cropped `displayImage` so the browse thumbnail +
                // rendered-preview cache reflect what the user sees (#638).
                let thumbSource = displayImage
                if let url = asset.primaryURL {
                    Task.detached(priority: .utility) {
                        await ThumbnailLoader.shared.updateThumbnailFromRender(thumbSource, for: url)
                    }
                    persistCurrentPreviewToCache()
                }
                // Display preview (#2009): idle/exit persist, local or cloud.
                scheduleDisplayPreviewPersist(thumbSource)
            }
        } catch {
            if let gen {
                let live = await renderActor.currentGeneration()
                if gen != live {
                    isRendering = false
                    return
                }
            }
            editSessionLogger.error(
                "decodeAndRender failed gen=\(gen ?? 0) phase=\(String(describing: phase), privacy: .public) error=\(String(describing: error), privacy: .public)"
            )
            renderError = error
            // Terminal failure once the decode is done (e.g. an unreadable file):
            // no full-quality frame is coming, so settle the cold-open indicator
            // here too — otherwise `isResolvingFirstFrame` (cleared only on a
            // successful publish) would spin forever. Transient bails above
            // (gen-mismatch / re-decode) intentionally leave it set so the
            // indicator stays up while the open is still resolving. #1201
            if isResolvingFirstFrame && !isFullQualityDecoding {
                isResolvingFirstFrame = false
                editSessionLogger.notice(
                    "loading indicator HIDDEN — decode failed, no full-quality frame coming (gen=\(gen ?? 0))"
                )
            }
        }
        isRendering = false
    }
}
