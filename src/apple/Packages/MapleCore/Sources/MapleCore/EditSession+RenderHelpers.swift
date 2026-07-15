// EditSession+RenderHelpers.swift — Render helpers extracted to satisfy file budget.
//

import Foundation
import CoreImage

@MainActor
extension EditSession {
    /// Schedule a fast-phase render WITHOUT going through `openAssetPipelineAsync`.
    /// Reuses the decoded buffer cache; just kicks `decodeAndRender(.fast)` so
    /// the next `presentViaGpuLive` runs against the current model.
    ///
    /// Surfaced for `GpuLiveCanvasController.layoutAndPresent` to call after
    /// `driver.register(layer:)` fires: in a cold-open with no `nativeImageSize`
    /// seed (cloud-loaded asset, sourceless PhotoKit, etc.), the canvas can't
    /// mount until the decode publishes a buffer extent. The cold-open's first
    /// render then publishes via the CPU path (because `hasLayer` was false at
    /// that moment) — `ensureRenderStarted`'s `renderedPreview == nil` guard
    /// then short-circuits any follow-up render, so the chip stays on CPU until
    /// the user drags a slider. This method is the canvas controller's "I just
    /// registered, please re-render" hook: cheap (no decode), bypasses the
    /// preview-set guard. (#1362 follow-up — caught on iPad with self-hosted
    /// cloud assets where the bytes download adds seconds to canvas-mount.)
    public func kickRenderAfterGpuCanvasMount() {
        guard gpuLiveDriver?.hasLayer == true, !gpuFramePresented else { return }
        _scheduleRender(phase: .fast)
    }

    /// Re-present the current model after the scene returns to `.active`
    /// (#1769, iOS). Metal discards presents issued while the app is
    /// backgrounded, and CoreAnimation may hand back a stale/partial drawable
    /// on reactivation — nothing else in the pipeline repaints when the MODEL
    /// hasn't changed, so a canvas backgrounded mid-present could stay torn
    /// indefinitely. One cheap fast-phase pass (cached decode → GPU present)
    /// puts a whole frame back on glass. No-op when the GPU path isn't active
    /// (the CPU `renderedPreview` is a plain SwiftUI image — reactivation
    /// re-composites it for free).
    public func representOnForeground() {
        guard GpuLiveFlag.isEnabled,
              gpuLiveDriver?.hasLayer == true,
              gpuFramePresented,
              !gpuPresentFailed else { return }
        _scheduleRender(phase: .fast)
    }

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
        // #1781: decode-bake anchor with a present frame; the export
        // decode's own frame export rides processSceneLinear(wbFrame:).
        return try await renderActor.renderForExport(
            asset: asset, model: model, asShot: wbDeltaAnchor
        )
    }
}
