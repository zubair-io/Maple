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
        if !GpuLiveFlag.isEnabled {
            logGpuLiveReject("flag-off", "MAPLE_GPU_LIVE=0 (or build w/o flag)")
            return false
        }
        guard let driver = gpuLiveDriver else {
            logGpuLiveReject("driver-nil", "gpuLiveDriver lazy init returned nil")
            return false
        }
        // The live chain is the RAW scene-linear chain (the decode-boundary
        // contract is written for the RAW decode buffer). Non-RAW keeps its CPU
        // path this cut — its decode/contract differ (no AE/capture-sharpen bake).
        guard asset.isRaw else {
            logGpuLiveReject("non-raw", "primaryURL=\(asset.primaryURL?.lastPathComponent ?? "nil") hintExt=\(asset.hintExtension ?? "nil")")
            return false
        }
        // No canvas to present into yet — let the CPU path publish a CIImage so
        // SOMETHING is on screen until the layer lays out and registers.
        guard driver.hasLayer else {
            logGpuLiveReject("no-layer", "GpuLiveCanvasView has not laid out — `useGpuCanvas` likely false in FullImageView")
            return false
        }

        let m = model
        let pipeline = self.pipeline
        let assetURL = asset.primaryURL

        // Open (upload-once) the session for these dims if needed. The readback
        // is the per-DECODE cost; `open` re-uploads only on a dims change.
        let dims = Self.gpuTargetDims(for: decoded, targetSize: targetSize, pipeline: pipeline)
        guard let dims else {
            logGpuLiveReject("nil-dims", "prescaledExtent rounded to 0 — targetSize=\(targetSize.map { "\($0.width)x\($0.height)" } ?? "nil")")
            return false
        }
        if !driver.isOpen(width: dims.width, height: dims.height) {
            guard let buf = pipeline.sceneLinearFloats(from: decoded, targetSize: targetSize) else {
                logGpuLiveReject("readback-fail", "sceneLinearFloats returned nil at \(dims.width)x\(dims.height)")
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
        // Wall-clock the present so the in-app diagnostic banner can show
        // last-tick ms. The internal `GpuFrameTimeStats` only records when the
        // HUD env-flag is on; this counter is unconditional (one Date pair per
        // present, single Observable write) so the in-app banner is always live.
        let presentStart = Date()
        await driver.present(model: m) { [weak self] error in
            // A real GPU/present failure: surface it on the session banner
            // (device logs aren't capturable). We've already committed to the
            // GPU path for this frame, so we don't retro-fall-back to CPU here —
            // the next tick re-attempts; a persistent failure shows the banner.
            self?.renderError = error
        }
        gpuLiveLastPresentMs = Date().timeIntervalSince(presentStart) * 1000.0
        gpuLivePresentCount &+= 1
        // A frame is now on the canvas layer — drive the loading indicator +
        // canvas-ready sentinel off this (renderedPreview is never set on this
        // path). NOT set in the stale-drop branch above (no frame presented). #1069
        // Latch once per session: `EditSession` is `@Observable` and fires on
        // every assignment (no same-value dedup), so an unguarded per-present
        // write would invalidate observing views each frame.
        if !gpuFramePresented { gpuFramePresented = true }
        // GPU analog of the CPU publish clear (#1221): `decodeAndRender` returns
        // early on a successful GPU present and never reaches its `renderedPreview`
        // block, so the cold-open indicator must be settled HERE too — otherwise
        // it stays stuck on RAWs using the (default) GPU live canvas. Gated on
        // `!isFullQualityDecoding` so the embedded-preview presents during the
        // decode don't clear it early, exactly as the CPU path. (Copilot #1222)
        if isResolvingFirstFrame && !isFullQualityDecoding {
            isResolvingFirstFrame = false
            editSessionLogger.notice(
                "loading indicator HIDDEN — first full-quality frame presented (GPU live, gen=\(gen ?? 0))"
            )
        }
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
    /// cold-open is still resolving its first full-quality frame (so it stays up
    /// from open, through the sub-second preview AND the decode, until the real
    /// image actually publishes), or in the no-preview blank-canvas window
    /// (`isRendering && !hasOnscreenFrame`). Pure → unit-testable; `nonisolated`
    /// like `canvasHasFrame`. #1201 / #1069 follow-up.
    public nonisolated static func shouldShowLoadingIndicator(
        isResolvingFirstFrame: Bool,
        isRendering: Bool,
        hasOnscreenFrame: Bool
    ) -> Bool {
        isResolvingFirstFrame || (isRendering && !hasOnscreenFrame)
    }

    /// Log a `notice` line the FIRST time the GPU live path rejects for a given
    /// reason in this session — and stay silent for every subsequent rejection
    /// for that same reason. A slider drag generating hundreds of ticks against
    /// a permanent reject (e.g. the canvas view never laid out) prints exactly
    /// one diagnostic line, loud enough to grep for, instead of flooding the log.
    /// The latch resets per asset (a new `EditSession` is created per open), so
    /// re-opening the same asset re-arms the diagnostic.
    func logGpuLiveReject(_ reason: String, _ detail: @autoclosure () -> String = "") {
        guard !gpuLiveRejectReasonsLogged.contains(reason) else { return }
        gpuLiveRejectReasonsLogged.insert(reason)
        let d = detail()
        let driver = gpuLiveDriver
        let driverState = "driver=\(driver == nil ? "nil" : "set") hasLayer=\(driver?.hasLayer ?? false) hasSession=\(driver?.hasSession ?? false)"
        let userToken = d.isEmpty ? reason : "\(reason)(\(d))"
        if d.isEmpty {
            editSessionLogger.notice(
                "GPU live REJECTED — \(reason, privacy: .public) [\(driverState, privacy: .public)] → CPU fallback this session"
            )
        } else {
            editSessionLogger.notice(
                "GPU live REJECTED — \(reason, privacy: .public): \(d, privacy: .public) [\(driverState, privacy: .public)] → CPU fallback this session"
            )
        }
        // Surface in-app too — iOS device logs aren't capturable (network pair,
        // no USB attach). The banner in `FullImageView` reads `gpuLiveDiagSummary`,
        // which prefers REJECT entries over the present-count line.
        gpuLiveRejectMessages.append(userToken)
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
