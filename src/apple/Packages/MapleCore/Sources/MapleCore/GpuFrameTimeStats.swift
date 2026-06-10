// GpuFrameTimeStats.swift — the rolling frame-time buffer behind the GPU HUD
// (epic #925, P4b-apple validation / #1053).
//
// Always compiled; the recorder no-ops unless the HUD sub-flag is on
// (`GpuHudFlag.isEnabled`). Records the per-slider-tick GPU render+present latency
// the driver measures around the `maple_gpu_present_chain` FFI, and exposes last /
// rolling-avg / max ms for the HUD overlay. `@Observable` + `@MainActor`, so the
// SwiftUI overlay re-renders each time a frame lands.
//
// ## Why a ring buffer (and why these three numbers)
//
// The 16ms slider-tick budget is the product bar; the HUD makes the on-device
// validation objective. A single instantaneous reading is noisy under a drag, so
// we keep a small rolling window:
//   * `last`  — the most recent presented frame (what a single tick cost now);
//   * `avg`   — mean over the window (the steady-state feel of a drag);
//   * `max`   — worst frame in the window (the budget violations hide here — a
//               16ms mean with a 60ms spike still drops a frame).
// The window is intentionally tiny (zero-alloc, MainActor-confined): it is read
// per frame by the overlay and written per presented frame by the driver.
//
// ## Cancelled frames never enter the stats
//
// Under a fast slider drag the supersede mechanism makes intermediate presents
// bail at the FFI entry (`RC_PRESENT_CANCELLED`) and return near-instantly. Those
// are NOT real edit→on-screen frames; recording them would drag `avg`/`last`
// toward ~0ms and make the HUD look better than reality — defeating the point.
// `GpuLiveSession.present` returns `nil` for a cancelled present, and the driver
// calls `record(_:)` only for a real (non-nil) elapsed time, so cancelled frames
// are excluded by construction.

import Foundation

/// Rolling per-frame GPU render+present latency (milliseconds) for the HUD.
/// `@MainActor` (written by the driver, read by the overlay, both MainActor) and
/// `@Observable` so the overlay updates as frames land. Only real presented
/// frames are recorded — cancelled (superseded) presents are dropped upstream.
@MainActor
@Observable
public final class GpuFrameTimeStats {
    /// The most recent presented frame's latency, in ms. `nil` until the first
    /// frame lands (the HUD shows a dash).
    public private(set) var lastMs: Double?
    /// Mean latency over the rolling window, in ms. `nil` until the first frame.
    public private(set) var avgMs: Double?
    /// Worst latency in the rolling window, in ms. `nil` until the first frame.
    public private(set) var maxMs: Double?
    /// Count of frames currently in the window (for the overlay's `n=` readout).
    public private(set) var sampleCount: Int = 0

    /// The rolling window of recent latencies (ms). Capped at `capacity`; oldest
    /// drops off the front. Plain array — the window is tiny and MainActor-only,
    /// so no synchronisation and the per-frame churn is negligible.
    private var window: [Double] = []
    private let capacity: Int

    /// `capacity` frames in the rolling window (default 60 ≈ one second at the
    /// 60Hz target — enough to smooth a drag without lagging the readout).
    public init(capacity: Int = 60) {
        self.capacity = max(1, capacity)
        window.reserveCapacity(self.capacity)
    }

    /// Record one presented frame's render+present latency (ms). Updates
    /// `last`/`avg`/`max` over the rolling window. Called by `GpuLiveDriver` ONLY
    /// for a real (non-cancelled) present, and only when the HUD flag is on — so
    /// flag-on/HUD-off does zero work here.
    public func record(_ ms: Double) {
        guard ms.isFinite, ms >= 0 else { return }
        if window.count == capacity {
            window.removeFirst()
        }
        window.append(ms)
        lastMs = ms
        sampleCount = window.count
        // Recompute avg/max over the window (≤ `capacity` elements — trivial).
        var sum = 0.0
        var peak = 0.0
        for v in window {
            sum += v
            if v > peak { peak = v }
        }
        avgMs = sum / Double(window.count)
        maxMs = peak
    }

    /// Drop the rolling window (e.g. on an asset switch, so a new image's HUD
    /// doesn't carry the prior image's worst frame). Resets all readouts to `nil`.
    public func reset() {
        window.removeAll(keepingCapacity: true)
        lastMs = nil
        avgMs = nil
        maxMs = nil
        sampleCount = 0
    }
}
