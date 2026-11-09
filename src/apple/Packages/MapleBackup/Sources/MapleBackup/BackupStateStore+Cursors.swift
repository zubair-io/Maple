// Sources/MapleBackup/BackupStateStore+Cursors.swift
//
// Persistent watermarks and incremental-discovery cursors for PhotoKit backup.
// Tracks the earliest and latest backed-up capture timestamps, PhotoKit scan
// watermarks, serialized PHPersistentChangeToken, and the server `/backup/state`
// `since` cursor so restarts and change notifications do not re-check the
// entire library from zero.

import Foundation
import GRDB

/// Persistent discovery and backup progress watermarks for a single device.
public struct BackupCursor: Sendable, Equatable {
  public let deviceId: String
  /// Latest `PHAsset.creationDate` inspected by the PhotoKit discovery pass.
  public var newestScannedAt: Date?
  /// Earliest `PHAsset.creationDate` inspected by the PhotoKit discovery pass.
  public var oldestScannedAt: Date?
  /// Tie-breaker `localIdentifier` at `oldestScannedAt`.
  public var oldestScannedPhid: String?
  /// Latest `captured_at` across all `.uploaded` photos for this device.
  public var newestBackedUpAt: Date?
  /// Earliest `captured_at` across all `.uploaded` photos for this device.
  public var oldestBackedUpAt: Date?
  /// ISO-8601 `first_seen` cursor for `GET /api/libraries/:id/backup/state?since=...`.
  public var lastServerReconciledAt: String?
  /// Keyed-archiver `Data` of the most recent `PHPersistentChangeToken`.
  public var phChangeToken: Data?
  /// Most recent eligible library photo count for instant cold-start UI display.
  public var libraryEligibleCount: Int?
  /// Fingerprint of inclusion settings (`includeVideos`, `includeBursts`, etc.).
  public var settingsFingerprint: String?
  /// True once a full-library discovery pass has completed for `settingsFingerprint`.
  public var initialScanCompleted: Bool

  public init(
    deviceId: String,
    newestScannedAt: Date? = nil,
    oldestScannedAt: Date? = nil,
    oldestScannedPhid: String? = nil,
    newestBackedUpAt: Date? = nil,
    oldestBackedUpAt: Date? = nil,
    lastServerReconciledAt: String? = nil,
    phChangeToken: Data? = nil,
    libraryEligibleCount: Int? = nil,
    settingsFingerprint: String? = nil,
    initialScanCompleted: Bool = false
  ) {
    self.deviceId = deviceId
    self.newestScannedAt = newestScannedAt
    self.oldestScannedAt = oldestScannedAt
    self.oldestScannedPhid = oldestScannedPhid
    self.newestBackedUpAt = newestBackedUpAt
    self.oldestBackedUpAt = oldestBackedUpAt
    self.lastServerReconciledAt = lastServerReconciledAt
    self.phChangeToken = phChangeToken
    self.libraryEligibleCount = libraryEligibleCount
    self.settingsFingerprint = settingsFingerprint
    self.initialScanCompleted = initialScanCompleted
  }
}

extension BackupStateStore {

  static func createCursorsTable(in db: Database) throws {
    try db.create(table: "backup_cursors", ifNotExists: true) { t in
      t.column("device_id", .text).primaryKey()
      t.column("newest_scanned_at", .double)
      t.column("oldest_scanned_at", .double)
      t.column("oldest_scanned_phid", .text)
      t.column("newest_backed_up_at", .double)
      t.column("oldest_backed_up_at", .double)
      t.column("last_server_reconciled_at", .text)
      t.column("ph_change_token", .blob)
      t.column("library_eligible_count", .integer)
      t.column("settings_fingerprint", .text)
      t.column("initial_scan_completed", .integer).notNull().defaults(to: 0)
    }
    // Seed backed-up watermarks from existing `.uploaded` rows when migrating
    // a store created before `backup_cursors` existed.
    try db.execute(
      sql: """
        INSERT INTO backup_cursors (device_id, newest_backed_up_at, oldest_backed_up_at)
        SELECT device_id, MAX(captured_at), MIN(captured_at)
          FROM tasks
         WHERE state = 'uploaded' AND captured_at IS NOT NULL
         GROUP BY device_id
        ON CONFLICT(device_id) DO UPDATE SET
          newest_backed_up_at = MAX(
            COALESCE(backup_cursors.newest_backed_up_at, excluded.newest_backed_up_at),
            COALESCE(excluded.newest_backed_up_at, backup_cursors.newest_backed_up_at)
          ),
          oldest_backed_up_at = MIN(
            COALESCE(backup_cursors.oldest_backed_up_at, excluded.oldest_backed_up_at),
            COALESCE(excluded.oldest_backed_up_at, backup_cursors.oldest_backed_up_at)
          )
        """)
  }

