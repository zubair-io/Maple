// EditSession+Render.swift — render scheduling + publish layer.
//
// Split from EditSession.swift (issue #120). Owns the path from a model
// mutation (slider tick, asset open) to a published `renderedPreview`:
//   • Two-phase scheduling (`_scheduleRender` fast → debounced refine)
//   • Visible-region refine + composite-over-prior-preview
//   • The fast/refine dispatch through `decodeAndRender`
//   • `renderFull` entry point + cache persistence for cold-open seeding
//
// The cold Rust FFI decode itself + the decoded-image cache state machine
// live in `EditSession+Decode.swift`. The export-render bypass lives there
// too because it shares decode-time-model parsing helpers.

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

    // MARK: - Cache persistence

    /// Snapshot the current `renderedPreview` into `RenderedPreviewCache`
    /// so a future cold open of this asset can paint pixels instantly.
    /// Called from both the refine path (after refine publishes) and the
    /// refine-skip branch in `_scheduleRefine` — without the latter,
    /// fit-to-window opens (the most common case) never populate the
    /// cache and every cold re-open redoes the Rust pipeline.
    func persistCurrentPreviewToCache() {
        guard let url = asset.primaryURL,
              let preview = renderedPreview else { return }
        let capturedImage = preview
        let capturedWidth = Int(max(previewSize.width, 1))
        Task.detached(priority: .utility) {
            await RenderedPreviewCache.shared.storePreview(
                capturedImage, for: url, screenWidth: capturedWidth
            )
        }
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
            // has zoomed past 1.0 (one source pixel per screen pixel)
            // we route the refine through the tile manager instead of
            // re-running the whole-image scene-linear pipeline. The
            // tile path renders 512² source-pixel tiles on demand and
            // composites them over the upscaled cached preview, so
            // memory stays bounded and slider/pan latency hits the
            // brief's 16 ms target on cache hits. The fit-zoom path
            // below is unchanged for `pixelScale < 1.0`.
            //
            // Gated by `EditSession.deepZoomEnabled`. Default OFF —
            // the per-tile pipeline has known color-discontinuity
            // artifacts at tile boundaries (local-context stages like
            // sharpen/clarity see different overlap context per tile).
            // When OFF, refine falls through to the sized-FFI path
            // below, which renders the full image once at the refined
            // target size — slower at very high zoom but pixel-perfect
            // colors. Flip ON once the per-tile color parity ticket
            // lands.
            if Self.deepZoomEnabled,
               pixelScale >= 1.0,
               !viewportSourceRect.isEmpty,
               let _ = asset.primaryURL {
                await refineDeepZoom(gen: gen)
                return
            }
            // Short-circuit when refine would render at the same (or smaller)
            // target as the most recent fast pass. Avoids a wasted CoreImage
            // pipeline build when the user hasn't actually zoomed in. Persist
            // the fast result first so a cold re-open can paint from the
            // cache — without this, fit-to-window opens (the common case)
            // never populate `RenderedPreviewCache`.
            if let fast = fastTargetSize, let refine = refinedTargetSize,
               refine.width <= fast.width + 1 && refine.height <= fast.height + 1 {
                persistCurrentPreviewToCache()
                return
            }
            // Visible-region refine. With a full-native cached decode
            // available (Piece 1), the only refine cost left is the
            // CoreImage materialise step — and at high zoom that step
            // is what gets billed for "100% feels heavy on slider tick"
            // because it's running the kernel chain across the whole
            // canvas. By cropping the lazy chain to `viewportSourceRect`
            // before calling `createCGImage`, CoreImage's planner
            // computes filters only for the visible window and we
            // composite the fresh visible patch over the prior preview
            // (upscaled to the canvas) so unrendered regions still show
            // the last-good pixels instead of black.
            //
            // Fallback to the legacy whole-canvas refine when the View
            // hasn't pushed a visible rect yet (Browse-grid prewarmed
            // sessions, the seed-from-metadata phase before
            // `notifyVisibleRegion` fires).
            let visible = viewportSourceRect
            if !visible.isEmpty,
               nativeImageSize.width > 0, nativeImageSize.height > 0,
               decodedCacheIsFreshForCurrentAsset(),
               decodedImage != nil {
                await refineVisibleRegion(visibleRect: visible, gen: gen)
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
    /// The kernel chain is lazy until `materializeRegion` forces a
    /// rasterise of `visibleRect` only, so the CoreImage planner spends
    /// shader time on viewport-sized pixel counts even at 100% zoom on
    /// a 100 MP RAW.
    func refineVisibleRegion(visibleRect: CGRect, gen: UInt64) async {
        guard let cached = decodedImage else { return }
        let assetID = asset.id
        let canvasSize = nativeImageSize
        let pipeline = self.pipeline
        let m = model
        let cachedDecodedAtModel = decodedAtModel
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

        // Run the kernel chain at the cached buffer's full extent (no
        // prescale). The crop+materialise below tells the CoreImage
        // planner which slice to actually compute, so the lazy graph
        // shouldn't run filters across the whole canvas.
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

        // Composite the freshly-rendered viewport patch over the prior
        // preview (upscaled to the canvas). Unrendered canvas regions
        // show the last good preview rather than black, which matches
        // the deep-zoom path's "progressive refine" UX.
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

    /// Place the tile composite (full-canvas extent, transparent where
    /// no tiles loaded) over an upscaled `underlay` (preview-quality
    /// image) so unloaded regions show preview pixels instead of black.
    /// The output extent equals `canvasSize`.
    func compositeWithPreviewUnderlay(
        _ composite: CIImage,
        underlay: CIImage?,
        canvasSize: CGSize
    ) -> CIImage {
        let canvasRect = CGRect(origin: .zero, size: canvasSize)
        guard let underlay,
              underlay.extent.width > 0,
              underlay.extent.height > 0,
              canvasSize.width > 0,
              canvasSize.height > 0
        else {
            return composite
        }
        // Scale the underlay to the full canvas. Translate origin to
        // (0, 0) first because some preview-source CIImages carry a
        // non-zero origin (cropped buffers, embedded JPEGs).
        let originNormalized = underlay.transformed(by: CGAffineTransform(
            translationX: -underlay.extent.origin.x,
            y: -underlay.extent.origin.y
        ))
        let sx = canvasSize.width / underlay.extent.width
        let sy = canvasSize.height / underlay.extent.height
        let scaledUnderlay = originNormalized
            .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
            .cropped(to: canvasRect)
        return composite
            .composited(over: scaledUnderlay)
            .cropped(to: canvasRect)
    }

    // MARK: - Unified decode + render

    /// Unified render entry point — handles both fast and refine phases
    /// by taking the target size as a parameter. Reuses the cached decoded
    /// CIImage on the hot path so slider ticks skip the Rust FFI.
    func decodeAndRender(targetSize: CGSize?, phase: RenderPhase, gen: UInt64? = nil) async {
        isRendering = true
        renderPhase = phase
        let m = model
        let asset = self.asset
        let pipeline = self.pipeline
        let cached = decodedImage
        let alreadyDecodedID = decodedForAssetID
        // Plan 2 M3 — snapshot the decode-time model for the WB kernel.
        // On the hot path (`cached != nil`) this is the value persisted
        // by the prior `sharedDecode` call. On the cold path it's
        // refreshed after `sharedDecode` returns below.
        let cachedDecodedAtModel = decodedAtModel
        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let cct = asShotCCT, let t = asShotTint else { return nil }
            return ImageEditPipeline.AsShotWB(temperature: cct, tint: t)
        }()
        editSessionLogger.debug(
            "decodeAndRender begin gen=\(gen ?? 0) phase=\(String(describing: phase), privacy: .public) target=\(targetSize?.width ?? 0)x\(targetSize?.height ?? 0) cached=\(cached != nil)"
        )
        // Signpost interval covers the full decode+process for this phase so
        // Instruments can show fast-pass and refine-pass bars stacked on the
        // same timeline. `.fast` and `.refine` are separate interval names so
        // they appear as independent lanes.
        let phaseName: StaticString = (phase == .fast) ? "fast" : "refine"
        let phaseSignpostID = editSessionSignposter.makeSignpostID()
        let phaseState = editSessionSignposter.beginInterval(phaseName, id: phaseSignpostID)
        defer { editSessionSignposter.endInterval(phaseName, phaseState) }

        let filterStageName: StaticString = (phase == .fast)
            ? "filter chain (.fast)"
            : "filter chain (.refine)"

        do {
            let image: CIImage
            // Cache validity: the decoded buffer is full-native and
            // covers every fast/refine target the canvas can request, so
            // the only thing that flips the cache stale (without an
            // explicit `invalidateDecodedCache()` call) is a sidecar
            // mtime change — the Rust path bakes sidecar-driven stages
            // (highlight_recovery, profile-driven WB) before returning,
            // so an external XMP edit demands a fresh decode.
            //
            // Dispatch the kernel chain on asset.isRaw — non-RAW skips
            // the WB-calibration kernel (the JPEG was baked at the
            // source-light already) and uses processSceneLinearNonRaw.
            let isRaw = asset.isRaw
            let cacheFresh = (cached != nil)
                && alreadyDecodedID == asset.id
                && decodedCacheIsFreshForCurrentAsset()
            if let cached, cacheFresh {
                // Cached decode — apply scene-linear chain only. Hot path
                // for slider/zoom/pan after first decode lands. The
                // CoreImage filter graph fuses `processSceneLinear`'s
                // lazy Lanczos prescale with the kernel chain so the
                // 200 MB fp16 intermediate never materialises — only
                // the requested target pixels do.
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
                // Cold decode — run the Rust FFI once (RAW) or ImageIO once
                // (non-RAW), cache the result. Dedupe: if another render
                // phase is already awaiting a decode for this asset, piggy-
                // back on its Task rather than starting a concurrent one.
                // SwiftUI can fire previewSize and pixelScale didSets in
                // rapid succession as the viewport lays itself out, which
                // used to schedule several cold decodes in parallel — each
                // observing `decodedImage` still nil because no sibling had
                // written it yet. The result was N concurrent Rust FFI
                // decodes on a 100MP RAW with no survivor ever reaching the
                // published-preview assignment. Single in-flight decode per
                // asset fixes it.
                let decoded = await sharedDecode(asset: asset, pipeline: pipeline)
                guard !Task.isCancelled else {
                    isRendering = false
                    return
                }
                guard let decoded else {
                    throw RenderError.pipelineFailed
                }
                // Plan 2 M3 — sharedDecode has just published decodedAtModel
                // (the model the Rust path used for this decode). Capture
                // it here so the WB kernel applies (live - decoded).
                let freshDecodedAtModel = self.decodedAtModel
                // Process is cheap (Metal-kernel chain) — run it per
                // phase with the caller's targetSize. Not shared with peers
                // because targetSize differs between fast and refine.
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

            // Refresh the on-disk thumbnail so the browse grid reflects the
            // user's develop (not the camera's embedded preview). Only on
            // the refine pass — the fast pass is viewport-sized and blurry
            // when downscaled to 256 px. Filesystem assets only: sourceless
            // assets don't have a stable URL to key off of.
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
            // Surface the failure. Without this log a silent decode failure
            // looks identical to "still decoding" from the outside — the
            // viewport just never paints.
            editSessionLogger.error(
                "decodeAndRender failed gen=\(gen ?? 0) phase=\(String(describing: phase), privacy: .public) error=\(String(describing: error), privacy: .public)"
            )
            renderError = error
        }
        isRendering = false
    }
}
