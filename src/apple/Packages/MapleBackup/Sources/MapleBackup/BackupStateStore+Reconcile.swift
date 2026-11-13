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
  /// has claimed, finished, or is waiting to retry alone, and every row that
  /// still owes a Live Photo video or edited render: the server holding the
  /// original says nothing about those, even once the row is out of retries.
  /// Returns the ids that were still pending: those are the queue entries the
  /// caller should cancel.
  public func markServerHeld(_ tasks: [BackupTask]) throws -> [BackupTaskID] {
    try dbQueue.write { db in
      try tasks.compactMap { task in
        let row = try Row.fetchOne(
          db,
          sql: """
            SELECT state, retry_count, companions_owed FROM tasks
             WHERE device_id = ? AND phasset_local_id = ?
            """,
          arguments: [task.id.deviceId, task.id.phassetLocalId])
        let prior = (row?["state"] as String?).flatMap(BackupState.init(rawValue:))
        let isRetrying = prior == .pending && (row?["retry_count"] as Int? ?? 0) > 0
        let owesCompanions = (row?["companions_owed"] as Int? ?? 0) != 0
        guard prior != .uploaded, prior != .uploading, !isRetrying, !owesCompanions else {
          return nil
        }
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

  /// Re-queues the photos that are still out of retries with a fresh budget,
  /// including ones whose original the server holds but whose companions it
  /// lacks. Rows settled since the caller's snapshot are left alone. Returns
  /// the tasks re-queued.
  public func requeueFailed(_ tasks: [BackupTask]) throws -> [BackupTask] {
    try dbQueue.write { db in
      try tasks.filter { task in
        try db.execute(
          sql: """
            UPDATE tasks
               SET state = ?, retry_count = 0, last_error = NULL, priority = ?,
                   enqueued_at = ?, captured_at = COALESCE(?, captured_at)
             WHERE device_id = ? AND phasset_local_id = ? AND state = ?
            """,
          arguments: [
            BackupState.pending.rawValue, task.priority.rawValue,
            task.enqueuedAt.timeIntervalSince1970, task.capturedAt?.timeIntervalSince1970,
            task.id.deviceId, task.id.phassetLocalId, BackupState.failedRetry.rawValue,
          ])
        return db.changesCount > 0
      }
    }
  }

  /// Creates the rows a walk found missing, leaving any row that exists by the
  /// time it writes alone: the live observer or a worker may have inserted or
  /// advanced it since the walk's snapshot, and replacing it would reset an
  /// upload in flight, restart its retry budget or drop its companions-owed
  /// mark. A row left alone only gains a capture date it lacked. Returns the
  /// tasks actually created, the only ones the caller should queue.
  public func insertMissing(_ tasks: [BackupTask]) throws -> [BackupTask] {
    try dbQueue.write { db in
      try tasks.filter { task in
        try db.execute(
          sql: """
            INSERT INTO tasks
              (device_id, phasset_local_id, state, priority, retry_count, last_error,
               enqueued_at, captured_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id, phasset_local_id) DO NOTHING
            """,
          arguments: [
            task.id.deviceId, task.id.phassetLocalId, task.state.rawValue,
            task.priority.rawValue, task.retryCount, task.lastError,
            task.enqueuedAt.timeIntervalSince1970, task.capturedAt?.timeIntervalSince1970,
          ])
        if db.changesCount > 0 { return true }
        try db.execute(
          sql: """
            UPDATE tasks SET captured_at = ?
             WHERE device_id = ? AND phasset_local_id = ? AND captured_at IS NULL
            """,
          arguments: [
            task.capturedAt?.timeIntervalSince1970, task.id.deviceId, task.id.phassetLocalId,
          ])
        return false
      }
    }
  }

  /// Records that the photo's Live Photo video or edited render has yet to
  /// reach the server. Set before the original is sent, so an original that
  /// lands without its response reaching us still leaves the mark.
  public func markCompanionsOwed(_ id: BackupTaskID) throws {
    try dbQueue.write { db in
      try db.execute(
        sql: """
          UPDATE tasks SET companions_owed = 1
           WHERE device_id = ? AND phasset_local_id = ?
          """,
        arguments: [id.deviceId, id.phassetLocalId])
    }
  }

  /// Photos the server may hold the original of but that still owe it a
  /// companion, so they never count as backed up.
  public func phidsOwingCompanions(deviceId: String) throws -> Set<String> {
    try dbQueue.read { db in
      Set(
        try String.fetchAll(
          db,
          sql: "SELECT phasset_local_id FROM tasks WHERE device_id = ? AND companions_owed = 1",
          arguments: [deviceId]))
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

  /// Drops the rows of photos the inclusion settings exclude that record
  /// nothing delivered. Each row is re-read in its own transaction, so a row a
  /// worker has claimed, uploaded or marked as owing companions since the
  /// caller's snapshot is kept: a pending row that now owes companions is
  /// parked, as the walk would have parked it. Returns the ids that were
  /// pending and left the queue, whose queue entries the caller should cancel.
  public func removeExcluded(_ ids: [BackupTaskID]) throws -> [BackupTaskID] {
    try dbQueue.write { db in
      try ids.compactMap { id in
        let row = try Row.fetchOne(
          db,
          sql: """
            SELECT state, companions_owed FROM tasks
             WHERE device_id = ? AND phasset_local_id = ?
            """,
          arguments: [id.deviceId, id.phassetLocalId])
        guard let prior = (row?["state"] as String?).flatMap(BackupState.init(rawValue:)) else {
          return nil
        }
        let owesCompanions = (row?["companions_owed"] as Int? ?? 0) != 0
        switch (prior, owesCompanions) {
        case (.observed, false), (.pending, false), (.failedRetry, false),
          (.localEditPending, false):
          try db.execute(
            sql: "DELETE FROM tasks WHERE device_id = ? AND phasset_local_id = ?",
            arguments: [id.deviceId, id.phassetLocalId])
        case (.pending, true):
          try db.execute(
            sql: "UPDATE tasks SET state = ? WHERE device_id = ? AND phasset_local_id = ?",
            arguments: [BackupState.skippedPolicy.rawValue, id.deviceId, id.phassetLocalId])
        default:
          return nil
        }
        return prior == .pending ? id : nil
      }
    }
  }

  /// Returns a dequeued task's row to pending while it waits for Wi-Fi.
  /// Returns false when a walk has since recorded the photo as uploaded or
  /// suspended it as excluded, or its row is gone, so the worker drops it
  /// rather than undo what the walk wrote.
  public func returnToPending(_ id: BackupTaskID) throws -> Bool {
    try dbQueue.write { db in
      try db.execute(
        sql: """
          UPDATE tasks SET state = ?, last_error = NULL
           WHERE device_id = ? AND phasset_local_id = ? AND state NOT IN (?, ?)
          """,
        arguments: [
          BackupState.pending.rawValue, id.deviceId, id.phassetLocalId,
          BackupState.uploaded.rawValue, BackupState.skippedPolicy.rawValue,
        ])
      return db.changesCount > 0
    }
  }

  /// Moves a dequeued task to uploading. Returns false when its row is gone, a
  /// walk already recorded the photo as uploaded, or a walk suspended it as
  /// excluded, so the worker drops it.
  public func claimForUpload(_ id: BackupTaskID) throws -> Bool {
    try dbQueue.write { db in
      try db.execute(
        sql: """
          UPDATE tasks SET state = ?, last_error = NULL
           WHERE device_id = ? AND phasset_local_id = ? AND state NOT IN (?, ?)
          """,
        arguments: [
          BackupState.uploading.rawValue, id.deviceId, id.phassetLocalId,
          BackupState.uploaded.rawValue, BackupState.skippedPolicy.rawValue,
        ])
      return db.changesCount > 0
    }
  }

  /// Parks pending rows of photos the inclusion settings now exclude as
  /// `.skippedPolicy`, keeping their retry count and companions-owed mark.
  /// Neither `rehydrate` nor a worker picks them up. Returns the ids that were
  /// pending, whose queue entries the caller should cancel.
  public func suspendExcluded(_ ids: [BackupTaskID]) throws -> [BackupTaskID] {
    try dbQueue.write { db in
      try ids.filter { id in
        try db.execute(
          sql: """
            UPDATE tasks SET state = ?
             WHERE device_id = ? AND phasset_local_id = ? AND state = ?
            """,
          arguments: [
            BackupState.skippedPolicy.rawValue, id.deviceId, id.phassetLocalId,
            BackupState.pending.rawValue,
          ])
        return db.changesCount > 0
      }
    }
  }

  /// Returns parked rows of photos that are listed again to pending. Returns
  /// the stored tasks resumed, with the retry count they were parked with.
  public func resumeExcluded(_ tasks: [BackupTask]) throws -> [BackupTask] {
    try dbQueue.write { db in
      try tasks.compactMap { task in
        try db.execute(
          sql: """
            UPDATE tasks SET state = ?, priority = ?, captured_at = COALESCE(?, captured_at)
             WHERE device_id = ? AND phasset_local_id = ? AND state = ?
            """,
          arguments: [
            BackupState.pending.rawValue, task.priority.rawValue,
            task.capturedAt?.timeIntervalSince1970, task.id.deviceId, task.id.phassetLocalId,
            BackupState.skippedPolicy.rawValue,
          ])
        guard db.changesCount > 0 else { return nil }
        return try Row.fetchOne(
          db, sql: "SELECT * FROM tasks WHERE device_id = ? AND phasset_local_id = ?",
          arguments: [task.id.deviceId, task.id.phassetLocalId]
        ).map(Self.decode)
      }
    }
  }

  /// The photos recorded as uploaded whose edit is stored under one of
  /// `fileNames`, each with the digest of the edit last delivered under the
  /// sidecar name the server reads, or nil when none was. Chosen in SQL from
  /// the stored edits, which are few, so a library of many photos never
  /// loads. The file name is `AppSupportSidecarStore.sidecarURL`'s: the local
  /// id with `/` replaced by `_`, plus `.xmp`.
  public func uploadedPhotosWithEdits(
    deviceId: String, sidecarFileNames fileNames: Set<String>
  ) throws -> [(phid: String, deliveredDigest: String?)] {
    guard !fileNames.isEmpty else { return [] }
    let names = String(decoding: try JSONEncoder().encode(Array(fileNames)), as: UTF8.self)
    return try dbQueue.read { db in
      try Row.fetchAll(
        db,
        sql: """
          SELECT t.phasset_local_id AS phid, s.digest AS digest
            FROM tasks t
            LEFT JOIN uploaded_sidecars s
              ON s.device_id = t.device_id AND s.phasset_local_id = t.phasset_local_id
             AND s.canonical_name = 1
           WHERE t.device_id = ? AND t.state = ?
             AND replace(t.phasset_local_id, '/', '_') || '.xmp'
                 IN (SELECT value FROM json_each(?))
          """,
        arguments: [deviceId, BackupState.uploaded.rawValue, names]
      ).map { (phid: $0["phid"], deliveredDigest: $0["digest"]) }
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