  static func recordUploadedWatermark(for id: BackupTaskID, in db: Database) throws {
    guard
      let ts = try Double.fetchOne(
        db,
        sql: "SELECT captured_at FROM tasks WHERE device_id = ? AND phasset_local_id = ?",
        arguments: [id.deviceId, id.phassetLocalId])
    else { return }
    try upsertBackedUpBounds(deviceId: id.deviceId, minTs: ts, maxTs: ts, in: db)
  }

  static func recordUploadedWatermarks(for tasks: [BackupTask], in db: Database) throws {
    var boundsByDevice: [String: (min: Double, max: Double)] = [:]
    for task in tasks where task.state == .uploaded {
      guard let ts = task.capturedAt?.timeIntervalSince1970 else { continue }
      if let cur = boundsByDevice[task.id.deviceId] {
        boundsByDevice[task.id.deviceId] = (min(cur.min, ts), max(cur.max, ts))
      } else {
        boundsByDevice[task.id.deviceId] = (ts, ts)
      }
    }
    for (deviceId, bounds) in boundsByDevice {
      try upsertBackedUpBounds(
        deviceId: deviceId, minTs: bounds.min, maxTs: bounds.max, in: db)
    }
  }

  private static func upsertBackedUpBounds(
    deviceId: String, minTs: Double, maxTs: Double, in db: Database
  ) throws {
    try db.execute(
      sql: """
        INSERT INTO backup_cursors (device_id, newest_backed_up_at, oldest_backed_up_at)
        VALUES (?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          newest_backed_up_at = MAX(
            COALESCE(backup_cursors.newest_backed_up_at, excluded.newest_backed_up_at),
            excluded.newest_backed_up_at
          ),
          oldest_backed_up_at = MIN(
            COALESCE(backup_cursors.oldest_backed_up_at, excluded.oldest_backed_up_at),
            excluded.oldest_backed_up_at
          )
        """,
      arguments: [deviceId, maxTs, minTs])
  }

  public func cursor(deviceId: String) throws -> BackupCursor {
    try dbQueue.read { db in
      guard
        let row = try Row.fetchOne(
          db,
          sql: "SELECT * FROM backup_cursors WHERE device_id = ?",
          arguments: [deviceId])
      else {
        return BackupCursor(deviceId: deviceId)
      }
      return Self.decodeCursor(row)
    }
  }

  public func saveCursor(_ cursor: BackupCursor) throws {
    try dbQueue.write { db in
      try db.execute(
        sql: """
          INSERT INTO backup_cursors (
            device_id, newest_scanned_at, oldest_scanned_at, oldest_scanned_phid,
            newest_backed_up_at, oldest_backed_up_at, last_server_reconciled_at,
            ph_change_token, library_eligible_count, settings_fingerprint,
            initial_scan_completed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            newest_scanned_at = excluded.newest_scanned_at,
            oldest_scanned_at = excluded.oldest_scanned_at,
            oldest_scanned_phid = excluded.oldest_scanned_phid,
            newest_backed_up_at = COALESCE(excluded.newest_backed_up_at, backup_cursors.newest_backed_up_at),
            oldest_backed_up_at = COALESCE(excluded.oldest_backed_up_at, backup_cursors.oldest_backed_up_at),
            last_server_reconciled_at = excluded.last_server_reconciled_at,
            ph_change_token = excluded.ph_change_token,
            library_eligible_count = excluded.library_eligible_count,
            settings_fingerprint = excluded.settings_fingerprint,
            initial_scan_completed = excluded.initial_scan_completed
          """,
        arguments: [
          cursor.deviceId,
          cursor.newestScannedAt?.timeIntervalSince1970,
          cursor.oldestScannedAt?.timeIntervalSince1970,
          cursor.oldestScannedPhid,
          cursor.newestBackedUpAt?.timeIntervalSince1970,
          cursor.oldestBackedUpAt?.timeIntervalSince1970,
          cursor.lastServerReconciledAt,
          cursor.phChangeToken,
          cursor.libraryEligibleCount,
          cursor.settingsFingerprint,
          cursor.initialScanCompleted ? 1 : 0,
        ])
    }
  }

