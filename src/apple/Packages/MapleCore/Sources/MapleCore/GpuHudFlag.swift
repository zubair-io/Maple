// GpuHudFlag.swift — the runtime sub-gate for the in-app GPU frame-time HUD
// (epic #925, P4b-apple validation / #1053).
//
// The HUD makes the on-device 16ms validation objective: it stamps the per-tick
// GPU render+present latency and shows last / avg / max ms, colour-coded vs the
// budget. It is a VALIDATION-ONLY overlay, off in normal flag-on use.
//
// A single RUNTIME gate: the HUD renders only when the process is launched with
// `MAPLE_GPU_HUD=1` (mirrors `GpuLiveFlag`'s `MAPLE_GPU_LIVE` read — Spike A
// confirmed env vars survive the macOS sandbox). It is OFF by default (it needs an
// explicit `=1`), so the HUD never appears in normal use even though the GPU live
// path is on by default. The frame-time measurement is gated on this flag too
// (`GpuLiveDriver`), so with the HUD off the render path does zero extra work.

import Foundation

/// Runtime gate for the GPU frame-time HUD. `isEnabled` is `true` ONLY when the
/// process is launched with `MAPLE_GPU_HUD=1`; otherwise `false` (the per-tick
/// latency is not recorded and the overlay is not shown).
public enum GpuHudFlag {
    /// Whether the GPU frame-time HUD is active for this process. Read once at
    /// launch. OFF unless `MAPLE_GPU_HUD=1`.
    public static let isEnabled: Bool = {
        return ProcessInfo.processInfo.environment["MAPLE_GPU_HUD"] == "1"
    }()
}
