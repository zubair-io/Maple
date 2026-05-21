// Sources/MapleBackup/BackupState.swift
//
// GRDB-backed persistence for the queue's state machine. One table —
// `tasks` — keyed by (device_id, phasset_local_id). This is internal queue
// state (counts, retry depth, in-flight chunk offsets), not user data:
// SQLite is appropriate for the concurrent-update + restart-recovery shape.
// User-visible sidecars stay as `.xmp` files (see AppSupportSidecarStore).
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §17.

import Foundation
import GRDB

public actor BackupStateStore {

    private let dbQueue: DatabaseQueue

    public init(databaseURL: URL) throws {
        self.dbQueue = try DatabaseQueue(path: databaseURL.path)
        try dbQueue.write { db in
            try db.create(table: "tasks", ifNotExists: true) { t in
                t.column("device_id", .text).notNull()
                t.column("phasset_local_id", .text).notNull()
                t.column("state", .text).notNull()
                t.column("priority", .integer).notNull()
                t.column("retry_count", .integer).notNull().defaults(to: 0)
                t.column("last_error", .text)
                t.column("enqueued_at", .double).notNull()
                t.primaryKey(["device_id", "phasset_local_id"])
            }
            try db.create(index: "tasks_state_idx",
                          on: "tasks", columns: ["state"],
                          ifNotExists: true)
        }
    }

    /// Insert or replace by the natural (device_id, phasset_local_id) PK.
    public func upsert(_ task: BackupTask) throws {
        try dbQueue.write { db in
            try db.execute(literal: """
                INSERT INTO tasks
                  (device_id, phasset_local_id, state, priority, retry_count, last_error, enqueued_at)
                VALUES
                  (\(task.id.deviceId), \(task.id.phassetLocalId), \(task.state.rawValue),
                   \(task.priority.rawValue), \(task.retryCount), \(task.lastError),
                   \(task.enqueuedAt.timeIntervalSince1970))
                ON CONFLICT(device_id, phasset_local_id) DO UPDATE SET
                  state=excluded.state,
                  priority=excluded.priority,
                  retry_count=excluded.retry_count,
                  last_error=excluded.last_error,
                  enqueued_at=excluded.enqueued_at
                """)
        }
    }

    /// Transition a task to `state`. Always overwrites `last_error` —
    /// pass nil to clear it on success. When `retryCount` is supplied,
    /// the `retry_count` column is updated in the same statement; when
    /// nil, the existing column value is preserved.
    public func transition(_ id: BackupTaskID,
                           to state: BackupState,
                           error: String? = nil,
                           retryCount: Int? = nil) throws {
        try dbQueue.write { db in
            if let retryCount {
                try db.execute(literal: """
                    UPDATE tasks
                       SET state=\(state.rawValue),
                           last_error=\(error),
                           retry_count=\(retryCount)
                     WHERE device_id=\(id.deviceId)
                       AND phasset_local_id=\(id.phassetLocalId)
                    """)
            } else {
                try db.execute(literal: """
                    UPDATE tasks
                       SET state=\(state.rawValue),
                           last_error=\(error)
                     WHERE device_id=\(id.deviceId)
                       AND phasset_local_id=\(id.phassetLocalId)
                    """)
            }
        }
    }

    public func find(_ id: BackupTaskID) throws -> BackupTask? {
        try dbQueue.read { db in
            try Row.fetchOne(db,
                             sql: "SELECT * FROM tasks WHERE device_id = ? AND phasset_local_id = ?",
                             arguments: [id.deviceId, id.phassetLocalId])
                .map(Self.decode)
        }
    }

    public func allTasks() throws -> [BackupTask] {
        try dbQueue.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM tasks").map(Self.decode)
        }
    }

    public func tasks(in state: BackupState) throws -> [BackupTask] {
        try dbQueue.read { db in
            try Row.fetchAll(db,
                             sql: "SELECT * FROM tasks WHERE state = ?",
                             arguments: [state.rawValue])
                .map(Self.decode)
        }
    }

    private static func decode(_ row: Row) -> BackupTask {
        BackupTask(
            id: BackupTaskID(deviceId: row["device_id"], phassetLocalId: row["phasset_local_id"]),
            state: BackupState(rawValue: row["state"]) ?? .observed,
            priority: BackupPriority(rawValue: row["priority"]) ?? .background,
            retryCount: row["retry_count"],
            lastError: row["last_error"],
            enqueuedAt: Date(timeIntervalSince1970: row["enqueued_at"]))
    }
}
