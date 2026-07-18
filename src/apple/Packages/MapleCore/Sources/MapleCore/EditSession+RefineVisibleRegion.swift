// EditSession+RefineVisibleRegion.swift — the visible-region refine pass.
//
// Owns `refineVisibleRegion` — the refine path that crops the cached
// full-resolution decode to the viewport rect and materializes just that
// patch through the CPU filter chain. Split out of EditSession+Render.swift
// to keep that file inside the #785 file-size budget.

import Foundation
import CoreImage

@MainActor
extension EditSession {
    // MARK: - Visible-region refine

    func refineVisibleRegion(
        visibleRect: CGRect,
        gen: UInt64,
        cached: CIImage,
        cachedDecodedAtModel: AdjustmentModel?,
        cachedNoiseProfile: [Float]? = nil,
        cachedISO: UInt32 = 0,
        cachedWbFrame: WbSliderFrame? = nil
    ) async {
        let assetID = asset.id
        let canvasSize = nativeImageSize
        let pipeline = self.pipeline
        let m = model
        adoptDecodedWbFrame(cachedWbFrame) // #1781/#1976: as-shot anchor below
        let asShot: ImageEditPipeline.AsShotWB? = wbDeltaAnchor
        // Auto Profile (#812) — resolve/cache the per-image cube off the
        // synchronous chain block via the shared CPU-render fetch (guard +
        // `.preview` quality semantics documented on the helper, #844). This
        // path is CPU-only, so the fetch is unconditionally correct here.
        let profileLUT = await autoProfileLUTForCPURender(asset: asset, model: m)

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
                    assetID: assetID,
                    noiseProfile: cachedNoiseProfile,
                    iso: cachedISO,
                    wbFrame: cachedWbFrame
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

        // Underlay = the preview on screen NOW, not a capture from before the
        // detached materialise: a fast pass may have published a newer full
        // render mid-flight, and compositing over the pre-await snapshot would
        // clobber it with stale-tone pixels outside the patch (#1881).
        let underlay = renderedPreview
        let composite = compositeWithPreviewUnderlay(
            materialised, underlay: underlay, canvasSize: canvasSize
        )
        // The patch only counts as a full render when it covers the whole
        // canvas — a viewport-sized patch leaves underlay pixels (possibly
        // rendered under an older model) visible outside its rect, and that
        // mixed image must never be persisted or pushed to the thumbnail.
        let coversCanvas = materialised.extent.contains(
            CGRect(origin: .zero, size: canvasSize).insetBy(dx: 1, dy: 1)
        )
        renderedPreview = composite
        previewIsFullRender = coversCanvas
        previewIsThumbnailSeed = false  // #2040: a real render always supersedes the thumbnail seed
        renderError = nil

        // `!isFullQualityDecoding` mirrors the persist gate: a refine off the
        // seeded decode would push camera-JPEG-derived pixels to the thumbnail.
        if coversCanvas, !isFullQualityDecoding {
            if let url = asset.primaryURL {
                // Browse thumbnail stays per-refine (cheap; keeps the grid
                // live during editing) and is inherently local.
                Task.detached(priority: .utility) { [composite] in
                    await ThumbnailLoader.shared.updateThumbnailFromRender(composite, for: url)
                }
                persistCurrentPreviewToCache()
            }
            // Display preview (#2009): capture the frame, persist on idle +
            // exit — never per tick. Local file or cloud upload via the sink.
            scheduleDisplayPreviewPersist(composite)
        }
    }
}
