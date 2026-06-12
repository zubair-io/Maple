// EditSession+GpuLive.swift — the wgpu LIVE-render present branch (epic #925,
// P4b-apple / #1028).
//
// Always compiled (the GPU FFI is in the default xcframework now). Reached only
// when the runtime flag is on (`GpuLiveFlag.isEnabled`); with it off,
// `decodeAndRender` (EditSession+Render) runs the CPU + Metal + CIColorCube path
// byte-for-byte — the "flag-off == today" guarantee.
//
// ## Why a parallel present, not a `processSceneLinear` rewrite
//
// `ImageEditPipeline.processSceneLinear` is `(decoded: CIImage) -> CIImage`; the
// editor publishes that CIImage to `renderedPreview` and `CIImageView` rasters
// it. The wgpu chain produces NO CIImage — `present_chain_to_surface` goes f32
// storage buffer → `CAMetalLayer` drawable with no CPU readback (that IS the perf
// win). So the GPU path cannot branch INSIDE `processSceneLinear` without either
// reading the chain back to a CIImage (killing the win) or changing the return
// type (breaking every caller + the flag-off path). Instead it is a PARALLEL
// presentation path gated at the `decodeAndRender` call site: when the GPU path
// handles a phase it presents to the layer and returns `true`, and the caller
// SKIPS the CPU `processSceneLinear` + `renderedPreview =` publish. The CPU path
// stays exactly as it was for the flag-off fallback.
//
// ## The decode-boundary contract (the silent-bug trap)
//
// The buffer handed to the GPU session is the SAME decoded scene-linear CIImage
// the CPU path uses — Rec.2020 fp16, AE + capture-sharpening baked at decode, WB
// landed at 6500/0 (D65). `makeGpuLiveParams` therefore passes
// `capture_sharpening: None`, does NOT re-run AE, and uses develop's ABSOLUTE WB
// (live temp/tint straight through). The on-screen result diverges from today's
// CPU pixels BY DESIGN (sharpen + nr_color move into the scene-linear chain at
// canonical positions; Auto Profile becomes curve + residual-LUT passes instead
// of a pre-composed CIColorCube) — convergence toward canonical `render`, not a
// regression. The colour-correctness proof is the raw-gpu host present-parity
// gate (≤ 1 LSB vs the CPU oracle), NOT a flag-on-vs-flag-off pixel diff.

import Foundation
import CoreImage

