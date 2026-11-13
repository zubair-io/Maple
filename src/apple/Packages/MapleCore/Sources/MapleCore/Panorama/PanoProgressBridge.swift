// PanoProgressBridge.swift — Lock-free bridge from the Rust pano progress
// callback to a MainActor closure, shared by the stitch and preview FFI calls.
// Moved out of RustPanoStitcher.swift (#4579).

import Foundation
import os

// MARK: - PanoProgressAtom

/// Lock-protected atom that stores the latest `(stage, fraction)` tick
/// received from the C trampoline.  The atom itself is heap-allocated and
/// passed through the C `cb_user` void pointer; its lifetime is managed by
/// `passRetained` / `release` in `_runFFI`.
///
/// `os_unfair_lock` is used because:
///   - It is async-signal–safe and callable from any thread including rayon
///     worker threads (unlike `NSLock` / `pthread_mutex`).
///   - The critical section is two word-stores — contention is negligible even
///     under parallel rayon calls.
///   - `Mutex<T>` from Swift Concurrency would require awaiting and cannot be
///     used from a synchronous C-ABI function.
// @unchecked because the lock guards all mutable state; Swift cannot verify
// that automatically, but the implementation is provably thread-safe.
final class PanoProgressAtom: @unchecked Sendable {
    // os_unfair_lock must be heap-allocated and accessed via pointer.
    // We store it in a fixed slot and never move the PanoProgressAtom after init.
    private var lock: os_unfair_lock = .init()

    // Latest values; guarded by `lock`.
    private var _stage: UInt32 = 0
    private var _frac: Float = 0.0

    // Whether any tick has been stored at all (sentinel for "not yet started").
    private var _hasTick: Bool = false

    /// Store a new tick from the C trampoline.  Called from arbitrary threads.
    @inline(__always)
    func store(stage: UInt32, frac: Float) {
        os_unfair_lock_lock(&lock)
        _stage = stage
        _frac  = frac
        _hasTick = true
        os_unfair_lock_unlock(&lock)
    }

    /// Read the latest tick.  Returns `nil` if no tick has been stored yet.
    /// Called only from the main thread (poller timer).
    func load() -> (stage: UInt32, frac: Float)? {
        os_unfair_lock_lock(&lock)
        let has = _hasTick
        let s   = _stage
        let f   = _frac
        os_unfair_lock_unlock(&lock)
        return has ? (s, f) : nil
    }
}

// MARK: - C trampoline (free function — no method pointer round-trip)

/// C-ABI trampoline called by the Rust worker for each progress tick.
/// Reconstructs the `PanoProgressAtom` from `user` WITHOUT consuming the retain
/// (passUnretained) — the atom lifetime is managed by the balanced
/// `passRetained`/`release` pair in `_runFFI`.
///
/// HOT PATH: does NO Task allocation and NO MainActor enqueue.  It does only
/// one lock-acquire + two word-stores + lock-release.  Safe to call from
/// multiple rayon threads concurrently.
///
/// Stage ordinals from `maple_pano::stitch` module docs:
///   0 = decode + priors
///   1 = ML load + proxy features
///   2 = match graph
///   3 = NCC refinement + reverification
///   4 = bundle adjustment + leveling
///   5 = composite
func panoProgressTrampoline(stage: UInt32, frac: Float, user: UnsafeMutableRawPointer?) {
    guard let user else { return }
    Unmanaged<PanoProgressAtom>.fromOpaque(user).takeUnretainedValue().store(stage: stage, frac: frac)
}

// MARK: - PanoProgressPoller

/// Main-run-loop timer that reads the shared atom ~20×/sec and calls the
/// `@MainActor` progress closure when the value changes.
///
/// Lifecycle: created just before the FFI call, invalidated just after it
/// returns.  One final forced flush is done after invalidation so the terminal
/// stage/fraction always reaches the UI regardless of poll timing.
@MainActor
final class PanoProgressPoller {
    private let atom: PanoProgressAtom
    private let closure: @MainActor (PanoStage, Double) -> Void
    private var timer: Timer?

    // Last value dispatched to the closure — used to suppress no-change ticks.
    private var lastStage: UInt32 = UInt32.max
    private var lastFrac: Float = -1.0

    init(atom: PanoProgressAtom, closure: @escaping @MainActor (PanoStage, Double) -> Void) {
        self.atom = atom
        self.closure = closure
    }

    /// Start polling.  Must be called from MainActor.
    func start() {
        // 50 ms interval → ~20 updates/sec (well inside human-perceptible latency).
        // scheduledTimer fires on the main run loop (same thread the MainActor
        // runs on); MainActor.assumeIsolated documents this invariant explicitly.
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.tick()
            }
        }
    }

    /// Stop polling and emit one final tick so the terminal state always
    /// reaches the UI.  Must be called from MainActor.
    func stop() {
        timer?.invalidate()
        timer = nil
        tick()   // flush terminal state unconditionally
    }

    // Reads the atom and dispatches if changed.
    private func tick() {
        guard let (s, f) = atom.load() else { return }
        // Suppress if unchanged (float equality is intentional: we stored the
        // exact bit pattern that came from Rust, so round-trip is exact).
        guard s != lastStage || f != lastFrac else { return }
        lastStage = s
        lastFrac  = f
        closure(PanoStage.fromFFIStage(s), Double(f))
    }
}

