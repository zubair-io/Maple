// GpuLiveDriver.swift — the EditSession-owned driver for the wgpu live render
// path (epic #925, P4b-apple / #1028).
//
// Always compiled, but only instantiated when the runtime flag is on
// (`GpuLiveFlag.isEnabled` — `EditSession.gpuLiveDriver` is `nil` otherwise). Flag
// OFF = the editor uses the CPU + Metal + CIColorCube path
// (`processSceneLinear` → `renderedPreview` → `CIImageView`) byte-for-byte.
//
// ## Role
//
// Bridges the EditSession two-phase scheduler to the serialized `GpuLiveSession`
// + the `CAMetalLayer` the canvas view hosts. The CPU path publishes a `CIImage`
// to `renderedPreview`; the GPU path instead presents directly to the layer (no
// CIImage, no `renderedPreview` write). So this is a PARALLEL presentation path,
// not a rewrite of `processSceneLinear` — which stays untouched (the flag-off
// guarantee).
//
// ## What it owns
//
//   * the `GpuLiveSession` (upload-once per dims; re-opened on a viewport ⇄ full
//     resize, pairing with the sized-fast / full-refine decode split);
//   * a weak reference to the registered `CAMetalLayer` (the view owns the layer's
//     lifetime; the driver presents into it);
//   * the per-image Auto Profile artifacts (fit once on open, via the session).
//
// ## Serialization + cancellation
//
// `GpuLiveSession` is an `actor` (one render in flight — the `!Send` Rust
// context). The driver's `present` calls hop onto it; the EditSession scheduler's
// GENERATION GUARD (the same `gen == live` check the CPU path uses before
// `renderedPreview = image`) decides whether a finished present is still current —
// a stale present (superseded by a newer edit) is simply not the one that lands on
// screen, exactly as today. A per-present `CancelFlag` lets a queued-but-stale
// present bail at the FFI entry before burning a GPU cycle.

import Foundation
import QuartzCore
import os

private let gpuDriverLog = Logger(subsystem: "app.justmaple.aperture", category: "gpu-live-driver")

/// Drives the wgpu live render path for one EditSession: owns the per-dims
/// `GpuLiveSession`, the registered `CAMetalLayer`, and the per-image Auto Profile
/// fit. `@MainActor` because it is created/registered/invoked from EditSession
/// (also `@MainActor`); the heavy GPU work hops onto the `GpuLiveSession` actor.
@MainActor
public final class GpuLiveDriver {
    /// The current session (one set of dims). `nil` until the first open; replaced
    /// on a dims change. Held strongly — it owns the uploaded image + GPU buffers.
    private var session: GpuLiveSession?
    /// Dims the current `session` was opened at; a present at different dims forces
    /// a re-open (upload-once is per-dims).
    private var sessionDims: (width: Int, height: Int)?

    /// The canvas layer to present into. Weak — the SwiftUI view owns it; if the
    /// view goes away the driver simply has nothing to present to.
    private weak var layer: CAMetalLayer?

    /// The RAW path + decode quality for the Auto Profile fit (set on open).
    private var autoProfileFitDone = false

    /// The input-shape tag for the open session (#1331): 0 = PostDcpRec2020Fp16
    /// (RAW, all stages), 1 = LinearRec2020Fp16 (pano PNG, skip WB+CS). Stored at
    /// `open` time and forwarded to every `present` so the chain knows which leading
    /// stages to run. 0 is the safe default (preserves pre-#1331 RAW behaviour).
    private var inputShape: UInt32 = 0

    /// Rolling per-tick GPU render+present latency for the in-app frame-time HUD
    /// (#1053). The driver records every REAL present's elapsed ms here (cancelled
    /// presents return `nil` and are skipped), but ONLY when `GpuHudFlag.isEnabled`
    /// — so a gpu build with the HUD off does zero extra work on the render path.
    /// `@Observable`, so `FullImageView`'s overlay re-renders as frames land.
    /// Owned by the driver (the natural recorder); the view reads it via
    /// `session.gpuLiveDriver?.frameStats`.
    public let frameStats = GpuFrameTimeStats()

