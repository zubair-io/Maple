// EditSession+Render.swift — render scheduling + publish layer.
//
// Split from EditSession.swift (issue #120). Owns the path from a model
// mutation (slider tick, asset open) to a published `renderedPreview`:
//   • Two-phase scheduling (`_scheduleRender` fast → debounced refine)
//   • Visible-region refine using the cached decoded buffer
//   • The fast/refine dispatch through `decodeAndRender`
//   • `renderFull` public entry point
//
// History: slice 2 of issue #194 moved the decoded-image cache + the
// Rust FFI decode + the per-target coalescer off this file onto
// `RenderActor`. The scheduler reads the actor's `snapshot(forAsset:)`
// on every fast/refine hop and calls `renderActor.sharedDecode(...)`
// for cold decodes. Slice 3 moves the scheduler itself.

import Foundation
import CoreImage

@MainActor
extension EditSession {
    // MARK: - Public render entry points

    /// Force a full-resolution render immediately (useful before export).
    public func renderFull() async {
        renderRequested = true
        await decodeAndRender(targetSize: nil, phase: .refine)
    }

    /// Bake the current model against a fresh full-quality decode for export.
    ///
    /// Forwarder onto `renderActor.renderForExport(...)`. Preserves the
    /// pre-slice-2 public surface so `MapleExporter` and other callers
    /// don't need to know the actor moved.
    public func renderForExport() async throws -> CIImage {
        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let cct = asShotCCT, let t = asShotTint else { return nil }
            return ImageEditPipeline.AsShotWB(temperature: cct, tint: t)
        }()
        return try await renderActor.renderForExport(
            asset: asset, model: model, asShot: asShot
        )
    }

    // MARK: - Two-phase scheduler

    /// Two-phase scheduler. Called on slider changes and on initial load:
    ///   1. Fast pass at `fastTargetSize` — renders at viewport resolution
    ///      so the filter chain stays in the 16ms budget on a 100MP RAW.
    ///   2. 250ms debounce then a refine pass at `refinedTargetSize`.
    ///      Skipped when pixelScale is 0 (fit mode) because refine == fast.
    ///
    /// Generation-counter guards preserved — stale tasks exit before
    /// writing UI state so a folder / image switch mid-render doesn't
    /// clobber the new image's preview.
    func _scheduleRender(phase: RenderPhase) {
        renderTask?.cancel()
        refineTask?.cancel()
        renderGeneration &+= 1
        let gen = renderGeneration
        editSessionLogger.debug("scheduleRender gen=\(gen) phase=\(String(describing: phase), privacy: .public)")
        renderTask = Task { @MainActor in
            // 50 ms debounce — during a continuous slider drag every
            // micro-tick (~60–120 Hz) lands here; cancelling the previous
            // task + sleeping this one short-circuits the storm. Only the
            // last tick of the drag burst survives to call decodeAndRender.
            try? await Task.sleep(for: .milliseconds(50))
            guard gen == renderGeneration, !Task.isCancelled else { return }
            await decodeAndRender(targetSize: fastTargetSize, phase: .fast, gen: gen)
            guard gen == renderGeneration, !Task.isCancelled else { return }
            _scheduleRefine(gen: gen)
        }
    }

    /// Kick a refine pass without re-running the fast phase. Used for
    /// pan/zoom (pixelScale changed) and viewport resizes where the cached
    /// decoded CIImage is still valid — we just need a different
    /// `targetSize` downstream.
    func _scheduleRefine(gen requested: UInt64? = nil) {
        refineTask?.cancel()
        let gen = requested ?? renderGeneration
        refineTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard gen == renderGeneration, !Task.isCancelled else { return }
            // Plan 3 / Ticket 06 M4 — deep-zoom branch. When the user
            // has zoomed past 1.0 we route the refine through the tile
            // manager instead of re-running the whole-image scene-linear
            // pipeline. See `EditSession+DeepZoom.swift` for the design.
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
            // Visible-region refine. With a full-native cached decode
            // available (Piece 1), the only refine cost left is the
            // CoreImage materialise step.
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
    }

    // MARK: - Visible-region refine

    /// Visible-region refine path. Mirrors the deep-zoom composite
    /// pattern (`compositeWithPreviewUnderlay`) but feeds the cached
    /// full-native scene-linear decode into the standard
    /// `processSceneLinear` chain rather than the per-tile decoder.
    ///
    /// Slice-2 change: the cached buffer + decoded-at-model now come in
    /// as parameters because they live on `RenderActor`. The caller has
    /// already taken the snapshot under the gen guard, so this method
    /// trusts the inputs.
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

        guard gen == renderGeneration, !Task.isCancelled else {
            editSessionLogger.debug(
                "refineVisibleRegion gen=\(gen) stale (current=\(self.renderGeneration)), dropping"
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

    /// Unified render entry point — handles both fast and refine phases
    /// by taking the target size as a parameter. Consults the
    /// `renderActor` cache snapshot on the hot path so slider ticks skip
    /// the Rust FFI; falls through to `renderActor.sharedDecode` on the
    /// cold path.
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
                // Cold decode — route through the actor. The `normalize`
                // closure hops back to MainActor to apply the
                // `decodedForNativeCanvas` upscale (which mutates
                // `nativeImageSize` via the synchronous metadata seed)
                // — see RenderActor.sharedDecode doc for the rationale.
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
                // The actor wrote `decodedAtModel` as the tail of its
                // sharedDecode. Re-read via snapshot so the WB kernel
                // applies (live - decoded).
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
            if let gen, gen != renderGeneration {
                editSessionLogger.debug("decodeAndRender gen=\(gen) stale (current=\(self.renderGeneration)), dropping result")
                isRendering = false
                return
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
            if let gen, gen != renderGeneration {
                isRendering = false
                return
            }
            editSessionLogger.error(
                "decodeAndRender failed gen=\(gen ?? 0) phase=\(String(describing: phase), privacy: .public) error=\(String(describing: error), privacy: .public)"
            )
            renderError = error
        }
        isRendering = false
    }
}
