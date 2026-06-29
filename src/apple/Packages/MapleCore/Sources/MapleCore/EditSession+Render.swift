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
//   • `decodeAndRender` / `refineVisibleRegion` / `renderFull` — the
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
    // MARK: - Public render entry points

    /// Force a full-resolution render immediately (useful before export).
    public func renderFull() async {
        renderRequested = true
        // Bypass the scheduler — caller wants the work to land before
        // returning. Take a fresh generation so the gen-check inside
        // `decodeAndRender` lines up against the live counter.
        let gen = await renderActor.currentGeneration()
        await decodeAndRender(targetSize: nil, phase: .refine, gen: gen)
    }

    /// Bake the current model against a fresh full-quality decode for export.
    public func renderForExport() async throws -> CIImage {
        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let cct = asShotCCT, let t = asShotTint else { return nil }
            return ImageEditPipeline.AsShotWB(temperature: cct, tint: t)
        }()
        return try await renderActor.renderForExport(
            asset: asset, model: model, asShot: asShot
        )
    }

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
        // the two fast refine paths below operate on FULL-FRAME source
        // geometry and can't honor the crop: the deep-zoom tile composite
        // and the visible-region refine both crop the full-frame decode to a
        // viewport rect, but `viewportSourceRect` is in CROPPED-image coords
        // (the canvas/zoom now anchor to `effectiveImageSize`). Re-rendering
        // the whole frame through `decodeAndRender(.refine)` is the correct,
        // crop-aware path (it applies `CropImageStage` on the developed
        // output) — a touch slower at deep zoom on a cropped image, but
        // correct. Full-frame (uncropped) renders keep both fast paths.
        let cropApplied = !cropEditingActive && CropImageStage.shouldApply(model.crop)
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
        // Visible-region refine. Requires a FULL-resolution cached decode
        // — this branch crops `snapshot.image` directly, so a sized fast
        // decode would yield a low-res zoom. When the cache is sized-only,
        // fall through to `decodeAndRender(.refine)` below, which
        // re-decodes full (#785).
        let visible = viewportSourceRect
        let snapshot = await renderActor.snapshot(forAsset: asset)
        if !cropApplied,
           !visible.isEmpty,
           nativeImageSize.width > 0, nativeImageSize.height > 0,
           snapshot.isFresh,
           snapshot.isFull,
           snapshot.image != nil {
            await refineVisibleRegion(
                visibleRect: visible,
                gen: gen,
                cached: snapshot.image!,
                cachedDecodedAtModel: snapshot.decodedAtModel
            )
            return
        }
        await decodeAndRender(targetSize: refinedTargetSize, phase: .refine, gen: gen)
    }

    // MARK: - Visible-region refine

    func refineVisibleRegion(
        visibleRect: CGRect,
        gen: UInt64,
        cached: CIImage,
        cachedDecodedAtModel: AdjustmentModel?
    ) async {
        let assetID = asset.id
        let canvasSize = nativeImageSize
        let pipeline = self.pipeline
        let m = model
        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let cct = asShotCCT, let t = asShotTint else { return nil }
            return ImageEditPipeline.AsShotWB(temperature: cct, tint: t)
        }()
        let priorPreview = renderedPreview
        // Auto Profile (#812) — resolve/cache the per-image cube off the
        // synchronous chain block, mirroring `decodeAndRender`. The editor
        // decode path develops at `.preview` (RenderActor's sharedDecode +
        // decodeSceneLinear* default to `.preview`), so the curve MUST be fit
        // at `.preview` too or it won't match the displayed pixels (#844).
        let profileLUT: CIFilter? = await {
            guard asset.isRaw, m.profile == .auto, let url = asset.primaryURL else { return nil }
            return await AutoProfileLUT.shared.filter(forRawAt: url, profile: m.profile, quality: .preview)
        }()

        renderPhase = .refine
        isRendering = true
        defer { isRendering = false }

        let phaseSignpostID = editSessionSignposter.makeSignpostID()
        let phaseState = editSessionSignposter.beginInterval("refine", id: phaseSignpostID)
        defer { editSessionSignposter.endInterval("refine", phaseState) }

        editSessionLogger.debug(
            "refineVisibleRegion gen=\(gen) rect=\(visibleRect.origin.x, format: .fixed(precision: 0)),\(visibleRect.origin.y, format: .fixed(precision: 0)) \(visibleRect.width, format: .fixed(precision: 0))x\(visibleRect.height, format: .fixed(precision: 0))"
        )

        let materialised = await Task.detached(priority: .userInitiated) {
            () -> CIImage? in
            mapleStage("filter chain (.refine visible-region)") {
                let chain = pipeline.processSceneLinear(
                    decoded: cached, model: m, targetSize: nil,
                    asShot: asShot, decodedAtModel: cachedDecodedAtModel,
                    profileLUT: profileLUT,
                    assetID: assetID
                )
                let cropped = chain.cropped(to: visibleRect)
                guard let cg = pipeline.materializeRegion(cropped, rect: visibleRect)
                else { return nil }
                let fresh = CIImage(cgImage: cg).transformed(
                    by: CGAffineTransform(translationX: visibleRect.minX, y: visibleRect.minY)
                )
                return fresh
            }
        }.value

        let live = await renderActor.currentGeneration()
        guard gen == live, !Task.isCancelled else {
            editSessionLogger.debug(
                "refineVisibleRegion gen=\(gen) stale (current=\(live)), dropping"
            )
            return
        }
        guard self.asset.id == assetID else { return }
        guard let materialised else {
            editSessionLogger.warning("refineVisibleRegion materialise failed; keeping fast preview")
            return
        }

        let composite = compositeWithPreviewUnderlay(
            materialised, underlay: priorPreview, canvasSize: canvasSize
        )
        renderedPreview = composite
        renderError = nil

        if let url = asset.primaryURL {
            Task.detached(priority: .utility) { [composite] in
                await ThumbnailLoader.shared.updateThumbnailFromRender(composite, for: url)
            }
            persistCurrentPreviewToCache()
        }
    }

    // MARK: - Unified decode + render

    func decodeAndRender(targetSize: CGSize?, phase: RenderPhase, gen: UInt64? = nil) async {
        isRendering = true
        renderPhase = phase
        let m = model
        let asset = self.asset
        let pipeline = self.pipeline
        // Crop + straighten (#638). Applied as a CoreImage geometry op on the
        // FINAL developed CIImage — the crop is not in the Rust core on Apple,
        // so it rides here on the published preview. The crop applies only
        // when the tool is NOT armed (`!cropEditingActive`): while armed the
        // overlay sits over the full frame and the render shows the uncropped
        // image. `effectiveCrop` already folds in that armed/disarmed gate.
        let crop = effectiveCrop
        let applyCrop = CropImageStage.shouldApply(crop)
        // #1617: the GPU live present crops the decoded scene-linear buffer
        // itself (a geometry op before the f32 readback), so it opens the
        // session at the CROPPED dims and needs the un-upscaled canvas target —
        // the cropped buffer already IS the kept region. Capture it before the
        // CPU-path upscale shadows `targetSize` just below.
        let gpuTargetSize = targetSize
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
            guard applyCrop, let t = targetSize else { return targetSize }
            let fracW = max(crop.right - crop.left, CropGeometry.minCropFraction)
            let fracH = max(crop.bottom - crop.top, CropGeometry.minCropFraction)
            let scaleW = CGFloat(min(1.0 / fracW, 8.0))
            let scaleH = CGFloat(min(1.0 / fracH, 8.0))
            return CGSize(width: t.width * scaleW, height: t.height * scaleH)
        }()
        let snapshot = await renderActor.snapshot(forAsset: asset)
        let cached = snapshot.image
        // Fast phase accepts any fresh cache (a downsampled decode is
        // fine for the viewport). Refine requires a FULL-resolution decode
        // — a sized-only cache from a prior fast pass is a miss, so refine
        // re-decodes full and never publishes a low-res final (#785).
        let cacheSufficient = (phase == .fast) || snapshot.isFull
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
        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let cct = asShotCCT, let t = asShotTint else { return nil }
            return ImageEditPipeline.AsShotWB(temperature: cct, tint: t)
        }()
        // Auto Profile (#812) — resolve (and cache) the per-image display-space
        // CIColorCube once per render, OFF the synchronous filter-chain block.
        // The fit is a cold JPEG-extract + develop the first time per image;
        // `AutoProfileLUT` caches the baked cube keyed on URL+mtime+quality so
        // slider ticks reuse it. Nil for non-RAW, `Profile::Neutral`, or fit
        // failure. The editor decode path develops at `.preview` (RenderActor's
        // sharedDecode + decodeSceneLinear* default to `.preview`), so the
        // curve is fit at `.preview` to match the displayed buffer (#844).
        let profileLUT: CIFilter? = await {
            guard asset.isRaw, m.profile == .auto, let url = asset.primaryURL else { return nil }
            return await AutoProfileLUT.shared.filter(forRawAt: url, profile: m.profile, quality: .preview)
        }()
        MemoryProbe.sample("after-fit phase=\(phase == .fast ? "fast" : "refine") auto=\(profileLUT != nil)")
        editSessionLogger.debug(
            "decodeAndRender begin gen=\(gen ?? 0) phase=\(String(describing: phase), privacy: .public) target=\(targetSize?.width ?? 0)x\(targetSize?.height ?? 0) cached=\(cached != nil) autoProfile=\(profileLUT != nil)"
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
                let gpuCached = applyCrop ? CropImageStage.apply(crop, to: cached) : cached
                if await presentViaGpuLive(decoded: gpuCached, targetSize: gpuTargetSize, gen: gen) {
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
                            assetID: assetID
                        )
                    }
                }.value
            } else {
                // Both phases decode to their bounded display target so the
                // full-res bitmap is never allocated (#785 fast phase, #1637
                // refine). Refine used to decode full-resolution even when the
                // scheduler handed it a capped `refinedTargetSize`, so a 100 MP
                // RAW allocated the full-sensor demosaic + a full-res GPU
                // texture and jetsam-killed iOS. `renderFull()` still passes a
                // nil target → genuine full-res for export prep; `.fast` caps a
                // nil/degenerate target rather than fall through to full-res.
                let decodeTarget = ImageEditPipeline.decodeTarget(
                    phase: phase, targetSize: targetSize
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
                // wgpu live present on the fresh decode (epic #925, P4b-apple) —
                // same runtime-gated parallel path as the cached branch above.
                // #1617: crop the decoded buffer before the GPU readback (as the
                // cached branch) so cropped frames present on the GPU too.
                let gpuDecoded = applyCrop ? CropImageStage.apply(crop, to: decoded) : decoded
                if await presentViaGpuLive(decoded: gpuDecoded, targetSize: gpuTargetSize, gen: gen) {
                    isRendering = false
                    return
                }
                let freshSnapshot = await renderActor.snapshot(forAsset: asset)
                let freshDecodedAtModel = freshSnapshot.decodedAtModel
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
                            asShot: asShot, decodedAtModel: freshDecodedAtModel,
                            profileLUT: profileLUT,
                            assetID: assetID
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
            let displayImage = applyCrop ? CropImageStage.apply(crop, to: image) : image

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

            if phase == .refine, let url = asset.primaryURL {
                // Use the cropped `displayImage` so the browse thumbnail +
                // rendered-preview cache reflect what the user sees (#638).
                let thumbSource = displayImage
                Task.detached(priority: .utility) {
                    await ThumbnailLoader.shared.updateThumbnailFromRender(thumbSource, for: url)
                }
                persistCurrentPreviewToCache()
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
