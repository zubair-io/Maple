// RenderCancelFlag.swift — Swift owner of a Rust-allocated cancellation flag
// (#951).
//
// The Rust FFI render entries (`maple_render_*_scene_linear*_f32`) take an
// optional `MapleCancelFlag *`. When the host flips it mid-render, the develop
// chain checks it INSIDE the expensive stages (`nr_color` etc.) and unwinds
// early, returning a dedicated rc the caller maps to "dropped". This lets a
// slider edit made during a cold open (~8.5 s `nr_color`) interrupt the
// in-flight decode instead of waiting for it to finish.
//
// Why Rust-owned: the render runs on a Rust worker thread that READS the flag
// while a DIFFERENT thread (the actor flipping a superseded decode) WRITES it.
// That cross-thread access must be atomic. Rather than reach for a Swift
// atomic dependency (swift-atomics is not a dependency of this package) or risk
// a data race on a plain `Bool`, the atomic lives entirely in Rust: this class
// just holds the opaque pointer and routes set/free through the C ABI, where
// all reads and writes are `AtomicBool` operations.
//
// Lifetime hazard (the load-bearing reason this is a class, not a struct):
// the Rust worker holds the raw pointer for the duration of the synchronous
// FFI call. The FFI joins that worker before returning, so the pointer is
// valid for the whole call — PROVIDED the Swift owner isn't freed underneath
// it. The decode Task that launched the render therefore keeps a strong
// reference to its `CancelFlag` across the entire `await` of the FFI call (see
// `RenderActor.sharedDecode`); the actor's own stored reference exists only so
// it can flip the flag when the decode is superseded, and replacing/clearing
// that stored reference is safe because the in-flight Task still holds its own.

import Foundation
import RawPipeline

/// Owns a Rust-allocated [`MapleCancelFlag`]. Flip it with `requestCancel()`
/// to ask an in-flight render holding `pointer` to unwind. Frees the Rust
/// allocation exactly once in `deinit`.
///
/// `@unchecked Sendable`: the underlying pointer is opaque and every operation
/// on it (`maple_cancel_flag_set`, and the reads on the Rust worker) is an
/// atomic on the Rust side, so concurrent `requestCancel()` from the actor and
/// reads from the render worker are safe. `deinit` must not race an in-flight
/// FFI call — guaranteed by the strong-reference rule documented above.
public final class CancelFlag: @unchecked Sendable {
    /// Pointer to the Rust-side flag. cbindgen emits `MapleCancelFlag` with the
    /// same `void *inner` shape as the existing `MapleRawHandle`, so Swift
    /// imports it as a struct and this is an `UnsafeMutablePointer`, not an
    /// `OpaquePointer` (matching how `MapleRawHandle` is handled in
    /// `PipelineRenderer`). Pass to a `cancel:`-aware FFI render entry; the
    /// `inner` field is never introspected from Swift.
    let pointer: UnsafeMutablePointer<MapleCancelFlag>?

    public init() {
        self.pointer = maple_cancel_flag_new()
    }

    /// Request cancellation of any in-flight render holding this flag.
    /// Idempotent; safe to call from any thread (atomic store in Rust). A
    /// no-op if allocation failed (`pointer == nil`).
    public func requestCancel() {
        guard let pointer else { return }
        maple_cancel_flag_set(pointer)
    }

    deinit {
        // Safe: `maple_cancel_flag_free` is a no-op on null and frees the
        // allocation exactly once. The strong-reference contract guarantees no
        // render call is still reading `pointer` when the last reference drops.
        if let pointer {
            maple_cancel_flag_free(pointer)
        }
    }
}
