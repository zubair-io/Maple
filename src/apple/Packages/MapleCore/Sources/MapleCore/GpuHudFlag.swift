// GpuHudFlag.swift — the runtime sub-gate for the in-app GPU frame-time HUD
// (epic #925, P4b-apple validation / #1053).
//
// The HUD makes the on-device 16ms validation objective: it stamps the per-tick
// GPU render+present latency and shows last / avg / max ms, colour-coded vs the
// budget. It is a VALIDATION-ONLY overlay, off in normal flag-on use.
//
// TWO gates, both must be on for the HUD to render (and the same `#if MAPLE_GPU`
// that gates the whole GPU live path — flag OFF = this file compiles to nothing):
//
//   1. COMPILE-TIME `#if MAPLE_GPU` — set only for the gpu-variant validation
//      build (`-D MAPLE_GPU`). Undefined everywhere else, so the HUD (and the GPU
//      live path it measures) compiles out and the shell is byte-for-byte today.
//   2. RUNTIME `MAPLE_GPU_HUD=1` launch-env — mirrors `GpuLiveFlag`'s
//      `MAPLE_GPU_LIVE=1` read (Spike A confirmed env vars survive the macOS
//      sandbox). So a gpu validation build runs the GPU live path with the HUD
//      ON (`MAPLE_GPU_LIVE=1 MAPLE_GPU_HUD=1`) or OFF (`MAPLE_GPU_HUD` unset)
//      without a recompile — "HUD-off == flag-on-today" is verifiable in the
//      SAME binary.
//
// `GpuHudFlag.isEnabled` is `false` whenever `MAPLE_GPU` is undefined, so the
// recorder and overlay both no-op in non-gpu builds. The frame-time measurement
// is gated on this flag too (`GpuLiveDriver`), so a gpu build with the HUD off
// does zero extra work on the render path.

import Foundation

/// Runtime + compile-time gate for the GPU frame-time HUD. `isEnabled` is `true`
/// ONLY in a gpu-variant build (`#if MAPLE_GPU`) launched with `MAPLE_GPU_HUD=1`.
/// Everywhere else (shipping, CI, a gpu build with the env flag off) it is
/// `false`: the per-tick latency is not recorded and the overlay is not shown.
public enum GpuHudFlag {
    /// Whether the GPU frame-time HUD is active for this process. Read once at
    /// launch (mirrors `GpuLiveFlag.isEnabled`).
    public static let isEnabled: Bool = {
        #if MAPLE_GPU
        return ProcessInfo.processInfo.environment["MAPLE_GPU_HUD"] == "1"
        #else
        return false
        #endif
    }()
}
