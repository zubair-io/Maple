// CanvasColorSpace.swift — the user-facing sRGB / Display P3 canvas toggle
// (#1338, P3 phase 2). Phase 1 (#1337) wired `TargetPrimaries` through the
// whole chain (raw-core → raw-gpu/raw-ffi → Apple's `MapleAdjustmentParams`/
// `MapleGpuLiveParams`) but hardcoded `target_primaries = 0` (sRGB) at both
// Apple call sites (`PipelineRenderer.makeParams`, `GpuLiveParams.
// makeGpuLiveParams`) — see the `#1338` markers left there. This file is the
// switch phase 1 left ready to flip.
//
// Mirrors `AmazeFlag`'s shape (UserDefaults-backed, re-evaluated per call so
// a Settings change takes effect on the NEXT render tick with no restart) —
// see that file's header for the general pattern this repeats.
//
// Two call sites must track this value in lockstep, both re-read per tick:
//   • `PipelineRenderer.makeParams` / `GpuLiveParams.makeGpuLiveParams` —
//     `target_primaries` (0 = sRGB, 1 = P3) picks which primaries matrix the
//     chain's `display_encode` stage bakes into the output pixels.
//   • `GpuLiveDriver.present` — the `CAMetalLayer.colorspace` TAG must match
//     what was just baked in, or CoreAnimation double-converts (tag P3 +
//     sRGB-tagged bytes = washed out; tag sRGB + P3-tagged bytes =
//     over-saturated, the exact bug #1512 fixed for the old hardcoded-P3
//     tag). `GpuLiveDriver.retagLayerIfNeeded` is the single place that
//     keeps the two in sync, called every present.
//
// THREAD SAFETY: `current` is read from `GpuLiveSession`, a plain (non-
// MainActor) `actor` — off the main thread. `UIScreen.main`/`NSScreen.main`
// are main-thread-only APIs (Apple's documented contract, not something the
// Swift 5 language mode this package builds under catches at compile time —
// see `Package.swift`'s `swiftLanguageModes: [.v5]`), so a straight-line read
// of either from `current`'s fallback path is unsafe (review round on
// #3192: three independent passes flagged it as a real crash/Main-Thread-
// Checker risk).
//
// Fix, and why it's shaped this way: `primeMainDisplayCapability()` MUST be
// called once, early, from the main thread (`MapleApp.init()` does this) and
// stores the probed value into a plain `nonisolated(unsafe) static var` —
// the SAME "process-wide, read-mostly config flag" pattern
// `EditSession.deepZoomEnabled` already uses in this codebase. A first
// attempt at this cached-once value used a `static let` whose initializer
// hopped to the main thread via `DispatchQueue.main.sync` when triggered
// off-main — jules' review caught that this DEADLOCKS: Swift's one-time
// static-init lock can be held by a background thread blocked inside that
// `.sync` call while the main thread separately blocks trying to acquire
// the SAME lock to read the same `static let`, so the main run loop never
// pumps the dispatched block that would let the background thread finish
// initializing and release the lock. A plain `var`, primed exactly once
// from a MainActor context that is guaranteed to run before any render
// actor spins up, sidesteps that entirely: no lock is ever taken on the
// read path, so there's nothing to deadlock. Before priming (or in a
// headless test host that never calls it), the cached value is the
// conservative `false` (sRGB) default — never a crash, never a hang.

import Foundation

#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

/// The two colorspaces the editor canvas (and the render chain feeding it)
/// can target. Raw values match the FFI wire encoding (`target_primaries`:
/// 0 = sRGB, 1 = P3) so `rawValue` can be passed straight through.
public enum CanvasColorSpace: Int, CaseIterable, Sendable {
    case srgb = 0
    case displayP3 = 1

    /// UserDefaults key backing the user-facing Settings picker.
    public static let defaultsKey = "canvasColorSpace"

