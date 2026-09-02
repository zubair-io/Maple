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
//   • `GpuLiveCanvasController` — the `CAMetalLayer.colorspace` TAG must
//     match what was just baked in, or CoreAnimation double-converts (tag
//     P3 + sRGB-tagged bytes = washed out; tag sRGB + P3-tagged bytes =
//     over-saturated, the exact bug #1512 fixed for the old hardcoded-P3
//     tag). `GpuLiveCanvasController.retagIfNeeded` is the single place
//     that keeps the two in sync, called every present.

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
        let stored = UserDefaults.standard.integer(forKey: defaultsKey)
        if let explicit = CanvasColorSpace(rawValue: stored),
            UserDefaults.standard.object(forKey: defaultsKey) != nil
        {
            return explicit
        }
        return mainDisplaySupportsP3 ? .displayP3 : .srgb
    }

    /// `target_primaries` wire value for the FFI param structs.
    public var wireValue: UInt32 { UInt32(rawValue) }

    /// Whether the CURRENT main display reports the Display P3 gamut.
    /// Best-effort: a screen that can't be resolved (headless test host,
    /// very early app launch) reads as non-P3 rather than crashing.
    static var mainDisplaySupportsP3: Bool {
        #if canImport(UIKit)
        return UIScreen.main.traitCollection.displayGamut == .P3
        #elseif canImport(AppKit)
        guard let screen = NSScreen.main else { return false }
        return screen.colorSpace == NSColorSpace.displayP3
        #else
        return false
        #endif
    }
}
