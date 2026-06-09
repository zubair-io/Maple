// GpuLiveDriver.swift — the EditSession-owned driver for the wgpu live render
// path (epic #925, P4b-apple / #1028).
//
// ENTIRELY gated behind `#if MAPLE_GPU`. Flag OFF = absent; the editor uses the
// CPU + Metal + CIColorCube path (`processSceneLinear` → `renderedPreview` →
// `CIImageView`) byte-for-byte.
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

#if MAPLE_GPU

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

    /// Open (or re-open) the session for `pixels` at `width × height` — the decoded
    /// scene-linear f32 RGBA buffer. A re-open happens only when the dims change
    /// (upload-once per dims). Resets the Auto Profile fit so the next `present`
    /// re-fits for the new buffer if needed. Throws on an FFI open failure (the
    /// caller falls back to leaving the canvas on its prior frame).
    public func open(pixels: [Float], width: Int, height: Int) throws {
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
        gpuDriverLog.debug("opened GPU live session \(width)x\(height)")
    }

    /// Fit the Auto Profile curve + residual LUT for `rawPath` once per open (the
    /// A2 artifacts the chain's curve/LUT passes reapply every tick). No-op after
    /// the first call per open, or when `model.profile != .auto`.
    public func fitAutoProfileIfNeeded(rawPath: String, model: AdjustmentModel, quality: PipelineRenderer.Quality) async {
        guard !autoProfileFitDone, let s = session else { return }
        autoProfileFitDone = true
        if model.profile == .auto {
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
    public func present(model: AdjustmentModel, onError: (Error) -> Void) async {
        guard let s = session else { return }
        guard let layer = layer else { return }
        // Supersede the prior present (if it hasn't already started on the
        // actor) before queuing this one — last-write-wins under a fast drag.
        inFlightCancel?.requestCancel()
        let cancel = CancelFlag()
        inFlightCancel = cancel
        do {
            // Hold a strong ref to `cancel` across the whole await so the
            // Rust entry's flag read can't race a dealloc (the RenderCancelFlag
            // strong-reference contract). `present` returns the GPU render+present
            // latency in ms for a REAL frame, or `nil` if it was superseded
            // (cancelled). Feed the HUD only the real frames, and only when the
            // HUD flag is on (flag-on/HUD-off does no recording at all).
            let elapsedMs = try await s.present(model: model, layer: layer, cancel: cancel)
            withExtendedLifetime(cancel) {}
            if GpuHudFlag.isEnabled, let elapsedMs {
                frameStats.record(elapsedMs)
            }
        } catch {
            gpuDriverLog.error("GPU present failed: \(error.localizedDescription, privacy: .public)")
            onError(error)
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

#endif
