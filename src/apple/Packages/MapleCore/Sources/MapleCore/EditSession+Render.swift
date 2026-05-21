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
        // Plan 3 / Ticket 06 M4 — deep-zoom branch.
        if Self.deepZoomEnabled,
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
        // Visible-region refine.
        let visible = viewportSourceRect
        let snapshot = await renderActor.snapshot(forAsset: asset)
        if !visible.isEmpty,
           nativeImageSize.width > 0, nativeImageSize.height > 0,
           snapshot.isFresh,
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
                    asShot: asShot, decodedAtModel: cachedDecodedAtModel
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
        let snapshot = await renderActor.snapshot(forAsset: asset)
        let cached = snapshot.image
        let cacheFresh = (cached != nil) && snapshot.isFresh
        let cachedDecodedAtModel = snapshot.decodedAtModel
        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let cct = asShotCCT, let t = asShotTint else { return nil }
            return ImageEditPipeline.AsShotWB(temperature: cct, tint: t)
        }()
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
            if let cached, cacheFresh {
                image = await Task.detached(priority: .userInitiated) {
                    mapleStage(filterStageName) {
                        if !isRaw {
                            return pipeline.processSceneLinearNonRaw(
                                decoded: cached, model: m, targetSize: targetSize
                            )
                        }
                        return pipeline.processSceneLinear(
                            decoded: cached, model: m, targetSize: targetSize,
                            asShot: asShot, decodedAtModel: cachedDecodedAtModel
                        )
                    }
                }.value
            } else {
                let decoded = await renderActor.sharedDecode(
                    asset: asset,
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
                let freshSnapshot = await renderActor.snapshot(forAsset: asset)
                let freshDecodedAtModel = freshSnapshot.decodedAtModel
                let processed = await Task.detached(priority: .userInitiated) {
                    mapleStage(filterStageName) {
                        if !isRaw {
                            return pipeline.processSceneLinearNonRaw(
                                decoded: decoded, model: m, targetSize: targetSize
                            )
                        }
                        return pipeline.processSceneLinear(
                            decoded: decoded, model: m, targetSize: targetSize,
                            asShot: asShot, decodedAtModel: freshDecodedAtModel
                        )
                    }
                }.value
                image = processed
            }

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
            renderedPreview = image
            renderError = nil
            editSessionLogger.debug(
                "decodeAndRender published preview gen=\(gen ?? 0) extent=\(image.extent.width)x\(image.extent.height)"
            )

            if phase == .refine, let url = asset.primaryURL {
                Task.detached(priority: .utility) {
                    await ThumbnailLoader.shared.updateThumbnailFromRender(image, for: url)
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
        }
        isRendering = false
    }
}
