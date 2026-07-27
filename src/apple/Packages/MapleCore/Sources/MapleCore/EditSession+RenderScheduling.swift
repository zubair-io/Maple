// EditSession+RenderScheduling.swift - the two-phase scheduler forwarders.
//
// Extracted from `EditSession+Render.swift` to keep that file inside the
// changed-file headroom budget (`tools/check-budget-headroom.sh`, #2311).
// Verbatim move of the "Two-phase scheduler" MARK section - no behaviour
// change.
//
// These four methods are one unit: `_scheduleRender` / `_scheduleRefine` are
// the entry points and `fastPhaseBody` / `refineBody` are their `private`
// bodies, so they must live in the SAME file for `private` to keep meaning
// file scope and nothing wider. The cancellation contract they implement is
// documented on `_scheduleRender` below and in `RenderActor`'s header.

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
}
