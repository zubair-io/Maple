// Sources/MapleBackup/BackupTask.swift
//
// Value types for the device-side backup queue + state machine.
// Used by BackupQueue (2.8), BackupStateStore (2.7), and BackupEngine (2.12).
//
// Identity is the natural (deviceId, phassetLocalId) pair — the same key the
// server's upload_sessions collection uses. deviceId is the stable per-install
// UUID from DeviceIdentity; phassetLocalId is Apple's PHAsset.localIdentifier.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §16, §17.

import Foundation

/// Stable identity for a backup task. Same shape as the server's
/// (device_id, phasset_local_id) resume key.
public struct BackupTaskID: Hashable, Sendable, Codable {
    public let deviceId: String
    public let phassetLocalId: String

    public init(deviceId: String, phassetLocalId: String) {
        self.deviceId = deviceId
        self.phassetLocalId = phassetLocalId
    }
}

/// Queue priority. `userEdit` jumps the line so a photo the user is actively
/// editing finishes uploading before the rest of the background backlog.
public enum BackupPriority: Int, Comparable, Sendable, Codable {
    case background = 0
    case userEdit = 10

    public static func < (a: BackupPriority, b: BackupPriority) -> Bool {
        a.rawValue < b.rawValue
    }
}

/// State machine for a single asset's backup lifecycle. Persistence is
/// handled by BackupStateStore (Task 2.7).
///
///   unseen → observed → pending → uploading → uploaded
///                          │
///                          ├──► failedRetry (exponential backoff)
///                          └──► skippedPolicy
///
///   (any state) → localEditPending  (App-Support sidecar exists, bytes
///                                    not uploaded yet; transitions back
///                                    to pending on next walk)
public enum BackupState: String, Sendable, Codable, CaseIterable {
    case observed
    case pending
    case uploading
    case uploaded
    case failedRetry
    case skippedPolicy
    case localEditPending
}

/// A single backup task as the queue and state store see it.
public struct BackupTask: Sendable, Hashable, Codable {
    public let id: BackupTaskID
    public var state: BackupState
    public var priority: BackupPriority
    public var retryCount: Int
    public var lastError: String?
    public var enqueuedAt: Date
    /// The asset's capture date (`PHAsset.creationDate`). The queue drains
    /// newer captures first within a priority, and because the value is
    /// persisted with the task that order survives a relaunch — the
    /// rehydrated backlog and any capture that lands mid-backlog both slot
    /// in by this date, not by when they happened to be enqueued (#3388).
    /// `nil` (rows written before the column existed, assets with no date)
    /// sorts after every dated task.
    public var capturedAt: Date?

    public init(id: BackupTaskID,
                state: BackupState,
                priority: BackupPriority,
                retryCount: Int = 0,
                lastError: String? = nil,
                enqueuedAt: Date = Date(),
                capturedAt: Date? = nil) {
        self.id = id
        self.state = state
        self.priority = priority
        self.retryCount = retryCount
        self.lastError = lastError
        self.enqueuedAt = enqueuedAt
        self.capturedAt = capturedAt
    }
}

/// Events emitted by `BackupQueue.observe()` so the UI can render live
/// progress without polling.
public enum BackupQueueEvent: Sendable {
    case enqueued(BackupTask)
    case started(BackupTaskID)
    case progress(BackupTaskID, sent: Int64, total: Int64)
    case completed(BackupTaskID, mapleId: String)
    case failed(BackupTaskID, error: String, willRetry: Bool)
    case cancelled(BackupTaskID)
    /// Bytes already landed (`.completed` was emitted first), but at least one
    /// best-effort companion (sidecar / rendered / live-mov) has fallen into its
    /// bounded detached-retry path. Emitted once per task on the 0→1 transition
    /// of its outstanding-companion count (#702). The photo is uploaded; some
    /// derived artifact is still in flight.
    case companionPending(BackupTaskID)
    /// The task's last outstanding companion reached a terminal state — it
    /// either landed on a retry or exhausted its bounded budget and was dropped
    /// (re-derivable artifacts regenerate on a future walk). Emitted once per
    /// task on the →0 transition. After this the photo is fully done (#702).
    case companionsResolved(BackupTaskID)
}
