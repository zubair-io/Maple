// GpuLiveSession.swift — Swift owner of a wgpu live-render session (epic #925,
// P4b-apple / #1028).
//
// Always compiled — the `MapleGpuLiveSession` / `MapleGpuLiveParams` types and the
// `maple_gpu_live_*` / `maple_gpu_present_chain` symbols are in the default
// xcframework header now (gpu is the default xcframework build). Used only when
// the runtime flag is on (`GpuLiveFlag.isEnabled`).
//
// ## Why an actor (the serialization invariant)
//
// `raw_gpu::GpuContext` + `LiveSession` are `!Send`/`!Sync` — one render in flight
// at a time, period (the cached-pipeline `OnceCell`, the `RefCell` frame pool).
// The CPU path parallelizes via concurrent `Task.detached` renders and drops
// stale ones at publish; the GPU path CANNOT — two concurrent FFI renders on one
// session is a data race. So all `maple_gpu_live_render` / `maple_gpu_present_chain`
// calls funnel through this actor (one owner, serialized). The handle is
// upload-once (per dims) and outlives individual ticks + view re-layouts.
//
// ## Lifecycle
//
//   1. `open(pixels:width:height:)` — uploads the decoded scene-linear f32 RGBA
//      buffer ONCE; subsequent renders reuse it (pooled, zero-alloc at stable dims).
//   2. `fitAutoProfile(rawPath:quality:)` — once per image, fits the Auto Profile
//      curve + residual LUT (the A2 artifacts) so the chain's curve/LUT passes
//      apply the tail (replacing the CIColorCube). Cached on this session.
//   3. `present(model:layer:cancel:)` — per slider tick / layout: build the gated
//      chain from the model (decode-boundary contract), run to f32, present to the
//      `CAMetalLayer`. Serialized by the actor.
//   4. deinit — closes the handle (frees all GPU buffers).
//
// A dims change (viewport ⇄ full-res) is a NEW session — `LiveSession` is
// upload-once per dims. The caller re-opens on resize (pairs with the sized-fast /
// full-refine decode logic in `EditSession+Render`).

import Foundation
import RawPipeline
import QuartzCore
import os

private let gpuLiveLog = Logger(subsystem: "app.justmaple.aperture", category: "gpu-live")

/// Errors surfaced by the GPU live session (carry the Rust `maple_last_error`
/// message or the return code so callers / the in-app HUD can show it — device
/// logs aren't capturable).
public struct GpuLiveError: Error, Sendable {
    public let message: String
}

/// The fitted Auto Profile artifacts for one image (the A2 un-composed
/// curve + residual LUT), held on the session so the chain's curve/LUT passes
/// reapply them every tick without re-fitting. `nil` curve ⇒ identity (the
/// residual alone); `nil` residual ⇒ no LUT pass.
private struct AutoProfileArtifacts {
    /// `PROFILE_CURVE_FLAT_LEN` floats, or `nil` if the fit produced no curve.
    let curveFlat: [Float]?
    /// The residual LUT edge + `size³·3` flat grid, or `nil` if no residual.
    let lutSize: Int
    let lutData: [Float]?
}

