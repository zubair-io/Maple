// GpuLiveFlag.swift — the runtime gate for the wgpu live render path (epic #925,
// P4b-apple / #1028).
//
// TWO gates, both must be on for the GPU live path to run (OFF in every shipping
// build):
//
//   1. COMPILE-TIME `#if MAPLE_GPU` — set only for the gpu-variant validation
//      build (`-D MAPLE_GPU`, matching the gpu xcframework on disk). Undefined in
//      shipping/CI/default builds, so the whole GPU live path compiles out and the
//      shell falls back to the CPU + Metal + CIColorCube path byte-for-byte.
//   2. RUNTIME `MAPLE_GPU_LIVE=1` launch-env — mirrors the `MAPLE_GPU_DEBUG=1`
//      pattern in `MapleApp` (Spike A confirmed env vars survive the macOS
//      sandbox). Lets a validation build run EITHER the GPU live path (flag on) or
//      the normal CPU path (flag off) without a recompile — so "flag-off == today"
//      is verifiable in the SAME binary the GPU branch compiles into.
//
// `GpuLiveFlag.isEnabled` is `false` whenever `MAPLE_GPU` is undefined, so callers
// that read it in non-gpu builds always take the CPU path.

import Foundation

/// Runtime + compile-time gate for the wgpu live render path. `isEnabled` is
/// `true` ONLY in a gpu-variant build (`#if MAPLE_GPU`) launched with
/// `MAPLE_GPU_LIVE=1`. Everywhere else (shipping, CI, or a gpu build with the env
/// flag off) it is `false` and the editor uses the CPU + Metal + CIColorCube path.
public enum GpuLiveFlag {
    /// Whether the GPU live render path is active for this process.
    public static let isEnabled: Bool = {
        #if MAPLE_GPU
        return ProcessInfo.processInfo.environment["MAPLE_GPU_LIVE"] == "1"
        #else
        return false
        #endif
    }()
}
