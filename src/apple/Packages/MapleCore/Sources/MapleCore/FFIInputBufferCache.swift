// FFIInputBufferCache.swift — single-entry cache around the per-tick FFI
// readback (the CIContext.render call that materialises the prescaled
// scene-linear CIImage into a flat f32 RGBA buffer for the Rust FFI).
//
// Ticket #1959 (follow-up to #1938): `applySceneLinearChainViaFFI` pays a
// GPU→CPU readback (`context.render(scaled, toBitmap:...)`, ~50 ms on a
// 1920×1080 f32 RGBA buffer) on EVERY slider tick, even though the
// readback's INPUT — the decoded scene-linear CIImage, prescaled to the
// current viewport — does not change across a slider drag. Only the
// `AdjustmentModel` changes tick to tick; the decoded buffer and the
// prescale target are per-session-open / per-viewport-resize constants.
// `SceneLinearChainCache` (#661) already memoizes the FFI's OUTPUT keyed
// on the model digest, but that cache is a MISS on every tick of an
// exposure-style drag (the digest changes every tick by design — that's
// the slider being dragged). This cache sits one step earlier: it
// memoizes the READBACK BYTES, which are model-independent, so even an
// FFI-output cache MISS can skip the GPU render.
//
// Key: identity (`ObjectIdentifier`) of the `decoded` CIImage the caller
// is developing from, plus the post-prescale (width, height) the readback
// ran at. `decoded` is a stable reference for the lifetime of a decode —
// `RenderActor.decodedImage` (see `RenderActor.swift`) holds exactly one
// `CIImage` instance per decode and hands the SAME instance to every
// `processSceneLinear` / `processSceneLinearNonRaw` call until the next
// real decode lands (a new asset open, a decode-target-crossing viewport
// resize, a baked-field edit, or a sidecar reload that changes the
// stripped model) — see `RenderActor.decodedImage` / `decodedBakedModel`.
// `===` identity is therefore the natural key: a new decoded instance
// means a genuinely different buffer, and this codebase never mutates a
// published CIImage in place — every pipeline stage returns a NEW CIImage
// via `applyingFilter` / `transformed(by:)` / `CIImage(bitmapData:...)`
// rather than mutating one that's already been handed out. Same instance
// + same target size therefore MUST read back to the same bytes; anything
// else (new instance, resized target) is a correct key miss.
//
// Scope — single-entry, same shape as `SceneLinearChainCache` (#661): one
// instance per `ImageEditPipeline` (one per `EditSession`). Bounded
// memory: one buffer at a time, replaced (never appended) on the next
// `put` — ~33 MB at the 1920×1080 fast-phase viewport (rowBytes =
// width * 16 B/px for f32 RGBA; 1920 * 16 * 1080 ≈ 33.2 MB), larger at
// refine-phase / native-resolution targets but still exactly one buffer
// resident at a time.
//
// Correctness invariant: the cached bytes are valid for exactly
// (decoded instance, width, height) — nothing else may vary the bytes,
// because the render that produces them (`ImageEditPipeline.
// prescaleForDisplay` + the flat f32 readback) is a pure function of
// those two inputs alone. If a future change makes the prescale depend on
// anything else, that input MUST join this key or this cache silently
// serves stale bytes.
//
// Cache disable hook: `MAPLE_DISABLE_FFI_INPUT_CACHE=1` forces every
// lookup to miss and every store to no-op — mirrors
// `MAPLE_DISABLE_FFI_CACHE` (`SceneLinearChainCache`) for perf-bench
// "cache disabled" baselines.

import Foundation
import CoreImage

/// Single-entry cache for the flat f32 RGBA readback of the prescaled
/// scene-linear CIImage that feeds `applySceneLinearChainViaFFI`. See the
/// file header for the design rationale and correctness invariant.
final class FFIInputBufferCache: @unchecked Sendable {

    // MARK: - Key

    /// Compound key — identity of the `decoded` CIImage the caller is
    /// developing from, plus the post-prescale extent the readback ran
    /// at (fast vs refine pass, or any other target-size change).
    struct Key: Hashable {
        let decodedID: ObjectIdentifier
        let width: Int
        let height: Int
    }

    // MARK: - State

    private let lock = NSLock()
    /// Single slot — most recent (key, bytes). New write evicts.
    private var slot: (key: Key, bytes: Data)?

    /// Honours `MAPLE_DISABLE_FFI_INPUT_CACHE=1`. Cached at init so the
    /// env lookup doesn't run on every tick.
    private let disabled: Bool

    init() {
        self.disabled = ProcessInfo.processInfo.environment["MAPLE_DISABLE_FFI_INPUT_CACHE"] == "1"
    }

    // MARK: - Lookup / store

    /// Return the cached readback bytes for `key`, or `nil` on miss / disabled.
    func get(_ key: Key) -> Data? {
        if disabled { return nil }
        lock.lock()
        defer { lock.unlock() }
        guard let slot, slot.key == key else { return nil }
        return slot.bytes
    }

    /// Replace the single slot with `(key, bytes)`. Subsequent reads on
    /// the same key hit until the next put evicts it.
    func put(_ key: Key, _ bytes: Data) {
        if disabled { return }
        lock.lock()
        defer { lock.unlock() }
        slot = (key, bytes)
    }

    /// Drop the cache slot (used by tests; production callers do not need
    /// this — `put` already evicts on the next render).
    func invalidate() {
        lock.lock()
        defer { lock.unlock() }
        slot = nil
    }
}