    /// Cancel flag of the most-recent present. The CPU path drops a stale
    /// render at the `renderedPreview =` generation gate; the GPU present has
    /// no such gate — once `present_chain_to_surface` runs, it's on screen. So
    /// before issuing a new present we FLIP this (the FFI bails at its entry →
    /// `RC_PRESENT_CANCELLED`) so a queued-but-superseded present under a fast
    /// slider drag never lands after the newer one. The `GpuLiveSession` actor
    /// serializes the presents themselves (one render in flight), so this is
    /// purely the "supersede the one already queued" guard. Held weakly: it's
    /// owned for the duration of its present call by `present(...)` below.
    private weak var inFlightCancel: CancelFlag?

    public init() {}

    /// Register the canvas layer the driver presents into. Called by
    /// `GpuLiveCanvasView` when its `CAMetalLayer` is created / its host view lays
    /// out. Idempotent.
    public func register(layer: CAMetalLayer) {
        self.layer = layer
    }

    /// Force the registered layer's `drawableSize` to exactly `(width, height)`.
    /// The wgpu present chain asserts `surface_dims == image_dims`; the
    /// canvas view sizes the layer from the host view's pixel bounds, but the
    /// renderer's `prescaledExtent` rounds to aspect-preserved integer dims
    /// that may be 1 pixel off (e.g. 914x685 viewport → 913x685 image). The
    /// present then throws `GpuLiveError(1)` and the canvas reads as opaque
    /// black — the #1240 "image disappears" report. Calling this with the
    /// image dims before `present` keeps them aligned.
    public func setDrawableSize(width: Int, height: Int) {
        guard let layer = layer else { return }
        let size = CGSize(width: CGFloat(width), height: CGFloat(height))
        if layer.drawableSize != size {
            layer.drawableSize = size
        }
    }

    /// Open (or re-open) the session for `pixels` at `width × height` — the decoded
    /// scene-linear f32 RGBA buffer. A re-open happens only when the dims change
    /// (upload-once per dims). Resets the Auto Profile fit so the next `present`
    /// re-fits for the new buffer if needed. Throws on an FFI open failure (the
    /// caller falls back to leaving the canvas on its prior frame).
    /// `inputShape` is the `MapleGpuLiveParams.input_shape` tag (#1331): 0 =
    /// PostDcpRec2020Fp16 (RAW, all stages), 1 = LinearRec2020Fp16 (pano PNG).
    public func open(pixels: [Float], width: Int, height: Int, inputShape: UInt32 = 0) throws {
        if let d = sessionDims, d.width == width, d.height == height, session != nil {
            // Same dims — reuse the existing upload-once session (just refresh the
            // pixels by re-opening only if the buffer content changed is the
            // caller's call; for a decode at the same dims we re-open to pick up the
            // new buffer).
        }
        let s = try GpuLiveSession(pixels: pixels, width: width, height: height)
        self.session = s
        self.sessionDims = (width, height)
        self.autoProfileFitDone = false
        self.inputShape = inputShape
        gpuDriverLog.debug("opened GPU live session \(width)x\(height) inputShape=\(inputShape)")
    }

    /// Fit the Auto Profile curve + residual LUT for `rawPath` once per open (the
    /// A2 artifacts the chain's curve/LUT passes reapply every tick). No-op after
    /// the first call per open, or when `model.profile != .auto`.
    public func fitAutoProfileIfNeeded(rawPath: String, model: AdjustmentModel, quality: PipelineRenderer.Quality) async {
        guard let s = session else { return }
        if model.profile == .auto && !autoProfileFitDone {
            autoProfileFitDone = true
            await s.fitAutoProfile(rawPath: rawPath, quality: quality)
        }
    }

