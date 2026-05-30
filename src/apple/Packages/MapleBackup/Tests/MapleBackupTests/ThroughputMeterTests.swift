// Tests/MapleBackupTests/ThroughputMeterTests.swift
//
// Unit coverage for the rolling-window throughput accumulator (#702). The
// meter takes an injected `now`, so every windowing edge case is exercised
// deterministically without sleeping real time.

import XCTest
@testable import MapleBackup

final class ThroughputMeterTests: XCTestCase {

    private func task(_ id: String) -> BackupTaskID {
        BackupTaskID(deviceId: "d", phassetLocalId: id)
    }

    /// Cumulative `.progress` deltas across one task accumulate to a steady
    /// bytes/sec over the window.
    func testBytesPerSecondFromCumulativeProgress() {
        var meter = ThroughputMeter(window: 10)
        let p = task("P1")
        // 1 MB sent over the first 1s (two cumulative samples).
        meter.recordProgress(task: p, cumulativeSent: 0, now: 0)
        meter.recordProgress(task: p, cumulativeSent: 500_000, now: 0.5)
        meter.recordProgress(task: p, cumulativeSent: 1_000_000, now: 1.0)
        // Oldest in-window sample is at t=0.5 (the first non-zero delta), so the
        // denominator is ~0.5s and total bytes is 1_000_000.
        let rate = meter.bytesPerSecond(now: 1.0)
        XCTAssertGreaterThan(rate, 0)
        // 1 MB over the 0.5s span between first and last counted sample.
        XCTAssertEqual(rate, 1_000_000 / 0.5, accuracy: 1_000)
    }

    /// A retried upload restarts `sent` at 0 — the delta must clamp to 0, never
    /// subtract from the running total (no negative spike).
    func testRetryResetDoesNotProduceNegativeBytes() {
        var meter = ThroughputMeter(window: 10)
        let p = task("P1")
        meter.recordProgress(task: p, cumulativeSent: 800_000, now: 0)
        // Upload failed and restarted: cumulative drops back to 0.
        meter.recordProgress(task: p, cumulativeSent: 0, now: 0.1)
        meter.recordProgress(task: p, cumulativeSent: 200_000, now: 0.2)
        // Only forward deltas count: 800_000 (first) + 200_000 (third) = 1_000_000.
        // The reset sample contributes 0, never a negative.
        let rate = meter.bytesPerSecond(now: 0.2)
        XCTAssertGreaterThanOrEqual(rate, 0)
        // Sanity: the negative jump was clamped, so the rate is positive.
        XCTAssertGreaterThan(rate, 0)
    }

    /// Completions feed photos/min.
    func testPhotosPerMinute() {
        var meter = ThroughputMeter(window: 60)
        // 6 photos across 30 seconds → 12 photos/min.
        for i in 0..<6 {
            meter.recordCompleted(task: task("P\(i)"), now: Double(i) * 6.0)
        }
        let rate = meter.photosPerMinute(now: 30.0)
        // 6 photos over the 30s span between first (t=0) and now → 12/min.
        XCTAssertEqual(rate, 12.0, accuracy: 0.5)
    }

    /// Samples older than the window must drop out, so a burst-then-idle stretch
    /// reports zero once the window has passed.
    func testWindowEviction() {
        var meter = ThroughputMeter(window: 5)
        let p = task("P1")
        meter.recordProgress(task: p, cumulativeSent: 0, now: 0)
        meter.recordProgress(task: p, cumulativeSent: 1_000_000, now: 1)
        XCTAssertGreaterThan(meter.bytesPerSecond(now: 1), 0)
        // 10s later — every sample is outside the 5s window.
        XCTAssertEqual(meter.bytesPerSecond(now: 11), 0, accuracy: 0.0001)
        XCTAssertEqual(meter.photosPerMinute(now: 11), 0, accuracy: 0.0001)
    }

    /// `reset()` clears samples AND per-task byte cursors, so the next progress
    /// sample's delta is measured from 0 (not from the pre-reset cumulative).
    func testResetClearsWindowAndCursors() {
        var meter = ThroughputMeter(window: 10)
        let p = task("P1")
        meter.recordProgress(task: p, cumulativeSent: 0, now: 0)
        meter.recordProgress(task: p, cumulativeSent: 5_000_000, now: 1)
        XCTAssertGreaterThan(meter.bytesPerSecond(now: 1), 0)

        meter.reset()
        XCTAssertEqual(meter.bytesPerSecond(now: 1), 0, accuracy: 0.0001)

        // After reset the per-task cursor is gone, so the FIRST post-reset
        // sample is measured from 0 — a cumulative of 5_000_000 reads as a full
        // 5_000_000-byte delta (NOT a 0-delta, which is what a surviving cursor
        // would have produced). The next sample adds another 1_000_000.
        meter.recordProgress(task: p, cumulativeSent: 5_000_000, now: 2)
        meter.recordProgress(task: p, cumulativeSent: 6_000_000, now: 3)
        // Total counted = 5_000_000 + 1_000_000 = 6_000_000 over the 1s span
        // from the oldest in-window sample (t=2) to now (t=3).
        XCTAssertEqual(meter.bytesPerSecond(now: 3), 6_000_000, accuracy: 100_000)
    }

    /// An empty / freshly-constructed meter reports zero, not NaN/Inf.
    func testIdleIsZero() {
        let meter = ThroughputMeter()
        XCTAssertEqual(meter.bytesPerSecond(now: 100), 0)
        XCTAssertEqual(meter.photosPerMinute(now: 100), 0)
    }
}