@MainActor
extension EditSession {
    /// Attempt to render `decoded` for this phase via the wgpu live chain and
    /// PRESENT it to the registered `CAMetalLayer`, returning `true` when the
    /// GPU path handled the frame (so `decodeAndRender` skips the CPU
    /// `processSceneLinear` + `renderedPreview` publish). Returns `false` —
    /// falling back to the CPU + Metal path — when:
    ///   * the runtime flag is off / no driver (a gpu build with `MAPLE_GPU_LIVE`
    ///     unset),
    ///   * no canvas layer is registered yet (the view hasn't laid out),
    ///   * the asset is non-RAW (the GPU live chain is the RAW scene-linear
    ///     chain; non-RAW keeps its CPU path this cut),
    ///   * the f32 readback or the session open fails (surfaced, then CPU).
    ///
    /// Upload-once contract: the decoded buffer is read back to f32 and uploaded
    /// to the `GpuLiveSession` only when the dims change (a new decode / a
    /// viewport ⇄ full resize); a slider tick at stable dims re-presents the
    /// GPU-resident upload with NO readback (the per-tick path stays
    /// readback-free — the 16ms budget).
    ///
    /// `gen` is the scheduler generation; a stale generation drops the present
    /// before it is issued (mirrors the CPU `renderedPreview =` gen-gate), and
    /// the driver additionally supersedes any present still queued behind the
    /// actor under a fast drag.
    func presentViaGpuLive(
        decoded: CIImage,
        targetSize: CGSize?,
        gen: UInt64?
    ) async -> Bool {
        guard GpuLiveFlag.isEnabled, let driver = gpuLiveDriver else { return false }
        // The live chain is the RAW scene-linear chain (the decode-boundary
        // contract is written for the RAW decode buffer). Non-RAW keeps its CPU
        // path this cut — its decode/contract differ (no AE/capture-sharpen bake).
        guard asset.isRaw else { return false }
        // No canvas to present into yet — let the CPU path publish a CIImage so
        // SOMETHING is on screen until the layer lays out and registers.
        guard driver.hasLayer else { return false }

        let m = model
        let pipeline = self.pipeline
        let assetURL = asset.primaryURL

        // Open (upload-once) the session for these dims if needed. The readback
        // is the per-DECODE cost; `open` re-uploads only on a dims change.
        let dims = Self.gpuTargetDims(for: decoded, targetSize: targetSize, pipeline: pipeline)
        guard let dims else { return false }
        if !driver.isOpen(width: dims.width, height: dims.height) {
            guard let buf = pipeline.sceneLinearFloats(from: decoded, targetSize: targetSize) else {
                return false
            }
            do {
                try driver.open(pixels: buf.pixels, width: buf.width, height: buf.height)
            } catch {
                editSessionLogger.error(
                    "GPU live open failed: \(error.localizedDescription, privacy: .public) — CPU fallback")
                return false
            }
            // Fit the per-image Auto Profile tail once per open (RAW + Auto only;
            // a no-op for Neutral). The editor decodes at `.preview`, so the fit
            // MUST be at `.preview` to match the displayed buffer (#844/#871).
            if m.profile == .auto, let url = assetURL {
                await driver.fitAutoProfileIfNeeded(
                    rawPath: url.path, model: m, quality: .preview)
            }
        }

        // Generation gate: drop a superseded present before issuing it (the CPU
        // path drops at `renderedPreview =`; the GPU present has no post-hoc
        // gate, so we check here AND let the driver supersede the queued one).
        if let gen {
            let live = await renderActor.currentGeneration()
            guard gen == live, !Task.isCancelled else {
                editSessionLogger.debug("GPU live present gen=\(gen) stale (current=\(live)), dropping")
                return true // handled (intentionally dropped) — do NOT fall to CPU
            }
        }

        // Clear any prior error BEFORE the present (optimistic) so a recovered
        // present drops the banner; the `onError` closure re-sets it on failure
        // (clearing AFTER would swallow the very error the closure just set).
        renderError = nil
        await driver.present(model: m) { [weak self] error in
            // A real GPU/present failure: surface it on the session banner
            // (device logs aren't capturable). We've already committed to the
            // GPU path for this frame, so we don't retro-fall-back to CPU here —
            // the next tick re-attempts; a persistent failure shows the banner.
            self?.renderError = error
        }
        // A frame is now on the canvas layer — drive the loading indicator +
        // canvas-ready sentinel off this (renderedPreview is never set on this
        // path). NOT set in the stale-drop branch above (no frame presented). #1069
        // Latch once per session: `EditSession` is `@Observable` and fires on
        // every assignment (no same-value dedup), so an unguarded per-present
        // write would invalidate observing views each frame.
        if !gpuFramePresented { gpuFramePresented = true }
        editSessionLogger.debug(
            "GPU live presented gen=\(gen ?? 0) \(dims.width)x\(dims.height)")
        return true
    }

    /// Whether the ACTIVE canvas currently has a frame on screen — the input the
    /// loading spinner + `canvas-render-ready` sentinel need. The GPU live path's
    /// canvas IS the `CAMetalLayer` (`gpuFramePresented`); the CPU path's canvas
    /// is `renderedPreview`. Keyed on the active path so neither a hydration-seeded
    /// `renderedPreview` (GPU path) nor a hardcoded constant drives readiness. Pure
    /// (all inputs explicit) so it is unit-testable without env/flags, and
    /// `nonisolated` so it's callable off the MainActor. See #1069.
    public nonisolated static func canvasHasFrame(
        gpuActive: Bool,
        gpuFramePresented: Bool,
        hasRenderedPreview: Bool
    ) -> Bool {
        gpuActive ? gpuFramePresented : hasRenderedPreview
    }

    /// Whether the cold-open loading indicator should be visible: while the
    /// full-quality decode is still in flight (so it stays up through the
    /// sub-second preview until the real decode lands), or in the no-preview
    /// blank-canvas window (`isRendering && !hasOnscreenFrame`). Pure → unit-
    /// testable; `nonisolated` like `canvasHasFrame`. #1201 / #1069 follow-up.
    public nonisolated static func shouldShowLoadingIndicator(
        isFullQualityDecoding: Bool,
        isRendering: Bool,
        hasOnscreenFrame: Bool
    ) -> Bool {
        isFullQualityDecoding || (isRendering && !hasOnscreenFrame)
    }

    /// The post-prescale pixel dims the GPU session/layer use for `decoded` at
    /// `targetSize` — the exact extent `sceneLinearFloats` produces, computed
    /// WITHOUT a readback so the open/no-op decision is cheap. Runs the same
    /// `prescaleForDisplay` the readback does (off the pipeline actor) and reads
    /// the resulting extent. `nil` on a degenerate extent.
    private static func gpuTargetDims(
        for decoded: CIImage,
        targetSize: CGSize?,
        pipeline: ImageEditPipeline
    ) -> (width: Int, height: Int)? {
        let extent = pipeline.prescaledExtent(of: decoded, targetSize: targetSize)
        let w = Int(extent.width.rounded())
        let h = Int(extent.height.rounded())
        guard w > 0, h > 0 else { return nil }
        return (w, h)
    }
}
