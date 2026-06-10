// GpuLiveFlag.swift — the runtime gate for the wgpu live render path (epic #925,
// P4b-apple / #1028, flipped on by default in #1064).
//
// The GPU live render path is now unconditionally compiled (the `#if MAPLE_GPU`
// compile gate was removed in #1064 — the Apple build is always-gpu, wgpu always
// linked) and is the SHIPPING DEFAULT, gated only at RUNTIME here.
//
// `MAPLE_GPU_LIVE` is a kill-switch: the GPU live path is ON unless the process is
// launched with `MAPLE_GPU_LIVE=0`, in which case the editor falls back to the CPU
// + Metal + CIColorCube path byte-for-byte. (Mirrors the `MAPLE_GPU_DEBUG` /
// `MAPLE_GPU_HUD` launch-env pattern in `MapleApp` — Spike A confirmed env vars
// survive the macOS sandbox.) The runtime CPU fallback in `EditSession+GpuLive`
// still covers a wgpu FAILURE at runtime; this flag is the operator override.
//
// NOTE: iOS-on-device perf/correctness of the default-on path is not yet
// validated — see #1064. The kill-switch covers wgpu failure→CPU, not a
// slow-but-successful frame; validate on-device (`MAPLE_GPU_HUD=1`) before a
// public release.

import Foundation

/// Runtime gate for the wgpu live render path. `isEnabled` is `true` by default
/// and becomes `false` only when the process is launched with `MAPLE_GPU_LIVE=0`
/// (the operator kill-switch), in which case the editor uses the CPU + Metal +
/// CIColorCube path.
public enum GpuLiveFlag {
    /// Whether the GPU live render path is active for this process. ON unless
    /// `MAPLE_GPU_LIVE=0`.
    public static let isEnabled: Bool = {
        return ProcessInfo.processInfo.environment["MAPLE_GPU_LIVE"] != "0"
    }()
}
