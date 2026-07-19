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
// Identity anchor (PR #2083 review): `ObjectIdentifier` alone is just the
// object's ADDRESS — after the decoded CIImage deallocates (asset switch,
// decode replacement), a NEW CIImage can allocate at the recycled address,
// match the stale key at the same viewport dims, and be served the
// PREVIOUS image's bytes: silent wrong pixels. The slot therefore also
// holds a `weak` reference to the CIImage it was keyed from, and `get`
// requires BOTH the key match AND `slotDecoded === decoded` (the caller's
// live instance). If the original deallocated, the weak reference is nil
// and the `===` compare fails — a recycled address can never false-hit;
// a live `===` match is definitionally the same object. The reference is
// weak (not strong) so the cache never extends the decode buffer's
// lifetime — the memory-pressure teardown path (#2037) relies on
// `renderActor.invalidate()` actually freeing the decoded image, and a
// strong reference here would silently pin ~GB-scale buffers.
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
// those two inputs alone. "Decoded instance" means the LIVE object the
// weak anchor proves is still the one the bytes were read from — not
// merely an address. If a future change makes the prescale depend on
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
    /// at (fast vs refine pass, or any other target-size change). The key
    /// alone is NOT sufficient for a hit — `get` additionally requires the
    /// slot's weak `decoded` anchor to still be the caller's live instance
    /// (see the file header's "Identity anchor" paragraph).
    struct Key: Hashable {
        let decodedID: ObjectIdentifier
        let width: Int
        let height: Int
    }

    // MARK: - Slot

    /// The single cache slot. A class (not a tuple) because the `decoded`
    /// identity anchor must be `weak`, and Swift tuples cannot hold weak
    /// references.
    private final class Slot {
        let key: Key
        let bytes: Data
        /// Weak identity anchor — the CIImage the bytes were read back
        /// from. Weak so the cache never extends the decode buffer's
        /// lifetime (#2037 memory-pressure teardown); nil after the
        /// original deallocates, which forces every subsequent `get` to
        /// miss even if a new CIImage recycles the same address.
        weak var decoded: CIImage?

        init(key: Key, bytes: Data, decoded: CIImage) {
            self.key = key
            self.bytes = bytes
            self.decoded = decoded
        }
    }

    // MARK: - State

    private let lock = NSLock()
    /// Single slot — most recent store. New write evicts.
    private var slot: Slot?

    /// Honours `MAPLE_DISABLE_FFI_INPUT_CACHE=1`. Cached at init so the
    /// env lookup doesn't run on every tick. The env value is the DEFAULT;
    /// `testOverrideEnabled` (when set) wins over it — see `effectiveDisabledLocked`.
    private let envDisabled: Bool

    /// Test-only runtime override of the env kill-switch. `nil` = follow
    /// the env default (`envDisabled`); non-nil forces the cache
    /// on (`true`) or off (`false`) regardless of the env var. Exists so a
    /// perf bench can A/B this fix ON vs OFF within ONE process — the env
    /// var is read once at init and can't be flipped mid-run, but a
    /// machine-independent regression ratio needs both arms on the same
    /// machine in the same run. Guarded by `lock`. Set via `_testSetEnabled(_:)`.
    private var testOverrideEnabled: Bool?

    init() {
        self.envDisabled = ProcessInfo.processInfo.environment["MAPLE_DISABLE_FFI_INPUT_CACHE"] == "1"
    }

    /// Effective disabled state — the test override wins when set, else the
    /// env-derived default. MUST be called with `lock` held.
    private var effectiveDisabledLocked: Bool {
        if let overrideEnabled = testOverrideEnabled { return !overrideEnabled }
        return envDisabled
    }

    // MARK: - Lookup / store

    /// Return the cached readback bytes for `key`, or `nil` on miss /
    /// disabled. `decoded` is the caller's live CIImage instance — a hit
    /// requires BOTH `slot.key == key` AND `slot.decoded === decoded`, so
    /// an address recycled by a later allocation can never serve the
    /// previous image's bytes (the weak anchor is nil or a different
    /// object by then).
    func get(_ key: Key, decoded: CIImage) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        if effectiveDisabledLocked { return nil }
        guard let slot, slot.key == key, slot.decoded === decoded else { return nil }
        return slot.bytes
    }

    /// Replace the single slot with `(key, bytes)`, anchored (weakly) to
    /// the `decoded` instance the bytes were read back from. Subsequent
    /// reads with the same key AND the same live instance hit until the
    /// next put evicts it (or `decoded` deallocates, which nils the weak
    /// anchor and turns every read into a miss).
    func put(_ key: Key, _ bytes: Data, decoded: CIImage) {
        lock.lock()
        defer { lock.unlock() }
        if effectiveDisabledLocked { return }
        slot = Slot(key: key, bytes: bytes, decoded: decoded)
    }

    // MARK: - Test hooks

    /// Test-only: override the `MAPLE_DISABLE_FFI_INPUT_CACHE` env
    /// kill-switch at runtime. `true` forces the cache ON, `false` forces
    /// it OFF, `nil` restores the env-derived default. Flipping the toggle
    /// also drops the current slot so an in-run A/B measurement never reads
    /// a value cached under the other arm. `internal` (test target only via
    /// `@testable import`) — not part of the production surface; the perf
    /// benches use it to measure this fix's win as a machine-independent
    /// on/off ratio (#2113).
    func _testSetEnabled(_ enabled: Bool?) {
        lock.lock()
        defer { lock.unlock() }
        testOverrideEnabled = enabled
        slot = nil
    }

    /// Drop the cache slot (used by tests; production callers do not need
    /// this — `put` already evicts on the next render).
    func invalidate() {
        lock.lock()
        defer { lock.unlock() }
        slot = nil
    }

    /// Whether the slot is empty — test inspection hook (verifies the
    /// #2042 gate: an unbounded nil-`targetSize` render must never
    /// populate the cache).
    var isEmpty: Bool {
        lock.lock()
        defer { lock.unlock() }
        return slot == nil
    }
}