  /// Advance the PhotoKit scan watermarks monotonically (newest moves forward,
  /// oldest moves backward) without clobbering server/token cursors.
  public func advanceScanWatermarks(
    deviceId: String,
    newestScannedAt: Date? = nil,
    oldestScannedAt: Date? = nil,
    oldestScannedPhid: String? = nil,
    libraryEligibleCount: Int? = nil,
    settingsFingerprint: String? = nil,
    initialScanCompleted: Bool? = nil
  ) throws {
    try dbQueue.write { db in
      let current =
        try Row.fetchOne(
          db, sql: "SELECT * FROM backup_cursors WHERE device_id = ?", arguments: [deviceId]
        ).map(Self.decodeCursor) ?? BackupCursor(deviceId: deviceId)

      let fingerprintChanged =
        settingsFingerprint != nil && current.settingsFingerprint != nil
        && settingsFingerprint != current.settingsFingerprint

      var merged = current
      if fingerprintChanged {
        merged.newestScannedAt = newestScannedAt
        merged.oldestScannedAt = oldestScannedAt
        merged.oldestScannedPhid = oldestScannedPhid
        merged.initialScanCompleted = initialScanCompleted ?? false
      } else {
        if let newest = newestScannedAt {
          merged.newestScannedAt = max(merged.newestScannedAt ?? newest, newest)
        }
        if let oldest = oldestScannedAt {
          if let existingOldest = merged.oldestScannedAt {
            if oldest <= existingOldest {
              merged.oldestScannedAt = oldest
              if let oldestScannedPhid { merged.oldestScannedPhid = oldestScannedPhid }
            }
          } else {
            merged.oldestScannedAt = oldest
            merged.oldestScannedPhid = oldestScannedPhid
          }
        }
        if let completed = initialScanCompleted {
          merged.initialScanCompleted = completed
        }
      }
      if let count = libraryEligibleCount { merged.libraryEligibleCount = count }
      if let fp = settingsFingerprint { merged.settingsFingerprint = fp }

      try db.execute(
        sql: """
          INSERT INTO backup_cursors (
            device_id, newest_scanned_at, oldest_scanned_at, oldest_scanned_phid,
            newest_backed_up_at, oldest_backed_up_at, last_server_reconciled_at,
            ph_change_token, library_eligible_count, settings_fingerprint,
            initial_scan_completed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            newest_scanned_at = excluded.newest_scanned_at,
            oldest_scanned_at = excluded.oldest_scanned_at,
            oldest_scanned_phid = excluded.oldest_scanned_phid,
            library_eligible_count = excluded.library_eligible_count,
            settings_fingerprint = excluded.settings_fingerprint,
            initial_scan_completed = excluded.initial_scan_completed
          """,
        arguments: [
          merged.deviceId,
          merged.newestScannedAt?.timeIntervalSince1970,
          merged.oldestScannedAt?.timeIntervalSince1970,
          merged.oldestScannedPhid,
          merged.newestBackedUpAt?.timeIntervalSince1970,
          merged.oldestBackedUpAt?.timeIntervalSince1970,
          merged.lastServerReconciledAt,
          merged.phChangeToken,
          merged.libraryEligibleCount,
          merged.settingsFingerprint,
          merged.initialScanCompleted ? 1 : 0,
        ])
    }
  }

  public func updateServerReconciledAt(deviceId: String, since: String?) throws {
    try dbQueue.write { db in
      try db.execute(
        sql: """
          INSERT INTO backup_cursors (device_id, last_server_reconciled_at)
          VALUES (?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            last_server_reconciled_at = excluded.last_server_reconciled_at
          """,
        arguments: [deviceId, since])
    }
  }

  public func updatePhotoKitChangeToken(deviceId: String, token: Data?) throws {
    try dbQueue.write { db in
      try db.execute(
        sql: """
          INSERT INTO backup_cursors (device_id, ph_change_token)
          VALUES (?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            ph_change_token = excluded.ph_change_token
          """,
        arguments: [deviceId, token])
    }
  }

  private static func decodeCursor(_ row: Row) -> BackupCursor {
    BackupCursor(
      deviceId: row["device_id"],
      newestScannedAt: (row["newest_scanned_at"] as Double?).map(
        Date.init(timeIntervalSince1970:)),
      oldestScannedAt: (row["oldest_scanned_at"] as Double?).map(
        Date.init(timeIntervalSince1970:)),
      oldestScannedPhid: row["oldest_scanned_phid"],
      newestBackedUpAt: (row["newest_backed_up_at"] as Double?).map(
        Date.init(timeIntervalSince1970:)),
      oldestBackedUpAt: (row["oldest_backed_up_at"] as Double?).map(
        Date.init(timeIntervalSince1970:)),
      lastServerReconciledAt: row["last_server_reconciled_at"],
      phChangeToken: row["ph_change_token"],
      libraryEligibleCount: row["library_eligible_count"],
      settingsFingerprint: row["settings_fingerprint"],
      initialScanCompleted: (row["initial_scan_completed"] as Int? ?? 0) != 0)
  }
}
