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

/// Identity of the pixel buffer currently uploaded to the open
/// `GpuLiveSession` (#2039, #2049). A same-dims present must still force a
/// re-open when either component changes:
///
///   * `decodeGeneration` — the `RenderActor` write-generation the uploaded
///     buffer came from. A baked-field edit (highlightRecovery,
///     captureSharpeningAmount/Sigma, the unsharp sharpenRadius/Detail/
///     Masking) forces a fresh decode at the SAME target dims; dims alone
///     can't detect that, so reusing the session on dims would silently
///     present the live chain over the STALE uploaded buffer (#2049).
///   * `crop` — the crop actually folded into the uploaded pixels
///     (`.identity` when no crop applies). A crop CHANGE alters
///     `CropImageStage.apply`'s output — even at a pixel size that happens
///     to coincide with the previous crop's — so dims coverage alone can't
///     stand in for it either (#2039).
public struct GpuUploadIdentity: Equatable, Sendable {
    public let decodeGeneration: UInt64
    public let crop: Crop

    public init(decodeGeneration: UInt64, crop: Crop) {
        self.decodeGeneration = decodeGeneration
        self.crop = crop
    }
}

/// Drives the wgpu live render path for one EditSession: owns the per-dims
/// `GpuLiveSession`, the registered `CAMetalLayer`, and the per-image Auto Profile
/// fit. `@MainActor` because it is created/registered/invoked from EditSession
/// (also `@MainActor`); the heavy GPU work hops onto the `GpuLiveSession` actor.
@MainActor
public final class GpuLiveDriver {
    /// The current session (one set of dims). `nil` until the first open; replaced
    /// on a dims change. Held strongly — it owns the uploaded image + GPU buffers.
    private var session: GpuLiveSession?
    /// Dims the current `session` was opened at; a present that isn't COVERED by
    /// these dims (either axis smaller than requested) forces a re-open
    /// (upload-once-and-reuse is per-covering-dims, #2039 — see `isOpen`).
    private var sessionDims: (width: Int, height: Int)?

    /// Identity of the pixels currently uploaded to `session` (#2039, #2049) —
    /// the decode generation + crop `open` was last called with. A present
    /// whose requested identity doesn't match this, even at covered dims,
    /// forces a re-open (see `GpuUploadIdentity`).
    private var uploadedIdentity: GpuUploadIdentity?

    /// The canvas layer to present into. Weak — the SwiftUI view owns it; if the
    /// view goes away the driver simply has nothing to present to.
    private weak var layer: CAMetalLayer?

    /// The surface-cache generation token (#1769). Forwarded to every
    /// `maple_gpu_present_chain`; the Rust side keys its PROCESS-WIDE present
    /// surface on `(generation, layer, dims)`. Bumped when:
    ///   * a DIFFERENT `CAMetalLayer` instance registers (SwiftUI recreated the
    ///     canvas view — covers malloc address reuse, where the raw pointer
    ///     alone would falsely match a dead layer), or
    ///   * the layer's `drawableSize` diverges from the last successful
    ///     present's dims at an otherwise-unchanged key (an external
    ///     re-derivation wgpu cannot see — see `presentDivergenceCheck`).
    /// A bump forces a deterministic old-surface teardown + fresh configure +
    /// the settle double-present on the Rust side.
    private var surfaceGeneration: UInt64 = 0

    /// The `(generation, dims)` of the most recent SUCCESSFUL present — the
    /// state the Rust cache is known to be configured at. Drives the
    /// drawableSize-divergence check: only when the upcoming present would hit
    /// the no-configure fast path (same generation, same dims) does a
    /// drawableSize mismatch mean an external invalidation.
    private var lastPresentedKey: (generation: UInt64, width: Int, height: Int)?

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
    /// `@Observable`, so `GpuFrameTimeHud` re-renders as frames land. Owned
    /// by the driver (the natural recorder); the view reads it via
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
    /// out. Idempotent for the SAME layer instance; a different instance bumps
    /// the surface generation so the Rust cache can never present against a
    /// recycled layer address (#1769).
    ///
    /// NOTE (single-writer contract, #1769): the driver does NOT write
    /// `layer.drawableSize` — wgpu's `surface.configure` owns it. Host-side
    /// writes (the old `layoutSubviews` sizing + `setDrawableSize`) invalidated
    /// the CAMetalLayer drawable pool without wgpu knowing, so a single present
    /// after a layout pass could land on a freshly-invalidated pool: the iPad
    /// partial-render splice, with none of #1743's double-present protection.
    public func register(layer: CAMetalLayer) {
        if layer !== self.layer {
            self.layer = layer
            surfaceGeneration &+= 1
        }
    }

