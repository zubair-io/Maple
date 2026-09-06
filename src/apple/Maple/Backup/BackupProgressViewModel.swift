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
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §7, §21.

import Foundation
import MapleBackup

@MainActor
@Observable
public final class BackupProgressViewModel {

    /// Explicit, user-visible run state for the backup engine.
    ///
    /// Distinct from `isRunning` (which only tracks "an observer is attached
    /// to the queue"): this is the engine *phase* the panel shows to the user
    /// — Stopped / Running / Paused / Restarting…. It is driven by
    /// `EngineHost` (the only thing that knows the real lifecycle) rather than
    /// inferred from queue events.
    public enum BackupRunPhase: Sendable {
        /// Engine has never started this session, or was fully torn down.
        case stopped
        /// Runner is launched and draining the queue.
        case running
        /// User tapped Pause — runner is stopped but counters/progress remain.
        case paused
        /// A restart is in flight (teardown + walk seeding the queue).
        case restarting

        /// Short label for the status row.
        public var label: String {
            switch self {
            case .stopped: return "Stopped"
            case .running: return "Running"
            case .paused: return "Paused"
            case .restarting: return "Restarting…"
            }
        }
    }

    /// Current engine phase. Driven by `EngineHost.start`/`stop`/`pause`.
    /// `@Observable` so the panel updates reactively.
    public private(set) var phase: BackupRunPhase = .stopped

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

    /// Outcome of the most recent PhotoKit walk (#3097). Published by
    /// `ChangeObserverWiring.enqueueAllNew` when a walk finishes, so the
    /// panel can distinguish "fully backed up, nothing to do" from the
    /// cold "never started" empty state — both have `totalEnqueued == 0`.
    public struct WalkSummary: Sendable, Hashable {
        /// Eligible assets the walk enumerated in the Photos library.
        public let enumerated: Int
        /// Tasks this walk actually queued (new + user-requested retries).
        public let enqueued: Int
        /// Tasks in the terminal `.failedRetry` state (out of retries).
        public let failedPermanently: Int
        public let finishedAt: Date

        public init(enumerated: Int, enqueued: Int,
                    failedPermanently: Int, finishedAt: Date) {
            self.enumerated = enumerated
            self.enqueued = enqueued
            self.failedPermanently = failedPermanently
            self.finishedAt = finishedAt
        }
    }

    /// Most recent walk outcome, or nil before the first walk completes.
    public private(set) var lastWalkSummary: WalkSummary?

    /// Live phase of the PhotoKit walk that seeds the queue (#3386). The
    /// walk enumerates the library, pulls the server's known-asset list,
    /// then hashes every remaining candidate and asks the server which it
    /// lacks — minutes on a large library, during which the queue is still
    /// empty. Without this the panel sat on Running / "No photos queued" for
    /// the whole scan, indistinguishable from a wedged engine.
    public enum WalkPhase: Sendable, Hashable {
        /// No walk in flight.
        case idle
        /// Enumerating `PHAsset`s and fetching the server's known-asset list.
        case enumerating
        /// Content-hashing candidates and checking them against the server.
        case reconciling(checked: Int, total: Int)
        /// The walk gave up before seeding the queue; the reason is shown
        /// verbatim so the user isn't left guessing.
        case failed(String)
    }

    /// Current walk phase. `recordWalkSummary` returns it to `.idle`.
    public private(set) var walkPhase: WalkPhase = .idle

    public func setWalkPhase(_ phase: WalkPhase) {
        walkPhase = phase
    }

    /// How many distinct assets we've observed enqueued in this session.
    /// Resets if `.start(queue:)` is called against a different queue.
    public private(set) var totalEnqueued: Int = 0
    /// How many have had their bytes land (`.completed`). Per #701 this is the
    /// photo-success signal — companions land best-effort afterward. It is NOT
    /// the "fully done" count; subtract the companions-pending set for that.
    public private(set) var totalCompleted: Int = 0
    /// How many have hit the max-retry ceiling and stopped retrying.
    public private(set) var totalFailed: Int = 0

    /// Tasks whose bytes landed but which still have ≥1 best-effort companion
    /// (sidecar / rendered / live-mov) outstanding in its bounded retry path
    /// (#702). Driven by `.companionPending` / `.companionsResolved`. Used to
    /// split `totalCompleted` into "done" vs "uploaded — companions pending".
    private var pendingCompanions: Set<BackupTaskID> = []

