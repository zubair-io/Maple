// GpuLiveFlag.swift — the gate for the wgpu live render path (epic #925,
// P4b-apple / #1028, default-on flip #1064).
//
// As of #1064 the wgpu+WGSL live render path is the Apple SHIPPING DEFAULT, so
// the two gates now combine to "on unless explicitly compiled out or killed":
//
//   1. COMPILE-TIME `#if MAPLE_GPU` — set for the shipping build (the project
//      defines `MAPLE_GPU` on both the Swift side, via
//      `SWIFT_ACTIVE_COMPILATION_CONDITIONS`, and the Clang module importer of
//      `RawPipeline.h`, via `-Xcc -DMAPLE_GPU` in `OTHER_SWIFT_FLAGS`; the
//      matching gpu xcframework is built by the "Build Rust xcframework" run
//      script with `MAPLE_XCFRAMEWORK_GPU=1`). If `MAPLE_GPU` is ever undefined
//      (e.g. a one-off non-gpu build), the whole GPU live path compiles out and
//      the shell falls back to the CPU + Metal + CIColorCube path byte-for-byte.
//   2. RUNTIME `MAPLE_GPU_LIVE` launch-env KILL-SWITCH — in a gpu build the path
//      is ON by default; setting `MAPLE_GPU_LIVE=0` opts OUT (forces the CPU
//      path) WITHOUT a recompile. Mirrors the `MAPLE_GPU_DEBUG=1` env pattern in
//      `MapleApp` (Spike A confirmed env vars survive the macOS sandbox), so the
//      legacy CPU path stays exercisable in the SAME binary the GPU branch
//      compiles into — e.g. for an on-device A/B or a fallback if a regression
//      is found post-ship.
//
// `GpuLiveFlag.isEnabled` is therefore `true` in any gpu build NOT launched with
// `MAPLE_GPU_LIVE=0`, and `false` whenever `MAPLE_GPU` is undefined — so callers
// that read it in a non-gpu build always take the CPU path. The Apple GPU live
// path also has a separate RUNTIME fallback: if the wgpu session fails to open
// or read back (`EditSession+GpuLive`), the editor reverts to CPU + Metal for
// that image even with the flag on.
//
// IMPORTANT (#1064): default-on is unvalidated on iOS hardware. The runtime
// fallback above covers a wgpu *failure* (→ CPU), but NOT a slow-or-wrong-but-
// successful GPU render — that must be validated on-device (the #1053 frame-time
// HUD) before a public release. `MAPLE_GPU_LIVE=0` is the kill-switch if needed.

import Foundation

/// Runtime + compile-time gate for the wgpu live render path. As of #1064 it is
/// the Apple shipping default: `isEnabled` is `true` in any gpu-variant build
/// (`#if MAPLE_GPU`) unless launched with the `MAPLE_GPU_LIVE=0` kill-switch, and
/// `false` whenever `MAPLE_GPU` is undefined (the editor then uses the CPU +
/// Metal + CIColorCube path).
public enum GpuLiveFlag {
    /// Whether the GPU live render path is active for this process.
    public static let isEnabled: Bool = {
        #if MAPLE_GPU
        // Default-on in a gpu build; `MAPLE_GPU_LIVE=0` is the opt-out
        // kill-switch (any other value, or unset, leaves it on).
        return ProcessInfo.processInfo.environment["MAPLE_GPU_LIVE"] != "0"
        #else
        return false
        #endif
    }()
}