    /// The active canvas colorspace for this process. Re-evaluated on each
    /// call so flipping the Settings picker takes effect on the NEXT render
    /// tick without an app restart (mirrors `AmazeFlag.isEnabled`).
    ///
    /// Resolution order:
    ///   1. UserDefaults `canvasColorSpace` — the user-facing picker, once
    ///      the user has touched it.
    ///   2. Default: `.displayP3` when the main display reports the P3
    ///      gamut, `.srgb` otherwise (#1338 acceptance: "P3 if available,
    ///      sRGB elsewhere").
    public static var current: CanvasColorSpace {
        // Single read of the stored object, type-checked before mapping
        // (Copilot review on #3192): the previous form called BOTH
        // `integer(forKey:)` and `object(forKey:)` — two lookups per call,
        // on the hot render-tick path — and `integer(forKey:)` silently
        // coerces any non-Int stored value (a corrupted default, or a
        // future migration bug) to `0`, i.e. an explicit "sRGB", rather
        // than falling through to the P3-if-available default below. A
        // single `as? Int` cast rejects a wrong-typed value outright.
        if let stored = UserDefaults.standard.object(forKey: defaultsKey) as? Int,
            let explicit = CanvasColorSpace(rawValue: stored)
        {
            return explicit
        }
        return mainDisplaySupportsP3 ? .displayP3 : .srgb
    }

    /// `target_primaries` wire value for the FFI param structs.
    public var wireValue: UInt32 { UInt32(rawValue) }

    /// Whether the main display reports the Display P3 gamut — a cached,
    /// process-wide, read-mostly flag (same shape as
    /// `EditSession.deepZoomEnabled`). `false` (conservative: sRGB) until
    /// `primeMainDisplayCapability()` runs; see the file banner's THREAD
    /// SAFETY note for why this is a plain var and not a lazily-computed
    /// `static let`.
    nonisolated(unsafe) private static var cachedMainDisplaySupportsP3 = false

    /// Guards `primeMainDisplayCapability()` so only the FIRST call (per
    /// process) actually probes the screen; later calls are no-ops. Not a
    /// correctness requirement (re-probing would just re-derive the same
    /// answer) — purely to avoid redundant `UIScreen`/`NSScreen` reads if
    /// something calls it more than once.
    nonisolated(unsafe) private static var didPrimeMainDisplayCapability = false

    static var mainDisplaySupportsP3: Bool { cachedMainDisplaySupportsP3 }

    /// Probe the main display's gamut and cache the result — MUST be called
    /// from the main thread, exactly once, early in app startup (before any
    /// background actor could read `CanvasColorSpace.current`). `MapleApp
    /// .init()` is that call site; see the file banner for the deadlock this
    /// replaces. A caller that reads `current` before priming (or a headless
    /// test host that never primes at all) gets the conservative `false`
    /// default rather than a crash or a hang — never wrong in a way that
    /// corrupts pixels, only in a way that under-picks P3 until the real
    /// value lands.
    @MainActor
    public static func primeMainDisplayCapability() {
        guard !didPrimeMainDisplayCapability else { return }
        didPrimeMainDisplayCapability = true
        #if canImport(UIKit)
        // `UIScreen.main` is deprecated (iOS 16+) in favor of a window
        // scene's own screen, but this is a one-time, view-less capability
        // probe with no window/scene reference to read one from — accepted
        // as-is (a NIT on #3192's review) rather than threading a scene
        // reference through app startup for a value resolved once and
        // cached forever.
        cachedMainDisplaySupportsP3 = UIScreen.main.traitCollection.displayGamut == .P3
        #elseif canImport(AppKit)
        // NOT `screen.colorSpace == NSColorSpace.displayP3` (review round on
        // #3192, jules): `NSScreen.colorSpace` reports the display's
        // CURRENTLY ACTIVE ICC profile (e.g. "Color LCD", "Apple XDR
        // Display"), which is essentially never identical to the generic
        // `NSColorSpace.displayP3` instance even on a P3-capable panel — the
        // comparison silently evaluates false and every P3 Mac falls back to
        // sRGB. `canRepresent(.p3)` asks the gamut question directly,
        // independent of which profile happens to be active.
        cachedMainDisplaySupportsP3 = NSScreen.main?.canRepresent(.p3) == true
        #endif
    }

    /// Test seam: force the cached capability value directly, bypassing the
    /// main-thread probe — lets a test exercise both the P3-available and
    /// not-available branches of `current`'s fallback without depending on
    /// (or being flaky against) whatever screen the test host actually has.
    static func setMainDisplaySupportsP3ForTests(_ value: Bool) {
        didPrimeMainDisplayCapability = true
        cachedMainDisplaySupportsP3 = value
    }
}
