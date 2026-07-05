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
    ///   * the f32 readback or the session open fails (surfaced, then CPU),
    ///   * the present itself THREW (#1769) — `gpuPresentFailed` flips, the GPU
    ///     canvas leaf unmounts, and this same pass publishes via the CPU path
    ///     so a torn drawable never stays on glass.
    ///
    /// Non-RAW assets (pano PNG, JPEG, HEIF) are now also handled via the GPU
    /// live chain with `inputShape = LinearRec2020Fp16` (#1331): the CPU decode
    /// (`decodeSceneLinearNonRaw`) promotes the buffer to extended linear Rec.2020
    /// before upload, so the chain skips only `capture_sharpening` (not WB —
    /// WB stays engaged with `decoded=6500/0` so temperature/tint slider edits
    /// work correctly on non-RAW assets) and runs the same user-edit and
    /// view-tail stages as the RAW path.
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
        guard GpuLiveFlag.isEnabled, let driver = gpuLiveDriver else {
            editSessionLogger.notice("GPU-TRACE reject flag-or-driver gen=\(gen ?? 0)")
            return false
        }
        // #1637: very large sensors blow the iOS ~6 GB per-process limit on the
        // GPU-live path — its wgpu storage buffers (display-res) plus the
        // in-driver auto-profile fit accumulate across image switches and, with
        // the CPU develop, jetsam-kill the app (a device A/B confirmed the
        // 100 MP reference RAW OOMs with GPU-live ON, survives with it OFF).
        // Fall back to the proven CPU two-phase path above the sensor threshold
        // AND when the size is unknown (`nativeImageSize == .zero`) — a
        // bytes-provider / PhotoKit asset seeds its size ASYNchronously, so a
        // 100 MP library photo can still read `.zero` here and must NOT take
        // the GPU path on spec (that OOM'd). GPU-live resumes once the size
        // seeds and proves small (see `gpuLiveSupportsSensor`).
        // `MAPLE_MEM_PROBE` forces the GPU path on regardless of sensor size so
        // the large-RAW GPU footprint can be MEASURED on device (#1647 M1); the
        // production gate below otherwise routes large sensors to CPU.
        let sensorLongEdge = max(nativeImageSize.width, nativeImageSize.height)
        guard MemoryProbe.isEnabled
            || ImageEditPipeline.gpuLiveSupportsSensor(longEdge: sensorLongEdge) else {
            editSessionLogger.notice(
                "GPU-TRACE reject large-sensor gen=\(gen ?? 0) longEdge=\(sensorLongEdge, format: .fixed(precision: 0))")
            return false
        }
        // Non-RAW assets (pano PNG, JPEG, HEIF) use the GPU live chain with
        // `inputShape = 1` (LinearRec2020Fp16): `decodeSceneLinearNonRaw` already
        // promotes the buffer to extended linear Rec.2020 via CoreImage. The chain
        // skips only capture_sharpening (not WB — WB stays engaged with
        // decoded=6500/0 so the user's temperature/tint slider edits land
        // correctly). All formats that reach here have a valid `decoded` CIImage
        // from the existing decode dispatch. (#1331)
        //
        // Prefer the content-sniffed classification recorded by `sharedDecode`
        // over `asset.isRaw`. Bytes-backed PhotoKit / Self-Hosted assets carry
        // no URL or extension, so `asset.isRaw` defaults them to RAW and the GPU
        // tail would run AgX on a non-RAW buffer — crushing white to grey (#1553).
        // URL/extension-backed assets never sniff (`resolvedIsRaw` is nil) and
        // fall back to `asset.isRaw`, which classifies them correctly up front.
        let resolvedIsRaw = await renderActor.resolvedIsRaw(for: asset.id) ?? asset.isRaw
        let inputShape: UInt32 = resolvedIsRaw ? 0 : 1
        guard driver.hasLayer else {
            editSessionLogger.notice("GPU-TRACE reject no-layer gen=\(gen ?? 0)")
            return false
        }

        let m = model
        let pipeline = self.pipeline
        let assetURL = asset.primaryURL

        let dims = Self.gpuTargetDims(for: decoded, targetSize: targetSize, pipeline: pipeline)
        guard let dims else {
            editSessionLogger.notice("GPU-TRACE reject nil-dims decoded.extent=\(decoded.extent.width)x\(decoded.extent.height) target=\(targetSize.map { "\($0.width)x\($0.height)" } ?? "nil")")
            return false
        }
        editSessionLogger.notice("GPU-TRACE enter gen=\(gen ?? 0) dims=\(dims.width)x\(dims.height) profile=\(String(describing: m.profile), privacy: .public)")
        MemoryProbe.sample("gpu-enter dims=\(dims.width)x\(dims.height) sensor=\(Int(sensorLongEdge))")

        if !driver.isOpen(width: dims.width, height: dims.height) {
            editSessionLogger.notice("GPU-TRACE open begin gen=\(gen ?? 0)")
            guard let buf = pipeline.sceneLinearFloats(from: decoded, targetSize: targetSize) else {
                editSessionLogger.notice("GPU-TRACE reject readback-fail gen=\(gen ?? 0)")
                return false
            }
            editSessionLogger.notice("GPU-TRACE readback ok pixels=\(buf.pixels.count) dims=\(buf.width)x\(buf.height) firstPx=[\(buf.pixels[0]), \(buf.pixels[1]), \(buf.pixels[2]), \(buf.pixels[3])]")
            do {
                try await driver.open(
                    pixels: buf.pixels, width: buf.width, height: buf.height,
                    inputShape: inputShape)
                editSessionLogger.notice("GPU-TRACE open ok gen=\(gen ?? 0) inputShape=\(inputShape)")
                MemoryProbe.sample("gpu-open dims=\(buf.width)x\(buf.height)")
            } catch {
                editSessionLogger.error(
                    "GPU live open failed: \(error.localizedDescription, privacy: .public) — CPU fallback")
                return false
            }
        }

        // Auto Profile fit: RAW + Auto only. Non-RAW assets have no rawPath to
        // fit from; their view chain runs through the identity profile artifacts
        // (`params.rs` defaults to the identity curve + 2³ LUT) (#1331).
        if asset.isRaw, m.profile == .auto, let url = assetURL {
            await driver.fitAutoProfileIfNeeded(
                rawPath: url.path, model: m, quality: .preview)
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

        renderError = nil
        // NOTE (#1769): the driver no longer writes `layer.drawableSize` here —
        // wgpu's `surface.configure` is the single writer (see
        // `GpuLiveDriver.register`). The old host-side write invalidated the
        // drawable pool on every 1-px disagreement, un-protected by the
        // settle double-present.
        editSessionLogger.notice("GPU-TRACE present begin gen=\(gen ?? 0) dims=\(dims.width)x\(dims.height)")
        var presentErr: Error? = nil
        await driver.present(
            model: m,
            asShotCCT: asShotCCT,
            asShotTint: asShotTint
        ) { [weak self] error in
            presentErr = error
            self?.renderError = error
        }
        if let presentErr {
            // NO silent failure (#1769): a thrown present means nothing (or a
            // torn frame) is on glass and the GPU path has no repaint of its
            // own. Returning `false` sends this same `decodeAndRender` pass
            // down the CPU `processSceneLinear` + `renderedPreview` publish,
            // and `gpuPresentFailed` unmounts the GPU canvas leaf so the CPU
            // preview is actually visible. Pre-#1769 this path returned `true`
            // ("handled"), leaving a stale/torn drawable on screen with no
            // recovery until the next successful GPU present.
            gpuPresentFailed = true
            editSessionLogger.notice("GPU-TRACE present FAILED gen=\(gen ?? 0), falling back to CPU canvas: \(presentErr.localizedDescription, privacy: .public)")
            return false
        }
        editSessionLogger.notice("GPU-TRACE present OK gen=\(gen ?? 0)")
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
            // #1665: populate the rendered-preview disk cache from THIS exact frame
            // so the next cold open paints instantly. The GPU present skips the CPU
            // `renderedPreview` publish + `persistCurrentPreviewToCache`, so without
            // this large RAWs never write a preview and every reopen re-decodes.
            // One-shot (this branch fires once per cold open); the readback + encode
            // run off the MainActor and never block a present or a slider tick.
            Task { await persistGpuFrameToPreviewCache() }
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
