// src/apple/Maple/Backup/BackupProgressViewModel.swift
//
// @Observable view-model that aggregates BackupQueueEvents into UI state.
// Bound by BackupStatusPanel (Task 3.5) to render the visible progress
// feature requested by the user — "we can see the photos that are being
// uploaded and we know about how much is left."
//
// Lifecycle: BackupStatusPanel constructs one of these on appear, calls
// `.start(queue:)`, and renders state. `.start()` is idempotent — calling
// twice cancels the prior observation task and starts a fresh one.
//
// Thumbnail fetching for the visible tiles is the View's job (PHAsset
// localIdentifiers are exposed via `inFlight` / `recentCompleted`); this VM
// stays PhotoKit-free so it's easy to drive from previews.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §7, §21.

import Foundation
import MapleBackup

@MainActor
@Observable
public final class BackupProgressViewModel {

    public struct InFlight: Identifiable, Hashable, Sendable {
        public let id: BackupTaskID
        public let startedAt: Date
        /// Bytes sent so far for this asset (updated per chunk via .progress events).
        public var bytesSent: Int64
        /// Total bytes for this asset. 0 until the first .progress event arrives.
        public var bytesTotal: Int64

        public init(id: BackupTaskID, startedAt: Date = Date(),
                    bytesSent: Int64 = 0, bytesTotal: Int64 = 0) {
            self.id = id; self.startedAt = startedAt
            self.bytesSent = bytesSent; self.bytesTotal = bytesTotal
        }

        /// 0.0 → 1.0 progress fraction, or nil when total is unknown.
        public var fractionDone: Double? {
            guard bytesTotal > 0 else { return nil }
            return min(1.0, Double(bytesSent) / Double(bytesTotal))
        }
    }

    public struct Completed: Identifiable, Hashable, Sendable {
        public let id: BackupTaskID
        public let mapleId: String
        public let completedAt: Date
        public init(id: BackupTaskID, mapleId: String, completedAt: Date = Date()) {
            self.id = id; self.mapleId = mapleId; self.completedAt = completedAt
        }
    }

    /// How many distinct assets we've observed enqueued in this session.
    /// Resets if `.start(queue:)` is called against a different queue.
    public private(set) var totalEnqueued: Int = 0
    /// How many have finished uploading.
    public private(set) var totalCompleted: Int = 0
    /// How many have hit the max-retry ceiling and stopped retrying.
    public private(set) var totalFailed: Int = 0

    /// The set of tasks currently uploading. Usually 1-4 at a time depending
    /// on engine concurrency.
    public private(set) var inFlight: [InFlight] = []

    /// Last 10 successfully uploaded tasks, newest first.
    public private(set) var recentCompleted: [Completed] = []

    /// Most recent failure message; nil if no failure has been observed yet.
    public private(set) var lastError: String?

    /// True between `.start()` and `.stop()`. The panel uses this to render
    /// "engine paused" vs "engine running" affordance.
    public private(set) var isRunning: Bool = false

    private var observerTask: Task<Void, Never>?
    /// Track which task IDs we've counted so retries don't inflate totalEnqueued.
    private var seenEnqueued: Set<BackupTaskID> = []

    public init() {}

    /// Subscribe to the queue's event stream and update state in real time.
    /// Idempotent — calling twice resets the prior observer.
    public func start(queue: any BackupQueue) {
        observerTask?.cancel()
        observerTask = Task { [weak self] in
            guard let self else { return }
            let stream = await queue.observe()
            await MainActor.run { self.isRunning = true }
            for await event in stream {
                await MainActor.run { self.apply(event) }
            }
            await MainActor.run { self.isRunning = false }
        }
    }

    public func stop() {
        observerTask?.cancel()
        observerTask = nil
        isRunning = false
    }

    /// Backfill `totalEnqueued` from a queue snapshot taken AFTER `start()`
    /// subscribed but possibly before the panel was visible. Without this,
    /// a panel that mounts after the engine has already enqueued thousands
    /// of tasks shows `0 of 0 photos` because `observe()` only emits
    /// future events. Idempotent — `seenEnqueued` deduplicates against
    /// any `.enqueued` events that arrived first.
    public func backfill(queued: [BackupTask]) {
        for task in queued where seenEnqueued.insert(task.id).inserted {
            totalEnqueued += 1
        }
    }

    /// Computed convenience: 0.0 → 1.0 progress when totalEnqueued > 0.
    public var fractionDone: Double {
        guard totalEnqueued > 0 else { return 0 }
        return min(1.0, Double(totalCompleted) / Double(totalEnqueued))
    }

    /// Computed convenience: short "5,234 of 12,890 photos" string.
    public var progressLabel: String {
        if totalEnqueued == 0 { return "No photos queued" }
        return "\(totalCompleted.formatted()) of \(totalEnqueued.formatted()) photos"
    }

    // MARK: - Event reducer

    private func apply(_ event: BackupQueueEvent) {
        switch event {
        case .enqueued(let task):
            if seenEnqueued.insert(task.id).inserted {
                totalEnqueued += 1
            }
        case .started(let id):
            // Add to inFlight if not already there.
            if !inFlight.contains(where: { $0.id == id }) {
                inFlight.append(InFlight(id: id))
            }
        case .progress(let id, let sent, let total):
            if let idx = inFlight.firstIndex(where: { $0.id == id }) {
                inFlight[idx].bytesSent = sent
                inFlight[idx].bytesTotal = total
            }
        case .completed(let id, let mapleId):
            inFlight.removeAll { $0.id == id }
            totalCompleted += 1
            recentCompleted.insert(Completed(id: id, mapleId: mapleId), at: 0)
            if recentCompleted.count > 10 {
                recentCompleted.removeLast(recentCompleted.count - 10)
            }
        case .failed(let id, let error, let willRetry):
            if !willRetry {
                inFlight.removeAll { $0.id == id }
                totalFailed += 1
            }
            lastError = error
        case .cancelled(let id):
            inFlight.removeAll { $0.id == id }
        }
    }
}