    /// Present `model` to the registered layer via the GPU chain. SUPERSEDES
    /// any present still queued behind the actor: flips the prior present's
    /// cancel flag (the FFI drops a superseded present at its entry) and mints a
    /// fresh flag for this one, so the last present issued wins. A no-op when
    /// there is no session or no layer yet (the canvas keeps its prior frame).
    /// Surfaces a real GPU/present error through `onError` (device logs aren't
    /// capturable — the in-app HUD is the only on-device surface).
    public func present(
        model: AdjustmentModel,
        asShotCCT: Double? = nil,
        asShotTint: Double? = nil,
        onError: (Error) -> Void
    ) async {
        guard let s = session else {
            gpuDriverLog.notice("GPU-TRACE driver.present skipped: no session")
            return
        }
        guard let layer = layer else {
            gpuDriverLog.notice("GPU-TRACE driver.present skipped: no layer")
            return
        }
        gpuDriverLog.notice("GPU-TRACE driver.present begin drawableSize=\(Int(layer.drawableSize.width))x\(Int(layer.drawableSize.height))")
        inFlightCancel?.requestCancel()
        let cancel = CancelFlag()
        inFlightCancel = cancel
        do {
            let elapsedMs = try await s.present(
                model: model, layer: layer, cancel: cancel,
                asShotCCT: asShotCCT, asShotTint: asShotTint,
                inputShape: self.inputShape
            )
            withExtendedLifetime(cancel) {}
            if let elapsedMs {
                gpuDriverLog.notice("GPU-TRACE driver.present OK \(elapsedMs)ms")
            } else {
                gpuDriverLog.notice("GPU-TRACE driver.present cancelled (returned nil)")
            }
            if GpuHudFlag.isEnabled, let elapsedMs {
                frameStats.record(elapsedMs)
            }
        } catch let e as GpuLiveError {
            gpuDriverLog.notice("GPU-TRACE driver.present THREW: \(e.message, privacy: .public)")
            onError(e)
        } catch {
            gpuDriverLog.notice("GPU-TRACE driver.present THREW: \(error.localizedDescription, privacy: .public)")
            onError(error)
        }
    }

    /// Render the CURRENT session's frame to a `width·height·3` u8 RGB CPU buffer —
    /// the EXACT bytes `present` puts on screen (same chain + dither; the live
    /// params hardcode `target_primaries = 0`, so sRGB-primary gamma-encoded).
    /// For a ONE-SHOT cold-open preview-cache populate (#1665); NOT for per-tick
    /// use — it re-runs the chain WITH a CPU readback, the very cost `present`
    /// avoids. Returns `nil` when no session is open or the render was cancelled
    /// (the caller then simply leaves the cache unpopulated).
    public func renderCurrentFrameBytes(
        model: AdjustmentModel
    ) async -> (bytes: [UInt8], width: Int, height: Int)? {
        guard let s = session, let dims = sessionDims else { return nil }
        do {
            guard let bytes = try await s.renderToBuffer(model: model, inputShape: inputShape)
            else { return nil }
            return (bytes, dims.width, dims.height)
        } catch {
            gpuDriverLog.error(
                "renderCurrentFrameBytes failed: \(error.localizedDescription, privacy: .public) — preview cache not populated")
            return nil
        }
    }

    /// Whether a session is open (so the EditSession knows the GPU path is live).
    public var hasSession: Bool { session != nil }

    /// Whether a canvas layer has been registered (the host view has laid out).
    /// Until then the GPU path has nothing to present into and the caller keeps
    /// publishing a CIImage via the CPU path so the canvas isn't blank.
    public var hasLayer: Bool { layer != nil }

    /// Whether the current session is open at exactly `width × height` — the
    /// upload-once guard. `decodeAndRender` re-opens (re-reads-back + re-uploads)
    /// only when this is `false` (a new decode or a viewport ⇄ full resize).
    public func isOpen(width: Int, height: Int) -> Bool {
        session != nil && sessionDims?.width == width && sessionDims?.height == height
    }

    /// The current session dims, if open.
    public var currentDims: (width: Int, height: Int)? { sessionDims }
}
