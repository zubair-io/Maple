// EditSession+ScopeCpu.swift — CPU / non-GPU-live scope producer (#3277).
//
// The GPU-live path gets its scope sample as a byproduct of
// `GpuLiveSession.present` (see EditSession+GpuLive.swift). Whenever that
// path declines the frame — GPU live off, no CAMetalLayer yet, or a readback
// failure — `decodeAndRender` (EditSession+Render.swift) falls through to
// the CPU filter chain instead, and that publish has no scope byproduct of
// its own (and never will for a non-RAW asset, which the GPU-live path never
// opens for). This file fills the gap with an independent, debounced scope
// compute that mirrors `LocalHistogram`'s shape: its own decode, its own
// develop, rather than threading a scope side-channel through
// `decodeAndRender`'s already-intricate cached/fresh branches.

import CoreImage
import Foundation

@MainActor
extension EditSession {
    /// Idle-debounce window before the CPU scope producer recomputes — same
    /// window `MiniHistogram` uses, so a slider drag settles before either
    /// diagnostic pays for a decode.
    static let scopeCpuIdleDebounce: Duration = .milliseconds(350)

    /// (Re)arm the debounced CPU scope compute for the current (asset,
    /// edit) state. Called from `decodeAndRender`'s CPU-path publish; a
    /// no-op when the scope HUD isn't showing. Each call cancels the prior
    /// pending compute, so a continuous slider drag coalesces to the tail —
    /// same shape as `scheduleDisplayPreviewPersist`.
    func scheduleScopeCpuUpdate() {
        guard scopeEnabled else { return }
        scopeCpuTask?.cancel()
        scopeCpuTask = Task { [weak self] in
            try? await Task.sleep(for: Self.scopeCpuIdleDebounce)
            guard !Task.isCancelled else { return }
            await self?.computeScopeCpu()
        }
    }

    /// Runs the decode + scoped-chain compute and publishes the result.
    /// Re-checks `scopeEnabled` after the awaits (the HUD may have been
    /// hidden, or the compute superseded, while this was in flight).
    private func computeScopeCpu() async {
        guard scopeEnabled else { return }
        guard asset.primaryURL != nil || asset.bytesProvider != nil else { return }
        let asset = self.asset
        let m = model
        do {
            let sample = try await Self.renderScopeSample(asset: asset, model: m)
            guard !Task.isCancelled, scopeEnabled else { return }
            scopeSample = sample
        } catch {
            // Best-effort diagnostic overlay: a failed compute just leaves
            // the last sample on screen (or none), matching
            // `LocalHistogram`'s callers' catch-and-keep-prior behaviour.
            editSessionLogger.error(
                "computeScopeCpu failed: \(String(describing: error), privacy: .public)"
            )
        }
    }

    /// Decode `asset` under `model` at a fixed diagnostic resolution and run
    /// it through the scoped fused FFI entry (chain + encode + vectorscope
    /// bin, one Rust call). `nonisolated` so it runs off the MainActor like
    /// `LocalHistogram`'s compute functions; takes `asset`/`model` by value
    /// so the caller can snapshot MainActor state before awaiting.
    ///
    /// WB is left at the FFI's own "no override" default — the same choice
    /// `EditSession+Masks.swift`'s `renderForSegmentation` makes for its own
    /// secondary consumer of the chain. This is a diagnostic readout of the
    /// graded color, not a pixel-parity path, so the as-shot-anchor
    /// precision a real slider frame buys is immaterial here.
    /// `internal` rather than `private` so `ScopeCpuProducerTests` can drive
    /// one compute directly, without waiting out the debounce.
    nonisolated static func renderScopeSample(
        asset: AssetRef,
        model: AdjustmentModel
    ) async throws -> ScopeSample {
        let target = CGSize(width: 1024, height: 1024)
        let pipeline = ImageEditPipeline()
        let decoded: CIImage
        let noiseProfile: [Float]?
        if asset.isRaw {
            guard let result = await pipeline.decodeSceneLinearSized(asset: asset, targetSize: target)
            else {
                throw PipelineError.renderFailed(code: -1, message: "scope decode failed")
            }
            decoded = result.image
            noiseProfile = result.noiseProfile
        } else {
            guard let result = await pipeline.decodeSceneLinearNonRaw(asset: asset, targetSize: target)
            else {
                throw PipelineError.renderFailed(code: -1, message: "scope decode failed (non-RAW)")
            }
            decoded = result
            noiseProfile = nil
        }
        guard let floats = pipeline.sceneLinearFloats(from: decoded, targetSize: nil) else {
            throw PipelineError.renderFailed(code: -2, message: "scope readback failed")
        }
        let inputBytes = floats.pixels.withUnsafeBufferPointer { Data(buffer: $0) }
        let params = PipelineRenderer.makeParams(from: model)
        return try PipelineRenderer.applyChainAndEncodeDisplayScoped(
            inputBytes: inputBytes,
            width: floats.width,
            height: floats.height,
            params: params,
            scopeLayer: -1,
            noiseProfile: noiseProfile,
            localAdjustments: model.localAdjustments  // #3338
        )
    }
}