/// A serialized wgpu live-render session bound to one uploaded image at one set of
/// dims. An `actor` so every FFI call (which touches the `!Send`/`!Sync` Rust
/// context) is serialized onto one executor — the single-render-in-flight invariant.
public actor GpuLiveSession {
    /// The opaque Rust handle (`maple_gpu_live_open` → `…_close`). `nil` once closed
    /// or if the open failed.
    private var handle: MapleGpuLiveSession?
    public let width: Int
    public let height: Int

    /// The per-image Auto Profile artifacts (fit once via `fitAutoProfile`); `nil`
    /// until fit, or when the image has no Auto tail (plain AgX / Neutral).
    private var autoProfile: AutoProfileArtifacts?

    /// Open a session over `pixels` (interleaved RGBA f32, `width·height·4` lanes —
    /// the decoded scene-linear Rec.2020 buffer). Uploads the image ONCE. Throws on
    /// a bad size or an FFI open failure.
    public init(pixels: [Float], width: Int, height: Int) throws {
        self.width = width
        self.height = height
        let expected = width * height * 4
        guard pixels.count == expected, width > 0, height > 0 else {
            throw GpuLiveError(
                message: "GpuLiveSession: pixel count \(pixels.count) != \(expected) for \(width)x\(height)")
        }
        var h = MapleGpuLiveSession()
        let rc = pixels.withUnsafeBufferPointer { buf in
            maple_gpu_live_open(buf.baseAddress, UInt32(width), UInt32(height), &h)
        }
        guard rc == 0 else {
            throw GpuLiveError(message: Self.lastError() ?? "maple_gpu_live_open rc=\(rc)")
        }
        self.handle = h
    }

    deinit {
        if var h = handle {
            maple_gpu_live_close(&h)
        }
    }

    /// Fit (and cache on this session) the Auto Profile curve + residual LUT for
    /// `rawPath` under `Profile::Auto` — the A2 artifacts the chain's curve/LUT
    /// passes reapply every tick. A no-op (clears to `nil` → plain AgX) when the
    /// model is not Auto or the RAW has no usable embedded JPEG. Cold per image
    /// (JPEG extract + develop); call once per asset open, never per tick.
    ///
    /// `quality` MUST match the decode quality (the editor decodes at `.preview`),
    /// or the fitted curve won't match the displayed pixels.
    public func fitAutoProfile(rawPath: String, quality: PipelineRenderer.Quality) {
        let curveLen = Int(MAPLE_PROFILE_CURVE_FLAT_LEN)
        var curve = [Float](repeating: 0, count: curveLen)
        var present: Int32 = 0
        // Residual fits at edge 49 today → 49³·3 floats; allocate generously and
        // let the FFI report the actual edge (re-call on -2 with the reported size).
        var lutCapacity = 49 * 49 * 49 * 3
        var lut = [Float](repeating: 0, count: lutCapacity)
        var lutSize: UInt32 = 0

        var rc = rawPath.withCString { cpath in
            curve.withUnsafeMutableBufferPointer { cbuf in
                lut.withUnsafeMutableBufferPointer { lbuf in
                    maple_gpu_fit_auto_profile(
                        cpath, nil, quality.rawValue,
                        cbuf.baseAddress, &present,
                        lbuf.baseAddress, UInt(lutCapacity), &lutSize
                    )
                }
            }
        }
        // -2: our buffer was too small — `lutSize` holds the needed edge; grow + retry
        // (the fit is cached, so the second call is cheap).
        if rc == -2, lutSize > 0 {
            let n = Int(lutSize)
            lutCapacity = n * n * n * 3
            lut = [Float](repeating: 0, count: lutCapacity)
            rc = rawPath.withCString { cpath in
                curve.withUnsafeMutableBufferPointer { cbuf in
                    lut.withUnsafeMutableBufferPointer { lbuf in
                        maple_gpu_fit_auto_profile(
                            cpath, nil, quality.rawValue,
                            cbuf.baseAddress, &present,
                            lbuf.baseAddress, UInt(lutCapacity), &lutSize
                        )
                    }
                }
            }
        }

        guard rc == 0 else {
            if rc == 1 {
                gpuLiveLog.notice("Auto Profile: no tail for \(rawPath, privacy: .public) — plain AgX")
            } else {
                gpuLiveLog.error("maple_gpu_fit_auto_profile rc=\(rc): \(Self.lastError() ?? "?", privacy: .public)")
            }
            autoProfile = nil
            return
        }

        let n = Int(lutSize)
        autoProfile = AutoProfileArtifacts(
            curveFlat: present == 1 ? curve : nil,
            lutSize: n,
            lutData: n > 0 ? Array(lut.prefix(n * n * n * 3)) : nil
        )
        gpuLiveLog.notice(
            "Auto Profile: fitted curve(present=\(present == 1)) + residual(edge=\(n)) for \(rawPath, privacy: .public)")
    }

    /// Render the gated chain for `model` (decode-boundary contract via
    /// `makeGpuLiveParams`) and PRESENT it to `layer` (a `CAMetalLayer`). The
    /// Auto Profile curve/LUT artifacts (if fit) ride the chain's curve/LUT passes.
    ///
    /// `cancel` is an optional `CancelFlag` the caller flips when a newer edit
    /// supersedes this present; the FFI drops a superseded present before touching
    /// the GPU. Returns normally on success or a silent drop (cancelled); throws on
    /// a real GPU/present failure so the caller can surface it.
    ///
    /// Returns the GPU render+present latency in MILLISECONDS for a real present
    /// (`rc == 0`), or `nil` when the present was cancelled (`rc == 4`, a newer
    /// edit superseded it). The latency is a `CACurrentMediaTime()` delta around
    /// the `maple_gpu_present_chain` FFI — the encode+submit+present span that
    /// maps to the 16ms slider-tick budget — with NO added GPU sync/readback (that
    /// would distort the very number we measure). The HUD's recorder drops the
    /// `nil` (cancelled) frames so they don't flatter the rolling average; see
    /// `GpuFrameTimeStats`.
    ///
    /// The actor serializes this — one render in flight (the `!Send` Rust context).
    @discardableResult
    public func present(
        model: AdjustmentModel,
        layer: CAMetalLayer,
        cancel: CancelFlag?,
        asShotCCT: Double? = nil,
        asShotTint: Double? = nil,
        inputShape: UInt32 = 0
    ) throws -> Double? {
        guard var h = handle else {
            throw GpuLiveError(message: "present: session is closed")
        }
        let params = PipelineRenderer.makeGpuLiveParams(
            from: model, asShotCCT: asShotCCT, asShotTint: asShotTint,
            inputShape: inputShape
        )
        let layerPtr = Unmanaged.passUnretained(layer).toOpaque()
        let cancelPtr = cancel?.pointer

        // Wire the Auto Profile arrays inside a live scope so the pointers are valid
        // for the whole FFI call (storing them on `params` outside would dangle).
        // The helper yields a pointer to the (array-wired) params so the FFI call
        // doesn't re-borrow `params` (Swift exclusivity).
        //
        // Stamp the wall clock immediately around the FFI: this span is the GPU
        // encode+submit+present — the meaningful edit→on-screen latency. The two
        // `CACurrentMediaTime()` reads are sub-microsecond, so the measurement
        // does not perturb the number (and is unconditional — the HUD flag gates
        // RECORDING, not the cheap timestamp).
        let t0 = CACurrentMediaTime()
        let rc = withGpuLiveParams(params) { pp in
            maple_gpu_present_chain(&h, pp, layerPtr, cancelPtr)
        }
        let elapsedMs = (CACurrentMediaTime() - t0) * 1000.0

        switch rc {
        case 0:
            return elapsedMs // presented — real edit→on-screen frame
        case 4:
            // RC_PRESENT_CANCELLED — a newer edit superseded this present; drop
            // quietly AND report `nil` so the cancelled (near-zero) frame never
            // enters the HUD's rolling stats.
            return nil
        default:
            throw GpuLiveError(message: Self.lastError() ?? "maple_gpu_present_chain rc=\(rc)")
        }
    }

    /// Render the gated chain for `model` and READ BACK the `width·height·3` u8
    /// RGB surface (the canonical `dither_and_quantize` layout) — the headless
    /// sibling of `present` (no `CAMetalLayer`). This is the host-test / fallback
    /// path: it exercises the SAME chain + dither the present runs, so a Swift
    /// caller can assert the plumbing links + the output is a real (non-flat) image
    /// without a drawable. Returns `nil` if the render was cancelled.
    ///
    /// Auto Profile artifacts ride the chain's passes (as in `present`). Serialized
    /// by the actor.
    public func renderToBuffer(
        model: AdjustmentModel,
        asShotCCT: Double? = nil,
        asShotTint: Double? = nil,
        inputShape: UInt32 = 0
    ) throws -> [UInt8]? {
        guard let h = handle else {
            throw GpuLiveError(message: "renderToBuffer: session is closed")
        }
        let params = PipelineRenderer.makeGpuLiveParams(
            from: model,
            asShotCCT: asShotCCT,
            asShotTint: asShotTint,
            inputShape: inputShape
        )
        var out = [UInt8](repeating: 0, count: width * height * 3)
        let rc = withGpuLiveParams(params) { pp in
            withUnsafePointer(to: h) { hp in
                out.withUnsafeMutableBufferPointer { obuf in
                    maple_gpu_live_render(hp, pp, obuf.baseAddress)
                }
            }
        }
        switch rc {
        case 0:
            return out
        case -3:
            return nil // render returned None (e.g. cancelled internally)
        default:
            throw GpuLiveError(message: Self.lastError() ?? "maple_gpu_live_render rc=\(rc)")
        }
    }

    /// Bind the fitted Auto Profile curve + residual LUT (if any) into a copy of
    /// `params` and yield a POINTER to that array-wired copy for the duration of
    /// `body` (the FFI reads the arrays only during the call; the `[Float]` buffers
    /// stay alive in scope, so no dangling pointer). Yielding a pointer — rather
    /// than mutating the caller's `params` in place — keeps the FFI call from
    /// re-borrowing `params` (Swift exclusive-access). When no artifacts are fit the
    /// params keep their NULL pointers (identity curve + no residual = plain AgX).
    private func withGpuLiveParams<R>(
        _ params: MapleGpuLiveParams,
        _ body: (UnsafePointer<MapleGpuLiveParams>) -> R
    ) -> R {
        var p = params
        guard let ap = autoProfile else {
            return withUnsafePointer(to: &p, body)
        }
        // Nested withUnsafe… to keep BOTH buffers alive across the call; `?? []`
        // gives a stable (empty) buffer when an artifact is absent.
        let curve = ap.curveFlat ?? []
        let lut = ap.lutData ?? []
        return curve.withUnsafeBufferPointer { cbuf in
            lut.withUnsafeBufferPointer { lbuf in
                if ap.curveFlat != nil {
                    p.profile_curve_ptr = cbuf.baseAddress
                    p.profile_curve_len = UInt(curve.count)
                }
                if ap.lutData != nil {
                    p.residual_lut_size = UInt32(ap.lutSize)
                    p.residual_lut_ptr = lbuf.baseAddress
                    p.residual_lut_len = UInt(lut.count)
                }
                return withUnsafePointer(to: &p, body)
            }
        }
    }

    private static func lastError() -> String? {
        guard let c = maple_last_error() else { return nil }
        return String(cString: c)
    }
}