    /// Photos fully landed — bytes AND all companions. Disjoint from
    /// `uploadedCompanionsPending` and `totalFailed`.
    public var doneCount: Int {
        max(0, totalCompleted - pendingCompanions.count)
    }

    /// Photos whose bytes landed but with a companion retry still outstanding.
    public var uploadedCompanionsPendingCount: Int {
        pendingCompanions.count
    }

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

    /// Live throughput in bytes/sec over a trailing window (#702). 0 when idle.
    public private(set) var bytesPerSecond: Double = 0
    /// Live throughput in photos/min over a trailing window (#702). 0 when idle.
    public private(set) var photosPerMinute: Double = 0

    private var observerTask: Task<Void, Never>?
    /// Track which task IDs we've counted so retries don't inflate totalEnqueued.
    private var seenEnqueued: Set<BackupTaskID> = []
    /// Rolling-window throughput accumulator (#702). Lives in MapleBackup so the
    /// windowing math is unit-tested there; the VM just feeds it events and
    /// republishes the rates. Reset on pause / restart.
    private var meter = ThroughputMeter()

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

    /// Set the user-visible engine phase. Called by `EngineHost` as the
    /// engine moves through its lifecycle.
    public func setPhase(_ newPhase: BackupRunPhase) {
        phase = newPhase
        // Throughput is a live "right now" readout — a stopped or restarting
        // engine has no flow, so clear the rolling window rather than letting a
        // stale rate linger (#702). `.running` keeps whatever's accumulated.
        if newPhase == .stopped || newPhase == .restarting {
            resetThroughput()
            // Same rationale as `markPaused`: a stopped/restarting engine has no
            // outstanding companion retries (they were cancelled), so a stranded
            // `pendingCompanions` entry would permanently skew the breakdown.
            pendingCompanions.removeAll()
        }
    }

    /// Mark the engine paused by the user: clear the "Uploading now" tiles
    /// (the in-flight uploads were cancelled by `EngineHost.stop()`, so
    /// leaving them on screen looks frozen) and flip the phase. Cumulative
    /// counters (`totalCompleted` / `totalEnqueued` / `totalFailed`) and the
    /// `recentCompleted` strip are intentionally preserved so the user keeps
    /// their progress context across a pause/resume.
    public func markPaused() {
        inFlight.removeAll()
        phase = .paused
        // The in-flight uploads were cancelled, so there's no live flow — reset
        // the rolling window so the panel doesn't show a frozen non-zero rate
        // while paused (#702).
        resetThroughput()
        // `EngineHost.stop()` cancels the detached companion retries; a cancelled
        // retry returns without emitting `.companionsResolved`, so any task that
        // was mid-retry would otherwise stay in `pendingCompanions` for the rest
        // of the session — permanently undercounting `doneCount` and freezing the
        // "Finishing" bucket. No companion retry is outstanding while paused, so
        // clear the set (#702).
        pendingCompanions.removeAll()
    }

    /// Clear the throughput accumulator and zero the published rates.
    private func resetThroughput() {
        meter.reset()
        bytesPerSecond = 0
        photosPerMinute = 0
    }

    /// True when the most recent walk checked a non-empty library and found
    /// nothing to queue, and no live queue events have arrived since — i.e.
    /// the backup is complete, not merely never-started (#3097). Any
    /// `.enqueued` event (a new capture) flips this back to the counting path.
    public var isAllBackedUp: Bool {
        guard totalEnqueued == 0, let summary = lastWalkSummary else { return false }
        return summary.enqueued == 0 && summary.enumerated > 0
    }

    /// Record the outcome of a finished PhotoKit walk (#3097).
    public func recordWalkSummary(_ summary: WalkSummary) {
        lastWalkSummary = summary
        walkPhase = .idle
    }

    /// Human-readable walk-phase line for the status panel, or nil while no
    /// walk is in flight.
    public var walkPhaseLabel: String? {
        switch walkPhase {
        case .idle:
            return nil
        case .enumerating:
            return "Scanning Photos library…"
        case .reconciling(let checked, let total):
            return "Checking \(checked.formatted()) of \(total.formatted()) photos against the server…"
        case .failed(let reason):
            return "Library scan failed: \(reason)"
        }
    }

