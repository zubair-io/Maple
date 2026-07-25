// DeepDenoiseProgress.swift — determinate BM3D progress for the editor (#1153).
//
// `deep_denoise` (spec § 3.2) is the one develop stage whose runtime is
// seconds rather than milliseconds, so the editor must show a DETERMINATE
// indicator while it runs. The numbers here are raw-core's own
// per-reference-row stage ticks, delivered through the
// `maple_set_deep_denoise_progress` C callback — never a simulated sweep.
//
// Shape mirrors `RustPanoStitcher`'s proven pano-progress plumbing: a
// lock-guarded atom written by a free C-ABI trampoline (called from whichever
// background thread drives the decode — no Task allocation, no MainActor hop
// in the hot path), polled by a MainActor timer that republishes changes.
//
// One shared registration for the process: the render actor decodes one image
// at a time, and the stage is inert unless `deepDenoise > 0`, so a single
// global channel is sufficient — and a per-render callback parameter would
// mean threading a sink through every `maple_render_*` signature for one
// stage (CLAUDE.md § 7).

import Foundation
import RawPipeline
import os

// MARK: - ProgressAtom

/// Latest `(fraction, pass)` tick. `os_unfair_lock`-guarded because the
/// writer is a C callback on an arbitrary thread and the reader is the
/// MainActor poll timer; the critical section is two word-stores.
///
/// `@unchecked Sendable`: the lock guards all mutable state, which the
/// compiler cannot verify on its own.
private final class ProgressAtom: @unchecked Sendable {
    private var lock = os_unfair_lock()
    private var _fraction: Float = 0
    private var _pass: UInt32 = 0
    /// Bumped on every store, so the poller can tell "still at 0%, running"
    /// from "nothing has run".
    private var _sequence: UInt64 = 0

    @inline(__always)
    func store(fraction: Float, pass: UInt32) {
        os_unfair_lock_lock(&lock)
        _fraction = fraction
        _pass = pass
        _sequence &+= 1
        os_unfair_lock_unlock(&lock)
    }

    func load() -> (fraction: Float, pass: UInt32, sequence: UInt64) {
        os_unfair_lock_lock(&lock)
        let snapshot = (_fraction, _pass, _sequence)
        os_unfair_lock_unlock(&lock)
        return snapshot
    }
}

/// The single process-wide atom. Registered with raw-core once, kept alive
/// for the process lifetime (the C side holds its address).
private let sharedAtom = ProgressAtom()

/// C-ABI trampoline handed to `maple_set_deep_denoise_progress`. Called from
/// the decode thread; does one lock-acquire and three word-stores.
private func deepDenoiseProgressTrampoline(
    fraction: Float,
    pass: UInt32,
    user: UnsafeMutableRawPointer?
) {
    guard let user else { return }
    Unmanaged<ProgressAtom>.fromOpaque(user)
        .takeUnretainedValue()
        .store(fraction: fraction, pass: pass)
}

// MARK: - DeepDenoiseProgressMonitor

/// A single BM3D progress reading.
public struct DeepDenoiseProgress: Equatable, Sendable {
    /// Overall completion across both passes, `0...1`.
    public let fraction: Double
    /// Pass currently running: 1 (hard threshold) or 2 (Wiener).
    public let pass: Int

    public init(fraction: Double, pass: Int) {
        self.fraction = fraction
        self.pass = pass
    }
}

/// Publishes `DeepDenoiseProgress` for the editor's determinate indicator.
///
/// `EditSession` owns one and drives `start()` / `stop()` around a render it
/// knows engages the stage (`deepDenoise > 0`); the value is `nil` whenever
/// nothing is running, which is what hides the bar.
@MainActor
@Observable
public final class DeepDenoiseProgressMonitor {
    /// Latest reading, or `nil` when the stage is not running.
    public private(set) var progress: DeepDenoiseProgress?

    @ObservationIgnored private var timer: Timer?
    /// Sequence observed when polling started — anything at or below it is a
    /// leftover from a previous run, not this one.
    @ObservationIgnored private var baselineSequence: UInt64 = 0

    public init() {}

    /// Register the C callback exactly once per process.
    @ObservationIgnored private static var registered = false

    private static func registerIfNeeded() {
        guard !registered else { return }
        registered = true
        // `passRetained` deliberately leaks one retain: the atom is a
        // process-lifetime singleton whose address the C side keeps.
        let user = Unmanaged.passRetained(sharedAtom).toOpaque()
        maple_set_deep_denoise_progress(deepDenoiseProgressTrampoline, user)
    }

    /// Begin publishing. Idempotent — a second call while running is a no-op,
    /// so overlapping fast/refine passes don't restart the bar.
    public func start() {
        guard timer == nil else { return }
        Self.registerIfNeeded()
        baselineSequence = sharedAtom.load().sequence
        progress = nil
        // 50 ms → ~20 updates/sec, the same cadence the pano poller uses.
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    /// Stop publishing and clear the reading (the bar disappears).
    public func stop() {
        timer?.invalidate()
        timer = nil
        progress = nil
    }

    private func tick() {
        let (fraction, pass, sequence) = sharedAtom.load()
        // No tick since `start()` ⇒ the stage has not reported yet (it may be
        // skipped entirely, e.g. a cached decode). Leave `progress` nil rather
        // than showing a 0% bar for a run that never happens.
        guard sequence > baselineSequence else { return }
        progress = DeepDenoiseProgress(
            fraction: Double(fraction).clampedToUnitInterval,
            pass: pass == 2 ? 2 : 1
        )
    }
}

private extension Double {
    var clampedToUnitInterval: Double { min(max(self, 0), 1) }
}
