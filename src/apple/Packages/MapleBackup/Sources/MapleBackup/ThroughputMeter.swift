// Sources/MapleBackup/ThroughputMeter.swift
//
// Rolling-window throughput accumulator for the backup progress UI (#702).
// Feeds two live rates — bytes/sec and photos/min — from the same event
// stream the progress VM already consumes (`.progress` for bytes, `.completed`
// for photos). Pure value type with an injectable clock so the windowing
// logic is unit-testable in `swift test` without sleeping real time (the VM
// itself lives in the app target, which has no package test coverage).
//
// Accounting notes:
//  - Bytes are derived from `.progress(sent:total:)`, which reports the
//    CUMULATIVE bytes sent for a single task. We track each task's last-seen
//    `sent` and add only the non-negative delta to a monotonic running total,
//    so a retried upload (whose `sent` restarts at 0) can't inject a negative
//    spike — the delta clamps to 0 and the next chunk resumes counting.
//  - Each sample is timestamped; `rate(now:)` only sums samples inside the
//    trailing `window`, so the readout reflects current speed, not a
//    session-lifetime average.
//  - `reset()` drops all samples and per-task state — the VM calls it on
//    pause / restart so a fresh run starts from a clean rolling window.

import Foundation

/// A trailing-window meter for backup throughput. Not thread-safe on its own;
/// the progress VM owns one and mutates it on the main actor.
public struct ThroughputMeter: Sendable {

    /// One unit of work that landed at a point in time, used to compute the
    /// trailing-window rates. `bytes` is the incremental bytes that arrived in
    /// this sample; `photos` is the number of photos that completed.
    private struct Sample: Sendable {
        let at: TimeInterval
        let bytes: Int64
        let photos: Int
    }

    /// Trailing window (seconds) over which rates are averaged. 10s is long
    /// enough to smooth per-chunk jitter but short enough to track real speed
    /// changes (e.g. moving off Wi-Fi) within a couple of UI ticks.
    public let window: TimeInterval

    private var samples: [Sample] = []

    /// Last cumulative `sent` value observed per task, so we add only the
    /// forward delta to the running total. Cleared on `reset()`.
    private var lastSentByTask: [BackupTaskID: Int64] = [:]

    public init(window: TimeInterval = 10) {
        precondition(window > 0, "window must be > 0")
        self.window = window
    }

    /// Record a cumulative-bytes progress sample for `task`. `cumulativeSent`
    /// is the total bytes sent so far for that task (the `.progress` event's
    /// `sent`). Only the non-negative forward delta since the last sample is
    /// counted, so retried uploads (sent restarts at 0) don't subtract.
    public mutating func recordProgress(task: BackupTaskID,
                                        cumulativeSent: Int64,
                                        now: TimeInterval) {
        let previous = lastSentByTask[task] ?? 0
        let delta = max(0, cumulativeSent - previous)
        lastSentByTask[task] = cumulativeSent
        if delta > 0 {
            samples.append(Sample(at: now, bytes: delta, photos: 0))
        }
        trim(now: now)
    }

    /// Record that one photo finished uploading (the `.completed` event). A
    /// completed task's per-task byte cursor is dropped so a future task reusing
    /// the id (it won't, but defensively) starts clean.
    public mutating func recordCompleted(task: BackupTaskID, now: TimeInterval) {
        samples.append(Sample(at: now, bytes: 0, photos: 1))
        lastSentByTask.removeValue(forKey: task)
        trim(now: now)
    }

    /// Drop all samples and per-task cursors. Called on pause / restart so the
    /// rolling window doesn't carry stale speed across a run boundary.
    public mutating func reset() {
        samples.removeAll()
        lastSentByTask.removeAll()
    }

    /// Bytes/sec over the trailing window as of `now`. Zero when the window is
    /// empty (idle or just reset).
    public func bytesPerSecond(now: TimeInterval) -> Double {
        let recent = samplesInWindow(now: now)
        guard !recent.isEmpty else { return 0 }
        let totalBytes = recent.reduce(Int64(0)) { $0 + $1.bytes }
        guard totalBytes > 0 else { return 0 }
        return Double(totalBytes) / elapsed(over: recent, now: now)
    }

    /// Photos/min over the trailing window as of `now`. Zero when the window
    /// holds no completions.
    public func photosPerMinute(now: TimeInterval) -> Double {
        let recent = samplesInWindow(now: now)
        let totalPhotos = recent.reduce(0) { $0 + $1.photos }
        guard totalPhotos > 0 else { return 0 }
        return Double(totalPhotos) / elapsed(over: recent, now: now) * 60.0
    }

    // MARK: - Internals

    private func samplesInWindow(now: TimeInterval) -> [Sample] {
        let cutoff = now - window
        return samples.filter { $0.at >= cutoff }
    }

    /// Effective elapsed span for a rate denominator: the time from the oldest
    /// in-window sample to `now`, floored at a small epsilon so a single fresh
    /// sample doesn't divide by ~0 and report an absurd spike.
    private func elapsed(over recent: [Sample], now: TimeInterval) -> Double {
        guard let oldest = recent.first?.at else { return window }
        return max(now - oldest, 0.001)
    }

    private mutating func trim(now: TimeInterval) {
        let cutoff = now - window
        if let firstKeep = samples.firstIndex(where: { $0.at >= cutoff }), firstKeep > 0 {
            samples.removeFirst(firstKeep)
        } else if samples.allSatisfy({ $0.at < cutoff }) {
            samples.removeAll()
        }
    }
}