    /// 0.0 → 1.0 progress through the reconciliation pass, nil for the
    /// phases that have no meaningful fraction (indeterminate spinner).
    public var walkFraction: Double? {
        guard case .reconciling(let checked, let total) = walkPhase, total > 0 else { return nil }
        return min(1.0, Double(checked) / Double(total))
    }

    /// Computed convenience: 0.0 → 1.0 progress when totalEnqueued > 0.
    /// A completed backup ("all backed up") renders a full bar.
    public var fractionDone: Double {
        if isAllBackedUp { return 1.0 }
        guard totalEnqueued > 0 else { return 0 }
        return min(1.0, Double(totalCompleted) / Double(totalEnqueued))
    }

    /// Computed convenience: short "5,234 of 12,890 photos" string. When the
    /// last walk confirmed the library is fully backed up, say so instead of
    /// the cold-start "No photos queued" (#3097).
    public var progressLabel: String {
        if isAllBackedUp, let summary = lastWalkSummary {
            return "All photos backed up · \(summary.enumerated.formatted()) photos"
        }
        if totalEnqueued == 0 { return "No photos queued" }
        return "\(totalCompleted.formatted()) of \(totalEnqueued.formatted()) photos"
    }

    /// Human-readable throughput line, e.g. "12.4 MB/s · 84 photos/min", or nil
    /// when nothing is flowing (so the panel can hide the row). Driven by the
    /// rolling-window meter (#702).
    public var throughputLabel: String? {
        guard bytesPerSecond > 0 || photosPerMinute >= 1 else { return nil }
        var parts: [String] = []
        if bytesPerSecond > 0 {
            let formatted = ByteCountFormatter.string(
                fromByteCount: Int64(bytesPerSecond), countStyle: .file)
            parts.append("\(formatted)/s")
        }
        if photosPerMinute >= 1 {
            parts.append("\(Int(photosPerMinute.rounded())) photos/min")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: - Event reducer

    // Internal (not private) so `@testable import Maple` can drive the reducer
    // directly in MapleTests without standing up the async event stream (#723).
    func apply(_ event: BackupQueueEvent) {
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
            meter.recordProgress(task: id, cumulativeSent: sent,
                                 now: Date().timeIntervalSinceReferenceDate)
            republishThroughput()
        case .completed(let id, let mapleId):
            inFlight.removeAll { $0.id == id }
            totalCompleted += 1
            recentCompleted.insert(Completed(id: id, mapleId: mapleId), at: 0)
            if recentCompleted.count > 10 {
                recentCompleted.removeLast(recentCompleted.count - 10)
            }
            meter.recordCompleted(task: id,
                                  now: Date().timeIntervalSinceReferenceDate)
            republishThroughput()
        case .failed(let id, let error, let willRetry):
            // Remove from the "Uploading now" strip regardless of `willRetry`:
            // a backing-off photo is *pending a retry*, not actively uploading,
            // so leaving it in `inFlight` with frozen `bytesSent/bytesTotal`
            // reads as a stuck tile (#723). The retry's subsequent `.started`
            // re-adds a fresh `InFlight(id:)` at 0%. Only a terminal failure
            // (no more retries) bumps `totalFailed`.
            inFlight.removeAll { $0.id == id }
            if !willRetry { totalFailed += 1 }
            lastError = error
        case .cancelled(let id):
            inFlight.removeAll { $0.id == id }
        case .companionPending(let id):
            // Bytes already landed (`.completed` arrived first; the engine emits
            // it before any companion work and the queue is a single actor, so
            // stream order is preserved). Re-classify this photo from "done" to
            // "uploaded — companions pending" (#702).
            pendingCompanions.insert(id)
        case .companionsResolved(let id):
            // Last companion reached a terminal state — back to fully done.
            pendingCompanions.remove(id)
        }
    }

    /// Recompute the published rates from the meter at "now". Called after every
    /// `.progress` / `.completed` so the panel reads fresh throughput. Also
    /// invoked when no event is flowing would leave a stale value — but that's
    /// acceptable for a live panel; the next event refreshes it.
    private func republishThroughput() {
        let now = Date().timeIntervalSinceReferenceDate
        bytesPerSecond = meter.bytesPerSecond(now: now)
        photosPerMinute = meter.photosPerMinute(now: now)
    }
}
