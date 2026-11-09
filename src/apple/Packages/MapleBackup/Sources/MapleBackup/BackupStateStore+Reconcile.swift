// Sources/MapleBackup/BackupStateStore+Reconcile.swift
//
// Rows a library walk settles while workers are uploading, and the local
// records it reads to decide how much to ask the server. Each write is one
// transaction that re-reads the row's state, so a walk working from an
// earlier snapshot of the table never overwrites a row a worker has claimed
// since, and a worker never uploads a row a walk has already settled.

import Foundation
import GRDB

extension BackupStateStore {

  /// Marks photos the server already holds as uploaded, leaving rows a worker
  /// has claimed, finished, or is waiting to retry alone: a retry can be the
  /// one that still owes a Live Photo video or edited render after the
  /// original landed. Returns the ids that were still pending: those are the
  /// queue entries the caller should cancel.
  public func markServerHeld(_ tasks: [BackupTask]) throws -> [BackupTaskID] {
    try dbQueue.write { db in
      try tasks.compactMap { task in
        let row = try Row.fetchOne(
          db,
          sql: "SELECT state, retry_count FROM tasks WHERE device_id = ? AND phasset_local_id = ?",
          arguments: [task.id.deviceId, task.id.phassetLocalId])
        let prior = (row?["state"] as String?).flatMap(BackupState.init(rawValue:))
        let isRetrying = prior == .pending && (row?["retry_count"] as Int? ?? 0) > 0
        guard prior != .uploaded, prior != .uploading, !isRetrying else { return nil }
        try db.execute(
          sql: """
            INSERT INTO tasks
              (device_id, phasset_local_id, state, priority, retry_count, last_error,
               enqueued_at, captured_at)
            VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
            ON CONFLICT(device_id, phasset_local_id) DO UPDATE SET
              state = excluded.state,
              last_error = NULL,
              captured_at = COALESCE(excluded.captured_at, tasks.captured_at)
            """,
          arguments: [
            task.id.deviceId, task.id.phassetLocalId, BackupState.uploaded.rawValue,
            task.priority.rawValue, task.enqueuedAt.timeIntervalSince1970,
            task.capturedAt?.timeIntervalSince1970,
          ])
        return prior == .pending ? task.id : nil
      }
    }
  }

  /// Forgets photos that left the library, except rows a worker is uploading.
  /// Returns the ids that were pending, whose queue entries the caller should
  /// cancel.
  public func removeDeleted(_ ids: [BackupTaskID]) throws -> [BackupTaskID] {
    try dbQueue.write { db in
      try ids.compactMap { id in
        guard let prior = try Self.state(of: id, in: db), prior != .uploading else { return nil }
        try db.execute(
          sql: "DELETE FROM tasks WHERE device_id = ? AND phasset_local_id = ?",
          arguments: [id.deviceId, id.phassetLocalId])
        return prior == .pending ? id : nil
      }
    }
  }

  /// Moves a dequeued task to uploading. Returns false when its row is gone or
  /// a walk already recorded the photo as uploaded, so the worker drops it.
  public func claimForUpload(_ id: BackupTaskID) throws -> Bool {
    try dbQueue.write { db in
      try db.execute(
        sql: """
          UPDATE tasks SET state = ?, last_error = NULL
           WHERE device_id = ? AND phasset_local_id = ? AND state != ?
          """,
        arguments: [
          BackupState.uploading.rawValue, id.deviceId, id.phassetLocalId,
          BackupState.uploaded.rawValue,
        ])
      return db.changesCount > 0
    }
  }

  public func phids(in state: BackupState, deviceId: String) throws -> [String] {
    try dbQueue.read { db in
      try String.fetchAll(
        db,
        sql: "SELECT phasset_local_id FROM tasks WHERE device_id = ? AND state = ?",
        arguments: [deviceId, state.rawValue])
    }
  }

  /// The digest of the edit last delivered under the sidecar name the server
  /// reads, or nil when none was.
  public func deliveredCanonicalDigest(_ id: BackupTaskID) throws -> String? {
    try dbQueue.read { db in
      try String.fetchOne(
        db,
        sql: """
          SELECT digest FROM uploaded_sidecars
           WHERE device_id = ? AND phasset_local_id = ? AND canonical_name = 1
          """,
        arguments: [id.deviceId, id.phassetLocalId])
    }
  }

  /// Records that the delivered edit already sits under the name the server
  /// reads, as every video sidecar always did.
  public func markDeliveredSidecarCanonical(_ id: BackupTaskID) throws {
    try dbQueue.write { db in
      try db.execute(
        sql: """
          UPDATE uploaded_sidecars SET canonical_name = 1
           WHERE device_id = ? AND phasset_local_id = ? AND canonical_name = 0
          """,
        arguments: [id.deviceId, id.phassetLocalId])
    }
  }

  private static func state(of id: BackupTaskID, in db: Database) throws -> BackupState? {
    try String.fetchOne(
      db,
      sql: "SELECT state FROM tasks WHERE device_id = ? AND phasset_local_id = ?",
      arguments: [id.deviceId, id.phassetLocalId]
    ).flatMap(BackupState.init(rawValue:))
  }
}
