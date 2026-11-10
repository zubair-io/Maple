import Foundation
import GRDB

/// Snapshot of persisted task states used to hydrate `BackupProgressViewModel`
/// immediately on cold start before the background PhotoKit walk completes.
public struct BackupStartupSnapshot: Sendable, Equatable {
  public let libraryPhotoIDs: Set<String>
  public let backedUpPhotoIDs: Set<String>

  public init(libraryPhotoIDs: Set<String>, backedUpPhotoIDs: Set<String>) {
    self.libraryPhotoIDs = libraryPhotoIDs
    self.backedUpPhotoIDs = backedUpPhotoIDs
  }
}

extension BackupStateStore {
  /// Resumes the persisted backlog on engine start: pending rows re-enter the
  /// queue, and rows a stopped or crashed engine left uploading go back to
  /// pending first. On macOS, call it only while holding `BackupEngineLock`:
  /// another host's uploading rows are its live uploads (#4988). iOS has a
  /// single host and takes no lock (#5022).
  /// `priority` overrides each task's own; the count is the tasks enqueued.
  @discardableResult
  public func rehydrate(into queue: some BackupQueue, priority: BackupPriority? = nil)
    async throws -> Int
  {
    let tasks: [BackupTask] = try await dbQueue.write { db in
      try db.execute(
        sql: "UPDATE tasks SET state = ? WHERE state = ?",
        arguments: [BackupState.pending.rawValue, BackupState.uploading.rawValue])
      return try Row.fetchAll(
        db,
        sql: """
          SELECT * FROM tasks
           WHERE state = ?
           ORDER BY priority DESC,
                    CASE WHEN captured_at IS NULL THEN 1 ELSE 0 END ASC,
                    captured_at DESC,
                    enqueued_at ASC
          """,
        arguments: [BackupState.pending.rawValue]
      ).map(Self.decode)
    }
    await queue.enqueue(tasks, priority: priority)
    return tasks.count
  }

  /// Build a cold-start snapshot from persisted SQLite records so the UI
  /// immediately displays existing backup progress before the PhotoKit walk
  /// finishes. Returns nil when the store has no recorded tasks yet.
  public func startupSnapshot(deviceId: String) throws -> BackupStartupSnapshot? {
    try dbQueue.read { db in
      let rows = try Row.fetchAll(
        db,
        sql: """
          SELECT phasset_local_id, state FROM tasks
           WHERE device_id = ? AND state != 'skippedPolicy'
          """,
        arguments: [deviceId])
      guard !rows.isEmpty else { return nil }
      let entries: [(phid: String, state: String)] = rows.map {
        ($0["phasset_local_id"], $0["state"])
      }
      return BackupStartupSnapshot(
        libraryPhotoIDs: Set(entries.map(\.phid)),
        backedUpPhotoIDs: Set(
          entries.filter { $0.state == BackupState.uploaded.rawValue }.map(\.phid)))
    }
  }

  /// Backfill missing `captured_at` dates on existing `.pending` rows (e.g.
  /// stores migrated from pre-#3388) and return the updated tasks so the
  /// live queue can re-order them newest-first. A row waiting out a retry
  /// backoff is left alone: the engine re-queues it itself, and queueing it
  /// here as well would upload it twice.
  public func backfillPendingCapturedDates(
    _ datesByPhid: [String: Date], deviceId: String
  ) throws -> [BackupTask] {
    guard !datesByPhid.isEmpty else { return [] }
    return try dbQueue.write { db in
      let nullPendingRows = try Row.fetchAll(
        db,
        sql: """
          SELECT * FROM tasks
           WHERE device_id = ? AND state = 'pending' AND retry_count = 0
             AND captured_at IS NULL
          """,
        arguments: [deviceId])
      guard !nullPendingRows.isEmpty else { return [] }
      var updated: [BackupTask] = []
      for row in nullPendingRows {
        let phid: String = row["phasset_local_id"]
        guard let date = datesByPhid[phid] else { continue }
        try db.execute(
          sql: """
            UPDATE tasks SET captured_at = ?
             WHERE device_id = ? AND phasset_local_id = ?
            """,
          arguments: [date.timeIntervalSince1970, deviceId, phid])
        var task = Self.decode(row)
        task.capturedAt = date
        updated.append(task)
      }
      return updated
    }
  }
}