    /// Open (or re-open) the session for `pixels` at `width × height` — the decoded
    /// scene-linear f32 RGBA buffer. A re-open happens only when the dims change
    /// (upload-once per dims) or a new decode lands. Resets the Auto Profile fit
    /// so the next `present` re-fits for the new buffer if needed. Throws on an
    /// FFI open failure (the caller falls back to leaving the canvas on its
    /// prior frame).
    ///
    /// DETERMINISTIC TEARDOWN (#1769): the OLD session is closed explicitly —
    /// and its close AWAITED — before the new one opens. Pre-#1769 the old
    /// actor's `deinit` closed the old FFI handle at a nondeterministic time,
    /// possibly after the replacement had already presented; with the handle
    /// owning the surface+context that dropped a live `wgpu::Surface` (and its
    /// whole device) against the still-mounted `CAMetalLayer` mid-flight — the
    /// cold-open splice boundary. The surface + `GpuContext` now live in a
    /// process-wide Rust slot that SURVIVES this re-open (dims changes
    /// reconfigure in place), and the old session teardown drops only its
    /// image/scratch buffers, serialized behind the same Rust-side lock.
    ///
    /// `inputShape` is the `MapleGpuLiveParams.input_shape` tag (#1331): 0 =
    /// PostDcpRec2020Fp16 (RAW, all stages), 1 = LinearRec2020Fp16 (pano PNG).
    ///
    /// `identity` (#2039, #2049) is the decode-generation + crop the caller
    /// read back `pixels` from — stored so a later `isOpen(coveringWidth:
    /// height:identity:)` can tell a genuine reuse apart from a same-dims
    /// present of DIFFERENT pixels (a baked-field re-decode or a crop change).
    public func open(
        pixels: [Float], width: Int, height: Int, inputShape: UInt32 = 0,
        identity: GpuUploadIdentity
    ) async throws {
        if let old = session {
            await old.close()
        }
        let s = try GpuLiveSession(pixels: pixels, width: width, height: height)
        self.session = s
        self.sessionDims = (width, height)
        self.uploadedIdentity = identity
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
        wbFrame: WbSliderFrame? = nil,
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
        // drawableSize divergence check (#1769): the Rust side is
        // `drawableSize`'s single writer (`surface.configure`), so when this
        // present would hit the no-configure fast path (same generation, same
        // dims as the last successful present) the layer MUST still report
        // those dims. A mismatch means something outside wgpu re-derived the
        // drawable pool (a CoreAnimation scale/bounds re-derivation) — bump the
        // generation so the Rust side tears down + reconfigures + settles with
        // the double-present instead of landing one present on an invalidated
        // pool.
        if let key = lastPresentedKey, let dims = sessionDims,
           key.generation == surfaceGeneration,
           key.width == dims.width, key.height == dims.height,
           layer.drawableSize != CGSize(width: CGFloat(dims.width), height: CGFloat(dims.height)) {
            surfaceGeneration &+= 1
            gpuDriverLog.notice(
                "GPU-TRACE drawableSize diverged (\(Int(layer.drawableSize.width))x\(Int(layer.drawableSize.height)) vs \(dims.width)x\(dims.height)) — bumped surface generation to \(self.surfaceGeneration)")
        }
        inFlightCancel?.requestCancel()
        let cancel = CancelFlag()
        inFlightCancel = cancel
        do {
            let elapsedMs = try await s.present(
                model: model, layer: layer, cancel: cancel,
                asShotCCT: asShotCCT, asShotTint: asShotTint,
                inputShape: self.inputShape,
                surfaceGeneration: surfaceGeneration,
                wbFrame: wbFrame
            )
            withExtendedLifetime(cancel) {}
            if let elapsedMs {
                gpuDriverLog.notice("GPU-TRACE driver.present OK \(elapsedMs)ms")
                if let dims = sessionDims {
                    lastPresentedKey = (surfaceGeneration, dims.width, dims.height)
                }
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
        model: AdjustmentModel,
        asShotCCT: Double? = nil,
        asShotTint: Double? = nil,
        wbFrame: WbSliderFrame? = nil
    ) async -> (bytes: [UInt8], width: Int, height: Int)? {
        guard let s = session, let dims = sessionDims else { return nil }
        do {
            guard let bytes = try await s.renderToBuffer(
                model: model,
                asShotCCT: asShotCCT,
                asShotTint: asShotTint,
                inputShape: inputShape,
                wbFrame: wbFrame
            )
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

    /// Pure reuse decision (#2039, #2049) — factored out of `isOpen` so it's
    /// testable with no Metal / session involved. `openDims`/`uploadedIdentity`
    /// are `nil` when no session is open (always "not reusable" then).
    ///
    /// Reuse requires BOTH:
    ///   * coverage — the open session's dims are ≥ the request on both axes.
    ///     `presentViaGpuLive` only ever requests the viewport size (fast) or
    ///     the ≤2× refine size, so reusing a bigger session for a smaller
    ///     request bounds the supersampling cost to that same ceiling — the
    ///     presented buffer supersamples down through the `CAMetalLayer`,
    ///     which is visually fine.
    ///   * identity — the uploaded pixels came from the SAME decode
    ///     generation and crop as the request. See `GpuUploadIdentity`.
    nonisolated static func shouldReuseSession(
        openDims: (width: Int, height: Int)?,
        uploadedIdentity: GpuUploadIdentity?,
        requestWidth: Int,
        requestHeight: Int,
        requestIdentity: GpuUploadIdentity
    ) -> Bool {
        guard let dims = openDims else { return false }
        return dims.width >= requestWidth
            && dims.height >= requestHeight
            && uploadedIdentity == requestIdentity
    }

    /// Whether the current session both COVERS `width × height` and was
    /// uploaded from `identity` — the upload-once-and-reuse guard (#2039,
    /// #2049). `presentViaGpuLive` re-reads-back + re-uploads only when this
    /// is `false`.
    public func isOpen(coveringWidth width: Int, height: Int, identity: GpuUploadIdentity) -> Bool {
        guard session != nil else { return false }
        return Self.shouldReuseSession(
            openDims: sessionDims, uploadedIdentity: uploadedIdentity,
            requestWidth: width, requestHeight: height, requestIdentity: identity
        )
    }

    /// The current session dims, if open.
    public var currentDims: (width: Int, height: Int)? { sessionDims }

    /// Explicitly close the current session (if any) and drop the
    /// reference, freeing its GPU buffers immediately rather than waiting
    /// for the next `open` to replace it. Used by the memory-pressure
    /// eviction path (#2037) to release an inactive editor's GPU-resident
    /// image without waiting for a future re-open.
    ///
    /// Safe to call while idle: `isOpen`/`hasSession` report `false` once
    /// `session` is `nil`, and the next `decodeAndRender` call transparently
    /// reopens against the current decode — the `!driver.isOpen(...)` guard
    /// in `presentViaGpuLive` (`EditSession+GpuLive.swift`) re-reads back the
    /// decoded image and calls `open` again. No-op if already closed.
    ///
    /// RE-ENTRANCY: the driver's stored state must be settled BEFORE the
    /// `await` — `@MainActor` prevents data races, not interleaving. While
    /// this call is suspended in `close()`, another main-actor task can run
    /// `open()` and install a NEW session; nil-ing the fields after the
    /// suspension would then wipe that new session's state (leaking its GPU
    /// buffers and desyncing `isOpen`/`hasSession`). So: capture the old
    /// session, clear the fields synchronously, then await the close.
    public func closeSession() async {
        guard let s = session else { return }
        session = nil
        sessionDims = nil
        autoProfileFitDone = false
        await s.close()
    }
}
